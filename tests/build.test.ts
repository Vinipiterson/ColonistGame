// Construction edge cases: building over colonists, building on natural tiles, stacked walls.
import { describe, expect, it } from 'vitest';
import { Tile } from '../src/sim/defs';
import { cell, runUntil, worldFromAscii } from './helpers';

const R = (x0: number, y0: number, x1 = x0, y1 = y0) => ({ x0, y0, x1, y1 });

describe('building on natural tiles', () => {
  it('a wall ordered on dirt digs it out first (yielding matter), then builds', () => {
    const w = worldFromAscii(['BBBBBBBB', 'B......B', 'B......B', 'B@...#.B', 'BBBBBBBB']);
    w.resources.matter = 100;
    w.issue({ type: 'build', rect: R(5, 3), kind: 'wall', priority: 6 });
    w.step();
    expect(w.orders.at(cell(w, 5, 3))?.kind).toBe('build');
    runUntil(w, () => w.orders.count === 0, 1000);
    expect(w.grid.tile[cell(w, 5, 3)]).toBe(Tile.Concrete);
    expect(w.grid.built[cell(w, 5, 3)]).toBe(1);
    expect(w.resources.matter).toBe(100 + 50 - 50);
  });

  it('ladders ordered into dirt dig it out first; matter is not needed for the dig phase', () => {
    const w = worldFromAscii(['BBBBBBBB', 'B......B', 'B......B', 'B@...#.B', 'B######B', 'BBBBBBBB']);
    w.resources.matter = 0;
    w.issue({ type: 'build', rect: R(5, 3, 5, 4), kind: 'ladder', priority: 6 });
    w.step();
    runUntil(w, () => w.orders.count === 0, 2000);
    expect(w.grid.stairs[cell(w, 5, 3)] + w.grid.stairs[cell(w, 5, 4)]).toBe(2);
    expect(w.resources.matter).toBe(100 - 50); // two dirt tiles dug (+100), two stairs paid from that
  });

  it('a build replaces a pending dig order on the same tile', () => {
    const w = worldFromAscii(['BBBBBBBB', 'B......B', 'B......B', 'B@...#.B', 'BBBBBBBB']);
    w.issue({ type: 'dig', rect: R(5, 3), priority: 6 });
    w.step();
    w.issue({ type: 'build', rect: R(5, 3), kind: 'wall', priority: 6 });
    w.step();
    expect(w.orders.count).toBe(1);
    expect(w.orders.at(cell(w, 5, 3))?.kind).toBe('build');
  });

  it('build never targets player-built tiles (use Deconstruct)', () => {
    const w = worldFromAscii(['BBBBBBBB', 'B......B', 'B......B', 'B@...W.B', 'BBBBBBBB']);
    w.issue({ type: 'build', rect: R(5, 3), kind: 'ladder', priority: 6 });
    w.step();
    expect(w.orders.count).toBe(0);
  });
});

describe('walls over colonists never deadlock', () => {
  // The reported bug: dig out the floor, then order walls back over it while colonists stand there.
  it('fuzz: trenches walled over (and the row above) always finish, nobody entombed', () => {
    let stuck = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const n = 2 + (seed % 5);
      const row = 'B' + '.'.repeat(3) + '@'.repeat(n) + '.'.repeat(14 - n) + 'B';
      const w = worldFromAscii([
        'B'.repeat(19), 'B' + '.'.repeat(17) + 'B', 'B' + '.'.repeat(17) + 'B', 'B' + '.'.repeat(17) + 'B',
        row, 'B' + '#'.repeat(17) + 'B', 'B' + '#'.repeat(17) + 'B', 'B'.repeat(19),
      ], seed);
      w.resources.matter = 5000;
      const x0 = 2 + (seed % 3), x1 = 12 + (seed % 4);
      const depth = seed % 2;
      w.issue({ type: 'dig', rect: R(x0, 5, x1, 5 + depth), priority: 6 });
      w.step();
      runUntil(w, () => w.orders.count === 0, 6000);
      w.issue({ type: 'build', rect: R(x0, 4 + (seed % 3 === 0 ? 0 : 1), x1, 5 + depth), kind: 'wall', priority: 6 });
      w.step();
      if (runUntil(w, () => w.orders.count === 0, 8000) < 0) stuck++;
      for (const c of w.colonists) {
        expect(c.alive).toBe(true);
        expect(w.grid.solid(c.x, c.y) || w.grid.solid(c.x, c.y - 1)).toBe(false);
      }
    }
    expect(stuck).toBe(0);
  });

  it('two builders standing in each other\'s wall cells still finish', () => {
    const w = worldFromAscii(['BBBBBBBB', 'B......B', 'B......B', 'B......B', 'B.@@...B', 'BBBBBBBB']);
    w.resources.matter = 500;
    w.issue({ type: 'build', rect: R(2, 4, 3, 4), kind: 'wall', priority: 6 });
    w.step();
    expect(runUntil(w, () => w.orders.count === 0, 2000)).toBeGreaterThan(0);
    for (const c of w.colonists) expect(w.grid.solid(c.x, c.y) || w.grid.solid(c.x, c.y - 1)).toBe(false);
  });
});

describe('losing footing', () => {
  it('a colonist whose floor vanishes steps to a side tile instead of falling', () => {
    const w = worldFromAscii(['BBBBBBBB', 'B......B', 'B......B', 'B..@...B', 'B.###..B', 'B......B', 'B......B', 'B......B', 'BBBBBBBB']);
    const c = w.colonists[0];
    w.grid.setTile(3, 4, Tile.Empty, false);
    w.step();
    expect(c.state).toBe('scrambling');
    runUntil(w, () => c.state === 'idle', 60);
    expect(c.y).toBe(3);
    expect([2, 4]).toContain(c.x);
    expect(c.health).toBe(100);
  });

  it('with nowhere to step, it hangs on for about a second and then falls', () => {
    const w = worldFromAscii(['BBBBBBB', 'B.....B', 'B.....B', 'B..@..B', 'B..#..B', 'B.....B', 'B.....B', 'B.....B', 'B.....B', 'BBBBBBB']);
    const c = w.colonists[0];
    w.grid.setTile(3, 4, Tile.Empty, false);
    const t = runUntil(w, () => c.state === 'falling', 60);
    expect(t).toBeGreaterThanOrEqual(19);
    runUntil(w, () => c.state === 'idle', 200);
    expect(c.y).toBe(8);
  });

  it('a colonist digging the tile it stands on scrambles to the side', () => {
    const w = worldFromAscii(['BBBBBBB', 'B.....B', 'B.....B', 'B..@..B', 'B.###.B', 'B.###.B', 'B.....B', 'B.....B', 'B.....B', 'BBBBBBB']);
    w.issue({ type: 'dig', rect: R(3, 4), priority: 6 });
    w.step();
    runUntil(w, () => w.orders.count === 0, 600);
    w.run(40);
    const c = w.colonists[0];
    expect(c.health).toBe(100);
    expect(c.y).toBe(3);
  });
});
