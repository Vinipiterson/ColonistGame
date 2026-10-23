// The simulation root. Owns all sim state and runs one fixed tick at a time.
//
// Tick order:
//   1. apply queued player commands
//   2. path service runs searches (node budget)
//   3. every colonist updates (needs, movement, work, using buildings, falls)
//   4. grid changes from this tick -> region rebuild + path revalidation
//   5. idle colonists get jobs (assignment budget); printers queue ration jobs
//   6. emergency preemption (every 10 ticks)

import {
  BUILDS, BLADDER_HOLD_LIMIT, BED_SLEEP_RATE, DECONSTRUCT_REFUND, DIRTY_THRESHOLD, DIRTY_WORK_SPEED, DT,
  EAT_TIME_STANDING, EAT_TIME_TABLE, EMERGENCY, EXHAUST_DAMAGE, FLOOR_SLEEP_FACTOR, GRAVITY, NEEDS,
  NEED_DEFS, PRINTER_PRIORITY, PRINTER_PRIORITY_SHORT, PRINTER_WORK, RESOURCES, SHOWER_TIME,
  SINK_HYGIENE, SINK_TIME, SKIP_SINK_HYGIENE, SLEEP_HEAL, STARVE_DAMAGE, START_RESOURCES, TILE_INFO,
  TOILET_TIME, Tile, WALK_SPEED, fallDamage, type BuildKind, type NeedId, type ResourceId,
} from './defs';
import {
  BuildingStore, buildingPlacements, canPlaceBuilding, freeSlot, slotUsable, useCell, type Building,
} from './buildings';
import { Colonist, NAMES, TINTS, type NeedTaskKind } from './colonist';
import { normRect, type Command, type SimEvent } from './commands';
import { Grid, type Rect } from './grid';
import { MAX_NEIGHBORS, Move, canOccupy, canStand, edgeDuration, edgeValid, landingY, neighbors } from './nav';
import {
  JOB_CHUNK, OrderStore, canPlaceBuild, canPlaceDeconstruct, canPlaceDig, hasWorkPositions, inReach,
  needsDig, orderCost, orderIsSolidBuild, orderStillValid, workPositions, type Order,
} from './orders';
import { PathService, type Path } from './pathfinder';
import { Regions } from './regions';
import { Rng } from './rng';
import { generateWorld } from './worldgen';

export interface WorldOptions {
  seed: number;
  w?: number;
  h?: number;
  colonists?: number;
}

const REVALIDATE_MARGIN = 4;
const IDLE_RETRY_TICKS = 20;
const IDLE_RETRY_MAX = 120;
const MAX_JOB_CHECKS = 600;
/** Seconds a colonist hangs on when the ground vanishes, looking for a side step, before falling. */
const SCRAMBLE_GRACE = 1.0;
const SCRAMBLE_STEP_TIME = 0.35;
/** A wall waits this long for colonists to leave its cell, then goes up and pushes them out. */
const WALL_WAIT_TICKS = 40;
const SEAL_DEFER_TICKS = 40;
const EVAC_SEARCH_NODES = 400;
/** Needs are evaluated once a second per colonist, staggered by id. */
const NEED_CHECK_TICKS = 20;
/** No building for a need was reachable: look again after this many ticks. */
const NEED_RETRY_TICKS = 100;
/** How often each colonist checks whether it is cut off from the colony. */
const STUCK_CHECK_TICKS = 100;

const NEED_TASK: Record<NeedId, NeedTaskKind> = { hunger: 'eat', sleep: 'sleep', bladder: 'toilet', hygiene: 'shower' };
const TASK_BUILDING: Record<NeedTaskKind, BuildKind | null> = {
  eat: 'table', sleep: 'bed', toilet: 'toilet', sink: 'sink', shower: 'shower',
};

export class World {
  readonly grid: Grid;
  readonly regions: Regions;
  readonly paths: PathService;
  readonly buildings: BuildingStore;
  readonly orders: OrderStore;
  readonly rng: Rng;
  colonists: Colonist[] = [];
  resources: Record<ResourceId, number> = { ...START_RESOURCES };
  tick = 0;
  events: SimEvent[] = [];
  gameOver = false;
  /** Where new colonists appear. */
  spawn = { x: 0, y: 0 };

  pathBudget = 40_000;
  assignBudget = 25;

  private cmdQueue: Command[] = [];
  private idleQueue: Colonist[] = [];
  private wakeIdle = false;
  /** A build was skipped for lack of resources: wake idle colonists when resources arrive. */
  private buildsWaiting = false;
  private nextColonistId = 1;
  /** Ration Printer id -> its pending operate order. */
  private printerOrders = new Map<number, Order>();
  private nc = new Int32Array(MAX_NEIGHBORS);
  private nt = new Uint8Array(MAX_NEIGHBORS);
  private nk = new Float32Array(MAX_NEIGHBORS);

  static create(opts: WorldOptions): World {
    const gen = generateWorld(opts.w ?? 192, opts.h ?? 128, opts.seed);
    const world = new World(gen.grid, opts.seed);
    world.spawn = gen.spawn;
    const n = opts.colonists ?? 3;
    for (let i = 0; i < n; i++) world.spawnColonist(gen.spawn.x - 1 + (i % 3), gen.spawn.y);
    return world;
  }

  constructor(grid: Grid, seed: number) {
    this.grid = grid;
    this.rng = new Rng(seed);
    this.regions = new Regions(grid);
    this.paths = new PathService(grid, this.regions);
    this.buildings = new BuildingStore(grid);
    this.orders = new OrderStore(grid, this.buildings);
    grid.dirty.length = 0;
  }

  get seconds(): number {
    return this.tick * DT;
  }
  get aliveCount(): number {
    let n = 0;
    for (const c of this.colonists) if (c.alive) n++;
    return n;
  }

  spawnColonist(x: number, y: number): Colonist {
    const id = this.nextColonistId++;
    const name = NAMES[(id - 1) % NAMES.length] + (id > NAMES.length ? ` ${Math.ceil(id / NAMES.length)}` : '');
    const c = new Colonist(id, name, this.rng.pick(TINTS));
    c.placeAt(this.grid.idx(x, y), this.grid.w);
    c.phase = this.rng.next() * Math.PI * 2;
    // stagger starting needs so the colony doesn't all queue for the toilet at once
    for (const n of NEEDS) c.needs[n] = 70 + this.rng.next() * 30;
    this.colonists.push(c);
    return c;
  }

  issue(cmd: Command): void {
    this.cmdQueue.push(cmd);
  }

  /** Run n ticks. */
  run(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }

  step(): void {
    if (this.gameOver) return;
    this.tick++;
    for (const cmd of this.cmdQueue) this.applyCommand(cmd);
    this.cmdQueue.length = 0;

    this.paths.process(this.pathBudget);
    for (const c of this.colonists) this.updateColonist(c);
    this.processNavChanges();

    if (this.wakeIdle) {
      this.wakeIdle = false;
      this.buildsWaiting = false;
      for (const c of this.colonists) {
        if (c.state === 'idle') {
          c.retryAt = this.tick;
          c.failCount = 0;
        }
      }
    }
    if (this.tick % 20 === 0) this.managePrinters();
    this.runAssignment();
    if (this.tick % 10 === 0) this.emergencyPreemption();
  }

  // ------------------------------------------------------------------ commands

  private forRect(r: Rect, fn: (cell: number) => void): void {
    const g = this.grid;
    const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0);
    const x1 = Math.min(g.w - 1, r.x1), y1 = Math.min(g.h - 1, r.y1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * g.w + x);
  }

  applyCommand(cmd: Command): void {
    const g = this.grid;
    const rect = normRect(cmd.rect.x0, cmd.rect.y0, cmd.rect.x1, cmd.rect.y1);
    switch (cmd.type) {
      case 'dig':
        this.forRect(rect, (cell) => {
          const ex = this.orders.at(cell);
          if (ex) { if (ex.kind === 'dig') this.orders.setPriority(ex, cmd.priority); return; }
          if (canPlaceDig(g, cell)) this.orders.create('dig', cell, cmd.priority, null);
        });
        break;
      case 'build': {
        const d = BUILDS[cmd.kind];
        if (d.shape === 'building') {
          for (const p of buildingPlacements(rect, cmd.kind)) {
            if (!canPlaceBuilding(g, cmd.kind, p.x, p.y)) continue;
            this.orders.create('build', g.idx(p.x, p.y), cmd.priority, cmd.kind, { flip: !!cmd.flip });
          }
          break;
        }
        this.forRect(rect, (cell) => {
          const ex = this.orders.at(cell);
          if (ex) {
            if (ex.kind === 'build' && ex.build === cmd.kind && ex.cells.length === 1) {
              this.orders.setPriority(ex, cmd.priority);
              ex.flip = !!cmd.flip;
              return;
            }
            // a pending dig (or a different tile build) on this cell is replaced by the new build
            if (ex.kind === 'deconstruct' || ex.cells.length > 1 || !canPlaceBuild(g, cell, cmd.kind, true)) return;
            this.cancelOrder(ex);
          } else if (!canPlaceBuild(g, cell, cmd.kind)) return;
          this.orders.create('build', cell, cmd.priority, cmd.kind, { flip: !!cmd.flip });
        });
        break;
      }
      case 'deconstruct':
        this.forRect(rect, (cell) => {
          const ex = this.orders.at(cell);
          if (ex) { if (ex.kind === 'deconstruct') this.orders.setPriority(ex, cmd.priority); return; }
          const b = this.buildings.at(cell);
          if (b) {
            const anchor = g.idx(b.x, b.y);
            if (g.order[anchor] < 0) this.orders.create('deconstruct', anchor, cmd.priority, null, { buildingId: b.id });
            return;
          }
          if (canPlaceDeconstruct(g, cell)) this.orders.create('deconstruct', cell, cmd.priority, null);
        });
        break;
      case 'cancel':
        this.forRect(rect, (cell) => {
          const o = this.orders.at(cell);
          if (o) this.cancelOrder(o);
        });
        break;
    }
    this.wakeIdle = true;
  }

  cancelOrder(o: Order): void {
    if (o.claimedBy >= 0) {
      const c = this.colonists.find((k) => k.id === o.claimedBy);
      if (c && c.job === o) this.dropJob(c, false);
    }
    if (o.paid) this.refund(orderCost(o), 1);
    if (o.kind === 'operate') this.printerOrders.delete(o.buildingId);
    this.orders.remove(o);
  }

  // ------------------------------------------------------------------ resources

  canAfford(cost: Partial<Record<ResourceId, number>>): boolean {
    for (const r of RESOURCES) if ((cost[r] ?? 0) > this.resources[r]) return false;
    return true;
  }
  private pay(cost: Partial<Record<ResourceId, number>>): void {
    for (const r of RESOURCES) this.resources[r] -= cost[r] ?? 0;
  }
  private refund(cost: Partial<Record<ResourceId, number>>, frac: number): void {
    for (const r of RESOURCES) this.resources[r] += Math.floor((cost[r] ?? 0) * frac);
    if (this.buildsWaiting) this.wakeIdle = true;
  }

  // ------------------------------------------------------------------ ration printers

  /** Meals the colony tries to keep in stock. */
  get foodTarget(): number {
    return Math.max(4, 2 * this.aliveCount);
  }

  /** Each printer gets one "print a meal" job while the stock is below target. */
  private managePrinters(): void {
    const printers = this.buildings.ofKind('printer');
    if (printers.size === 0) return;
    let planned = this.resources.food + this.printerOrders.size;
    const short = this.resources.food < this.aliveCount;
    for (const b of printers) {
      const existing = this.printerOrders.get(b.id);
      if (existing) {
        if (existing.removed) this.printerOrders.delete(b.id);
        else {
          const p = short ? PRINTER_PRIORITY_SHORT : PRINTER_PRIORITY;
          if (existing.priority < p) this.orders.setPriority(existing, p);
          continue;
        }
      }
      if (planned >= this.foodTarget) continue;
      const o = this.orders.create('operate', useCell(this.grid, b, 0), short ? PRINTER_PRIORITY_SHORT : PRINTER_PRIORITY, null, {
        buildingId: b.id, work: PRINTER_WORK,
      });
      this.printerOrders.set(b.id, o);
      planned++;
      this.wakeIdle = true;
    }
  }

  // ------------------------------------------------------------------ jobs

  private needsPayment(o: Order): boolean {
    return !o.paid && (o.kind === 'operate' || (o.kind === 'build' && !needsDig(this.grid, o)));
  }

  /**
   * Find the best reachable job for c at or above minPriority. Does not claim it.
   * Walks priority buckets from the top; inside a bucket, searches job chunks in rings
   * around the colonist, so the cost depends on nearby jobs, not on the total job count.
   */
  findJob(c: Colonist, minPriority = 1): { order: Order; goals: number[] } | null {
    const rid = this.regions.regionOf(c.cell);
    if (rid < 0) return null;
    const reach = this.regions.reachableFrom(rid)!;
    const rver = this.regions.version;
    const g = this.grid;
    const os = this.orders;
    const ccx = (c.x / JOB_CHUNK) | 0, ccy = (c.y / JOB_CHUNK) | 0;
    const maxR = Math.max(os.jcw, os.jch);
    const cand: Order[] = [];
    let checks = 0;
    for (let p = EMERGENCY; p >= minPriority; p--) {
      const total = os.availCount[p];
      if (total === 0) continue;
      const row = os.spatial[p];
      let seen = 0;
      for (let r = 0; r <= maxR && seen < total; r++) {
        cand.length = 0;
        for (let cy = ccy - r; cy <= ccy + r; cy++) {
          if (cy < 0 || cy >= os.jch) continue;
          const edgeRow = cy === ccy - r || cy === ccy + r;
          for (let cx = ccx - r; cx <= ccx + r; cx += edgeRow ? 1 : 2 * r || 1) {
            if (cx < 0 || cx >= os.jcw) continue;
            const set = row[cy * os.jcw + cx];
            if (!set || set.size === 0) continue;
            for (const o of set) {
              if (o.claimedBy >= 0) continue;
              seen++;
              if (o.unreach && o.unreach.get(rid) === rver) continue;
              if (o.deferUntil > this.tick) continue;
              if (this.waitsForBelow(o)) continue;
              if (this.needsPayment(o) && !this.canAfford(orderCost(o))) {
                this.buildsWaiting = true;
                continue;
              }
              cand.push(o);
            }
          }
        }
        if (cand.length === 0) continue;
        cand.sort((a, b) => Math.abs(a.x - c.x) + Math.abs(a.y - c.y) - Math.abs(b.x - c.x) - Math.abs(b.y - c.y));
        for (const o of cand) {
          if (++checks > MAX_JOB_CHECKS) return null;
          if (!orderStillValid(g, o, this.buildings)) continue;
          const goals = this.reachableGoals(o, reach, rid);
          if (goals.length) return { order: o, goals };
          (o.unreach ??= new Map()).set(rid, rver);
        }
      }
    }
    return null;
  }

  /**
   * Reachable work positions, best class first: normal spots, then spots inside another pending
   * wall (that wall will wait for us), then standing on top of a tile we are about to dig out.
   * A spot only counts if the colonist could also walk back from it to where it is now
   * (`homeRid`): nobody takes a job at the bottom of a pit it could only drop into. Spots inside
   * planned walls are the exception (filling a pit pushes the builder up and out).
   */
  private reachableGoals(o: Order, reach: Uint8Array, homeRid: number): number[] {
    const cr = this.regions.cellRegion;
    const wp = workPositions(this.grid, o, this.buildings, this.orders.pendingSolid);
    const forward = (cell: number) => {
      const r = cr[cell];
      return r >= 0 && r < reach.length && reach[r] === 1;
    };
    const roundTrip = (cell: number) => {
      if (!forward(cell)) return false;
      const r = cr[cell];
      if (r === homeRid || homeRid < 0) return true;
      const back = this.regions.reachableFrom(r);
      return !!back && homeRid < back.length && back[homeRid] === 1;
    };
    let f = wp.preferred.filter(roundTrip);
    if (f.length) return f;
    // Inside another planned wall: no way back needed, that wall pushes us up when it goes up.
    f = wp.inPending.filter(forward);
    if (f.length) return f;
    return wp.onTop.filter(roundTrip);
  }

  private runAssignment(): void {
    // enqueue idle colonists whose retry time has come
    for (const c of this.colonists) {
      if (c.state === 'idle' && !c.inQueue && this.tick >= c.retryAt) {
        c.inQueue = true;
        this.idleQueue.push(c);
      }
    }
    let budget = this.assignBudget;
    while (budget-- > 0 && this.idleQueue.length) {
      const c = this.idleQueue.shift()!;
      c.inQueue = false;
      if (c.state !== 'idle') continue;
      const found = this.findJob(c);
      if (!found) {
        // exponential backoff: nothing reachable now, look again later (or when woken)
        c.retryAt = this.tick + Math.min(IDLE_RETRY_MAX, IDLE_RETRY_TICKS << c.failCount) + (c.id % 7);
        if (c.failCount < 4) c.failCount++;
        continue;
      }
      c.failCount = 0;
      this.takeJob(c, found.order, found.goals);
    }
  }

  private takeJob(c: Colonist, o: Order, goals: number[]): void {
    this.orders.claim(o, c.id);
    c.job = o;
    c.goal = 'job';
    this.requestPath(c, goals);
  }

  private emergencyPreemption(): void {
    if (!this.orders.hasUnclaimedEmergency()) return;
    for (const c of this.colonists) {
      if (c.state === 'dead' || c.state === 'falling' || c.state === 'scrambling' || c.state === 'using') continue;
      if (c.goal === 'need') continue;
      if (c.job && c.job.priority === EMERGENCY) continue;
      const found = this.findJob(c, EMERGENCY);
      if (!found) continue;
      if (c.job) this.dropJob(c, true);
      this.takeJob(c, found.order, found.goals);
      if (!this.orders.hasUnclaimedEmergency()) return;
    }
  }

  /** Release the colonist's job (order stays). Leaves the colonist idle in place. */
  private dropJob(c: Colonist, retryNow: boolean): void {
    if (c.job && c.job.claimedBy === c.id) this.orders.claim(c.job, -1);
    c.job = null;
    if (c.goal === 'job') c.goal = null;
    this.paths.cancel(c.req);
    c.req = null;
    if (c.state === 'moving') this.snapToNearestCell(c);
    c.path = null;
    if (c.state === 'moving' || c.state === 'pathing' || c.state === 'working') c.state = 'idle';
    c.retryAt = retryNow ? this.tick : this.tick + IDLE_RETRY_TICKS;
  }

  // ------------------------------------------------------------------ paths

  private requestPath(c: Colonist, goals: number[]): void {
    this.paths.cancel(c.req);
    c.req = this.paths.request(c.cell, goals);
    c.state = 'pathing';
    c.path = null;
    this.handlePathResult(c); // instant results (fast fail / already there)
  }

  /** Recompute goals for the colonist's current job and re-path, or give the job up. */
  private repathToJob(c: Colonist): void {
    const o = c.job;
    if (!o || o.removed || !orderStillValid(this.grid, o, this.buildings)) {
      this.dropJob(c, true);
      return;
    }
    const rid = this.regions.regionOf(c.cell);
    const reach = this.regions.reachableFrom(rid);
    const goals = reach ? this.reachableGoals(o, reach, rid) : [];
    if (!goals.length) {
      if (rid >= 0) (o.unreach ??= new Map()).set(rid, this.regions.version);
      this.dropJob(c, true); // reassign to the next-best reachable job right away
      return;
    }
    this.requestPath(c, goals);
  }

  /** The path to whatever the colonist was doing broke: try again or give it up. */
  private repathCurrentGoal(c: Colonist): void {
    c.path = null;
    c.state = 'idle';
    if (c.goal === 'job') this.repathToJob(c);
    else if (c.goal === 'need') this.repathToNeed(c);
    else c.goal = null;
  }

  private handlePathResult(c: Colonist): void {
    const req = c.req;
    if (!req || req.status === 'pending') return;
    c.req = null;
    if (req.status === 'failed') {
      if (c.goal === 'job' && c.job) {
        const rid = this.regions.regionOf(c.cell);
        if (rid >= 0) (c.job.unreach ??= new Map()).set(rid, this.regions.version);
        this.dropJob(c, true);
      } else if (c.goal === 'need') {
        this.abandonNeed(c, true);
      } else {
        c.goal = null;
        c.state = 'idle';
        c.retryAt = this.tick + IDLE_RETRY_TICKS;
      }
      return;
    }
    const path = req.path!;
    if (req.navVersion !== this.grid.navVersion && !this.pathStillValid(c.cell, path, 0)) {
      this.repathCurrentGoal(c);
      return;
    }
    this.startPath(c, path);
  }

  private startPath(c: Colonist, path: Path): void {
    c.path = path;
    c.pathI = 0;
    c.edgeT = 0;
    c.edgeDur = 0;
    const g = this.grid;
    let x0 = c.x, y0 = c.y, x1 = c.x, y1 = c.y;
    for (const cell of path.cells) {
      const x = cell % g.w, y = (cell / g.w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    c.pathBox = { x0, y0: y0 - 1, x1, y1 };
    if (path.cells.length === 0) this.arrive(c);
    else c.state = 'moving';
  }

  private pathStillValid(from: number, path: Path, startI: number): boolean {
    let prev = from;
    for (let i = startI; i < path.cells.length; i++) {
      if (!edgeValid(this.grid, prev, path.cells[i], path.types[i])) return false;
      prev = path.cells[i];
    }
    return true;
  }

  // ------------------------------------------------------------------ nav changes

  private processNavChanges(): void {
    const g = this.grid;
    if (g.dirty.length === 0) return;
    const rects = g.dirty;
    g.dirty = [];
    for (const r of rects) this.regions.markRect(r);
    this.regions.update();
    this.refreshOrdersNear(rects);
    for (const c of this.colonists) {
      if (c.state !== 'moving' || !c.path) continue;
      const b = c.pathBox;
      let hit = false;
      for (const r of rects) {
        if (r.x1 + REVALIDATE_MARGIN >= b.x0 && r.x0 - REVALIDATE_MARGIN <= b.x1 &&
            r.y1 + REVALIDATE_MARGIN >= b.y0 && r.y0 - REVALIDATE_MARGIN <= b.y1) { hit = true; break; }
      }
      if (!hit) continue;
      const path = c.path;
      const from = c.edgeT === 0 ? c.cell : c.edgeFrom;
      const curOk = edgeValid(g, from, path.cells[c.pathI], path.types[c.pathI]);
      if (curOk && this.pathStillValid(path.cells[c.pathI], path, c.pathI + 1)) continue;
      if (!curOk) this.snapToNearestCell(c);
      this.repathCurrentGoal(c);
    }
  }

  /** Orders whose reach area overlaps a changed rect may have become (un)workable. */
  private refreshOrdersNear(rects: Rect[]): void {
    const g = this.grid;
    for (const r of rects) {
      const x0 = Math.max(0, r.x0 - 1), x1 = Math.min(g.w - 1, r.x1 + 1);
      const y0 = Math.max(0, r.y0 - 4), y1 = Math.min(g.h - 1, r.y1 + 2);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const id = g.order[y * g.w + x];
          if (id < 0) continue;
          const o = this.orders.get(id);
          if (o) this.orders.refreshActive(o);
        }
      }
    }
  }

  /** Abort a mid-edge move: settle on whichever end of the edge is closer. */
  private snapToNearestCell(c: Colonist): void {
    if (!c.path || c.edgeT === 0) {
      c.edgeT = 0;
      return;
    }
    const to = c.path.cells[c.pathI];
    const target = c.edgeT >= 0.5 ? to : c.edgeFrom;
    c.cell = target;
    c.x = target % this.grid.w;
    c.y = (target / this.grid.w) | 0;
    c.px = c.x;
    c.py = c.y;
    c.edgeT = 0;
    c.edgeDur = 0;
  }

  // ------------------------------------------------------------------ colonist update

  private updateColonist(c: Colonist): void {
    c.prevPx = c.px;
    c.prevPy = c.py;
    if (c.state === 'dead') return;
    this.updateNeeds(c);
    if (!c.alive) return;
    if (c.state === 'falling') {
      this.updateFall(c);
      return;
    }
    if (c.state === 'scrambling') {
      this.updateScramble(c);
      return;
    }
    if (c.state !== 'moving' || c.edgeT === 0) {
      // stationary (or at a cell boundary): check we are still supported
      if (!canStand(this.grid, c.x, c.y)) {
        if (canOccupy(this.grid, c.x, c.y)) {
          if (c.state === 'using') this.abandonNeed(c, false);
          this.startScramble(c);
          return;
        }
        this.unstick(c);
      }
    }
    if ((this.tick + c.id) % NEED_CHECK_TICKS === 0) this.checkNeeds(c);
    if ((this.tick + c.id) % STUCK_CHECK_TICKS === 0) this.checkStuck(c);
    switch (c.state) {
      case 'idle':
        this.maybeEvacuate(c);
        break;
      case 'pathing':
        this.handlePathResult(c);
        break;
      case 'moving':
        this.advanceMove(c);
        break;
      case 'working':
        this.doWork(c);
        break;
      case 'using':
        this.doUse(c);
        break;
    }
  }

  // ------------------------------------------------------------------ needs

  /** Decay needs, apply sleep recovery, and the damage / death timers at zero. */
  private updateNeeds(c: Colonist): void {
    const n = c.needs;
    const t = c.needTask;
    const sleeping = c.state === 'using' && t?.kind === 'sleep';
    for (const k of NEEDS) {
      if (k === 'sleep' && sleeping) continue;
      n[k] = Math.max(0, n[k] - NEED_DEFS[k].decay * DT);
    }
    if (sleeping) {
      const rate = BED_SLEEP_RATE * (t!.buildingId >= 0 ? 1 : FLOOR_SLEEP_FACTOR);
      n.sleep = Math.min(100, n.sleep + rate * DT);
      c.health = Math.min(100, c.health + SLEEP_HEAL * DT);
    }
    if (n.hunger <= 0) {
      c.health -= STARVE_DAMAGE * DT;
      if (c.health <= 0) return this.kill(c, 'starved');
    }
    if (n.sleep <= 0) {
      c.health -= EXHAUST_DAMAGE * DT;
      if (c.health <= 0) return this.kill(c, 'exhaustion');
    }
    if (n.bladder <= 0) {
      c.bladderHold += DT;
      if (c.bladderHold >= BLADDER_HOLD_LIMIT) return this.kill(c, 'held their bladder too long');
    } else c.bladderHold = 0;
  }

  /** The most pressing need below its "want" line, and how bad it is. */
  private pressingNeed(c: Colonist): { need: NeedId; level: 'want' | 'urgent' | 'critical' } | null {
    let best: NeedId | null = null;
    let bestScore = 1;
    for (const k of NEEDS) {
      const d = NEED_DEFS[k];
      const v = c.needs[k];
      if (v >= d.want) continue;
      const score = v / d.want;
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (!best) return null;
    const d = NEED_DEFS[best];
    const v = c.needs[best];
    return { need: best, level: v < d.critical ? 'critical' : v < d.urgent ? 'urgent' : 'want' };
  }

  /** Once a second: decide whether to leave what we are doing to take care of a need. */
  private checkNeeds(c: Colonist): void {
    if (c.goal === 'need' || c.goal === 'evacuate') return;
    if (c.state !== 'idle' && c.state !== 'pathing' && c.state !== 'moving' && c.state !== 'working') return;
    const p = this.pressingNeed(c);
    if (!p) return;
    if (this.tick < c.needRetryAt && p.level !== 'critical') return;
    const busy = !!c.job;
    const allowed =
      p.level === 'critical' ||
      (p.level === 'urgent' && (!busy || c.job!.priority < EMERGENCY)) ||
      (p.level === 'want' && !busy);
    if (!allowed) return;
    this.startNeed(c, NEED_TASK[p.need]);
  }

  /** Nearest reachable building of a kind with a free, usable slot. */
  private findNeedBuilding(c: Colonist, kind: BuildKind): { b: Building; slot: number } | null {
    let best: { b: Building; slot: number } | null = null;
    let bestD = 1e9;
    for (const b of this.buildings.ofKind(kind)) {
      const slot = freeSlot(b);
      if (slot < 0 || !slotUsable(this.grid, b, slot)) continue;
      const uc = useCell(this.grid, b, slot);
      const d = Math.abs(b.x - c.x) + Math.abs(b.y - c.y);
      if (d >= bestD) continue;
      if (!this.regions.canReach(c.cell, uc)) continue;
      best = { b, slot };
      bestD = d;
    }
    return best;
  }

  /**
   * Leave the current job (remembered for later) and go take care of a need.
   * Sleep and eating fall back to the floor / standing up when there is no building.
   */
  private startNeed(c: Colonist, kind: NeedTaskKind): boolean {
    if (kind === 'eat' && this.resources.food < 1) {
      c.needRetryAt = this.tick + NEED_RETRY_TICKS;
      if (c.needs.hunger < NEED_DEFS.hunger.urgent && this.tick % 600 < NEED_CHECK_TICKS) {
        this.events.push({ type: 'needFail', colonistId: c.id, name: c.name, text: 'is hungry and there are no meals' });
      }
      return false;
    }
    const bkind = TASK_BUILDING[kind];
    const target = bkind ? this.findNeedBuilding(c, bkind) : null;
    if (!target && (kind === 'toilet' || kind === 'sink' || kind === 'shower')) {
      c.needRetryAt = this.tick + NEED_RETRY_TICKS;
      if (kind === 'toilet' && c.needs.bladder < NEED_DEFS.bladder.urgent && this.tick % 600 < NEED_CHECK_TICKS) {
        this.events.push({ type: 'needFail', colonistId: c.id, name: c.name, text: 'needs a toilet and can\'t reach one' });
      }
      return false;
    }
    // suspend the current job
    if (c.job) {
      c.resumeOrder = c.job;
      this.dropJob(c, true);
    }
    this.paths.cancel(c.req);
    c.req = null;
    if (c.state === 'moving') this.snapToNearestCell(c);
    c.path = null;
    c.goal = 'need';
    if (target) {
      target.b.users[target.slot] = c.id;
      c.needTask = { kind, buildingId: target.b.id, slot: target.slot, timer: 0 };
      this.requestPath(c, [useCell(this.grid, target.b, target.slot)]);
    } else {
      // floor nap / eat standing up, right here
      c.needTask = { kind, buildingId: -1, slot: 0, timer: 0 };
      this.beginUse(c);
    }
    return true;
  }

  private repathToNeed(c: Colonist): void {
    const t = c.needTask;
    const b = t && t.buildingId >= 0 ? this.buildings.get(t.buildingId) : undefined;
    if (!t || !b) {
      this.abandonNeed(c, true);
      return;
    }
    const uc = useCell(this.grid, b, t.slot);
    if (!this.regions.canReach(c.cell, uc)) {
      this.abandonNeed(c, true);
      return;
    }
    this.requestPath(c, [uc]);
  }

  /** Arrived (or doing it on the spot): start using. Eating takes the meal now. */
  private beginUse(c: Colonist): void {
    const t = c.needTask!;
    if (t.buildingId >= 0) {
      const b = this.buildings.get(t.buildingId);
      if (!b || b.users[t.slot] !== c.id || useCell(this.grid, b, t.slot) !== c.cell) {
        this.abandonNeed(c, true);
        return;
      }
    }
    if (t.kind === 'eat') {
      if (this.resources.food < 1) {
        this.abandonNeed(c, true);
        return;
      }
      this.resources.food -= 1;
    }
    t.timer = 0;
    c.state = 'using';
  }

  private useDuration(c: Colonist): number {
    const t = c.needTask!;
    switch (t.kind) {
      case 'eat': return t.buildingId >= 0 ? EAT_TIME_TABLE : EAT_TIME_STANDING;
      case 'toilet': return TOILET_TIME;
      case 'sink': return SINK_TIME;
      case 'shower': return SHOWER_TIME;
      case 'sleep': return Infinity; // until rested
    }
  }

  private doUse(c: Colonist): void {
    const t = c.needTask;
    if (!t) {
      c.state = 'idle';
      return;
    }
    if (t.buildingId >= 0 && !this.buildings.get(t.buildingId)) {
      this.abandonNeed(c, false); // building removed under us
      return;
    }
    t.timer += DT;
    c.phase += DT * 2;
    if (t.kind === 'sleep') {
      // wake up rested, or because another need became urgent
      if (c.needs.sleep >= 100) return this.finishNeed(c);
      if ((this.tick + c.id) % NEED_CHECK_TICKS === 0) {
        for (const k of NEEDS) {
          if (k !== 'sleep' && k !== 'hygiene' && c.needs[k] < NEED_DEFS[k].urgent) return this.finishNeed(c);
        }
      }
      return;
    }
    if (t.timer >= this.useDuration(c)) this.finishNeed(c);
  }

  /** Apply the effect, free the building, then wash hands or go back to work. */
  private finishNeed(c: Colonist): void {
    const t = c.needTask!;
    const n = c.needs;
    switch (t.kind) {
      case 'eat': n.hunger = 100; break;
      case 'toilet':
        n.bladder = 100;
        c.bladderHold = 0;
        if (this.buildings.ofKind('sink').size > 0) c.sinkPending = true;
        else n.hygiene = Math.max(0, n.hygiene + SKIP_SINK_HYGIENE);
        break;
      case 'sink': n.hygiene = Math.min(100, n.hygiene + SINK_HYGIENE); break;
      case 'shower': n.hygiene = 100; break;
      case 'sleep': break;
    }
    this.releaseNeedBuilding(c);
    c.needTask = null;
    c.goal = null;
    c.state = 'idle';
    if (c.sinkPending) {
      c.sinkPending = false;
      if (this.startNeed(c, 'sink')) return;
      n.hygiene = Math.max(0, n.hygiene + SKIP_SINK_HYGIENE);
    }
    this.resumeWork(c);
  }

  private releaseNeedBuilding(c: Colonist): void {
    const t = c.needTask;
    if (!t || t.buildingId < 0) return;
    const b = this.buildings.get(t.buildingId);
    if (b && b.users[t.slot] === c.id) b.users[t.slot] = -1;
  }

  /** Give up on the need (path broke, building gone...). Needs are re-checked within a second. */
  private abandonNeed(c: Colonist, retryLater: boolean): void {
    this.releaseNeedBuilding(c);
    c.needTask = null;
    if (c.goal === 'need') c.goal = null;
    this.paths.cancel(c.req);
    c.req = null;
    if (c.state === 'moving') this.snapToNearestCell(c);
    c.path = null;
    if (c.state === 'using' || c.state === 'pathing' || c.state === 'moving') c.state = 'idle';
    if (retryLater) c.needRetryAt = this.tick + NEED_RETRY_TICKS;
    this.resumeWork(c);
  }

  /** Take back the job given up for a need, if nobody else took it; otherwise find work. */
  private resumeWork(c: Colonist): void {
    const o = c.resumeOrder;
    c.resumeOrder = null;
    c.retryAt = this.tick;
    if (c.state !== 'idle' || !o || o.removed || o.claimedBy >= 0) return;
    if (!orderStillValid(this.grid, o, this.buildings)) return;
    const rid = this.regions.regionOf(c.cell);
    const reach = this.regions.reachableFrom(rid);
    const goals = reach ? this.reachableGoals(o, reach, rid) : [];
    if (goals.length) this.takeJob(c, o, goals);
  }

  /**
   * Warn the player (once) when a colonist can no longer walk to the colony and back, e.g. after
   * digging itself into a pit. A ladder or stairs gets it out; it keeps working inside meanwhile.
   */
  private checkStuck(c: Colonist): void {
    if (c.state !== 'idle' && c.state !== 'working' && c.state !== 'moving' && c.state !== 'pathing') return;
    const g = this.grid;
    const homes: number[] = [];
    if (canStand(g, this.spawn.x, this.spawn.y)) homes.push(g.idx(this.spawn.x, this.spawn.y));
    for (const kind of ['toilet', 'bed', 'printer'] as BuildKind[]) {
      for (const b of this.buildings.ofKind(kind)) homes.push(useCell(g, b, 0));
    }
    if (!homes.length) return;
    const ok = homes.some((h) => this.regions.canReach(c.cell, h) && this.regions.canReach(h, c.cell));
    if (!ok && !c.stuck) {
      this.events.push({ type: 'needFail', colonistId: c.id, name: c.name, text: 'is stuck and can\'t get back to the colony. Build a ladder or stairs to them' });
    }
    c.stuck = !ok;
  }

  // ------------------------------------------------------------------ losing footing

  /** The ground is gone: hang on for up to SCRAMBLE_GRACE seconds and try to step to the side. */
  private startScramble(c: Colonist): void {
    this.paths.cancel(c.req);
    c.req = null;
    if (c.state === 'moving') this.snapToNearestCell(c);
    c.path = null;
    c.edgeT = 0;
    c.edgeDur = 0;
    c.state = 'scrambling';
    c.scrambleTime = 0;
    c.scrambleTo = -1;
    c.scrambleT = 0;
  }

  /** Side cells a colonist hanging at (x,y) can pull itself onto, best first. */
  private escapeCell(c: Colonist): number {
    const g = this.grid;
    const x = c.x, y = c.y;
    const dirs = [c.facing, -c.facing];
    for (const dx of dirs) if (canStand(g, x + dx, y)) return g.idx(x + dx, y); // level
    for (const dx of dirs) if (canStand(g, x + dx, y - 1) && g.free(x, y - 2)) return g.idx(x + dx, y - 1); // up a step
    for (const dx of dirs) if (canOccupy(g, x + dx, y) && canStand(g, x + dx, y + 1)) return g.idx(x + dx, y + 1); // down a step
    return -1;
  }

  private updateScramble(c: Colonist): void {
    const g = this.grid;
    c.scrambleTime += DT;
    c.phase += DT * 30;
    if (c.scrambleTo < 0) {
      if (canStand(g, c.x, c.y)) {
        this.resumeAfterLanding(c); // ground came back (e.g. a ladder was built)
        return;
      }
      if (!canOccupy(g, c.x, c.y)) {
        this.unstick(c);
        this.resumeAfterLanding(c);
        return;
      }
      const to = this.escapeCell(c);
      if (to >= 0) {
        c.scrambleFrom = c.cell;
        c.scrambleTo = to;
        c.scrambleT = 0;
        c.facing = to % g.w > c.x ? 1 : -1;
      } else if (c.scrambleTime >= SCRAMBLE_GRACE) {
        this.startFall(c);
      }
      return;
    }
    // pulling onto the side cell
    const tx = c.scrambleTo % g.w, ty = (c.scrambleTo / g.w) | 0;
    if (!canStand(g, tx, ty)) {
      c.scrambleTo = -1; // it vanished too: look again (the grace timer keeps running)
      c.px = c.x;
      c.py = c.y;
      return;
    }
    c.scrambleT = Math.min(1, c.scrambleT + DT / SCRAMBLE_STEP_TIME);
    const fx = c.scrambleFrom % g.w, fy = (c.scrambleFrom / g.w) | 0;
    c.px = fx + (tx - fx) * c.scrambleT;
    c.py = fy + (ty - fy) * c.scrambleT;
    if (c.scrambleT >= 1) {
      c.placeAt(c.scrambleTo, g.w);
      c.scrambleTo = -1;
      this.resumeAfterLanding(c);
    }
  }

  /** Back on solid ground: continue the job / need if there is one, otherwise look for work. */
  private resumeAfterLanding(c: Colonist): void {
    c.state = 'idle';
    if (c.goal === 'job' && c.job) this.repathToJob(c);
    else if (c.goal === 'need' && c.needTask) this.repathToNeed(c);
    else {
      c.goal = null;
      c.retryAt = this.tick;
    }
  }

  private startFall(c: Colonist): void {
    this.paths.cancel(c.req);
    c.req = null;
    c.path = null;
    c.edgeT = 0;
    c.state = 'falling';
    c.fallFromY = c.y;
    c.vy = 0;
  }

  private updateFall(c: Colonist): void {
    const g = this.grid;
    c.vy = Math.min(c.vy + GRAVITY * DT, 40);
    c.py += c.vy * DT;
    let ly = landingY(g, c.x, c.fallFromY);
    if (ly < 0) ly = c.fallFromY; // blocked somehow: land where we are
    if (c.py >= ly) {
      c.py = ly;
      c.y = ly;
      c.cell = ly * g.w + c.x;
      const h = ly - c.fallFromY;
      const dmg = fallDamage(h);
      if (dmg > 0) {
        c.health -= dmg;
        this.events.push({ type: 'fall', colonistId: c.id, name: c.name, height: h, damage: dmg });
      }
      if (c.health <= 0) {
        this.kill(c, `fell ${h} tiles`);
        return;
      }
      this.resumeAfterLanding(c);
    } else {
      c.y = Math.floor(c.py);
      c.cell = c.y * g.w + c.x;
    }
  }

  /** The colonist's cell became solid: move to the nearest stand cell (upward first on ties). */
  private unstick(c: Colonist): void {
    const g = this.grid;
    for (let r = 1; r < 8; r++) {
      let best = -1, bestD = 1e9;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!canStand(g, c.x + dx, c.y + dy)) continue;
          const d = Math.abs(dx) + Math.abs(dy) + (dy > 0 ? 0.5 : 0);
          if (d < bestD) { bestD = d; best = g.idx(c.x + dx, c.y + dy); }
        }
      }
      if (best >= 0) {
        c.placeAt(best, g.w);
        return;
      }
    }
  }

  private kill(c: Colonist, cause: string): void {
    if (c.job && c.job.claimedBy === c.id) this.orders.claim(c.job, -1);
    c.job = null;
    this.releaseNeedBuilding(c);
    c.needTask = null;
    c.resumeOrder = null;
    this.paths.cancel(c.req);
    c.req = null;
    c.path = null;
    c.state = 'dead';
    c.health = 0;
    c.deathCause = cause;
    this.events.push({ type: 'death', colonistId: c.id, name: c.name, cause });
    if (this.aliveCount === 0) {
      this.gameOver = true;
      this.events.push({ type: 'gameOver' });
    }
  }

  private advanceMove(c: Colonist): void {
    const g = this.grid;
    const path = c.path!;
    let remain = DT;
    while (remain > 0 && c.state === 'moving') {
      const to = path.cells[c.pathI];
      const type = path.types[c.pathI];
      if (c.edgeT === 0 && c.edgeDur === 0) {
        if (!edgeValid(g, c.cell, to, type)) {
          this.repathCurrentGoal(c);
          return;
        }
        c.edgeFrom = c.cell;
        c.edgeDur = edgeDuration(type, path.costs[c.pathI], WALK_SPEED);
        const tx = to % g.w;
        if (tx !== c.x) c.facing = tx > c.x ? 1 : -1;
      }
      const dt = Math.min(remain, (1 - c.edgeT) * c.edgeDur);
      c.edgeT += dt / c.edgeDur;
      remain -= dt;
      c.phase += dt * 12;
      const fx = c.edgeFrom % g.w, fy = (c.edgeFrom / g.w) | 0;
      const tx = to % g.w, ty = (to / g.w) | 0;
      const t = Math.min(1, c.edgeT);
      if (type === Move.Fall) {
        // sideways first, then drop with ease-in
        const side = fx === tx ? 0 : 0.3;
        c.px = fx + (tx - fx) * Math.min(1, side ? t / side : 1);
        const v = side ? Math.max(0, (t - side) / (1 - side)) : t;
        c.py = fy + (ty - fy) * v * v;
      } else {
        c.px = fx + (tx - fx) * t;
        c.py = fy + (ty - fy) * t;
      }
      if (c.edgeT >= 1 - 1e-6) {
        c.cell = to;
        c.x = tx;
        c.y = ty;
        c.px = tx;
        c.py = ty;
        c.edgeT = 0;
        c.edgeDur = 0;
        c.pathI++;
        if (c.pathI >= path.cells.length) {
          c.path = null;
          this.arrive(c);
        }
      }
    }
  }

  private arrive(c: Colonist): void {
    c.path = null;
    if (c.goal === 'need' && c.needTask) {
      this.beginUse(c);
      return;
    }
    if (c.goal === 'job' && c.job) {
      if (c.job.removed || !orderStillValid(this.grid, c.job, this.buildings)) {
        this.completeOrDiscardInvalid(c);
        return;
      }
      if (!inReach(this.grid, c.job, c.cell, this.buildings)) {
        this.repathToJob(c);
        return;
      }
      c.state = 'working';
      return;
    }
    c.goal = null;
    c.state = 'idle';
    c.retryAt = this.tick;
  }

  private completeOrDiscardInvalid(c: Colonist): void {
    const o = c.job!;
    if (!o.removed) this.cancelOrder(o); // target no longer exists (e.g. dug by a cave-in)
    c.job = null;
    c.goal = null;
    c.state = 'idle';
    c.retryAt = this.tick;
  }

  // ------------------------------------------------------------------ work

  private doWork(c: Colonist): void {
    const g = this.grid;
    const o = c.job;
    if (!o || o.removed) {
      c.job = null;
      c.goal = null;
      c.state = 'idle';
      c.retryAt = this.tick;
      return;
    }
    if (!orderStillValid(g, o, this.buildings)) {
      this.completeOrDiscardInvalid(c);
      return;
    }
    if (!inReach(g, o, c.cell, this.buildings)) {
      this.repathToJob(c);
      return;
    }
    c.phase += DT * 6;
    const speed = c.needs.hygiene < DIRTY_THRESHOLD ? DIRTY_WORK_SPEED : 1;

    // Phase 1 (tile builds on natural tiles): dig the tile out.
    if (needsDig(g, o)) {
      o.digProgress += DT * speed;
      if (o.digProgress >= o.digWork) this.digOut(o.x, o.y);
      return;
    }

    if ((o.kind === 'build' || o.kind === 'operate') && o.progress === 0) {
      // Don't seal off a neighbouring wall order that could still be built from here.
      if (orderIsSolidBuild(o) && (this.waitsForBelow(o) || this.wouldSealNeighbour(o, c) || this.wouldStrand(o))) {
        o.deferUntil = this.tick + SEAL_DEFER_TICKS;
        this.dropJob(c, true);
        return;
      }
      if (!o.paid) {
        const cost = orderCost(o);
        if (!this.canAfford(cost)) {
          this.buildsWaiting = true;
          this.dropJob(c, false);
          return;
        }
        this.pay(cost);
        o.paid = true;
      }
    }

    if (orderIsSolidBuild(o) && this.cellOccupied(o.cell, c)) {
      // Ask whoever is standing in the way to move; after a short wait, build anyway and
      // push them out (otherwise two builders standing in each other's cells wait forever).
      o.waitingClear = true;
      o.waitTicks++;
      this.evictOccupants(o, c);
      if (o.waitTicks < WALL_WAIT_TICKS) return;
    }
    o.waitingClear = false;
    o.progress += DT * speed;
    if (o.progress >= o.work) {
      // re-check: another wall may have gone up next to us while we worked
      if (orderIsSolidBuild(o) && (this.wouldSealNeighbour(o, c) || this.wouldStrand(o))) {
        o.progress = o.work;
        o.deferUntil = this.tick + SEAL_DEFER_TICKS;
        this.dropJob(c, true);
        return;
      }
      this.completeOrder(c, o);
    }
  }

  /** Remove a natural tile and add its yield to the stockpile. */
  private digOut(x: number, y: number): void {
    const g = this.grid;
    const info = TILE_INFO[g.tile[g.idx(x, y)]];
    if (info.yieldRes) {
      this.resources[info.yieldRes] += info.yieldAmount ?? 0;
      if (this.buildsWaiting) this.wakeIdle = true;
    }
    g.setTile(x, y, Tile.Empty, false);
  }

  /**
   * Stacked walls go up bottom-first: a wall waits while the cell below it has a workable pending
   * wall. Anyone standing in the stack is pushed up as it fills instead of being sealed in.
   */
  private waitsForBelow(o: Order): boolean {
    if (!orderIsSolidBuild(o) || o.y + 1 >= this.grid.h) return false;
    const below = this.orders.at(o.cell + this.grid.w);
    return !!below && below.active && orderIsSolidBuild(below) && orderStillValid(this.grid, below, this.buildings);
  }

  /**
   * Would turning o's cell solid leave a nearby pending wall (that this builder can reach now)
   * with no place to stand? Then that one should go up first.
   */
  private wouldSealNeighbour(o: Order, builder: Colonist): boolean {
    const g = this.grid;
    const rid = this.regions.regionOf(builder.cell);
    const reach = this.regions.reachableFrom(rid);
    if (!reach) return false;
    const affected: Order[] = [];
    for (let y = o.y - 2; y <= o.y + 4; y++) {
      for (let x = o.x - 2; x <= o.x + 2; x++) {
        if (!g.inBounds(x, y)) continue;
        const n = this.orders.at(g.idx(x, y));
        if (n && n !== o && orderIsSolidBuild(n) && this.reachableGoals(n, reach, rid).length) affected.push(n);
      }
    }
    if (!affected.length) return false;
    const i = o.cell;
    const saved = g.tile[i];
    g.tile[i] = Tile.Concrete; // hypothetical, restored below (no dirty tracking)
    let seals = false;
    for (const n of affected) {
      if (!hasWorkPositions(workPositions(g, n, this.buildings))) {
        seals = true;
        break;
      }
    }
    g.tile[i] = saved;
    return seals;
  }

  /**
   * Would turning o's cell solid cut a nearby colonist off from a place it can walk to and back
   * from today (beds, toilets, the printer..., the spawn, other colonists)? Stairs are the usual
   * culprit: the space under a staircase loses its headroom. Checked with a real (cheap,
   * incremental) region update on a hypothetical grid, then reverted.
   * Colonists standing in the cell itself (or in another planned wall) are ignored: walls push
   * them out when they go up.
   */
  private wouldStrand(o: Order): boolean {
    const g = this.grid;
    const R = 40;
    const MAX = 48;
    // Cells, not regions: the change itself may split a region, so region ids can't be deduped.
    const near: number[] = [];
    for (const c of this.colonists) {
      if (near.length >= MAX) break;
      if (!c.alive || c.state === 'falling' || c.state === 'scrambling') continue;
      if (Math.abs(c.x - o.x) > R || Math.abs(c.y - o.y) > R) continue;
      if (this.bodyOverlaps(c, o.cell)) continue;
      // standing inside another planned wall: that wall will push them out when it goes up
      if (this.orders.pendingSolid(c.cell) || this.orders.pendingSolid(c.cell - g.w)) continue;
      if (this.regions.regionOf(c.cell) >= 0) near.push(c.cell);
    }
    if (!near.length) return false;
    const places = near.slice();
    const addPlace = (cell: number) => {
      if (places.length < MAX * 2 && this.regions.regionOf(cell) >= 0) places.push(cell);
    };
    for (const kind of ['toilet', 'bed', 'printer', 'table', 'sink', 'shower'] as BuildKind[]) {
      for (const b of this.buildings.ofKind(kind)) {
        if (Math.abs(b.x - o.x) <= R * 2 && Math.abs(b.y - o.y) <= R * 2) addPlace(useCell(g, b, 0));
      }
    }
    addPlace(g.idx(this.spawn.x, this.spawn.y));
    const roundTrips = () => {
      let n = 0;
      for (const a of near) for (const b of places) if (this.regions.canReach(a, b) && this.regions.canReach(b, a)) n++;
      return n;
    };
    const before = roundTrips();
    const i = o.cell;
    const saved = g.tile[i];
    const rect = { x0: o.x, y0: o.y, x1: o.x, y1: o.y };
    g.tile[i] = Tile.Concrete; // hypothetical
    this.regions.markRect(rect);
    const after = roundTrips();
    g.tile[i] = saved;
    this.regions.markRect(rect);
    this.regions.update();
    return after < before;
  }

  /** Is any living colonist other than `except` overlapping this cell (including mid-move)? */
  private cellOccupied(cell: number, except?: Colonist): boolean {
    for (const k of this.colonists) if (k !== except && this.bodyOverlaps(k, cell)) return true;
    return false;
  }

  private bodyOverlaps(k: Colonist, cell: number): boolean {
    if (k.state === 'dead') return false;
    const g = this.grid;
    const x = cell % g.w, y = (cell / g.w) | 0;
    if (x < Math.floor(k.px) || x > Math.ceil(k.px)) return false;
    return y >= Math.floor(k.py) - 1 && y <= Math.ceil(k.py);
  }

  /** Colonists standing still inside a wall that is about to go up drop what they do and step out. */
  private evictOccupants(o: Order, builder: Colonist): void {
    for (const k of this.colonists) {
      if (k === builder || !this.bodyOverlaps(k, o.cell)) continue;
      if (k.state === 'using') this.abandonNeed(k, false);
      if (k.state === 'working' || k.state === 'pathing' || k.state === 'idle') {
        if (k.job) this.dropJob(k, true);
        this.tryEvacuate(k, true);
      }
    }
  }

  /** Idle colonists standing inside a pending wall step aside so it can be built. */
  private maybeEvacuate(c: Colonist): void {
    const g = this.grid;
    const ps = this.orders.pendingSolid;
    if (!ps(c.cell) && !ps(c.cell - g.w)) return;
    this.tryEvacuate(c, false);
  }

  /** Walk to the nearest reachable stand cell whose body is clear of pending walls (BFS). */
  private tryEvacuate(c: Colonist, force: boolean): void {
    if (!force && this.tick < c.evacRetryAt) return;
    const g = this.grid;
    const ps = this.orders.pendingSolid;
    const seen = new Set<number>([c.cell]);
    const queue = [c.cell];
    const goals: number[] = [];
    for (let qi = 0; qi < queue.length && qi < EVAC_SEARCH_NODES && goals.length < 6; qi++) {
      const cur = queue[qi];
      if (cur !== c.cell && !ps(cur) && !ps(cur - g.w)) {
        goals.push(cur);
        continue;
      }
      const n = neighbors(g, cur, this.nc, this.nt, this.nk);
      for (let i = 0; i < n; i++) {
        if (seen.has(this.nc[i])) continue;
        seen.add(this.nc[i]);
        queue.push(this.nc[i]);
      }
    }
    if (!goals.length) {
      c.evacRetryAt = this.tick + IDLE_RETRY_MAX; // boxed in: the wall will push us out
      return;
    }
    c.goal = 'evacuate';
    this.requestPath(c, goals);
  }

  /** A wall just went up where colonists stand: move each to the nearest free spot (prefers up). */
  private displaceFrom(cell: number): void {
    for (const k of this.colonists) {
      if (k.state === 'dead' || !this.bodyOverlaps(k, cell)) continue;
      if (k.state === 'using') this.abandonNeed(k, false);
      const hadJob = k.goal === 'job' && k.job;
      this.paths.cancel(k.req);
      k.req = null;
      k.path = null;
      k.edgeT = 0;
      k.edgeDur = 0;
      this.unstick(k);
      if (k.state === 'falling' || k.state === 'scrambling' || k.state === 'moving' || k.state === 'pathing' || k.state === 'working') {
        k.state = 'idle';
        if (hadJob) this.repathToJob(k);
        else {
          k.goal = null;
          k.retryAt = this.tick;
        }
      }
    }
  }

  private completeOrder(c: Colonist, o: Order): void {
    const g = this.grid;
    const x = o.x, y = o.y;
    switch (o.kind) {
      case 'dig':
        this.digOut(x, y);
        break;
      case 'build': {
        const d = BUILDS[o.build!];
        if (d.shape === 'building') this.buildings.add(o.build!, x, y, o.flip);
        else if (o.build === 'wall') {
          g.setTile(x, y, Tile.Concrete, true);
          this.displaceFrom(o.cell);
        } else if (o.build === 'stairs') {
          g.setStairBlock(x, y, !o.flip);
          this.displaceFrom(o.cell);
        } else g.setStairs(x, y, true);
        break;
      }
      case 'deconstruct':
        if (o.buildingId >= 0) this.removeBuilding(o.buildingId, true);
        else if (g.stairs[o.cell]) {
          g.setStairs(x, y, false);
          this.refund(BUILDS.ladder.cost, DECONSTRUCT_REFUND);
        } else {
          const wasStair = g.tile[o.cell] === Tile.Stairs;
          g.setTile(x, y, Tile.Empty, false);
          this.refund((wasStair ? BUILDS.stairs : BUILDS.wall).cost, DECONSTRUCT_REFUND);
        }
        break;
      case 'operate':
        this.resources.food += 1;
        this.printerOrders.delete(o.buildingId);
        break;
    }
    this.orders.remove(o);
    c.job = null;
    c.goal = null;
    c.state = 'idle';
    c.retryAt = this.tick;
    c.failCount = 0;
  }

  /** Remove a building: users are interrupted, its automatic jobs cancelled, half the cost refunded. */
  removeBuilding(id: number, refund: boolean): void {
    const b = this.buildings.get(id);
    if (!b) return;
    for (const k of this.colonists) {
      if (k.needTask && k.needTask.buildingId === id) this.abandonNeed(k, false);
    }
    const po = this.printerOrders.get(id);
    if (po) this.cancelOrder(po);
    this.buildings.remove(b);
    if (refund) this.refund(BUILDS[b.kind].cost, DECONSTRUCT_REFUND);
  }
}
