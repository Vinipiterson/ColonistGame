// Orders = work units: player intent on tiles (dig / build / deconstruct) plus automatic jobs
// (operate: printing rations, cooking, sowing, harvesting, cranking a generator). Each has a priority.
// One order is one job. Indexed by priority and by 16x16 chunk for job search.
//
// Shapes:
//   tile build/deconstruct  -> one cell (wall, ladder, stair block). A build on a natural tile
//                              has two phases: dig it out, then build.
//   building build/deconstruct -> a footprint (`cells`), anchored at its top-left cell.
//   operate                 -> a building's use cell; not written to the grid's order layer.

import {
  BUILDS, DECONSTRUCT_WORK, EMERGENCY, SKILLS, TILE_INFO, Tile, type BuildKind, type ResourceId, type SkillId,
} from './defs';

export const SKILL_INDEX = Object.fromEntries(SKILLS.map((s, i) => [s, i])) as Record<SkillId, number>;
import { canPlaceBuilding, footprint, useCell, type BuildingStore } from './buildings';
import type { Grid } from './grid';
import { canStand } from './nav';

export type OrderKind = 'dig' | 'build' | 'deconstruct' | 'operate';
/** What an operate order does at its building. */
export type OperateTask = 'print' | 'cook' | 'sow' | 'harvest' | 'crank' | 'research' | 'clean' | 'refuel';

const TASK_SKILL: Record<OperateTask, SkillId> = {
  print: 'cooking', cook: 'cooking', sow: 'farming', harvest: 'farming', research: 'research',
  crank: 'operating', clean: 'operating', refuel: 'operating',
};

/** The skill a job trains (and that likings / hates apply to). */
export function orderSkill(o: Order): SkillId {
  if (o.kind === 'dig') return 'digging';
  if (o.kind === 'operate') return TASK_SKILL[o.task ?? 'print'];
  return 'building';
}
export type Cost = Partial<Record<ResourceId, number>>;

export interface Order {
  id: number;
  kind: OrderKind;
  /** Anchor cell (top-left of a footprint; the use cell for operate). */
  cell: number;
  x: number;
  y: number;
  /** All cells this order targets (1 for tiles, the footprint for buildings, [] for operate). */
  cells: number[];
  priority: number; // 1..9, 10 = emergency
  build: BuildKind | null;
  /** Mirrored / facing flag chosen with R (stairs: true = rises to the right). */
  flip: boolean;
  /** Building targeted by a deconstruct/operate order, or -1. */
  buildingId: number;
  /** Operate orders: the task and what it costs (paid when the work starts). */
  task: OperateTask | null;
  opCost: Cost;
  work: number; // seconds needed (build / dig / deconstruct / operate phase)
  progress: number; // seconds done
  /** Build on a natural tile: seconds to dig it out first (0 if the cell was empty). */
  digWork: number;
  digProgress: number;
  /** Ticks a solid build has been waiting for colonists to leave its cell. */
  waitTicks: number;
  /** A solid build that would seal off a neighbouring build waits until this tick. */
  deferUntil: number;
  claimedBy: number; // colonist id or -1
  paid: boolean; // cost already taken from the stockpile
  removed: boolean;
  /** Set while a solid build waits for colonists to leave the cell. */
  waitingClear: boolean;
  /** region id -> nav version at which no work position was reachable from that region. */
  unreach: Map<number, number> | null;
  /** Has at least one stand cell in reach (see OrderStore.spatial). */
  active: boolean;
}

export interface OrderOptions {
  flip?: boolean;
  buildingId?: number;
  work?: number;
  task?: OperateTask;
  cost?: Cost;
}

/** Spatial bucket size for job search. */
export const JOB_CHUNK = 16;

export class OrderStore {
  private byId = new Map<number, Order>();
  private nextId = 1;
  /** buckets[p] holds all live orders of priority p. */
  readonly buckets: Set<Order>[] = Array.from({ length: EMERGENCY + 1 }, () => new Set());
  /**
   * spatial[p][chunk]: *active* orders of priority p in that chunk. An order is active when at
   * least one stand cell is within reach of it. Buried dig orders stay parked (not indexed) until
   * the grid near them changes, so job search only ever looks at the workable frontier.
   */
  readonly spatial: (Set<Order> | undefined)[][];
  readonly activeCount: Int32Array = new Int32Array(EMERGENCY + 1);
  /** Active and unclaimed orders per priority: lets job search skip exhausted buckets. */
  readonly availCount: Int32Array = new Int32Array(EMERGENCY + 1);
  /** The same, per priority and skill (index p * SKILLS.length + skill): likings / hates filter by skill. */
  readonly availSkill: Int32Array = new Int32Array((EMERGENCY + 1) * SKILLS.length);
  readonly jcw: number;
  readonly jch: number;
  private g: Grid;
  private buildings: BuildingStore;

  constructor(g: Grid, buildings: BuildingStore) {
    this.g = g;
    this.buildings = buildings;
    this.jcw = Math.ceil(g.w / JOB_CHUNK);
    this.jch = Math.ceil(g.h / JOB_CHUNK);
    this.spatial = Array.from({ length: EMERGENCY + 1 }, () => new Array(this.jcw * this.jch));
  }

  chunkOf(o: Order): number {
    return ((o.y / JOB_CHUNK) | 0) * this.jcw + ((o.x / JOB_CHUNK) | 0);
  }
  private index(o: Order): void {
    this.buckets[o.priority].add(o);
    if (o.active) {
      const row = this.spatial[o.priority];
      (row[this.chunkOf(o)] ??= new Set()).add(o);
      this.activeCount[o.priority]++;
      if (o.claimedBy < 0) {
        this.availCount[o.priority]++;
        this.availSkill[o.priority * SKILLS.length + SKILL_INDEX[orderSkill(o)]]++;
      }
    }
  }
  private unindex(o: Order): void {
    this.buckets[o.priority].delete(o);
    if (o.active) {
      this.spatial[o.priority][this.chunkOf(o)]?.delete(o);
      this.activeCount[o.priority]--;
      if (o.claimedBy < 0) {
        this.availCount[o.priority]--;
        this.availSkill[o.priority * SKILLS.length + SKILL_INDEX[orderSkill(o)]]--;
      }
    }
  }

  /** Set or clear (-1) the colonist working on this order. */
  claim(o: Order, colonistId: number): void {
    if (o.claimedBy === colonistId) return;
    if (o.removed) {
      o.claimedBy = colonistId;
      return;
    }
    this.unindex(o);
    o.claimedBy = colonistId;
    this.index(o);
  }

  /** Re-evaluate whether the order is workable from any stand cell (call after nearby grid edits). */
  refreshActive(o: Order): void {
    const active = hasWorkPositions(workPositions(this.g, o, this.buildings));
    if (active === o.active) return;
    this.unindex(o);
    o.active = active;
    this.index(o);
  }

  get count(): number {
    return this.byId.size;
  }
  get(id: number): Order | undefined {
    return this.byId.get(id);
  }
  /** The order written on this cell (operate orders are not on cells). */
  at(cell: number): Order | undefined {
    const id = this.g.order[cell];
    return id >= 0 ? this.byId.get(id) : undefined;
  }
  all(): IterableIterator<Order> {
    return this.byId.values();
  }

  create(kind: OrderKind, cell: number, priority: number, build: BuildKind | null, opts: OrderOptions = {}): Order {
    const g = this.g;
    let work = DECONSTRUCT_WORK;
    let cells = [cell];
    const x = g.cx(cell), y = g.cy(cell);
    if (kind === 'dig') work = TILE_INFO[g.tile[cell]].digWork;
    else if (kind === 'build') {
      const d = BUILDS[build!];
      work = d.work;
      if (d.shape === 'building') cells = footprint(g, x, y, d.w, d.h);
    } else if (kind === 'deconstruct' && opts.buildingId !== undefined) {
      const b = this.buildings.get(opts.buildingId)!;
      cells = footprint(g, b.x, b.y, b.w, b.h);
    } else if (kind === 'operate') cells = [];
    if (opts.work !== undefined) work = opts.work;
    const digWork = kind === 'build' && BUILDS[build!].shape === 'tile' && g.tile[cell] !== Tile.Empty
      ? TILE_INFO[g.tile[cell]].digWork : 0;
    const o: Order = {
      id: this.nextId++, kind, cell, x, y, cells, priority, build, flip: !!opts.flip,
      buildingId: opts.buildingId ?? -1, task: opts.task ?? null, opCost: opts.cost ?? {}, work,
      progress: 0, digWork, digProgress: 0, waitTicks: 0, deferUntil: 0,
      claimedBy: -1, paid: false, removed: false, waitingClear: false, unreach: null, active: false,
    };
    this.byId.set(o.id, o);
    o.active = hasWorkPositions(workPositions(g, o, this.buildings));
    this.index(o);
    for (const c of cells) g.setOrder(c, o.id);
    return o;
  }

  remove(o: Order): void {
    if (o.removed) return;
    o.removed = true;
    this.byId.delete(o.id);
    this.unindex(o);
    for (const c of o.cells) if (this.g.order[c] === o.id) this.g.setOrder(c, -1);
  }

  setPriority(o: Order, p: number): void {
    if (o.priority === p) return;
    this.unindex(o);
    o.priority = p;
    this.index(o);
    o.unreach = null;
    for (const c of o.cells) this.g.setOrder(c, o.id); // redraw badge
  }

  /** Does this cell hold a pending solid build (a wall or stair block that still has to go up)? */
  readonly pendingSolid = (cell: number): boolean => {
    const id = this.g.order[cell];
    if (id < 0) return false;
    const o = this.byId.get(id);
    return !!o && orderIsSolidBuild(o);
  };

  hasUnclaimedEmergency(): boolean {
    for (const o of this.buckets[EMERGENCY]) if (o.claimedBy < 0) return true;
    return false;
  }

  /** Restore order id counter after loading. */
  set idCounter(v: number) {
    this.nextId = v;
  }
  get idCounter(): number {
    return this.nextId;
  }
}

// ---------- placement rules (used by commands and by job validity checks) ----------

export function canPlaceDig(g: Grid, cell: number): boolean {
  return g.order[cell] === -1 && g.isDiggable(cell) && g.tile[cell] !== Tile.Empty;
}

/**
 * Tile builds go on empty cells or on natural diggable tiles (dug out first); never into a
 * ladder or building. `ignoreOrder`: the cell's existing order will be replaced (a pending dig).
 */
export function canPlaceBuild(g: Grid, cell: number, kind: BuildKind, ignoreOrder = false): boolean {
  if (BUILDS[kind].shape !== 'tile') return false;
  if (!ignoreOrder && g.order[cell] !== -1) return false;
  if (g.stairs[cell] || g.bld[cell] >= 0) return false;
  return g.tile[cell] === Tile.Empty || g.isDiggable(cell);
}

/** A tile build order whose cell still holds a natural tile that must be dug out first. */
export function needsDig(g: Grid, o: Order): boolean {
  return o.kind === 'build' && o.cells.length === 1 && BUILDS[o.build!].shape === 'tile' && g.tile[o.cell] !== Tile.Empty;
}

/** Player-built tile (wall, stair block) or ladder in this cell. Buildings are handled separately. */
export function canPlaceDeconstruct(g: Grid, cell: number): boolean {
  if (g.order[cell] !== -1) return false;
  return (g.built[cell] === 1 && g.tile[cell] !== Tile.Empty) || g.stairs[cell] === 1;
}

/** Is the order's target still in a state where the work makes sense? */
export function orderStillValid(g: Grid, o: Order, buildings: BuildingStore): boolean {
  const c = o.cell;
  switch (o.kind) {
    case 'dig':
      return g.isDiggable(c) && g.tile[c] !== Tile.Empty;
    case 'build': {
      const d = BUILDS[o.build!];
      if (d.shape === 'building') return canPlaceBuilding(g, o.build!, o.x, o.y, true);
      return !g.stairs[c] && g.bld[c] < 0 && (g.tile[c] === Tile.Empty || g.isDiggable(c));
    }
    case 'deconstruct':
      if (o.buildingId >= 0) return !!buildings.get(o.buildingId);
      return (g.built[c] === 1 && g.tile[c] !== Tile.Empty) || g.stairs[c] === 1;
    case 'operate': {
      const b = buildings.get(o.buildingId);
      if (!b) return false;
      if (o.task === 'sow') return !b.planted;
      if (o.task === 'harvest') return b.planted && b.growth >= 1;
      if (o.task === 'clean') return b.dirty;
      return true;
    }
  }
}

export function orderCost(o: Order): Cost {
  if (o.kind === 'build') return BUILDS[o.build!].cost;
  if (o.kind === 'operate') return o.opCost;
  return {};
}

export function orderIsSolidBuild(o: Order): boolean {
  return o.kind === 'build' && BUILDS[o.build!].solid;
}

export interface WorkPositions {
  /** Best: not on top of the target, not inside another pending wall. */
  preferred: number[];
  /** Standing directly on top of a tile that will be dug out (you drop when it goes). */
  onTop: number[];
  /** Body would be inside another pending solid build (that build then has to wait). */
  inPending: number[];
}

/**
 * Stand cells from which a colonist can work on the order.
 * Reach: horizontally within 1 tile, vertically from 3 above the feet (2 above the head) to
 * 1 below them, for any of the order's cells. Operate orders: exactly the building's use cell.
 * `pendingSolid(cell)` tells whether a cell has a pending solid build order.
 */
export function workPositions(
  g: Grid, o: Order, buildings: BuildingStore, pendingSolid?: (cell: number) => boolean,
): WorkPositions {
  const preferred: number[] = [], onTop: number[] = [], inPending: number[] = [];
  if (o.kind === 'operate') {
    const b = buildings.get(o.buildingId);
    if (b) {
      const c = useCell(g, b, 0);
      if (canStand(g, c % g.w, (c / g.w) | 0)) preferred.push(c);
    }
    return { preferred, onTop, inPending };
  }
  const solidBuild = orderIsSolidBuild(o);
  const willDig = o.kind === 'dig' || needsDig(g, o);
  const seen = o.cells.length > 1 ? new Set<number>() : null;
  for (const target of o.cells) {
    const tx = target % g.w, ty = (target / g.w) | 0;
    for (let sy = ty - 1; sy <= ty + 3; sy++) {
      for (let sx = tx - 1; sx <= tx + 1; sx++) {
        if (!canStand(g, sx, sy)) continue;
        const cell = sy * g.w + sx;
        if (seen) {
          if (seen.has(cell)) continue;
          seen.add(cell);
        }
        const overlaps = sx === tx && (sy === ty || sy - 1 === ty);
        if (overlaps && solidBuild) continue;
        if (sx === tx && sy === ty - 1 && willDig) onTop.push(cell);
        else if (pendingSolid && (pendingSolid(cell) || pendingSolid(cell - g.w))) inPending.push(cell);
        else preferred.push(cell);
      }
    }
  }
  return { preferred, onTop, inPending };
}

export function hasWorkPositions(p: WorkPositions): boolean {
  return p.preferred.length + p.onTop.length + p.inPending.length > 0;
}

export function inReach(g: Grid, o: Order, cell: number, buildings: BuildingStore): boolean {
  if (o.kind === 'operate') {
    const b = buildings.get(o.buildingId);
    return !!b && useCell(g, b, 0) === cell;
  }
  const sx = g.cx(cell), sy = g.cy(cell);
  for (const t of o.cells) {
    const tx = t % g.w, ty = (t / g.w) | 0;
    if (Math.abs(sx - tx) <= 1 && ty >= sy - 3 && ty <= sy + 1) return true;
  }
  return false;
}
