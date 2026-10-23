// Milestone 3 end-to-end: build a powered farm through the real UI (food + power build groups,
// building inspector to pick a crop and switch a lamp off), fast-forward, and check that crops
// grow and get harvested, the Cooking Station turns them into meals and the lamp lights the room.
// Usage: npm run build && node e2e/farm.mjs   (screenshots in e2e/shots/)

import { launchBrowser } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shots = resolve('e2e/shots');
mkdirSync(shots, { recursive: true });
const url = pathToFileURL(resolve('dist/index.html')).href + '?seed=20261024';

const browser = await launchBrowser();
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
const pick = async (kind) => {
  const cat = await page.getAttribute(`.build-btn[data-build="${kind}"]`, 'data-cat');
  await page.click(`.btab[data-cat="${cat}"]`);
  await page.click(`.build-btn[data-build="${kind}"]`);
};
/** Fast-forward n ticks; long runs keep needs topped up (this colony has no toilets or beds). */
const runFed = (n) => page.evaluate((n) => {
  const w = window.__colony.world;
  for (let i = 0; i < n; i++) {
    if (i % 200 === 0) for (const c of w.colonists) for (const k of Object.keys(c.needs)) c.needs[k] = 100;
    w.step();
  }
}, n);
const state = () => page.evaluate(() => {
  const w = window.__colony.world;
  const k = {};
  for (const b of w.buildings.all()) k[b.kind] = (k[b.kind] ?? 0) + 1;
  return {
    k, res: { ...w.resources }, power: { ...w.power }, lit: w.light.litCount, alive: w.aliveCount,
    planters: [...w.buildings.ofKind('planter')].map((b) => ({ id: b.id, x: b.x, crop: b.crop, planted: b.planted, growth: b.growth })),
    builds: [...w.orders.all()].filter((o) => o.kind === 'build').length,
  };
});

await page.evaluate(() => {
  const { world, renderer } = window.__colony;
  world.resources.matter = 5000;
  world.resources.coal = 600;
  world.resources.food = 0;
  renderer.cam.zoom = 34;
});
await page.waitForTimeout(200);
const s = await page.evaluate(() => window.__colony.world.spawn);

// Build through the build bar: three planters, generators, battery, stove, printer, two lamps
await page.keyboard.press('KeyB');
const groups = await page.$$eval('.btab', (els) => els.map((e) => e.textContent));
check(groups.includes('Food') && groups.includes('Power & light'), `build bar has Food and Power tabs (${groups.join(', ')})`);
await pick('planter');
await drag(s.x - 8, s.y, s.x - 6, s.y); // three side by side
await pick('crank');
await click(s.x - 4, s.y);
await pick('battery');
await click(s.x - 2, s.y);
await pick('stove');
await click(s.x + 2, s.y);
await pick('coalgen');
await click(s.x + 5, s.y);
await pick('printer');
await click(s.x + 7, s.y);
await pick('lamp');
await page.mouse.move(...Object.values(await tileToScreen(s.x, s.y - 2)));
await page.waitForTimeout(80);
const badGhost = await page.evaluate(() => window.__colony.renderer.preview?.ghosts?.[0]?.ok);
check(badGhost === false, 'a lamp cannot hang in mid-air');
await click(s.x, s.y - 3);
await click(s.x - 7, s.y - 3);
await page.waitForTimeout(100);
await page.screenshot({ path: `${shots}/m3-01-blueprints.png` });
await page.keyboard.press('Escape');

await page.evaluate(() => {
  const w = window.__colony.world;
  for (let i = 0; i < 20 * 900 && [...w.orders.all()].some((o) => o.kind === 'build'); i++) {
    if (i % 200 === 0) for (const c of w.colonists) for (const k of Object.keys(c.needs)) c.needs[k] = 100;
    w.step();
  }
});
let st = await state();
check(st.builds === 0, `everything built (${st.builds} build orders left)`);
check(st.k.planter === 3 && st.k.lamp === 2 && st.k.stove === 1 && st.k.coalgen === 1 && st.k.battery === 1, `buildings exist ${JSON.stringify(st.k)}`);

// Inspector: click the left planter, choose Sunberry
await click(s.x - 8, s.y);
await page.waitForTimeout(150);
check(await page.isVisible('.hud-building'), 'clicking a planter opens the building inspector');
await page.click('.bp-crop[data-crop="sunberry"]');
await runFed(2);
st = await state();
const crops = st.planters.map((p) => (p.x === s.x - 8 ? 'clicked:' : '') + p.crop);
check(crops.includes('clicked:sunberry') && crops.filter((c) => c === 'tuber').length === 2, `crop chosen in the inspector (${crops})`);
await page.screenshot({ path: `${shots}/m3-02-inspector.png` });

// Power: lamps lit, meals printed with power
await runFed(20 * 60);
st = await state();
check(st.lit > 20, `powered lamps light the room (${st.lit} lit cells)`);
check(await page.isVisible('.chip-power'), `power readout shows (${await page.textContent('.chip-power')})`);
check(st.planters.every((p) => p.planted), 'all planters sown');
check(st.res.food >= 3, `printer made meals with generator power (${st.res.food})`);
await page.screenshot({ path: `${shots}/m3-03-farm-lit.png` });

// One day: sunberries ripen and get harvested; two days: tubers too
await runFed(20 * 600 * 1.05);
st = await state();
check(st.res.sunberry >= 2, `sunberries harvested after a day (${st.res.sunberry})`);
await runFed(20 * 600 * 1.05);
st = await state();
check(st.res.tuber >= 4, `tubers harvested after two days (${st.res.tuber})`);
check(st.res.coal < 600, `the coal generator burnt fuel (${st.res.coal.toFixed(1)} coal left)`);

// Meals run out: the Cooking Station turns crops into meals
const crops0 = st.res.tuber + st.res.sunberry;
await page.evaluate(() => { window.__colony.world.resources.food = 0; });
await runFed(20 * 60);
st = await state();
check(st.res.food >= 1 && st.res.tuber + st.res.sunberry < crops0, `crops cooked into meals (meals ${st.res.food}, crops ${crops0} -> ${st.res.tuber + st.res.sunberry})`);
await page.screenshot({ path: `${shots}/m3-04-harvest.png` });

// Inspector: switch a lamp off
await click(s.x, s.y - 3);
await page.waitForTimeout(150);
const lit0 = (await state()).lit;
await page.click('.bp-toggle');
await runFed(2);
const lit1 = (await state()).lit;
check(lit1 < lit0, `switching a lamp off in the inspector darkens it (${lit0} -> ${lit1} lit cells)`);
await page.waitForTimeout(150);
await page.screenshot({ path: `${shots}/m3-05-lamp-off.png` });

await page.keyboard.press('KeyB');
await page.setViewportSize({ width: 400, height: 800 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/m3-06-phone-build.png` });

check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall farm checks passed');
process.exit(failures ? 1 : 0);
