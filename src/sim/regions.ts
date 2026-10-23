// Hierarchical reachability.
//
// The map is cut into CHUNK x CHUNK chunks. Inside a chunk, stand cells connected by two-way
// moves (walk/step/climb) form a region. Each region stores the *target cells* of its edges
// that leave the region (including one-way falls). Targets are resolved to regions at query
// time, so when a chunk is rebuilt, regions in other chunks never hold stale region ids.
//
// A grid change can affect an edge whose source is up to SAFE_FALL+1 tiles away, so dirty
// rects are expanded by that margin before marking chunks for rebuild.

import { SAFE_FALL } from './defs';
import type { Grid, Rect } from './grid';
import { MAX_NEIGHBORS, Move, canStand, neighbors } from './nav';

export const CHUNK = 16;
const MARGIN = SAFE_FALL + 1;

interface Region {
  id: number;
  chunk: number;
  cells: number[];
  out: number[]; // target cells outside this region
}

export class Regions {
  readonly g: Grid;
  readonly cw: number;
  readonly ch: number;
  /** Region id of each stand cell, -1 for cells a colonist can't stand in. */
  readonly cellRegion: Int32Array;
  private regions: (Region | null)[] = [];
  private freeIds: number[] = [];
  private chunkRegions: number[][];
  private chunkDirty: Uint8Array;
  /** Region version at which each chunk was last rebuilt. */
  readonly chunkStamp: Int32Array;
  private anyDirty = false;
  /** Bumped every time regions/edges actually change. */
  version = 0;

  private cache = new Map<number, Uint8Array>();
  private cacheVersion = -1;
  private stamp: Int32Array = new Int32Array(0);
  private stampGen = 0;
  private queue: number[] = [];

  private nC = new Int32Array(MAX_NEIGHBORS);
  private nT = new Uint8Array(MAX_NEIGHBORS);
  private nK = new Float32Array(MAX_NEIGHBORS);

  constructor(g: Grid) {
    this.g = g;
    this.cw = Math.ceil(g.w / CHUNK);
    this.ch = Math.ceil(g.h / CHUNK);
    this.cellRegion = new Int32Array(g.size).fill(-1);
    this.chunkRegions = Array.from({ length: this.cw * this.ch }, () => []);
    this.chunkDirty = new Uint8Array(this.cw * this.ch);
    this.chunkStamp = new Int32Array(this.cw * this.ch);
    this.markAllDirty();
  }

  get regionCount(): number {
    return this.regions.length - this.freeIds.length;
  }

  markAllDirty(): void {
    this.chunkDirty.fill(1);
    this.anyDirty = true;
  }

  markRect(r: Rect): void {
    const x0 = Math.max(0, Math.floor((r.x0 - MARGIN) / CHUNK));
    const y0 = Math.max(0, Math.floor((r.y0 - MARGIN) / CHUNK));
    const x1 = Math.min(this.cw - 1, Math.floor((r.x1 + MARGIN) / CHUNK));
    const y1 = Math.min(this.ch - 1, Math.floor((r.y1 + MARGIN) / CHUNK));
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) this.chunkDirty[cy * this.cw + cx] = 1;
    this.anyDirty = true;
  }

  /** Rebuild every dirty chunk. Cheap no-op when nothing changed. */
  update(): void {
    if (!this.anyDirty) return;
    this.anyDirty = false;
    const dirty: number[] = [];
    for (let c = 0; c < this.chunkDirty.length; c++) if (this.chunkDirty[c]) dirty.push(c);
    this.chunkDirty.fill(0);
    // 1) drop old regions in dirty chunks
    for (const c of dirty) {
      for (const id of this.chunkRegions[c]) {
        const r = this.regions[id]!;
        for (const cell of r.cells) this.cellRegion[cell] = -1;
        this.regions[id] = null;
        this.freeIds.push(id);
      }
      this.chunkRegions[c] = [];
    }
    // 2) flood fill new regions
    const created: Region[] = [];
    for (const c of dirty) {
      this.fillChunk(c, created);
      this.chunkStamp[c] = this.version + 1;
    }
    // 3) edges (needs all new cellRegion entries in place)
    for (const r of created) this.computeEdges(r);
    this.version++;
  }

  private fillChunk(c: number, created: Region[]): void {
    const g = this.g;
    const ccx = c % this.cw, ccy = (c / this.cw) | 0;
    const x0 = ccx * CHUNK, y0 = ccy * CHUNK;
    const x1 = Math.min(g.w, x0 + CHUNK), y1 = Math.min(g.h, y0 + CHUNK);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const cell = y * g.w + x;
        if (this.cellRegion[cell] !== -1 || !canStand(g, x, y)) continue;
        const id = this.freeIds.length ? this.freeIds.pop()! : this.regions.length;
        const r: Region = { id, chunk: c, cells: [], out: [] };
        this.regions[id] = r;
        this.chunkRegions[c].push(id);
        created.push(r);
        const stack = [cell];
        this.cellRegion[cell] = id;
        while (stack.length) {
          const cur = stack.pop()!;
          r.cells.push(cur);
          const n = neighbors(g, cur, this.nC, this.nT, this.nK);
          for (let i = 0; i < n; i++) {
            if (this.nT[i] === Move.Fall) continue;
            const t = this.nC[i];
            const tx = t % g.w, ty = (t / g.w) | 0;
            if (tx < x0 || tx >= x1 || ty < y0 || ty >= y1) continue;
            if (this.cellRegion[t] !== -1) continue;
            this.cellRegion[t] = id;
            stack.push(t);
          }
        }
      }
    }
  }

  private computeEdges(r: Region): void {
    const seen = new Set<number>();
    for (const cell of r.cells) {
      const n = neighbors(this.g, cell, this.nC, this.nT, this.nK);
      for (let i = 0; i < n; i++) {
        const t = this.nC[i];
        if (this.cellRegion[t] === r.id) continue;
        if (!seen.has(t)) {
          seen.add(t);
          r.out.push(t);
        }
      }
    }
  }

  /** Latest rebuild stamp among chunks overlapping the cell rect (for local cache invalidation). */
  localStamp(x0: number, y0: number, x1: number, y1: number): number {
    this.update();
    const cx0 = Math.max(0, Math.floor(x0 / CHUNK)), cy0 = Math.max(0, Math.floor(y0 / CHUNK));
    const cx1 = Math.min(this.cw - 1, Math.floor(x1 / CHUNK)), cy1 = Math.min(this.ch - 1, Math.floor(y1 / CHUNK));
    let m = 0;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) m = Math.max(m, this.chunkStamp[cy * this.cw + cx]);
    return m;
  }

  regionOf(cell: number): number {
    this.update();
    return this.cellRegion[cell];
  }

  /** Bitmap over region ids reachable from region `rid` (inclusive). Cached per version. */
  reachableFrom(rid: number): Uint8Array | null {
    if (rid < 0) return null;
    this.update();
    if (this.cacheVersion !== this.version) {
      this.cache.clear();
      this.cacheVersion = this.version;
    }
    const hit = this.cache.get(rid);
    if (hit) return hit;
    const n = this.regions.length;
    if (this.stamp.length < n) this.stamp = new Int32Array(n * 2);
    const gen = ++this.stampGen;
    const set = new Uint8Array(n);
    const q = this.queue;
    q.length = 0;
    q.push(rid);
    this.stamp[rid] = gen;
    set[rid] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const r = this.regions[q[qi]]!;
      for (const t of r.out) {
        const tr = this.cellRegion[t];
        if (tr < 0 || this.stamp[tr] === gen) continue;
        this.stamp[tr] = gen;
        set[tr] = 1;
        q.push(tr);
      }
    }
    this.cache.set(rid, set);
    return set;
  }

  /** Can a colonist standing at `from` reach stand cell `to`? */
  canReach(from: number, to: number): boolean {
    this.update();
    const a = this.cellRegion[from], b = this.cellRegion[to];
    if (a < 0 || b < 0) return false;
    if (a === b) return true;
    const set = this.reachableFrom(a)!;
    return b < set.length && set[b] === 1;
  }
}
