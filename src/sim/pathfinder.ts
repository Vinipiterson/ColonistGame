// PathService: multi-goal A* over stand cells, time-sliced with a node budget per tick.
// One search is active at a time and can resume across ticks; requests are FIFO.
// Typed-array scratch buffers + generation stamps mean no per-search allocation or clearing.

import type { Grid } from './grid';
import { MAX_NEIGHBORS, neighbors } from './nav';
import type { Regions } from './regions';

export interface Path {
  cells: Int32Array; // excludes the start cell
  types: Uint8Array;
  costs: Float32Array;
}

export type PathStatus = 'pending' | 'found' | 'failed';

export interface PathRequest {
  id: number;
  start: number;
  goals: number[];
  status: PathStatus;
  path: Path | null;
  navVersion: number; // grid version when the search ran
  cancelled: boolean;
}

const MAX_NODES_PER_SEARCH = 120_000;

export class PathService {
  private g: Grid;
  private regions: Regions;
  private queue: PathRequest[] = [];
  private nextId = 1;

  private gScore: Float32Array;
  private parent: Int32Array;
  private pType: Uint8Array;
  private pCost: Float32Array;
  private seen: Int32Array;
  private closed: Int32Array;
  private goalMark: Int32Array;
  private gen = 0;

  private heapCell = new Int32Array(1024);
  private heapF = new Float32Array(1024);
  private heapN = 0;

  private active: PathRequest | null = null;
  private expanded = 0;
  private goalXs: number[] = [];
  private goalYs: number[] = [];

  private nC = new Int32Array(MAX_NEIGHBORS);
  private nT = new Uint8Array(MAX_NEIGHBORS);
  private nK = new Float32Array(MAX_NEIGHBORS);

  /** Stats for the HUD / benchmarks. */
  stats = { searches: 0, expanded: 0, failedFast: 0 };

  constructor(g: Grid, regions: Regions) {
    this.g = g;
    this.regions = regions;
    const n = g.size;
    this.gScore = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.pType = new Uint8Array(n);
    this.pCost = new Float32Array(n);
    this.seen = new Int32Array(n);
    this.closed = new Int32Array(n);
    this.goalMark = new Int32Array(n);
  }

  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  request(start: number, goals: number[]): PathRequest {
    const req: PathRequest = {
      id: this.nextId++, start, goals, status: 'pending', path: null, navVersion: 0, cancelled: false,
    };
    // Region pre-check: fail instantly when no goal is reachable (the common failure case).
    const reach = goals.some((gl) => this.regions.canReach(start, gl));
    if (!reach) {
      req.status = 'failed';
      req.navVersion = this.g.navVersion;
      this.stats.failedFast++;
      return req;
    }
    if (goals.includes(start)) {
      req.status = 'found';
      req.path = { cells: new Int32Array(0), types: new Uint8Array(0), costs: new Float32Array(0) };
      req.navVersion = this.g.navVersion;
      return req;
    }
    this.queue.push(req);
    return req;
  }

  cancel(req: PathRequest | null): void {
    if (req && req.status === 'pending') req.cancelled = true;
  }

  /** Run searches until the node budget for this tick is spent. */
  process(budget: number): void {
    while (budget > 0) {
      if (!this.active) {
        let next: PathRequest | undefined;
        while ((next = this.queue.shift()) && next.cancelled) { /* skip */ }
        if (!next) return;
        this.begin(next);
      }
      const req = this.active!;
      if (req.cancelled) {
        this.active = null;
        continue;
      }
      budget = this.step(req, budget);
    }
  }

  /** Synchronous search (tests, tools). */
  findNow(start: number, goals: number[]): Path | null {
    const req = this.request(start, goals);
    if (req.status !== 'pending') return req.path;
    // Move it to the front and run it to completion.
    this.queue.splice(this.queue.indexOf(req), 1);
    const prev = this.active;
    if (prev) {
      // The scratch buffers are shared, so the interrupted search restarts later (rare).
      this.queue.unshift(prev);
      this.active = null;
    }
    this.begin(req);
    while (req.status === 'pending') this.step(req, 1 << 30);
    return req.path;
  }

  private begin(req: PathRequest): void {
    this.active = req;
    this.gen++;
    this.expanded = 0;
    this.heapN = 0;
    const g = this.g;
    this.goalXs.length = 0;
    this.goalYs.length = 0;
    for (const gl of req.goals) {
      this.goalMark[gl] = this.gen;
      this.goalXs.push(gl % g.w);
      this.goalYs.push((gl / g.w) | 0);
    }
    this.seen[req.start] = this.gen;
    this.gScore[req.start] = 0;
    this.parent[req.start] = -1;
    this.push(req.start, this.h(req.start));
    req.navVersion = g.navVersion;
  }

  private h(cell: number): number {
    const w = this.g.w;
    const x = cell % w, y = (cell / w) | 0;
    let best = 1e9;
    const xs = this.goalXs, ys = this.goalYs;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - x) + 0.7 * Math.abs(ys[i] - y);
      if (d < best) best = d;
    }
    return best;
  }

  private step(req: PathRequest, budget: number): number {
    const gen = this.gen;
    while (this.heapN > 0 && budget > 0) {
      const cur = this.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      budget--;
      this.expanded++;
      this.stats.expanded++;
      if (this.goalMark[cur] === gen) {
        this.finish(req, cur);
        return budget;
      }
      if (this.expanded > MAX_NODES_PER_SEARCH) break;
      const n = neighbors(this.g, cur, this.nC, this.nT, this.nK);
      const gc = this.gScore[cur];
      for (let i = 0; i < n; i++) {
        const t = this.nC[i];
        if (this.closed[t] === gen) continue;
        const ng = gc + this.nK[i];
        if (this.seen[t] !== gen || ng < this.gScore[t]) {
          this.seen[t] = gen;
          this.gScore[t] = ng;
          this.parent[t] = cur;
          this.pType[t] = this.nT[i];
          this.pCost[t] = this.nK[i];
          this.push(t, ng + this.h(t));
        }
      }
    }
    if (this.heapN === 0 || this.expanded > MAX_NODES_PER_SEARCH) {
      req.status = 'failed';
      this.active = null;
      this.stats.searches++;
    }
    return budget;
  }

  private finish(req: PathRequest, goal: number): void {
    const cells: number[] = [], types: number[] = [], costs: number[] = [];
    let c = goal;
    while (c !== req.start) {
      cells.push(c);
      types.push(this.pType[c]);
      costs.push(this.pCost[c]);
      c = this.parent[c];
    }
    cells.reverse(); types.reverse(); costs.reverse();
    req.path = { cells: Int32Array.from(cells), types: Uint8Array.from(types), costs: Float32Array.from(costs) };
    req.status = 'found';
    this.active = null;
    this.stats.searches++;
  }

  // --- binary min-heap ---
  private push(cell: number, f: number): void {
    if (this.heapN === this.heapCell.length) {
      const nc = new Int32Array(this.heapN * 2); nc.set(this.heapCell); this.heapCell = nc;
      const nf = new Float32Array(this.heapN * 2); nf.set(this.heapF); this.heapF = nf;
    }
    let i = this.heapN++;
    const hc = this.heapCell, hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hc[i] = hc[p]; hf[i] = hf[p];
      i = p;
    }
    hc[i] = cell; hf[i] = f;
  }

  private pop(): number {
    const hc = this.heapCell, hf = this.heapF;
    const top = hc[0];
    const n = --this.heapN;
    if (n > 0) {
      const lc = hc[n], lf = hf[n];
      let i = 0;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        if (l + 1 < n && hf[l + 1] < hf[l]) l++;
        if (hf[l] >= lf) break;
        hc[i] = hc[l]; hf[i] = hf[l];
        i = l;
      }
      hc[i] = lc; hf[i] = lf;
    }
    return top;
  }
}
