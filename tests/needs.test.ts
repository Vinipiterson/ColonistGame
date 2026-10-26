// Milestone 2: stair blocks, multi-tile buildings, doors, needs, ration printer, deaths.
import { describe, expect, it } from 'vitest';
import { BLADDER_HOLD_LIMIT, DAY_SECONDS, STAIR_STEP_COST, TICK_HZ, Tile } from '../src/sim/defs';
import { canPlaceBuilding } from '../src/sim/buildings';
import { World } from '../src/sim/world';
import { cell, runUntil, worldFromAscii } from './helpers';

const R = (x0: number, y0: number, x1 = x0, y1 = y0) => ({ x0, y0, x1, y1 });
const SEC = TICK_HZ;

/** Wide room with a floor; colonist(s) at '@'. */
function room(extraRows: string[] = []): World {
  return worldFromAscii([
    'BBBBBBBBBBBBBBBBBB',
    'B................B',
    'B................B',
    'B................B',
    'B.@..............B',
    ...extraRows,
    'BBBBBBBBBBBBBBBBBB',
  ]);
}

describe('stair blocks (rotatable)', () => {
  it('builds a stair block with the chosen facing; walking up it is cheaper than a bare ledge', () => {
    const w = worldFromAscii([
      'BBBBBBBBBB',
      'B........B',
      'B........B',
      'B........B',
      'B@.......B',
      'BBBBBBBBBB',
    ]);
    w.resources.matter = 500;
    w.issue({ type: 'build', rect: R(4, 4), kind: 'stairs', priority: 6, flip: false });
    w.issue({ type: 'build', rect: R(5, 4), kind: 'stairs', priority: 6, flip: true });
    w.step();
    runUntil(w, () => w.orders.count === 0, 2000);
    const g = w.grid;
    expect(g.tile[cell(w, 4, 4)]).toBe(Tile.Stairs);
    expect(g.tileDir[cell(w, 4, 4)]).toBe(1); // rises to the right
    expect(g.tileDir[cell(w, 5, 4)]).toBe(0); // flipped: rises to the left
    // from the left floor up onto (4,3): along a stair rising right -> cheap step
    const p = w.paths.findNow(cell(w, 3, 4), [cell(w, 4, 3)])!;
    expect(p.costs[p.costs.length - 1]).toBeCloseTo(STAIR_STEP_COST);
    // from the right floor up onto (5,3): stair (5,4) rises left, we move left -> cheap too
    const p2 = w.paths.findNow(cell(w, 6, 4), [cell(w, 5, 3)])!;
    expect(p2.costs[p2.costs.length - 1]).toBeCloseTo(STAIR_STEP_COST);
    // deconstructing a stair block refunds half its cost
    const before = w.resources.matter;
    w.issue({ type: 'deconstruct', rect: R(4, 4), priority: 6 });
    w.step();
    runUntil(w, () => w.orders.count === 0, 2000);
    expect(w.resources.matter).toBe(before + 20);
  });
});

describe('multi-tile buildings', () => {
  it('placement needs an empty footprint and solid floor under the whole bottom row', () => {
    const w = worldFromAscii([
      'BBBBBBBB',
      'B......B',
      'B......B',
      'B......B',
      'BBB.BBBB',
    ]);
    const g = w.grid;
    expect(canPlaceBuilding(g, 'bed', 1, 3)).toBe(true);
    expect(canPlaceBuilding(g, 'bed', 2, 3)).toBe(false); // (3,4) under it is a hole
    expect(canPlaceBuilding(g, 'bed', 1, 2)).toBe(false); // floating
    expect(canPlaceBuilding(g, 'printer', 4, 2)).toBe(true); // 2x2
    expect(canPlaceBuilding(g, 'printer', 6, 2)).toBe(false); // out of the room (bedrock)
  });

  it('dragging tiles copies without overlap; built beds become buildings; deconstruct refunds half', () => {
    const w = room();
    w.resources.matter = 1000;
    w.issue({ type: 'build', rect: R(4, 4, 9, 4), kind: 'bed', priority: 6 });
    w.step();
    expect(w.orders.count).toBe(3);
    runUntil(w, () => w.orders.count === 0, 3000);
    expect(w.buildings.ofKind('bed').size).toBe(3);
    expect(w.resources.matter).toBe(1000 - 3 * 80);
    w.issue({ type: 'deconstruct', rect: R(4, 4), priority: 6 });
    w.step();
    runUntil(w, () => w.orders.count === 0, 2000);
    expect(w.buildings.ofKind('bed').size).toBe(2);
    expect(w.resources.matter).toBe(1000 - 3 * 80 + 40);
  });

  it('colonists walk through doors and furniture', () => {
    const w = room();
    w.resources.matter = 1000;
    // a wall with a door gap at x=8: wall cells (8,1..2), door (8,3..4)
    w.issue({ type: 'build', rect: R(8, 1, 8, 2), kind: 'wall', priority: 6 });
    w.issue({ type: 'build', rect: R(8, 4), kind: 'door', priority: 6 });
    w.step();
    runUntil(w, () => w.orders.count === 0, 3000);
    expect(w.buildings.ofKind('door').size).toBe(1);
    const p = w.paths.findNow(w.colonists[0].cell, [cell(w, 14, 4)]);
    expect(p).not.toBeNull();
  });
});

describe('needs', () => {
  function setup(): World {
    const w = room();
    w.resources.matter = 2000;
    w.buildings.add('toilet', 10, 3, false);
    w.buildings.add('sink', 12, 4, false);
    return w;
  }

  it('uses the toilet, then washes hands', () => {
    const w = setup();
    const c = w.colonists[0];
    c.needs.bladder = 10;
    const hyg = c.needs.hygiene;
    runUntil(w, () => c.needTask?.kind === 'toilet' && c.state === 'using', 400);
    runUntil(w, () => c.needTask?.kind === 'sink', 400);
    runUntil(w, () => c.needTask === null && c.state !== 'using', 400);
    expect(c.needs.bladder).toBeGreaterThan(95);
    expect(c.needs.hygiene).toBeGreaterThan(hyg); // sink bonus beats the decay
  });

  it('an urgent need interrupts work, and the colonist comes back to the same job', () => {
    const w = setup();
    const c = w.colonists[0];
    w.grid.setTile(1, 3, Tile.Radioactive, false);
    w.grid.setTile(1, 2, Tile.Radioactive, false);
    w.grid.setTile(1, 1, Tile.Radioactive, false);
    w.issue({ type: 'dig', rect: R(1, 1, 1, 3), priority: 5 });
    runUntil(w, () => c.state === 'working', 400);
    const job = c.job!;
    c.needs.bladder = 10; // below urgent
    runUntil(w, () => c.goal === 'need', 40);
    expect(job.claimedBy).toBe(-1);
    runUntil(w, () => c.job === job || job.removed, 1200);
    expect(c.job === job || job.removed).toBe(true);
  });

  it('with no toilet, holding it too long is fatal', () => {
    const w = room();
    const c = w.colonists[0];
    c.needs.bladder = 0;
    c.needs.hunger = c.needs.sleep = c.needs.hygiene = 100;
    const t = runUntil(w, () => !c.alive, (BLADDER_HOLD_LIMIT + 5) * SEC);
    expect(t).toBeGreaterThan((BLADDER_HOLD_LIMIT - 1) * SEC);
    expect(c.deathCause).toBe('held their bladder too long');
    expect(w.gameOver).toBe(true);
  });

  it('with no meals, a colonist starves', () => {
    const w = room();
    const c = w.colonists[0];
    w.resources.food = 0;
    c.needs.hunger = 0;
    c.needs.bladder = 100;
    runUntil(w, () => !c.alive, 0.6 * DAY_SECONDS * SEC);
    expect(c.deathCause).toBe('starved');
  });

  it('eats a meal standing up when there is no table, faster at a table', () => {
    const w = room();
    const c = w.colonists[0];
    w.resources.food = 2;
    c.needs.hunger = 30;
    runUntil(w, () => c.state === 'using', 60);
    expect(c.needTask?.buildingId).toBe(-1);
    expect(w.resources.food).toBe(1);
    runUntil(w, () => c.state !== 'using', 400);
    expect(c.needs.hunger).toBeGreaterThan(95);
    w.buildings.add('table', 8, 4, false);
    c.needs.hunger = 30;
    runUntil(w, () => c.state === 'using', 400);
    expect(c.needTask?.buildingId).toBeGreaterThan(0);
  });

  it('naps on the floor without a bed (half speed), and in a bed when there is one', () => {
    const w = room();
    const c = w.colonists[0];
    c.needs.sleep = 20;
    c.needs.bladder = c.needs.hunger = 100;
    runUntil(w, () => c.state === 'using', 60);
    expect(c.needTask).toMatchObject({ kind: 'sleep', buildingId: -1 });
    const t0 = w.tick;
    runUntil(w, () => c.state !== 'using', 8000);
    const floorTicks = w.tick - t0;
    w.buildings.add('bed', 6, 4, false);
    c.needs.sleep = 20;
    c.needs.bladder = c.needs.hunger = 100;
    runUntil(w, () => c.state === 'using', 400);
    expect(c.needTask?.kind).toBe('sleep');
    expect(c.needTask!.buildingId).toBeGreaterThan(0);
    const t1 = w.tick;
    runUntil(w, () => c.state !== 'using', 8000);
    expect(w.tick - t1).toBeLessThan(floorTicks * 0.6);
  });

  it('removing a building in use interrupts its user', () => {
    const w = setup();
    const c = w.colonists[0];
    c.needs.bladder = 10;
    runUntil(w, () => c.state === 'using', 400);
    const b = w.buildings.get(c.needTask!.buildingId)!;
    w.removeBuilding(b.id, false);
    w.step();
    expect(c.state).not.toBe('using');
    expect(c.alive).toBe(true);
  });
});

describe('ration printer', () => {
  it('keeps the meal stock up, spending matter (and power: a colonist cranks first)', () => {
    const w = room();
    w.resources.food = 0;
    w.resources.matter = 1000;
    w.buildings.add('printer', 8, 3, false);
    w.buildings.add('crank', 11, 3, false);
    w.buildings.add('battery', 14, 3, false);
    const c = w.colonists[0];
    c.needs.hunger = 100;
    runUntil(w, () => w.resources.food >= 4, 4000);
    expect(w.resources.food).toBe(4); // target: max(4, 2 x colonists)
    w.run(400);
    expect(w.resources.food).toBe(4);
    expect(w.resources.matter).toBe(1000 - 4 * 100);
  });
});

describe('survival', () => {
  it('a furnished colony of 3 survives 5 days with no deaths', () => {
    const w = World.create({ seed: 4242, colonists: 3 });
    const s = w.spawn;
    w.resources.matter = 3000;
    w.resources.food = 2;
    // furnish the starting chamber (floor row = s.y)
    w.buildings.add('bed', s.x - 9, s.y, false);
    w.buildings.add('bed', s.x - 7, s.y, false);
    w.buildings.add('bed', s.x - 5, s.y, false);
    w.buildings.add('toilet', s.x + 3, s.y - 1, false);
    w.buildings.add('sink', s.x + 4, s.y, false);
    w.buildings.add('shower', s.x + 5, s.y - 1, false);
    w.buildings.add('table', s.x + 6, s.y, false);
    w.buildings.add('printer', s.x + 8, s.y - 1, false);
    w.buildings.add('crank', s.x - 3, s.y - 1, false);
    w.buildings.add('battery', s.x + 1, s.y - 1, false);
    // some digging to keep them busy
    w.issue({ type: 'dig', rect: R(s.x + 10, s.y - 3, s.x + 20, s.y), priority: 5 });
    w.run(5 * DAY_SECONDS * SEC);
    expect(w.colonists.every((c) => c.alive)).toBe(true);
    expect(w.colonists.every((c) => c.health > 50)).toBe(true);
  });
});

describe('not getting trapped', () => {
  it('a colonist will not drop into a pit it cannot climb back out of to do a job', () => {
    const w = worldFromAscii([
      'BBBBBBBBBBBB',
      'B..........B',
      'B..........B',
      'B@...#######',
      'B###.#######',
      'B###.#######',
      'B###..c#####',
      'BBBBBBBBBBBB',
    ]);
    // the pit (x=4, falls 3 to y=6) has coal at (6,6) reachable only from inside it
    w.issue({ type: 'dig', rect: R(6, 6), priority: 9 });
    w.run(400);
    const c = w.colonists[0];
    expect(c.y).toBe(3); // stayed on the ledge
    expect(w.grid.tile[cell(w, 6, 6)]).toBe(Tile.Coal);
  });

  it('a stair block that would cut a colonist off from the colony is held back', () => {
    // colonist in a low dead end (x=1..3); the only way out is the step up onto the block at (4,4).
    // A stair block at (3,3) would take the headroom over (3,4) and seal the dead end.
    // (The low ceiling at (1..2,2) stops the colonist scaling out onto the stair block instead.)
    const w = worldFromAscii([
      'BBBBBBBBBB',
      'B........B',
      'BBB......B',
      'B........B',
      'B@..#....B',
      'BBBBBBBBBB',
    ]);
    w.resources.matter = 500;
    const c = w.colonists[0];
    w.spawnColonist(7, 4);
    w.spawn = { x: 7, y: 4 };
    w.issue({ type: 'build', rect: R(3, 3), kind: 'stairs', priority: 9 });
    w.run(600);
    expect(w.grid.tile[cell(w, 3, 3)]).toBe(Tile.Empty);
    expect(w.regions.canReach(c.cell, cell(w, 7, 4))).toBe(true);
    // once the colonist has left the dead end, the stairs go up
    c.placeAt(cell(w, 6, 4), w.grid.w);
    w.run(600);
    expect(w.grid.tile[cell(w, 3, 3)]).toBe(Tile.Stairs);
  });

  it('warns once when a colonist ends up in a pit it cannot climb out of', () => {
    const w = worldFromAscii([
      'BBBBBBBB',
      'B......B',
      'B......B',
      'B..@...B',
      'B######B',
      'B######B',
      'B######B',
      'BBBBBBBB',
    ]);
    w.spawn = { x: 5, y: 3 };
    const c = w.colonists[0];
    for (let y = 4; y <= 6; y++) w.grid.setTile(3, y, Tile.Empty, false);
    c.placeAt(cell(w, 3, 6), w.grid.w); // at the bottom of a 3-deep, 1-wide shaft
    w.run(400);
    expect(c.y).toBe(6);
    const warnings = w.events.filter((e) => e.type === 'needFail' && e.text.includes('stuck'));
    expect(warnings.length).toBe(1);
  });
});
