// End-to-end check in a real Chromium: loads the built single-file game, drives it with real
// mouse drags and key presses, fast-forwards the sim, asserts on state and saves screenshots.
// Usage: npm run build && npm run e2e   (screenshots land in e2e/shots/)

import { launchBrowser } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shots = resolve('e2e/shots');
mkdirSync(shots, { recursive: true });
const url = pathToFileURL(resolve('dist/index.html')).href + '?seed=20261022';

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|ERR_INTERNET/.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.__colony);

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}

/** Screen position (CSS px) of the center of tile (x, y). */
async function tileToScreen(x, y) {
  return page.evaluate(([x, y]) => {
    const r = window.__colony.renderer;
    return { x: (x + 0.5 - r.cam.x) * r.cam.zoom + r.viewW / 2, y: (y + 0.5 - r.cam.y) * r.cam.zoom + r.viewH / 2 };
  }, [x, y]);
}
async function dragTiles(x0, y0, x1, y1) {
  const a = await tileToScreen(x0, y0), b = await tileToScreen(x1, y1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  return async () => page.mouse.up();
}
const state = () =>
  page.evaluate(() => {
    const { world, tools } = window.__colony;
    return {
      matter: world.resources.matter, coal: world.resources.coal, orders: world.orders.count,
      alive: world.aliveCount, priority: tools.priority, mode: tools.mode, tick: world.tick,
      orderPriorities: [...world.orders.all()].map((o) => o.priority),
    };
  });
const run = (n) => page.evaluate((n) => window.__colony.world.run(n), n);

await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/01-start.png` });
const spawn = await page.evaluate(() => window.__colony.world.spawn);
let s = await state();
check(s.alive === 3, 'starts with 3 colonists');
check(s.priority === 6, 'default priority is 6');

// --- Dig: drag a rectangle to the right of the chamber
await page.keyboard.press('KeyG');
let release = await dragTiles(spawn.x + 10, spawn.y - 3, spawn.x + 16, spawn.y);
await page.screenshot({ path: `${shots}/02-dig-drag-preview.png` });
await release();
await run(1);
s = await state();
check(s.mode === 'dig', 'G selects the Dig tool');
check(s.orders === 28, `dig rectangle creates 28 orders (got ${s.orders})`);
check(s.orderPriorities.every((p) => p === 6), 'orders use the selected priority (6)');
await page.screenshot({ path: `${shots}/03-dig-orders.png` });

// --- Priority widget: key 8 then click 3 on the widget; persists for new orders
await page.keyboard.press('Digit8');
check((await state()).priority === 8, 'key 8 selects priority 8');
await page.click('.prio[data-priority="3"]');
check((await state()).priority === 3, 'clicking the widget selects priority 3');
release = await dragTiles(spawn.x - 16, spawn.y - 2, spawn.x - 11, spawn.y);
await release();
await run(1);
s = await state();
check(s.orderPriorities.filter((p) => p === 3).length === 18, 'new orders take the persistent priority 3');

// --- let them work
await run(20 * 90);
s = await state();
check(s.matter > 300, `digging adds matter (matter ${s.matter})`);
check(s.orders < 46, `orders get completed (${s.orders} left)`);
await page.screenshot({ path: `${shots}/04-after-digging.png` });

// --- Build: stairs column + a wall row
await page.keyboard.press('KeyB');
await page.click('.build-btn[data-build="ladder"]');
await page.screenshot({ path: `${shots}/05-build-bar.png` });
release = await dragTiles(spawn.x + 3, spawn.y - 3, spawn.x + 3, spawn.y);
await release();
await page.click('.build-btn[data-build="wall"]');
release = await dragTiles(spawn.x - 6, spawn.y - 3, spawn.x - 4, spawn.y - 3);
await release();
await run(1);
await page.screenshot({ path: `${shots}/06-build-ghosts.png` });
await run(20 * 60);
const built = await page.evaluate(([x, y]) => {
  const g = window.__colony.world.grid;
  let stairs = 0, walls = 0;
  for (let yy = y - 3; yy <= y; yy++) stairs += g.stairs[g.idx(x + 3, yy)];
  for (let xx = x - 6; xx <= x - 4; xx++) walls += g.built[g.idx(xx, y - 3)];
  return { stairs, walls };
}, [spawn.x, spawn.y]);
check(built.stairs === 4, `4 stairs built (${built.stairs})`);
check(built.walls === 3, `3 walls built (${built.walls})`);

// --- Deconstruct one wall, Cancel a pending dig area
await page.keyboard.press('KeyX');
release = await dragTiles(spawn.x - 6, spawn.y - 3, spawn.x - 6, spawn.y - 3);
await release();
await page.keyboard.press('KeyG');
release = await dragTiles(spawn.x - 3, spawn.y + 2, spawn.x + 3, spawn.y + 4);
await release();
await run(1);
const before = (await state()).orders;
await page.keyboard.press('KeyC');
release = await dragTiles(spawn.x - 3, spawn.y + 2, spawn.x + 3, spawn.y + 4);
await release();
await run(1);
const after = (await state()).orders;
check(before - after >= 21, `cancel removes the dig orders in the rectangle (${before} -> ${after})`);
await run(20 * 20);
const wallGone = await page.evaluate(([x, y]) => window.__colony.world.grid.built[window.__colony.world.grid.idx(x - 6, y - 3)], [spawn.x, spawn.y]);
check(wallGone === 0, 'deconstructed wall is removed');

// --- Reported bug: dig the floor under the colonists, then wall it back over them
const cols = await page.evaluate(() => window.__colony.world.colonists.map((c) => [c.x, c.y]));
const minX = Math.min(...cols.map((c) => c[0])) - 1, maxX = Math.max(...cols.map((c) => c[0])) + 1;
const floorY = spawn.y + 1;
await page.keyboard.press('KeyG');
release = await dragTiles(minX, floorY, maxX, floorY);
await release();
await run(1);
await run(20 * 40);
await page.keyboard.press('KeyB');
await page.click('.build-btn[data-build="wall"]');
release = await dragTiles(minX, floorY, maxX, floorY);
await release();
await run(1);
await page.screenshot({ path: `${shots}/06b-walls-over-colonists.png` });
const t0 = (await state()).tick;
await page.evaluate(() => { const w = window.__colony.world; for (let i = 0; i < 20 * 120 && [...w.orders.all()].some((o) => o.kind === 'build'); i++) w.step(); });
const wallsLeft = await page.evaluate(() => [...window.__colony.world.orders.all()].filter((o) => o.kind === 'build').length);
check(wallsLeft === 0, `walls built over colonists finish (left ${wallsLeft}, ${(await state()).tick - t0} ticks)`);
const entombed = await page.evaluate(() => window.__colony.world.colonists.filter((c) => c.alive && (window.__colony.world.grid.solid(c.x, c.y) || window.__colony.world.grid.solid(c.x, c.y - 1))).length);
check(entombed === 0, 'no colonist ends up inside a wall');

// --- Build directly on dirt: stairs dragged down into natural ground (dug out first, then built)
await page.click('.build-btn[data-build="ladder"]');
release = await dragTiles(spawn.x + 6, spawn.y + 1, spawn.x + 6, spawn.y + 4);
await release();
await run(1);
const onDirt = await page.evaluate(() => [...window.__colony.world.orders.all()].filter((o) => o.kind === 'build' && o.digWork > 0).length);
check(onDirt === 4, `stairs accepted on 4 natural tiles (${onDirt})`);
await page.screenshot({ path: `${shots}/06c-build-on-tiles.png` });
await run(20 * 60);
const stairsDug = await page.evaluate(([x, y]) => { const g = window.__colony.world.grid; let n = 0; for (let yy = y + 1; yy <= y + 4; yy++) n += g.stairs[g.idx(x + 6, yy)]; return n; }, [spawn.x, spawn.y]);
check(stairsDug === 4, `stairs shaft dug and built (${stairsDug}/4)`);
await page.keyboard.press('Escape');

// --- Esc returns to select; click a colonist opens the panel
await page.keyboard.press('Escape');
const c0 = await page.evaluate(() => { const c = window.__colony.world.colonists[0]; return { x: c.x, y: c.y }; });
const cp = await tileToScreen(c0.x, c0.y - 0.6);
await page.mouse.click(cp.x, cp.y);
await page.waitForTimeout(100);
const panelVisible = await page.isVisible('.hud-colonist');
check(panelVisible, 'clicking a colonist opens the colonist panel');

// --- real-time run for a moment so the wobble/interp path renders
await page.click('.hud-speed .btn[data-speed="3"]');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${shots}/07-overview.png` });

// --- zoomed out view + phone width
await page.mouse.move(640, 380);
await page.mouse.wheel(0, 900);
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/08-zoomed-out.png` });
await page.setViewportSize({ width: 400, height: 780 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/09-phone.png` });

check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
