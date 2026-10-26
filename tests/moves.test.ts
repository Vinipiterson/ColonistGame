// Jumping a 1-wide gap and scaling a 2-high ledge.
import { describe, expect, it } from 'vitest';
import { Tile } from '../src/sim/defs';
import { Grid } from '../src/sim/grid';
import { MAX_NEIGHBORS, Move, canStand, neighbors } from '../src/sim/nav';
import { Rng } from '../src/sim/rng';
import { cell, runUntil, worldFromAscii } from './helpers';

const types = (w: ReturnType<typeof worldFromAscii>, from: number, to: number): number[] => {
  const p = w.paths.findNow(from, [to]);
  return p ? Array.from(p.types) : [];
};

describe('jumping', () => {
  it('jumps a 1-wide gap at the same height, both ways', () => {
    const w = worldFromAscii([
      'BBBBBBBBBB',
      'B........B',
      'B........B',
      'B........B',
      'B@.......B',
      '####.#####',
      '####.#####',
      '####.#####',
      '####.#####',
      'BBBBBBBBBB',
    ]);
    // the 4-deep shaft at x=4 is too deep to drop into and climb out of: crossing needs a jump
    expect(types(w, cell(w, 3, 4), cell(w, 6, 4))).toContain(Move.Jump);
    expect(types(w, cell(w, 6, 4), cell(w, 3, 4))).toContain(Move.Jump);
    expect(w.regions.canReach(cell(w, 1, 4), cell(w, 8, 4))).toBe(true);
    const c = w.colonists[0];
    w.paths.cancel(c.req);
    // walk there for real
    w.issue({ type: 'dig', rect: { x0: 8, y0: 5, x1: 8, y1: 5 }, priority: 9 });
    const t = runUntil(w, () => w.grid.tile[cell(w, 8, 5)] === Tile.Empty, 400);
    expect(t).toBeGreaterThan(0);
  });

  it('cannot jump a 2-wide gap', () => {
    const w = worldFromAscii([
      'BBBBBBBBBB',
      'B........B',
      'B........B',
      'B........B',
      'B@......#B',
      '####..####',
      '####..####',
      '####..####',
      '####..####',
      'BBBBBBBBBB',
    ]);
    expect(w.regions.canReach(cell(w, 1, 4), cell(w, 7, 4))).toBe(false);
  });

  it('needs headroom for the arc', () => {
    const w = worldFromAscii([
      'BBBBBBBBBB',
      'B........B',
      'B...#....B', // low ceiling over the gap
      'B........B',
      'B@.......B',
      '####.#####',
      '####.#####',
      '####.#####',
      '####.#####',
      'BBBBBBBBBB',
    ]);
    expect(w.regions.canReach(cell(w, 3, 4), cell(w, 6, 4))).toBe(false);
  });
});

describe('scaling 2-high ledges', () => {
  it('climbs up a 2-high ledge and back down, but not a 3-high one', () => {
    const w = worldFromAscii([
      'BBBBBBBBBBBB',
      'B..........B',
      'B..........B',
      'B..........B',
      'B......#####',
      'B....###...B',
      'B@...###...B',
      'BBBBBBBBBBBB',
    ]);
    // (4,6) -> (5,4): two up onto the block
    expect(types(w, cell(w, 4, 6), cell(w, 5, 4))).toEqual([Move.Scale]);
    expect(w.regions.canReach(cell(w, 5, 4), cell(w, 1, 6))).toBe(true);
    // (6,4) -> (7,3): the next ledge is only 1 high (a step); (10,6) under the overhang is sealed
    expect(w.regions.canReach(cell(w, 1, 6), cell(w, 9, 3))).toBe(true);
  });

  it('a colonist climbs out of a 2-deep pit', () => {
    const w = worldFromAscii([
      'BBBBBBBBBB',
      'B........B',
      'B........B',
      'B........B',
      'B........B',
      'B###..###B',
      'B###..###B',
      'BBBBBBBBBB',
    ]);
    const c = w.colonists.length ? w.colonists[0] : w.spawnColonist(4, 6);
    c.aptitude = {};
    w.spawn = { x: 1, y: 4 };
    expect(w.regions.canReach(cell(w, 4, 6), cell(w, 1, 4))).toBe(true);
    expect(w.regions.canReach(cell(w, 1, 4), cell(w, 4, 6))).toBe(true);
    w.issue({ type: 'dig', rect: { x0: 1, y0: 5, x1: 1, y1: 5 }, priority: 9 });
    const t = runUntil(w, () => w.grid.tile[cell(w, 1, 5)] === Tile.Empty, 600);
    expect(t).toBeGreaterThan(0);
  });
});

describe('two-way moves', () => {
  it('fuzz: every non-fall edge has a mirror edge of the same type (regions rely on it)', () => {
    const rng = new Rng(4242);
    const nc = new Int32Array(MAX_NEIGHBORS), nt = new Uint8Array(MAX_NEIGHBORS), nk = new Float32Array(MAX_NEIGHBORS);
    const bc = new Int32Array(MAX_NEIGHBORS), bt = new Uint8Array(MAX_NEIGHBORS), bk = new Float32Array(MAX_NEIGHBORS);
    let checked = 0;
    for (let trial = 0; trial < 60; trial++) {
      const g = new Grid(24, 16);
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          const edge = x === 0 || y === 0 || x === g.w - 1 || y === g.h - 1;
          const r = rng.next();
          g.rawSetTile(x, y, edge || r < 0.4 ? Tile.Dirt : Tile.Empty);
          if (!edge && r > 0.97) g.stairs[g.idx(x, y)] = 1;
        }
      }
      for (let y = 1; y < g.h - 1; y++) {
        for (let x = 1; x < g.w - 1; x++) {
          if (!canStand(g, x, y)) continue;
          const from = g.idx(x, y);
          const n = neighbors(g, from, nc, nt, nk);
          for (let i = 0; i < n; i++) {
            if (nt[i] === Move.Fall) continue;
            const back = neighbors(g, nc[i], bc, bt, bk);
            let ok = false;
            for (let j = 0; j < back; j++) if (bc[j] === from && bt[j] === nt[i]) ok = true;
            if (!ok) throw new Error(`no mirror for ${['walk', 'step', 'climb', 'fall', 'jump', 'scale'][nt[i]]} (${x},${y}) -> (${nc[i] % g.w},${(nc[i] / g.w) | 0})`);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
