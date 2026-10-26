// Rooms: an area of open cells closed off on every side by player-built walls, stair blocks or
// doors, between ROOM_MIN_CELLS and ROOM_MAX_CELLS cells. Natural tiles (dirt, coal, bedrock)
// leak: a dug-out cave is not a room until it is walled in. A room's type comes from the
// buildings in it; enough decor makes it Nice.
//
// Updates are local: rooms touching a changed rect are dissolved and their area re-flooded.
// Every flood stops at ROOM_MAX_CELLS + 1 cells, so a change next to a huge cave costs a bounded
// amount of work, and cells are stamped per update so a region is flooded at most once.

import {
  BUILDS, FARM_MIN_PLANTERS, NICE_DECOR_PER_CELL, ROOM_MAX_CELLS, ROOM_MIN_CELLS, SOLID, type BuildKind, type RoomType,
} from './defs';
import type { BuildingStore } from './buildings';
import type { Grid, Rect } from './grid';

export interface Room {
  id: number;
  cells: number[];
  type: RoomType;
  decor: number;
  nice: boolean;
  /** Bounding box (for the overlay label). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const OPEN = 0, WALL = 1, LEAK = 2;
/** Buildings that make a room a workplace rather than a barracks. */
const WORKSTATIONS = new Set<BuildKind>(['printer', 'stove', 'crank', 'coalgen', 'reactor', 'research', 'advresearch']);
const WASH = new Set<BuildKind>(['toilet', 'flushtoilet', 'sink', 'shower']);

export class RoomMap {
  /** Room id per cell, or -1. */
  readonly roomOf: Int32Array;
  readonly rooms = new Map<number, Room>();
  /** Bumped whenever rooms change (renderer / HUD caches). */
  version = 0;
  private nextId = 1;
  private stamp: Int32Array;
  private gen = 0;
  private g: Grid;
  private buildings: BuildingStore;

  constructor(g: Grid, buildings: BuildingStore) {
    this.g = g;
    this.buildings = buildings;
    this.roomOf = new Int32Array(g.size).fill(-1);
    this.stamp = new Int32Array(g.size);
  }

  at(cell: number): Room | undefined {
    const id = this.roomOf[cell];
    return id >= 0 ? this.rooms.get(id) : undefined;
  }

  /** Room around a building (its bottom-left cell). */
  ofBuilding(b: { x: number; y: number; h: number }): Room | undefined {
    return this.at((b.y + b.h - 1) * this.g.w + b.x);
  }

  private kind(i: number): number {
    const g = this.g;
    if (SOLID[g.tile[i]]) return g.built[i] ? WALL : LEAK;
    const bid = g.bld[i];
    if (bid >= 0 && this.buildings.get(bid)?.kind === 'door') return WALL;
    return OPEN;
  }

  /** Re-detect rooms around these rects (grid edits, buildings added or removed). */
  update(rects: Rect[]): void {
    if (!rects.length) return;
    const g = this.g;
    this.gen++;
    const seeds: number[] = [];
    for (const r of rects) {
      const x0 = Math.max(0, r.x0 - 1), y0 = Math.max(0, r.y0 - 1);
      const x1 = Math.min(g.w - 1, r.x1 + 1), y1 = Math.min(g.h - 1, r.y1 + 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * g.w + x;
          const id = this.roomOf[i];
          if (id >= 0) this.dissolve(id, seeds);
          seeds.push(i);
        }
      }
    }
    for (const s of seeds) this.flood(s);
    this.version++;
  }

  private dissolve(id: number, seeds: number[]): void {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    for (const c of room.cells) {
      this.roomOf[c] = -1;
      seeds.push(c);
    }
  }

  private flood(seed: number): void {
    const g = this.g;
    if (this.stamp[seed] === this.gen || this.kind(seed) !== OPEN) return;
    const cells = [seed];
    this.stamp[seed] = this.gen;
    // Stop as soon as the area can't be a room: it touches a natural tile / the map edge, or is too big.
    const visit = (n: number): boolean => {
      const k = this.kind(n);
      if (k === LEAK) return false;
      if (k === OPEN && this.stamp[n] !== this.gen) {
        this.stamp[n] = this.gen;
        cells.push(n);
      }
      return true;
    };
    for (let qi = 0; qi < cells.length; qi++) {
      if (cells.length > ROOM_MAX_CELLS) return;
      const c = cells[qi];
      const x = c % g.w, y = (c / g.w) | 0;
      if (x === 0 || y === 0 || x === g.w - 1 || y === g.h - 1) return;
      if (!visit(c - 1) || !visit(c + 1) || !visit(c - g.w) || !visit(c + g.w)) return;
    }
    if (cells.length < ROOM_MIN_CELLS) return;
    const room: Room = { id: this.nextId++, cells, type: 'room', decor: 0, nice: false, x0: g.w, y0: g.h, x1: 0, y1: 0 };
    for (const c of cells) {
      this.roomOf[c] = room.id;
      const x = c % g.w, y = (c / g.w) | 0;
      if (x < room.x0) room.x0 = x;
      if (x > room.x1) room.x1 = x;
      if (y < room.y0) room.y0 = y;
      if (y > room.y1) room.y1 = y;
    }
    this.classify(room);
    this.rooms.set(room.id, room);
  }

  /**
   * Type by contents: a research station makes a Laboratory; enough planters a Farm; beds
   * without workstations a Barracks; tables (no beds) a Mess Hall; toilets / sinks / showers a
   * Washroom; anything else is just a Room. Decor adds up; Nice at NICE_DECOR_PER_CELL.
   */
  private classify(room: Room): void {
    const seen = new Set<number>();
    const count = new Map<BuildKind, number>();
    let decor = 0, work = false;
    for (const c of room.cells) {
      const id = this.g.bld[c];
      if (id < 0 || seen.has(id)) continue;
      seen.add(id);
      const b = this.buildings.get(id);
      if (!b) continue;
      count.set(b.kind, (count.get(b.kind) ?? 0) + 1);
      decor += BUILDS[b.kind].decor ?? 0;
      if (WORKSTATIONS.has(b.kind)) work = true;
    }
    const has = (k: BuildKind) => (count.get(k) ?? 0) > 0;
    let type: RoomType = 'room';
    if (has('research') || has('advresearch')) type = 'lab';
    else if ((count.get('planter') ?? 0) >= FARM_MIN_PLANTERS) type = 'farm';
    else if (has('bed') && !work) type = 'barracks';
    else if (has('table') && !has('bed')) type = 'messhall';
    else if ([...WASH].some(has) && !work && !has('bed')) type = 'washroom';
    room.type = type;
    room.decor = decor;
    room.nice = decor >= room.cells.length * NICE_DECOR_PER_CELL;
  }
}
