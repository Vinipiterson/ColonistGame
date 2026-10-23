// Milestone 3: planters and crops, cooking, raw food, the power pool (manual / coal generators,
// batteries, reactor, brownouts) and lamp light.
import { describe, expect, it } from 'vitest';
import { BUILDS, CROPS, DAY_SECONDS, LIGHT_WORK_BONUS, NEED_DEFS, RAW_HUNGER, TICK_HZ, Tile } from '../src/sim/defs';
import { canPlaceBuilding } from '../src/sim/buildings';
import type { World } from '../src/sim/world';
import { cell, runUntil, worldFromAscii } from './helpers';

const R = (x0: number, y0: number, x1 = x0, y1 = y0) => ({ x0, y0, x1, y1 });
const SEC = TICK_HZ;

/**
 * Room 20 wide, 4 tall (rows 1..4, floor at y=5), optionally with a colonist at (2,4).
 * Everything is researched (research itself is tested in research.test.ts).
 */
function room(colonist = true): World {
  const w = worldFromAscii([
    'BBBBBBBBBBBBBBBBBBBBBB',
    'B....................B',
    'B....................B',
    'B....................B',
    colonist ? 'B.@..................B' : 'B....................B',
    'BBBBBBBBBBBBBBBBBBBBBB',
  ]);
  w.unlockAll();
  return w;
}

/** Step n ticks keeping every colonist's needs topped up (long farm tests have no toilets). */
function runFed(w: World, n: number, until?: () => boolean): number {
  for (let i = 0; i < n; i++) {
    if (until && until()) return i;
    if (i % 100 === 0) for (const c of w.colonists) for (const k of Object.keys(c.needs) as (keyof typeof c.needs)[]) c.needs[k] = 100;
    w.step();
  }
  return until && until() ? n : -1;
}

describe('planters and crops', () => {
  it('sows (paying the seed cost), grows, harvests and re-sows on its own', () => {
    const w = room();
    w.resources.matter = 100;
    const p = w.buildings.add('planter', 6, 3, false);
    expect(p.crop).toBe('mushroom');
    w.issue({ type: 'configure', buildingId: p.id, crop: 'tuber' });
    runFed(w, 30 * SEC, () => p.planted);
    expect(p.planted).toBe(true);
    expect(w.resources.matter).toBe(80);
    // ripe after 2 days, then harvested: 2 tubers, and a new seed goes in
    const t = runFed(w, (2 * DAY_SECONDS + 60) * SEC, () => w.resources.tuber > 0);
    expect(t).toBeGreaterThan((2 * DAY_SECONDS - 5) * SEC);
    expect(w.resources.tuber).toBe(CROPS.tuber.yield);
    runFed(w, 30 * SEC, () => p.planted);
    expect(p.planted).toBe(true);
    expect(w.resources.matter).toBe(60);
  });

  it('sunberries only grow while their grow lamp has power; mushrooms need nothing', () => {
    const w = room(false);
    const berry = w.buildings.add('planter', 3, 3, false);
    const mush = w.buildings.add('planter', 4, 3, false);
    w.issue({ type: 'configure', buildingId: berry.id, crop: 'sunberry' });
    w.step();
    expect(berry.lamp).toBe(true); // sunberries switch the grow lamp on
    berry.planted = mush.planted = true;
    w.run(60 * SEC);
    expect(berry.growth).toBe(0);
    expect(berry.powered).toBe(false);
    expect(mush.growth).toBeCloseTo(60 / CROPS.mushroom.growSeconds, 3);
    // a coal generator powers the lamp
    w.resources.coal = 100;
    w.buildings.add('coalgen', 8, 3, false);
    w.run(60 * SEC);
    expect(berry.powered).toBe(true);
    expect(berry.growth).toBeGreaterThan(55 / CROPS.sunberry.growSeconds);
    expect(w.resources.coal).toBeLessThan(100);
  });

  it('choosing another crop uproots the plant; switching a planter off stops its jobs', () => {
    const w = room();
    const p = w.buildings.add('planter', 6, 3, false);
    p.planted = true;
    p.growth = 0.5;
    w.issue({ type: 'configure', buildingId: p.id, crop: 'tuber' });
    w.step();
    expect(p.planted).toBe(false);
    expect(p.growth).toBe(0);
    w.issue({ type: 'configure', buildingId: p.id, on: false });
    runFed(w, 30 * SEC);
    expect(p.planted).toBe(false);
    expect([...w.orders.all()].some((o) => o.buildingId === p.id)).toBe(false);
    w.issue({ type: 'configure', buildingId: p.id, on: true });
    runFed(w, 30 * SEC, () => p.planted);
    expect(p.planted).toBe(true);
  });
});

describe('food', () => {
  it('the Cooking Station turns crops into meals before the printer prints any', () => {
    const w = room();
    w.resources.food = 0;
    w.resources.tuber = 4;
    w.resources.matter = 1000;
    w.resources.coal = 500;
    w.buildings.add('stove', 4, 3, false);
    w.buildings.add('printer', 8, 3, false);
    w.buildings.add('coalgen', 12, 3, false);
    runFed(w, 120 * SEC, () => w.resources.food >= 4);
    expect(w.resources.food).toBe(4); // target max(4, 2 x colonists)
    expect(w.resources.tuber).toBe(0); // 2 meals from 4 tubers
    expect(w.resources.matter).toBe(1000 - 2 * 100); // the printer made the other 2
  });

  it('with no meals, colonists eat a raw portion: less filling, slower', () => {
    const w = room();
    const c = w.colonists[0];
    w.resources.food = 0;
    w.resources.tuber = 3;
    c.needs.hunger = 30;
    runUntil(w, () => c.state === 'using', 60);
    expect(c.needTask).toMatchObject({ kind: 'eat', raw: 'tuber' });
    expect(w.resources.tuber).toBe(3 - CROPS.tuber.perMeal);
    runUntil(w, () => c.state !== 'using', 400);
    expect(c.needs.hunger).toBeGreaterThan(30 + RAW_HUNGER - 2);
    expect(c.needs.hunger).toBeLessThan(95);
    // one tuber left is less than a portion: nothing to eat
    c.needs.hunger = 10;
    w.run(35 * SEC); // the warning repeats every 30 s
    expect(c.state).not.toBe('using');
    expect(w.events.some((e) => e.type === 'needFail' && e.text.includes('no food'))).toBe(true);
  });
});

describe('power', () => {
  it('a manual generator gets cranked when power is short; cranking is tiring', () => {
    const w = room();
    w.resources.food = 0;
    w.resources.matter = 1000;
    const crank = w.buildings.add('crank', 8, 3, false);
    w.buildings.add('battery', 12, 3, false);
    w.buildings.add('printer', 14, 3, false);
    const c = w.colonists[0];
    c.needs.hunger = c.needs.sleep = 100;
    runUntil(w, () => c.state === 'working' && c.job?.task === 'crank', 30 * SEC);
    expect(c.job?.buildingId).toBe(crank.id);
    const h0 = c.needs.hunger, s0 = c.needs.sleep;
    w.run(10 * SEC);
    expect(h0 - c.needs.hunger).toBeCloseTo(2 * NEED_DEFS.hunger.decay * 10, 2);
    expect(s0 - c.needs.sleep).toBeCloseTo(2 * NEED_DEFS.sleep.decay * 10, 2);
    expect(w.power.gen).toBeCloseTo(BUILDS.crank.powerGen!, 0);
    // the charge it builds up runs the printer afterwards
    runFed(w, 200 * SEC, () => w.resources.food >= 4);
    expect(w.resources.food).toBe(4);
  });

  it('fuel generators charge batteries, stop when full, restart below 90%', () => {
    const w = room(false);
    w.resources.coal = 1000;
    const gen = w.buildings.add('coalgen', 3, 3, false);
    const bat = w.buildings.add('battery', 6, 3, false);
    w.buildings.add('lamp', 8, 1, false);
    const cap = BUILDS.battery.capacity!;
    w.run(2 * SEC);
    expect(gen.powered).toBe(true);
    const full = runUntil(w, () => !gen.powered, 60 * SEC);
    expect(full).toBeGreaterThan(0);
    expect(bat.charge).toBeGreaterThan(cap * 0.97);
    const coal = w.resources.coal;
    w.run(30 * SEC);
    expect(w.resources.coal).toBe(coal); // idle: no fuel burnt
    runUntil(w, () => gen.powered, 400 * SEC);
    expect(gen.powered).toBe(true);
    // (the charge already includes the generator's first second)
    expect(bat.charge).toBeLessThan(cap * 0.9 + BUILDS.coalgen.powerGen!);
    expect(bat.charge).toBeGreaterThan(cap * 0.85);
  });

  it('the reactor burns radioactive matter for a lot of power', () => {
    const w = room(false);
    w.resources.radioactive = 10;
    const r = w.buildings.add('reactor', 3, 2, false);
    w.buildings.add('battery', 7, 3, false);
    w.run(5 * SEC);
    expect(r.powered).toBe(true);
    expect(w.power.gen).toBe(3000);
    expect(w.resources.radioactive).toBeCloseTo(10 - 0.01 * 5, 5);
  });

  it('brownout: consumers get power in building order until it runs out', () => {
    const w = room(false);
    w.resources.coal = 1000;
    w.buildings.add('coalgen', 18, 3, false); // 800 W, no battery
    const planters = [];
    for (let i = 0; i < 14; i++) {
      const p = w.buildings.add('planter', 2 + i, 3, false);
      p.crop = 'sunberry';
      p.lamp = true;
      p.planted = true;
      planters.push(p);
    }
    w.run(2 * SEC);
    // 14 x 60 W = 840 W > 800 W: the last one goes dark
    expect(planters.filter((p) => p.powered).length).toBe(13);
    expect(planters[13].powered).toBe(false);
    expect(w.power.unmet).toBe(60);
    w.issue({ type: 'configure', buildingId: planters[0].id, on: false });
    w.run(2 * SEC);
    expect(planters.slice(1).every((p) => p.powered)).toBe(true);
    expect(w.power.unmet).toBe(0);
  });
});

describe('lamps and light', () => {
  /** Dirt column at x=6 splits the room; dirt floor so there is something to dig. */
  function litRoom(): World {
    return worldFromAscii([
      'BBBBBBBBBBBBBB',
      'B.....#......B',
      'B.....#......B',
      'B.....#......B',
      'B..@..#......B',
      'B############B',
      'BBBBBBBBBBBBBB',
    ]);
  }

  it('a lamp hangs under a solid tile and lights what it can see', () => {
    const w = litRoom();
    const g = w.grid;
    expect(canPlaceBuilding(g, 'lamp', 3, 1)).toBe(true);
    expect(canPlaceBuilding(g, 'lamp', 3, 2)).toBe(false); // nothing to hang from
    const lamp = w.buildings.add('lamp', 3, 1, false);
    w.run(2 * SEC);
    expect(lamp.powered).toBe(false); // no power yet
    expect(w.light.level[cell(w, 3, 4)]).toBe(0);
    const bat = w.buildings.add('battery', 9, 3, false);
    bat.charge = 20_000;
    w.run(2 * SEC);
    expect(lamp.powered).toBe(true);
    expect(w.light.level[cell(w, 3, 4)]).toBeGreaterThan(0);
    expect(w.light.level[cell(w, 1, 2)]).toBeGreaterThan(0);
    expect(w.light.level[cell(w, 6, 2)]).toBeGreaterThan(0); // the wall face itself
    expect(w.light.level[cell(w, 7, 2)]).toBe(0); // behind the dirt column
    // dig the column away: light reaches through
    for (let y = 1; y <= 4; y++) g.setTile(6, y, Tile.Empty, false);
    w.step();
    expect(w.light.level[cell(w, 7, 2)]).toBeGreaterThan(0);
    // switched off: dark again
    w.issue({ type: 'configure', buildingId: lamp.id, on: false });
    w.step();
    expect(w.light.litCount).toBe(0);
  });

  it('work in the light is faster', () => {
    const progressPerSecond = (lit: boolean): number => {
      const w = litRoom();
      if (lit) {
        w.buildings.add('lamp', 3, 1, false);
        w.buildings.add('battery', 9, 3, false).charge = 20_000;
        w.run(2 * SEC);
      }
      w.issue({ type: 'dig', rect: R(4, 5), priority: 6 });
      const c = w.colonists[0];
      runUntil(w, () => c.state === 'working', 200);
      const o = c.job!;
      const p0 = o.progress;
      w.run(SEC);
      return o.progress - p0;
    };
    expect(progressPerSecond(false)).toBeCloseTo(1, 5);
    expect(progressPerSecond(true)).toBeCloseTo(LIGHT_WORK_BONUS, 5);
  });
});
