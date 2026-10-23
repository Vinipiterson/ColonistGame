// Milestone 2 end-to-end: furnish the start chamber through the real UI (build bar, clicks,
// drags, R to flip stairs), fast-forward two days, and check the colony lives in it.
// Usage: npm run build && node e2e/furnish.mjs   (screenshots in e2e/shots/)

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find((p) => existsSync(p));
const shots = resolve('e2e/shots');
mkdirSync(shots, { recursive: true });
const url = 'file://' + resolve('dist/index.html') + '?seed=20261023';

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|ERR_INTERNET/.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.__colony);

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const tileToScreen = (x, y) =>
  page.evaluate(([x, y]) => {
    const r = window.__colony.renderer;
    return { x: (x + 0.5 - r.cam.x) * r.cam.zoom + r.viewW / 2, y: (y + 0.5 - r.cam.y) * r.cam.zoom + r.viewH / 2 };
  }, [x, y]);
async function drag(x0, y0, x1, y1) {
  const a = await tileToScreen(x0, y0), b = await tileToScreen(x1, y1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}
const click = (x, y) => drag(x, y, x, y);
const run = (n) => page.evaluate((n) => window.__colony.world.run(n), n);
const pick = async (kind) => page.click(`.build-btn[data-build="${kind}"]`);

await page.evaluate(() => {
  const { world, renderer } = window.__colony;
  world.resources.matter = 3000;
  renderer.cam.zoom = 30;
});
await page.waitForTimeout(200);
const s = await page.evaluate(() => window.__colony.world.spawn);

// Dig a stairwell to the left and an upper corridor the staircase leads to
await page.keyboard.press('KeyG');
await drag(s.x - 13, s.y - 6, s.x - 10, s.y);
await drag(s.x - 22, s.y - 6, s.x - 14, s.y - 3);

// Furniture through the build bar
await page.keyboard.press('KeyB');
check(await page.isVisible('.bgroup-title'), 'build bar shows Structure / Furniture groups');
await pick('bed');
await page.mouse.move(...Object.values(await tileToScreen(s.x - 8, s.y)));
await page.waitForTimeout(100);
await page.screenshot({ path: `${shots}/m2-01-bed-ghost.png` });
await drag(s.x - 9, s.y, s.x - 6, s.y); // two beds side by side
await pick('toilet');
await click(s.x + 3, s.y);
await pick('sink');
await click(s.x + 4, s.y);
await pick('shower');
await click(s.x + 5, s.y);
await pick('table');
await click(s.x + 6, s.y);
await pick('printer');
await click(s.x + 8, s.y);
// a wall with a door in it, splitting the chamber
await pick('wall');
await drag(s.x - 4, s.y - 3, s.x - 4, s.y - 2);
await pick('door');
await click(s.x - 4, s.y);
// staircase rising to the left (R), out of the side room
await pick('stairs');
await page.keyboard.press('KeyR');
const flipped = await page.evaluate(() => window.__colony.tools.flip);
check(flipped === true, 'R flips the stairs direction');
for (let k = 0; k < 3; k++) await click(s.x - 11 - k, s.y - k);
await page.keyboard.press('KeyR');
await run(1);
const orders = await page.evaluate(() => [...window.__colony.world.orders.all()].map((o) => o.build ?? o.kind));
check(['bed', 'toilet', 'sink', 'shower', 'table', 'printer', 'door'].every((k) => orders.includes(k)), `all furniture orders placed (${orders.filter((o) => o !== 'dig').join(', ')})`);
check(orders.filter((o) => o === 'bed').length === 2, 'dragging places two beds side by side');
await page.screenshot({ path: `${shots}/m2-02-blueprints.png` });

// Fast-forward until built
await page.evaluate(() => {
  const w = window.__colony.world;
  for (let i = 0; i < 20 * 600 && [...w.orders.all()].some((o) => o.kind === 'build'); i++) w.step();
});
const built = await page.evaluate(() => {
  const w = window.__colony.world;
  const k = {};
  for (const b of w.buildings.all()) k[b.kind] = (k[b.kind] ?? 0) + 1;
  const g = w.grid;
  const stairs = [];
  for (let i = 0; i < g.size; i++) if (g.tile[i] === 6) stairs.push(g.tileDir[i]);
  return { k, stairs, left: [...w.orders.all()].filter((o) => o.kind === 'build').length };
});
check(built.left === 0, `everything built (${built.left} build orders left)`);
check(built.k.bed === 2 && built.k.printer === 1 && built.k.door === 1, `buildings exist ${JSON.stringify(built.k)}`);
check(built.stairs.length === 3 && built.stairs.every((d) => d === 0), `3 stair blocks rising left (${built.stairs})`);

// Two in-game days
await run(20 * 600 * 2);
const st = await page.evaluate(() => {
  const w = window.__colony.world;
  return { alive: w.aliveCount, food: w.resources.food, health: w.colonists.map((c) => Math.round(c.health)), deaths: w.colonists.filter((c) => !c.alive).map((c) => c.deathCause) };
});
check(st.alive === 3, `all 3 alive after 2 days (${JSON.stringify(st)})`);
check(st.food >= 1, `ration printer keeps meals in stock (${st.food})`);

// Real-time: doors open as colonists pass; catch someone using furniture
await page.evaluate(() => {
  // send everyone to bed: the beds are on the other side of the door
  for (const c of window.__colony.world.colonists) { c.needs.sleep = 10; c.needs.bladder = 100; c.needs.hunger = 100; }
});
await page.click('.hud-speed .btn[data-speed="3"]');
let maxOpen = 0;
let usingShot = false;
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => {
    const { world, renderer } = window.__colony;
    const d = [...world.buildings.ofKind('door')][0];
    const user = world.colonists.find((c) => c.state === 'using');
    return { open: d ? renderer.doorOpenness(d) : 0, user: user ? user.id : -1 };
  });
  maxOpen = Math.max(maxOpen, info.open);
  if (info.user > 0 && !usingShot) {
    await page.evaluate((id) => { window.__colony.hud.selectedId = id; window.__colony.renderer.selectedId = id; }, info.user);
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${shots}/m2-03-using.png` });
    usingShot = true;
  }
  if (maxOpen > 0.75 && usingShot) break;
}
check(maxOpen > 0.75, `door opens when a colonist passes (max ${maxOpen.toFixed(2)})`);
await page.screenshot({ path: `${shots}/m2-04-base.png` });

// Force a need so the icon / panel shows, then a phone-width shot
await page.evaluate(() => { const c = window.__colony.world.colonists[0]; c.needs.bladder = 5; window.__colony.hud.selectedId = c.id; window.__colony.renderer.selectedId = c.id; });
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/m2-05-need.png` });
await page.keyboard.press('KeyB');
await page.setViewportSize({ width: 400, height: 800 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/m2-06-phone-build.png` });

check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall furnish checks passed');
process.exit(failures ? 1 : 0);
