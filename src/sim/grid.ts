// The tile grid: one typed array per layer, indexed by cell = y * w + x (y grows downward).
// Every mutation goes through set*() so dirty rects are recorded for nav, rooms and rendering.

import { SOLID, TILE_INFO, Tile, type TileId } from './defs';

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number; // inclusive
}

export class Grid {
  readonly w: number;
  readonly h: number;
  readonly size: number;
  /** Tile material (Tile.*). */
  readonly tile: Uint8Array;
  /** 1 if the solid tile in this cell was placed by the player (Deconstruct may remove it). */
  readonly built: Uint8Array;
  /** 1 if the cell contains a ladder (always player-built). Field keeps the old name for brevity. */
  readonly stairs: Uint8Array;
  /** Facing of a Tile.Stairs block: 1 = rises to the right, 0 = rises to the left. */
  readonly tileDir: Uint8Array;
  /** Building id occupying this cell, or -1. Buildings are not solid: colonists walk through. */
  readonly bld: Int32Array;
  /** Order id on this cell, or -1. */
  readonly order: Int32Array;

  /** Bumped on every change that can affect navigation. */
  navVersion = 1;
  /** Rects changed since the sim last consumed them (nav/revalidation). */
  dirty: Rect[] = [];
  /** Rects changed since the renderer last consumed them. */
  renderDirty: Rect[] = [];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.size = w * h;
    this.tile = new Uint8Array(this.size);
    this.built = new Uint8Array(this.size);
    this.stairs = new Uint8Array(this.size);
    this.tileDir = new Uint8Array(this.size);
    this.bld = new Int32Array(this.size).fill(-1);
    this.order = new Int32Array(this.size).fill(-1);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }
  cx(i: number): number {
    return i % this.w;
  }
  cy(i: number): number {
    return (i / this.w) | 0;
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  /** Out of bounds counts as solid. */
  solid(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return true;
    return SOLID[this.tile[y * this.w + x]] === 1;
  }
  /** In bounds and not solid. */
  free(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return SOLID[this.tile[y * this.w + x]] === 0;
  }
  /** Ladder in this cell? (named hasStairs historically; Tile.Stairs blocks are solid tiles). */
  hasStairs(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.stairs[y * this.w + x] === 1;
  }
  isNatural(i: number): boolean {
    return this.tile[i] !== Tile.Empty && this.built[i] === 0;
  }
  isDiggable(i: number): boolean {
    return this.built[i] === 0 && TILE_INFO[this.tile[i]].diggable;
  }

  setTile(x: number, y: number, t: TileId, built: boolean): void {
    const i = this.idx(x, y);
    this.tile[i] = t;
    this.built[i] = built ? 1 : 0;
    this.touch(x, y, x, y);
  }
  setStairBlock(x: number, y: number, risesRight: boolean): void {
    const i = this.idx(x, y);
    this.tile[i] = Tile.Stairs;
    this.built[i] = 1;
    this.tileDir[i] = risesRight ? 1 : 0;
    this.touch(x, y, x, y);
  }
  /** Building layer changes need a redraw (and rooms later), not a nav update. */
  setBld(i: number, id: number): void {
    this.bld[i] = id;
    const x = this.cx(i), y = this.cy(i);
    this.renderDirty.push({ x0: x, y0: y, x1: x, y1: y });
  }
  setStairs(x: number, y: number, on: boolean): void {
    this.stairs[this.idx(x, y)] = on ? 1 : 0;
    this.touch(x, y, x, y);
  }
  /** Order layer changes only need a redraw, not a nav update. */
  setOrder(i: number, id: number): void {
    this.order[i] = id;
    const x = this.cx(i), y = this.cy(i);
    this.renderDirty.push({ x0: x, y0: y, x1: x, y1: y });
  }

  touch(x0: number, y0: number, x1: number, y1: number): void {
    this.navVersion++;
    const r = { x0, y0, x1, y1 };
    this.dirty.push(r);
    this.renderDirty.push(r);
  }

  /** Bulk write without per-cell dirty tracking (world gen / tests); call touchAll() after. */
  rawSetTile(x: number, y: number, t: TileId, built = false): void {
    const i = this.idx(x, y);
    this.tile[i] = t;
    this.built[i] = built ? 1 : 0;
  }
  touchAll(): void {
    this.touch(0, 0, this.w - 1, this.h - 1);
  }
}
