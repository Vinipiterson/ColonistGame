// Milestone 4b: rooms (built walls only, types, decor, bonuses) and happiness (moodlets, mood
// effects, stress breaks, stomach bugs), plus cooked meals vs rations.
import { describe, expect, it } from 'vitest';
import {
  BARRACKS_SLEEP_BONUS, BED_SLEEP_RATE, BREAK_MOOD, CROPS, DAY_SECONDS, FARM_GROWTH_BONUS, HAPPY_SPEED, MOODLETS,
  SICK_SPEED, TICK_HZ, Tile,
} from '../src/sim/defs';
import type { World } from '../src/sim/world';
import { cell, runUntil, worldFromAscii } from './helpers';

const SEC = TICK_HZ;

/**
 * Two areas on a dirt floor: a walled room (x 2..9, rows 2..4: 24 cells, built walls 'W' all
 * round, a door gap at x=10 in rows 3..4) and open dirt cave space to the right.
 */
function base(): World {
  return worldFromAscii([
    'BBBBBBBBBBBBBBBBBBBBBB',
    'BWWWWWWWWWW#########BB',
    'BW........W.........BB',
    'BW..@.................',
    'BW....................',
    'BWWWWWWWWWWW#########B',
    'BBBBBBBBBBBBBBBBBBBBBB',
  ]);
}

/** Close the room with a door at x=10 (rows 3..4) and let rooms update. */
function closeRoom(w: World): void {
  w.buildings.add('door', 10, 3, false);
  w.step();
  w.run(SEC);
}

describe('rooms', () => {
  it('needs built walls (and doors) all round; open to the cave it is not a room', () => {
    const w = base();
    w.run(SEC);
    expect(w.rooms.at(cell(w, 3, 3))).toBeUndefined();
    closeRoom(w);
    const room = w.rooms.at(cell(w, 3, 3))!;
    expect(room).toBeDefined();
    expect(room.cells.length).toBe(24);
    expect(room.type).toBe('room');
    expect(w.rooms.at(cell(w, 12, 3))).toBeUndefined(); // the cave
  });

  it('natural tiles leak: a wall dug out of the room breaks it', () => {
    const w = base();
    closeRoom(w);
    expect(w.rooms.at(cell(w, 3, 3))).toBeDefined();
    w.grid.setTile(1, 3, Tile.Dirt, false); // a natural tile in the wall
    w.run(SEC);
    expect(w.rooms.at(cell(w, 3, 3))).toBeUndefined();
  });

  it('gets its type from what is inside, and is Nice with enough decor', () => {
    const w = base();
    closeRoom(w);
    const room = () => w.rooms.at(cell(w, 3, 3))!;
    w.buildings.add('bed', 2, 4, false);
    w.run(SEC);
    expect(room().type).toBe('barracks');
    expect(room().nice).toBe(false);
    w.buildings.add('plant', 5, 4, false);
    w.buildings.add('painting', 6, 2, false);
    w.run(SEC);
    expect(room().decor).toBe(35);
    expect(room().nice).toBe(true); // 35 >= 24 * 0.5
    w.buildings.add('research', 7, 3, false);
    w.run(SEC);
    expect(room().type).toBe('lab');
  });

  it('a Barracks bed restores sleep 25% faster and gives a moodlet', () => {
    const w = base();
    closeRoom(w);
    w.buildings.add('bed', 2, 4, false);
    w.run(SEC);
    const c = w.colonists[0];
    c.needs.sleep = 20;
    c.needs.hunger = c.needs.bladder = c.needs.hygiene = 100;
    runUntil(w, () => c.state === 'using', 400);
    const s0 = c.needs.sleep;
    w.run(10 * SEC);
    expect(c.needs.sleep - s0).toBeCloseTo(BED_SLEEP_RATE * BARRACKS_SLEEP_BONUS * 10, 1);
    runUntil(w, () => c.state !== 'using', 8000);
    expect(c.moodlets.get('barracks')?.value).toBe(MOODLETS.barracks.value);
  });

  it('planters in a Farm grow 20% faster', () => {
    const w = base();
    closeRoom(w);
    const a = w.buildings.add('planter', 3, 3, false);
    w.buildings.add('planter', 4, 3, false);
    w.unlockAll();
    w.run(SEC);
    expect(w.rooms.ofBuilding(a)!.type).toBe('farm');
    a.planted = true;
    w.colonists[0].retryAt = Infinity; // nobody sows the other one / harvests
    const g0 = a.growth;
    w.run(100 * SEC);
    expect(a.growth - g0).toBeCloseTo((100 * FARM_GROWTH_BONUS) / CROPS.mushroom.growSeconds, 4);
  });
});

describe('happiness', () => {
  it('cooked meals are eaten first and make colonists happier than rations or raw crops', () => {
    const eat = (setup: (w: World) => void): Map<string, number> => {
      const w = base();
      setup(w);
      const c = w.colonists[0];
      c.needs.hunger = 30;
      runUntil(w, () => c.state === 'using', 60);
      runUntil(w, () => c.state !== 'using', 600);
      return new Map([...c.moodlets].map(([k, m]) => [k, m.value]));
    };
    const cooked = eat((w) => { w.resources.meal = 1; w.resources.food = 1; });
    expect(cooked.get('cooked')).toBe(MOODLETS.cooked.value);
    expect(cooked.get('standing')).toBe(MOODLETS.standing.value);
    const ration = eat((w) => { w.resources.meal = 0; w.resources.food = 1; });
    expect(ration.has('cooked')).toBe(false);
    const raw = eat((w) => { w.resources.food = 0; w.resources.tuber = 2; });
    expect(raw.get('raw')).toBe(MOODLETS.raw.value);
  });

  it('a floor nap gives a sore back (and slower work)', () => {
    const w = base();
    const c = w.colonists[0];
    c.needs.sleep = 20;
    c.needs.hunger = c.needs.bladder = c.needs.hygiene = 100;
    runUntil(w, () => c.state === 'using', 60);
    runUntil(w, () => c.state !== 'using', 8000);
    expect(c.moodlets.has('soreback')).toBe(true);
  });

  it('mood is 50 plus moodlets; happy colonists work faster, sick ones slower', () => {
    const rate = (setup: (w: World) => void) => {
      const w = base();
      const c = w.colonists[0];
      setup(w);
      w.run(SEC); // mood update
      w.issue({ type: 'dig', rect: { x0: 12, y0: 5, x1: 15, y1: 5 }, priority: 6 });
      runUntil(w, () => c.state === 'working', 200);
      const o = c.job!, p0 = o.progress;
      w.run(SEC);
      return { mood: c.mood, speed: o.progress - p0 };
    };
    const plain = rate(() => {});
    expect(plain.mood).toBe(50);
    expect(plain.speed).toBeCloseTo(1, 5);
    const happy = rate((w) => {
      for (const id of ['cooked', 'barracks', 'messhall', 'vented'] as const) w.addMoodlet(w.colonists[0], id);
    });
    expect(happy.mood).toBe(50 + 6 + 5 + 4 + 15);
    expect(happy.speed).toBeCloseTo(HAPPY_SPEED, 5);
    const sick = rate((w) => { w.colonists[0].sick = DAY_SECONDS; });
    expect(sick.speed).toBeCloseTo(SICK_SPEED, 5); // mood 40: no mood effect
  });

  it('very low mood leads to a stress break: no work for a game hour', () => {
    const w = base();
    const c = w.colonists[0];
    w.issue({ type: 'dig', rect: { x0: 12, y0: 5, x1: 15, y1: 5 }, priority: 6 });
    runUntil(w, () => c.state === 'working', 200);
    c.needs.hygiene = 5; // smelly (a condition moodlet: stays while dirty)
    for (const id of ['death', 'raw', 'soreback', 'cleaned', 'standing'] as const) w.addMoodlet(c, id);
    runUntil(w, () => c.onBreak, 2 * SEC);
    expect(c.mood).toBeLessThan(BREAK_MOOD);
    expect(c.onBreak).toBe(true);
    expect(c.job).toBe(null);
    expect(c.activity()).toBe('Stress break');
    w.run(10 * SEC);
    expect(c.job).toBe(null);
    runUntil(w, () => !c.onBreak, (DAY_SECONDS / 24 + 2) * SEC);
    expect(c.moodlets.has('vented')).toBe(true);
    runUntil(w, () => !!c.job, 5 * SEC);
    expect(c.job).not.toBe(null);
  });

  it('dirty colonists eventually catch a stomach bug, which wears off', () => {
    const w = base();
    const c = w.colonists[0];
    let caught = -1;
    for (let i = 0; i < 12 * DAY_SECONDS * SEC && caught < 0; i++) { // ~30% a day
      if (i % 100 === 0) { c.needs.hunger = c.needs.sleep = c.needs.bladder = 100; c.needs.hygiene = 5; }
      w.step();
      if (c.sick > 0) caught = i;
    }
    expect(caught).toBeGreaterThan(0);
    expect(c.moodlets.has('sick') || c.sick > 0).toBe(true);
    for (let i = 0; i < 1.6 * DAY_SECONDS * SEC; i++) {
      if (i % 100 === 0) c.needs.hunger = c.needs.sleep = c.needs.bladder = c.needs.hygiene = 100;
      w.step();
    }
    expect(c.alive).toBe(true);
    expect(c.sick).toBe(0);
    expect(c.moodlets.has('sick')).toBe(false);
  });

  it('cleaning an outhouse and a death are unhappy moments', () => {
    const w = base();
    const out = w.buildings.add('toilet', 12, 3, false);
    out.dirty = true;
    const c = w.colonists[0];
    runUntil(w, () => !out.dirty, 60 * SEC);
    expect(c.moodlets.get('cleaned')?.value).toBe(MOODLETS.cleaned.value);
    const other = w.spawnColonist(15, 4);
    other.needs.hunger = 0;
    other.health = 1;
    w.resources.food = 0;
    runUntil(w, () => !other.alive, 60 * SEC);
    expect(c.moodlets.get('death')?.value).toBe(MOODLETS.death.value);
  });
});
