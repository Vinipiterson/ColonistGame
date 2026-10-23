import { describe, expect, it } from 'vitest';
import { EMERGENCY, Tile, fallDamage } from '../src/sim/defs';
import { World } from '../src/sim/world';
import { cell, runUntil, worldFromAscii } from './helpers';

const R = (x0: number, y0: number, x1 = x0, y1 = y0) => ({ x0, y0, x1, y1 });

describe('digging and resources', () => {
  it('a colonist digs a marked tile and the stockpile grows', () => {
    const w = worldFromAscii([
      'BBBBBBBB',
      'B......B',
      'B......B',
      'B@...#.B',
      'BBBBBBBB',
    ]);
    const before = w.resources.matter;
    w.issue({ type: 'dig', rect: R(5, 3), priority: 6 });
    const t = runUntil(w, () => w.grid.tile[cell(w, 5, 3)] === Tile.Empty, 400);
    expect(t).toBeGreaterThan(0);
    expect(w.resources.matter).toBe(before + 50);
    expect(w.orders.count).toBe(0);
  });

  it('coal yields coal', () => {
    const w = worldFromAscii(['BBBBBB', 'B....B', 'B....B', 'B@.c.B', 'BBBBBB']);
    w.issue({ type: 'dig', rect: R(3, 3), priority: 6 });
    w.step();
    runUntil(w, () => w.orders.count === 0, 400);
    expect(w.resources.coal).toBe(50);
  });

  it('Dig never marks player-built tiles; Deconstruct never marks natural tiles', () => {
    const w = worldFromAscii(['BBBBBBB', 'B.....B', 'B.....B', 'B@.W#.B', 'BBBBBBB']);
    w.issue({ type: 'dig', rect: R(1, 1, 5, 3), priority: 6 });
    w.step();
    expect(w.orders.at(cell(w, 3, 3))).toBeUndefined();
    expect(w.orders.at(cell(w, 4, 3))?.kind).toBe('dig');
    w.issue({ type: 'cancel', rect: R(0, 0, 6, 4) });
    w.issue({ type: 'deconstruct', rect: R(1, 1, 5, 3), priority: 6 });
    w.step();
    expect(w.orders.at(cell(w, 4, 3))).toBeUndefined();
    expect(w.orders.at(cell(w, 3, 3))?.kind).toBe('deconstruct');
  });
});

describe('building', () => {
  it('builds a wall, pays matter, and deconstruct refunds half', () => {
    const w = worldFromAscii(['BBBBBBB', 'B.....B', 'B.....B', 'B@....B', 'BBBBBBB']);
    w.resources.matter = 100;
    w.issue({ type: 'build', rect: R(4, 3), kind: 'wall', priority: 6 });
    runUntil(w, () => w.grid.tile[cell(w, 4, 3)] === Tile.Concrete, 600);
    expect(w.grid.built[cell(w, 4, 3)]).toBe(1);
    expect(w.resources.matter).toBe(50);
    w.issue({ type: 'deconstruct', rect: R(4, 3), priority: 6 });
    runUntil(w, () => w.grid.tile[cell(w, 4, 3)] === Tile.Empty, 600);
    expect(w.resources.matter).toBe(75);
  });

  it('build orders wait when there is not enough matter', () => {
    const w = worldFromAscii(['BBBBBBB', 'B.....B', 'B.....B', 'B@....B', 'BBBBBBB']);
    w.resources.matter = 10;
    w.issue({ type: 'build', rect: R(4, 3), kind: 'wall', priority: 6 });
    w.run(200);
    expect(w.grid.tile[cell(w, 4, 3)]).toBe(Tile.Empty);
    w.resources.matter = 60;
    runUntil(w, () => w.grid.tile[cell(w, 4, 3)] === Tile.Concrete, 600);
    expect(w.resources.matter).toBe(10);
  });

  it('an idle colonist standing where a wall is ordered steps aside', () => {
    const w = worldFromAscii(['BBBBBBBB', 'B......B', 'B......B', 'B.@....B', 'BBBBBBBB']);
    w.issue({ type: 'build', rect: R(2, 3), kind: 'wall', priority: 6 });
    const t = runUntil(w, () => w.grid.tile[cell(w, 2, 3)] === Tile.Concrete, 1200);
    expect(t).toBeGreaterThan(0);
    const c = w.colonists[0];
    expect(c.alive).toBe(true);
    expect(c.x).not.toBe(2);
  });

  it('cancel removes orders in batch and refunds paid builds', () => {
    const w = worldFromAscii(['BBBBBBBBBB', 'B........B', 'B........B', 'B@...####B', 'BBBBBBBBBB']);
    w.issue({ type: 'dig', rect: R(5, 3, 8, 3), priority: 6 });
    w.issue({ type: 'build', rect: R(2, 1, 4, 1), kind: 'ladder', priority: 6 });
    w.step();
    expect(w.orders.count).toBe(7);
    w.issue({ type: 'cancel', rect: R(0, 0, 9, 4) });
    w.step();
    expect(w.orders.count).toBe(0);
    expect(w.colonists[0].job).toBeNull();
  });
});

describe('priorities', () => {
  it('higher priority wins even when farther away', () => {
    const w = worldFromAscii(['BBBBBBBBBBBB', 'B..........B', 'B..........B', 'B@.#......#B', 'BBBBBBBBBBBB']);
    w.issue({ type: 'dig', rect: R(3, 3), priority: 3 });
    w.issue({ type: 'dig', rect: R(10, 3), priority: 8 });
    w.step();
    runUntil(w, () => w.orders.count < 2, 2000);
    expect(w.grid.tile[cell(w, 10, 3)]).toBe(Tile.Empty);
    expect(w.grid.tile[cell(w, 3, 3)]).toBe(Tile.Dirt);
  });

  it('an emergency order interrupts current work', () => {
    const w = worldFromAscii(['BBBBBBBBBBBBBB', 'B............B', 'B............B', 'Brrrrr@......B', 'BBBBBBBBBBBBBB']);
    w.issue({ type: 'dig', rect: R(1, 3, 5, 3), priority: 5 });
    runUntil(w, () => w.colonists[0].state === 'working', 400);
    const firstJob = w.colonists[0].job!;
    expect(firstJob.priority).toBe(5);
    w.resources.matter = 200;
    w.issue({ type: 'build', rect: R(11, 3), kind: 'ladder', priority: EMERGENCY });
    runUntil(w, () => w.colonists[0].job?.priority === EMERGENCY, 40);
    expect(w.colonists[0].job?.priority).toBe(EMERGENCY);
    expect(firstJob.claimedBy).toBe(-1);
    runUntil(w, () => w.grid.stairs[cell(w, 11, 3)] === 1, 1000);
    expect(w.grid.stairs[cell(w, 11, 3)]).toBe(1);
  });
});

describe('falls', () => {
  function pillar(height: number): World {
    // colonist on a 1-wide pillar; floor of the pit is bedrock
    const rows = ['BBBBBBB', 'B.....B', 'B..@..B'];
    for (let i = 0; i < height; i++) rows.push('B..#..B');
    rows.push('BBBBBBB');
    return worldFromAscii(rows);
  }

  it('falls of 3 tiles or less are safe; damage scales beyond', () => {
    for (const h of [2, 3, 4, 6]) {
      const w = pillar(h);
      const c = w.colonists[0];
      // remove the whole pillar under the colonist
      for (let i = 0; i < h; i++) w.grid.setTile(3, 3 + i, Tile.Empty, false);
      runUntil(w, () => c.state === 'idle' && w.tick > 2, 200);
      expect(c.y).toBe(2 + h);
      expect(c.health).toBe(100 - fallDamage(h));
    }
  });

  it('a fall of 8+ tiles kills, and losing the last colonist ends the game', () => {
    const w = pillar(8);
    for (let i = 0; i < 8; i++) w.grid.setTile(3, 3 + i, Tile.Empty, false);
    runUntil(w, () => w.gameOver, 200);
    expect(w.colonists[0].state).toBe('dead');
    expect(w.gameOver).toBe(true);
    expect(w.events.some((e) => e.type === 'gameOver')).toBe(true);
  });
});

describe('path revalidation', () => {
  it('when the bridge ahead is dug out, the colonist takes the next reachable job instead', () => {
    const w = worldFromAscii([
      'BBBBBBBBBBBBBBBBBBBBBB',
      'B....................B',
      'B....................B',
      'B#@.........#.......#B',
      'B####........######c#B',
      'B####........#########',
      'B####........#########',
      'B####........#########',
      'B####........#########',
      'BBBBBBBBBBBBBBBBBBBBBB',
    ]);
    const g = w.grid;
    // bridge across the pit at row 4
    for (let x = 5; x <= 12; x++) g.rawSetTile(x, 4, Tile.Concrete, true);
    g.touchAll();
    w.issue({ type: 'dig', rect: R(19, 4), priority: 9 }); // far side, coal
    w.issue({ type: 'dig', rect: R(1, 3), priority: 2 }); // near side, low priority
    const c = w.colonists[0];
    runUntil(w, () => c.state === 'moving' && c.x >= 4, 400);
    expect(c.job?.x).toBe(19);
    // knock out the middle of the bridge (ahead of the colonist)
    g.setTile(9, 4, Tile.Empty, false);
    g.setTile(10, 4, Tile.Empty, false);
    w.step();
    expect(c.job?.x).not.toBe(19);
    runUntil(w, () => g.tile[cell(w, 1, 3)] === Tile.Empty, 1000);
    expect(g.tile[cell(w, 1, 3)]).toBe(Tile.Empty);
    expect(c.health).toBe(100);
    expect(g.tile[cell(w, 19, 4)]).toBe(Tile.Coal); // still unreachable, untouched
  });
});

describe('determinism', () => {
  it('same seed + same commands = same world', () => {
    const run = () => {
      const w = World.create({ seed: 123, w: 96, h: 64, colonists: 6 });
      const s = w.spawn;
      w.issue({ type: 'dig', rect: R(s.x - 12, s.y - 3, s.x + 12, s.y + 4), priority: 6 });
      w.run(3000);
      let hash = 0;
      for (let i = 0; i < w.grid.size; i++) hash = (hash * 31 + w.grid.tile[i]) | 0;
      for (const c of w.colonists) hash = (hash * 31 + c.cell + Math.round(c.health)) | 0;
      return { hash, matter: w.resources.matter };
    };
    const a = run(), b = run();
    expect(a).toEqual(b);
    expect(a.matter).toBeGreaterThan(300);
  });
});
