import { describe, expect, it } from 'vitest';
import { Tile } from '../src/sim/defs';
import { MAX_NEIGHBORS, Move, canStand, neighbors } from '../src/sim/nav';
import { Regions } from '../src/sim/regions';
import { World } from '../src/sim/world';
import { cell, worldFromAscii } from './helpers';

const nc = new Int32Array(MAX_NEIGHBORS), nt = new Uint8Array(MAX_NEIGHBORS), nk = new Float32Array(MAX_NEIGHBORS);

describe('movement rules', () => {
  it('walks on a floor and is blocked by walls', () => {
    const w = worldFromAscii([
      'BBBBBBBB',
      'B......B',
      'B......B',
      'B@...#.B',
      'BBBBBBBB',
    ]);
    const p = w.paths.findNow(cell(w, 1, 3), [cell(w, 4, 3)]);
    expect(p).not.toBeNull();
    expect(Array.from(p!.types).every((t) => t === Move.Walk)).toBe(true);
    // (5,3) is dirt: (6,3) needs a step over it -> step up onto (5,2), step down to (6,3)
    const p2 = w.paths.findNow(cell(w, 1, 3), [cell(w, 6, 3)]);
    expect(p2).not.toBeNull();
    expect(Array.from(p2!.types)).toContain(Move.Step);
  });

  it('can step up 1 tile but not 2', () => {
    const w = worldFromAscii([
      'BBBBBBB',
      'B.....B',
      'B.....B',
      'B...#.B',
      'B@.##.B',
      'BBBBBBB',
    ]);
    // (3,3) is on top of the 1-high block: reachable
    expect(w.paths.findNow(cell(w, 1, 4), [cell(w, 3, 3)])).not.toBeNull();
    // (4,2) is on top of the 2-high column, only reachable via (3,3) step -> ok
    expect(w.paths.findNow(cell(w, 1, 4), [cell(w, 4, 2)])).not.toBeNull();
    const w2 = worldFromAscii([
      'BBBBBB',
      'B....B',
      'B....B',
      'B..#.B',
      'B@.#.B',
      'BBBBBB',
    ]);
    expect(w2.paths.findNow(cell(w2, 1, 4), [cell(w2, 3, 2)])).toBeNull();
  });

  it('climbs stairs in both directions', () => {
    const w = worldFromAscii([
      'BBBBBBB',
      'B.....B',
      'B.....B',
      'B..H###',
      'B..H..B',
      'B@.H..B',
      'BBBBBBB',
    ]);
    const up = w.paths.findNow(cell(w, 1, 5), [cell(w, 5, 2)]);
    expect(up).not.toBeNull();
    expect(Array.from(up!.types)).toContain(Move.Climb);
    const down = w.paths.findNow(cell(w, 5, 2), [cell(w, 1, 5)]);
    expect(down).not.toBeNull();
  });

  it('plans falls up to 3 tiles but never higher', () => {
    const w3 = worldFromAscii([
      'BBBBBB',
      'B....B',
      'B@...B',
      'B##..B',
      'B##..B',
      'B##..B',
      'BBBBBB',
    ]);
    const p = w3.paths.findNow(cell(w3, 1, 2), [cell(w3, 3, 5)]);
    expect(p).not.toBeNull();
    expect(Array.from(p!.types)).toContain(Move.Fall);
    const w4 = worldFromAscii([
      'BBBBBB',
      'B....B',
      'B@...B',
      'B##..B',
      'B##..B',
      'B##..B',
      'B##..B',
      'BBBBBB',
    ]);
    expect(w4.paths.findNow(cell(w4, 1, 2), [cell(w4, 3, 6)])).toBeNull();
  });

  it('two-way moves are symmetric on a generated world', () => {
    const w = World.create({ seed: 42, w: 96, h: 64 });
    const g = w.grid;
    // dig a bunch of random holes and add stairs to get varied terrain
    for (let i = 0; i < 400; i++) {
      const x = 1 + w.rng.int(0, g.w - 2), y = 1 + w.rng.int(0, g.h - 2);
      if (w.rng.next() < 0.15) g.stairs[g.idx(x, y)] = g.tile[g.idx(x, y)] === Tile.Empty ? 1 : 0;
      else g.rawSetTile(x, y, Tile.Empty);
    }
    let checked = 0;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (!canStand(g, x, y)) continue;
      const n = neighbors(g, g.idx(x, y), nc, nt, nk);
      const outs = Array.from({ length: n }, (_, i) => [nc[i], nt[i]]);
      for (const [t, type] of outs) {
        if (type === Move.Fall) continue;
        const n2 = neighbors(g, t, nc, nt, nk);
        let back = false;
        for (let i = 0; i < n2; i++) if (nc[i] === g.idx(x, y) && nt[i] !== Move.Fall) back = true;
        expect(back, `edge ${x},${y} -> ${t % g.w},${(t / g.w) | 0} type ${type}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

/** Ground truth reachability via plain BFS over the cell graph. */
function bfsReach(w: World, from: number): Set<number> {
  const g = w.grid;
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const c = q.shift()!;
    const n = neighbors(g, c, nc, nt, nk);
    for (let i = 0; i < n; i++) if (!seen.has(nc[i])) { seen.add(nc[i]); q.push(nc[i]); }
  }
  return seen;
}

describe('regions', () => {
  it('region reachability matches cell-level BFS, including after incremental edits', () => {
    const w = World.create({ seed: 7, w: 128, h: 80 });
    const g = w.grid;
    const check = () => {
      w.regions.update();
      const stands: number[] = [];
      for (let i = 0; i < g.size; i++) if (canStand(g, g.cx(i), g.cy(i))) stands.push(i);
      for (let s = 0; s < 6; s++) {
        const from = stands[w.rng.int(0, stands.length)];
        const truth = bfsReach(w, from);
        for (let k = 0; k < 300; k++) {
          const to = stands[w.rng.int(0, stands.length)];
          expect(w.regions.canReach(from, to)).toBe(truth.has(to));
        }
      }
    };
    check();
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 60; i++) {
        const x = 1 + w.rng.int(0, g.w - 2), y = 1 + w.rng.int(0, g.h - 2);
        const r = w.rng.next();
        if (r < 0.6) g.setTile(x, y, Tile.Empty, false);
        else if (r < 0.85) g.setTile(x, y, Tile.Concrete, true);
        else if (g.tile[g.idx(x, y)] === Tile.Empty) g.setStairs(x, y, true);
      }
      for (const rect of g.dirty) w.regions.markRect(rect);
      g.dirty = [];
      check();
      // incremental result must equal a full rebuild
      const fresh = new Regions(g);
      fresh.update();
      expect(fresh.regionCount).toBe(w.regions.regionCount);
    }
  });
});
