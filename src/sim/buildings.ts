// Multi-tile buildings (doors, furniture, the ration printer).
// A building occupies a w x h footprint (x,y = top-left). Buildings are not solid: colonists
// walk through them, as in ONI. Each building has `slots` use cells along its bottom row
// (where a colonist stands to use it) and per-slot reservations.

import { BUILDS, DEFAULT_CROP, type BuildKind, type CropId } from './defs';
import type { Grid } from './grid';
import { canStand } from './nav';

export interface Building {
  id: number;
  kind: BuildKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Mirrored horizontally (R while placing). */
  flip: boolean;
  /** Colonist id using/heading to each slot, or -1. */
  users: number[];
  removed: boolean;
  /** Player switch (inspector). Off: no power draw, no generation, no automatic jobs. */
  on: boolean;
  /** Consumers: got power in the last power update. Generators: ran in the last update. */
  powered: boolean;
  /** Battery charge in joules. */
  charge: number;
  /** Planter: chosen crop, whether a plant is in, and its growth 0..1 (1 = ripe). */
  crop: CropId;
  planted: boolean;
  growth: number;
  /** Last tick a colonist worked at it (powered workstations draw power only while busy). */
  busyTick: number;
  /** Manual generator: ticks cranked since the last power update. */
  crankTicks: number;
}

export class BuildingStore {
  private byId = new Map<number, Building>();
  private nextId = 1;
  readonly byKind = new Map<BuildKind, Set<Building>>();
  private g: Grid;

  constructor(g: Grid) {
    this.g = g;
  }

  get count(): number {
    return this.byId.size;
  }
  get(id: number): Building | undefined {
    return this.byId.get(id);
  }
  at(cell: number): Building | undefined {
    const id = this.g.bld[cell];
    return id >= 0 ? this.byId.get(id) : undefined;
  }
  all(): IterableIterator<Building> {
    return this.byId.values();
  }
  ofKind(kind: BuildKind): Set<Building> {
    let s = this.byKind.get(kind);
    if (!s) {
      s = new Set();
      this.byKind.set(kind, s);
    }
    return s;
  }

  add(kind: BuildKind, x: number, y: number, flip: boolean): Building {
    const d = BUILDS[kind];
    const b: Building = {
      id: this.nextId++, kind, x, y, w: d.w, h: d.h, flip,
      users: new Array(Math.max(1, d.slots)).fill(-1), removed: false,
      on: true, powered: false, charge: 0, crop: DEFAULT_CROP, planted: false, growth: 0, busyTick: -1000, crankTicks: 0,
    };
    this.byId.set(b.id, b);
    this.ofKind(kind).add(b);
    for (const c of footprint(this.g, x, y, d.w, d.h)) this.g.setBld(c, b.id);
    return b;
  }

  remove(b: Building): void {
    if (b.removed) return;
    b.removed = true;
    this.byId.delete(b.id);
    this.ofKind(b.kind).delete(b);
    for (const c of footprint(this.g, b.x, b.y, b.w, b.h)) if (this.g.bld[c] === b.id) this.g.setBld(c, -1);
  }
}

export function footprint(g: Grid, x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out.push(yy * g.w + xx);
  return out;
}

/** Cell a colonist stands in (feet) to use slot i: bottom row of the footprint. */
export function useCell(g: Grid, b: Building, slot: number): number {
  const bottom = b.y + b.h - 1;
  if (b.kind === 'bed') {
    // one sleeper; lies across the bed, feet cell is the foot end
    const x = b.flip ? b.x + b.w - 1 : b.x;
    return bottom * g.w + x;
  }
  if (b.kind === 'printer' || b.kind === 'stove' || b.kind === 'crank') {
    // operator stands at the control side
    const x = b.flip ? b.x : b.x + b.w - 1;
    return bottom * g.w + x;
  }
  return bottom * g.w + Math.min(b.x + slot, b.x + b.w - 1);
}

/** Can a colonist currently stand at the use cell of slot i? */
export function slotUsable(g: Grid, b: Building, slot: number): boolean {
  const c = useCell(g, b, slot);
  return canStand(g, c % g.w, (c / g.w) | 0);
}

export function freeSlot(b: Building): number {
  return b.users.indexOf(-1);
}

/**
 * Placement rules for a building footprint with top-left (x,y):
 * in bounds, every cell empty (not solid, no ladder, no other building, no order),
 * and solid floor under the whole bottom row (ceiling mounts: solid tiles above the top row).
 * `ignoreOrders` lets the caller skip the order check (e.g. for previews of replacements).
 */
export function canPlaceBuilding(g: Grid, kind: BuildKind, x: number, y: number, ignoreOrders = false): boolean {
  const d = BUILDS[kind];
  if (x < 0 || y < 0 || x + d.w > g.w || y + d.h > g.h) return false;
  for (let yy = y; yy < y + d.h; yy++) {
    for (let xx = x; xx < x + d.w; xx++) {
      const i = yy * g.w + xx;
      if (g.solid(xx, yy) || g.stairs[i] || g.bld[i] >= 0) return false;
      if (!ignoreOrders && g.order[i] >= 0) return false;
    }
  }
  const supportY = d.mount === 'ceiling' ? y - 1 : y + d.h;
  for (let xx = x; xx < x + d.w; xx++) if (!g.solid(xx, supportY)) return false;
  return true;
}

/**
 * Where copies of a building go when the player drags a rectangle: the drag's left edge and
 * bottom row anchor the first copy; copies tile rightwards and upwards without overlapping.
 * A plain click (1x1 rect) places one copy whose bottom-left cell is the clicked cell.
 * Returns top-left anchors.
 */
export function buildingPlacements(
  rect: { x0: number; y0: number; x1: number; y1: number }, kind: BuildKind,
): { x: number; y: number }[] {
  const d = BUILDS[kind];
  const nx = Math.max(1, Math.floor((rect.x1 - rect.x0 + 1) / d.w));
  const ny = Math.max(1, Math.floor((rect.y1 - rect.y0 + 1) / d.h));
  const out: { x: number; y: number }[] = [];
  for (let j = 0; j < ny; j++) {
    const bottom = rect.y1 - j * d.h;
    for (let i = 0; i < nx; i++) out.push({ x: rect.x0 + i * d.w, y: bottom - d.h + 1 });
  }
  return out;
}
