// Canvas 2D renderer.
// - Tiles and (static) buildings are drawn into cached chunk bitmaps (CHUNK_TILES x CHUNK_TILES)
//   that are redrawn only when the grid reports a change inside them.
// - Animated machines (doors, generators, batteries), plants, lamp light, "no power" badges,
//   orders, colonists, need icons and the placement preview are drawn every frame, only for what
//   is visible.
// - Drawing uses a tile-unit transform: 1 unit = 1 tile, scaled by the camera zoom.

import {
  BUILDS, DIRTY_THRESHOLD, EMERGENCY, MAX_HEALTH, NEED_DEFS, ROOM_LABEL, Tile, type BuildKind, type RoomType,
} from '../sim/defs';
import type { Building } from '../sim/buildings';
import type { Colonist } from '../sim/colonist';
import type { Rect } from '../sim/grid';
import { orderCost, type Order } from '../sim/orders';
import { hash2 } from '../sim/rng';
import type { World } from '../sim/world';
import { ANIMATED, drawBuilding, drawGrowLamp, drawLadder, drawPlant, drawStairBlock } from './art';

const CHUNK_TILES = 32;
const TEX = 16; // bitmap pixels per tile inside chunk caches

export interface Camera {
  x: number; // tile coordinate at the screen center
  y: number;
  zoom: number; // screen pixels per tile
}

export interface Ghost {
  kind: BuildKind;
  x: number; // top-left
  y: number;
  flip: boolean;
  ok: boolean;
}

export interface Preview {
  /** Drag rectangle (omitted for a hover-only building ghost). */
  rect: Rect | null;
  color: string;
  valid: (cell: number) => boolean;
  /** Building footprints that would be placed. */
  ghosts?: Ghost[];
  /** Tile build being previewed (draws its shape in valid cells, e.g. stair direction). */
  tileKind?: BuildKind;
  flip?: boolean;
}

const COLORS = {
  bgTop: [40, 31, 26],
  bgBottom: [16, 13, 18],
  dirt: '#7a5434', dirtLight: '#8f6542', dirtDark: '#5f4027',
  coal: '#3b3734', coalLump: '#191716', coalGlint: '#6d6760',
  rad: '#2f3b2a', radCrystal: '#7dff5a', radGlow: 'rgba(125,255,90,0.25)',
  bedrock: '#2b2632', bedrockLight: '#3b3445',
  concrete: '#bdb8b0', concreteLine: '#8f8b85', concreteHi: '#dcd8d1',
};

const BLUE = 'rgba(90,175,255,';
const RED = 'rgba(255,110,110,';
const ROOM_COLOR: Record<RoomType, string> = {
  barracks: '#5aafff', messhall: '#f2a93b', washroom: '#6ec6ff', farm: '#7cfc9a', lab: '#c77dff', room: '#d8d0c4',
};

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: World;
  cam: Camera;
  private chunks = new Map<number, HTMLCanvasElement>();
  private dirtyChunks = new Set<number>();
  private ccw: number;
  private cch: number;
  private seed: number;
  private patterns: Record<string, CanvasPattern | null> = {};
  private doorOpen = new Map<number, number>();
  private crankAngle = new Map<number, number>();
  private lastTime = 0;
  selectedId = -1;
  selectedBuilding = -1;
  /** Priority tool active: show the priority of every work building. */
  showBuildingPriority = false;
  /** Rooms overlay (V): tint rooms by type, with labels. */
  showRooms = false;
  hoverCell = -1;
  preview: Preview | null = null;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, world: World, seed: number) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.world = world;
    this.seed = seed;
    const g = world.grid;
    this.ccw = Math.ceil(g.w / CHUNK_TILES);
    this.cch = Math.ceil(g.h / CHUNK_TILES);
    for (let i = 0; i < this.ccw * this.cch; i++) this.dirtyChunks.add(i);
    this.cam = { x: world.spawn.x + 0.5, y: world.spawn.y - 1, zoom: 26 };
    this.patterns.dig = this.makeHatch('rgba(255,150,40,0.85)', 'rgba(255,150,40,0.12)');
    this.patterns.deconstruct = this.makeHatch('rgba(255,70,70,0.85)', 'rgba(255,60,60,0.18)');
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  get viewW(): number {
    return this.canvas.width / this.dpr;
  }
  get viewH(): number {
    return this.canvas.height / this.dpr;
  }

  screenToTile(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewW / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this.viewH / 2) / this.cam.zoom + this.cam.y,
    };
  }

  clampCamera(): void {
    const g = this.world.grid;
    this.cam.zoom = Math.max(6, Math.min(64, this.cam.zoom));
    this.cam.x = Math.max(0, Math.min(g.w, this.cam.x));
    this.cam.y = Math.max(0, Math.min(g.h, this.cam.y));
  }

  private makeHatch(line: string, fill: string): CanvasPattern | null {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const x = c.getContext('2d')!;
    x.fillStyle = fill;
    x.fillRect(0, 0, 8, 8);
    x.strokeStyle = line;
    x.lineWidth = 1.6;
    x.beginPath();
    x.moveTo(-2, 10); x.lineTo(10, -2);
    x.moveTo(-2, 2); x.lineTo(2, -2);
    x.moveTo(6, 10); x.lineTo(10, 6);
    x.stroke();
    return this.ctx.createPattern(c, 'repeat');
  }

  // ------------------------------------------------------------------ chunk cache

  private consumeGridChanges(): void {
    const g = this.world.grid;
    if (!g.renderDirty.length) return;
    for (const r of g.renderDirty) {
      // +-1: tile edges/rims depend on neighbours; +2 for buildings spanning chunk borders
      const x0 = Math.max(0, Math.floor((r.x0 - 2) / CHUNK_TILES));
      const y0 = Math.max(0, Math.floor((r.y0 - 2) / CHUNK_TILES));
      const x1 = Math.min(this.ccw - 1, Math.floor((r.x1 + 2) / CHUNK_TILES));
      const y1 = Math.min(this.cch - 1, Math.floor((r.y1 + 2) / CHUNK_TILES));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) this.dirtyChunks.add(cy * this.ccw + cx);
    }
    g.renderDirty.length = 0;
  }

  private chunkCanvas(ci: number): HTMLCanvasElement {
    let c = this.chunks.get(ci);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = CHUNK_TILES * TEX;
      this.chunks.set(ci, c);
      this.dirtyChunks.add(ci);
    }
    if (this.dirtyChunks.has(ci)) {
      this.dirtyChunks.delete(ci);
      this.paintChunk(ci, c);
    }
    return c;
  }

  private paintChunk(ci: number, canvas: HTMLCanvasElement): void {
    const g = this.world.grid;
    const ctx = canvas.getContext('2d')!;
    const ox = (ci % this.ccw) * CHUNK_TILES, oy = Math.floor(ci / this.ccw) * CHUNK_TILES;
    ctx.setTransform(TEX, 0, 0, TEX, -ox * TEX, -oy * TEX);
    ctx.clearRect(ox, oy, CHUNK_TILES, CHUNK_TILES);
    for (let y = oy; y < Math.min(g.h, oy + CHUNK_TILES); y++) {
      for (let x = ox; x < Math.min(g.w, ox + CHUNK_TILES); x++) this.paintCell(ctx, x, y);
    }
    // static buildings (animated ones are drawn per frame)
    for (const b of this.world.buildings.all()) {
      if (ANIMATED.has(b.kind)) continue;
      if (b.x + b.w <= ox || b.x >= ox + CHUNK_TILES || b.y + b.h <= oy || b.y >= oy + CHUNK_TILES) continue;
      drawBuilding(ctx, b.kind, b.x, b.y, b.w, b.h, b.flip);
    }
  }

  private bgColor(y: number): string {
    const t = y / this.world.grid.h;
    const a = COLORS.bgTop, b = COLORS.bgBottom;
    return `rgb(${a[0] + (b[0] - a[0]) * t | 0},${a[1] + (b[1] - a[1]) * t | 0},${a[2] + (b[2] - a[2]) * t | 0})`;
  }

  private paintCell(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const g = this.world.grid;
    const i = y * g.w + x;
    const t = g.tile[i];
    const h = (k: number) => hash2(x * 7 + k, y * 13 - k, this.seed);
    const px = 1 / TEX;
    if (t === Tile.Empty || t === Tile.Stairs) {
      ctx.fillStyle = this.bgColor(y);
      ctx.fillRect(x, y, 1, 1);
      if (t === Tile.Empty && h(1) > 0.8) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(x + h(2) * 0.7, y + h(3) * 0.7, 0.25, 0.25);
      }
      if (t === Tile.Stairs) drawStairBlock(ctx, x, y, g.tileDir[i] === 1);
    } else if (t === Tile.Dirt) {
      ctx.fillStyle = COLORS.dirt;
      ctx.fillRect(x, y, 1, 1);
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = h(k + 10) > 0.5 ? COLORS.dirtLight : COLORS.dirtDark;
        ctx.fillRect(x + h(k + 20) * 0.85, y + h(k + 30) * 0.85, 2 * px + h(k) * 2 * px, 2 * px);
      }
    } else if (t === Tile.Coal) {
      ctx.fillStyle = COLORS.coal;
      ctx.fillRect(x, y, 1, 1);
      for (let k = 0; k < 4; k++) {
        ctx.fillStyle = COLORS.coalLump;
        const s = 0.18 + h(k) * 0.18;
        ctx.fillRect(x + h(k + 20) * (1 - s), y + h(k + 30) * (1 - s), s, s * 0.8);
      }
      ctx.fillStyle = COLORS.coalGlint;
      ctx.fillRect(x + h(5) * 0.8, y + h(6) * 0.8, 2 * px, 2 * px);
    } else if (t === Tile.Radioactive) {
      ctx.fillStyle = COLORS.rad;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = COLORS.radGlow;
      ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
      ctx.fillStyle = COLORS.radCrystal;
      for (let k = 0; k < 3; k++) {
        const cx = x + 0.15 + h(k + 40) * 0.7, cy = y + 0.15 + h(k + 50) * 0.7;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 0.14); ctx.lineTo(cx + 0.07, cy); ctx.lineTo(cx, cy + 0.14); ctx.lineTo(cx - 0.07, cy);
        ctx.fill();
      }
    } else if (t === Tile.Bedrock) {
      ctx.fillStyle = COLORS.bedrock;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = COLORS.bedrockLight;
      ctx.fillRect(x + h(1) * 0.6, y + h(2) * 0.6, 0.4, 2 * px);
    } else if (t === Tile.Concrete) {
      ctx.fillStyle = COLORS.concrete;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = COLORS.concreteLine;
      // brick-like blocks, offset every other row
      ctx.fillRect(x, y + 0.5 - px / 2, 1, px);
      const off = y % 2 === 0 ? 0.5 : 0.0;
      ctx.fillRect(x + off, y, px, 0.5);
      ctx.fillRect(x + ((off + 0.5) % 1), y + 0.5, px, 0.5);
      ctx.fillStyle = COLORS.concreteHi;
      ctx.fillRect(x, y, 1, px);
    }
    // exposed edges on full solid tiles: dark outline, lighter rim on top surfaces
    if (t !== Tile.Empty && t !== Tile.Stairs) {
      const freeAt = (dx: number, dy: number) => g.free(x + dx, y + dy);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      if (freeAt(-1, 0)) ctx.fillRect(x, y, px * 1.5, 1);
      if (freeAt(1, 0)) ctx.fillRect(x + 1 - px * 1.5, y, px * 1.5, 1);
      if (freeAt(0, 1)) ctx.fillRect(x, y + 1 - px * 1.5, 1, px * 1.5);
      if (freeAt(0, -1)) {
        ctx.fillStyle = t === Tile.Concrete ? 'rgba(255,255,255,0.35)' : 'rgba(255,230,190,0.22)';
        ctx.fillRect(x, y, 1, px * 2);
      }
    }
    if (g.stairs[i]) drawLadder(ctx, x, y);
  }

  // ------------------------------------------------------------------ frame

  draw(alpha: number, timeSec: number): void {
    const dt = Math.min(0.1, Math.max(0, timeSec - this.lastTime));
    this.lastTime = timeSec;
    this.consumeGridChanges();
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const vw = this.viewW, vh = this.viewH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0a0d';
    ctx.fillRect(0, 0, vw, vh);
    const ox = vw / 2 - this.cam.x * z, oy = vh / 2 - this.cam.y * z;
    ctx.setTransform(z * this.dpr, 0, 0, z * this.dpr, ox * this.dpr, oy * this.dpr);
    ctx.imageSmoothingEnabled = z < TEX;

    const g = this.world.grid;
    const tx0 = Math.max(0, Math.floor(-ox / z)), ty0 = Math.max(0, Math.floor(-oy / z));
    const tx1 = Math.min(g.w - 1, Math.ceil((vw - ox) / z)), ty1 = Math.min(g.h - 1, Math.ceil((vh - oy) / z));

    // tiles + static buildings
    const cx0 = Math.floor(tx0 / CHUNK_TILES), cx1 = Math.floor(tx1 / CHUNK_TILES);
    const cy0 = Math.floor(ty0 / CHUNK_TILES), cy1 = Math.floor(ty1 / CHUNK_TILES);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunkCanvas(cy * this.ccw + cx);
        ctx.drawImage(c, cx * CHUNK_TILES, cy * CHUNK_TILES, CHUNK_TILES, CHUNK_TILES);
      }
    }

    this.drawLight(tx0, ty0, tx1, ty1);
    if (this.showRooms) this.drawRooms(tx0, ty0, tx1, ty1);
    this.drawAnimated(dt, tx0, ty0, tx1, ty1, timeSec);
    this.drawOrders(tx0, ty0, tx1, ty1, timeSec);
    this.drawSelectedBuilding();
    if (this.showBuildingPriority) this.drawBuildingPriorities(tx0, ty0, tx1, ty1);
    this.drawPreview();
    for (const c of this.world.colonists) if (c.state === 'dead') this.drawColonist(c, alpha, timeSec);
    for (const c of this.world.colonists) if (c.state !== 'dead') this.drawColonist(c, alpha, timeSec);
    this.drawHover();
  }

  /** Warm glow over lit cells (levels come from the sim's light map). */
  private drawLight(tx0: number, ty0: number, tx1: number, ty1: number): void {
    const L = this.world.light;
    if (L.litCount === 0) return;
    const g = this.world.grid;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgb(255,214,140)';
    for (let y = ty0; y <= ty1; y++) {
      for (let x = tx0; x <= tx1; x++) {
        const v = L.level[y * g.w + x];
        if (!v || !g.free(x, y)) continue; // lit wall faces count in the sim, but only open cells glow
        ctx.globalAlpha = (v / 255) * 0.24;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Per-frame buildings: doors slide open while a colonist is in or next to the doorway; the
   * manual generator's wheel turns while cranked; fuel generators and reactors glow while running;
   * batteries show their charge; lit lamps, plants, and a badge on consumers left without power.
   */
  private drawAnimated(dt: number, tx0: number, ty0: number, tx1: number, ty1: number, time: number): void {
    const ctx = this.ctx;
    const w = this.world;
    for (const b of w.buildings.ofKind('door')) {
      let near = false;
      for (const c of w.colonists) {
        if (c.state === 'dead') continue;
        if (Math.abs(c.px - b.x) < 1.25 && c.py > b.y - 0.5 && c.py < b.y + b.h + 0.5) { near = true; break; }
      }
      const cur = this.doorOpen.get(b.id) ?? 0;
      const next = cur + ((near ? 1 : 0) - cur) * Math.min(1, dt * 9);
      this.doorOpen.set(b.id, next);
    }
    for (const b of w.buildings.all()) {
      if (b.x + b.w < tx0 || b.x > tx1 || b.y + b.h < ty0 || b.y > ty1) continue;
      const d = BUILDS[b.kind];
      if (ANIMATED.has(b.kind)) {
        let anim = 0;
        if (b.kind === 'door') anim = this.doorOpen.get(b.id) ?? 0;
        else if (b.kind === 'crank') {
          anim = (this.crankAngle.get(b.id) ?? 0) + (b.powered ? dt * 5 : 0);
          this.crankAngle.set(b.id, anim % (Math.PI * 2));
        } else if (b.kind === 'battery') anim = b.charge / d.capacity!;
        else anim = b.powered ? time + 0.01 : 0;
        drawBuilding(ctx, b.kind, b.x, b.y, b.w, b.h, b.flip, anim);
      } else if (b.kind === 'lamp' && b.powered) {
        drawBuilding(ctx, 'lamp', b.x, b.y, b.w, b.h, b.flip, 1);
        const grad = ctx.createRadialGradient(b.x + 0.5, b.y + 0.6, 0.05, b.x + 0.5, b.y + 0.6, 0.9);
        grad.addColorStop(0, 'rgba(255,220,150,0.55)');
        grad.addColorStop(1, 'rgba(255,220,150,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(b.x - 0.4, b.y - 0.3, 1.8, 1.8);
      } else if (b.kind === 'planter') {
        if (b.lamp) drawGrowLamp(ctx, b.x, b.y, b.powered);
        if (b.planted) drawPlant(ctx, b.crop, b.x, b.y, b.growth);
      } else if (b.kind === 'toilet' && b.dirty) this.drawDirty(b.x, b.y, time);
      if (b.on && !b.powered && w.powerDraw(b) > 0) this.drawNoPower(b.x + b.w - 0.25, b.y + 0.25, time);
    }
  }

  /** A dirty outhouse: grime and a couple of buzzing flies. */
  private drawDirty(x: number, y: number, time: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(92,70,30,0.55)';
    ctx.fillRect(x + 0.2, y + 1.4, 0.42, 0.2);
    ctx.fillRect(x + 0.3, y + 1.85, 0.25, 0.15);
    ctx.fillStyle = '#1b1b1b';
    for (let k = 0; k < 2; k++) {
      const a = time * (5 + k * 2) + k * 2;
      ctx.fillRect(x + 0.45 + Math.cos(a) * 0.25, y + 0.95 + Math.sin(a * 1.3) * 0.18, 0.06, 0.06);
    }
  }

  /** A blinking lightning bolt: this building wants power and gets none. */
  private drawNoPower(cx: number, cy: number, time: number): void {
    const ctx = this.ctx;
    ctx.globalAlpha = 0.65 + 0.35 * Math.sin(time * 5);
    ctx.fillStyle = 'rgba(15,12,14,0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(cx + 0.04, cy - 0.15);
    ctx.lineTo(cx - 0.09, cy + 0.02);
    ctx.lineTo(cx, cy + 0.02);
    ctx.lineTo(cx - 0.04, cy + 0.15);
    ctx.lineTo(cx + 0.09, cy - 0.02);
    ctx.lineTo(cx, cy - 0.02);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawBuildingPriorities(tx0: number, ty0: number, tx1: number, ty1: number): void {
    for (const b of this.world.buildings.all()) {
      if (BUILDS[b.kind].jobPriority === undefined) continue;
      if (b.x + b.w < tx0 || b.x > tx1 || b.y + b.h < ty0 || b.y > ty1) continue;
      this.drawPrioBadge(b.x, b.y, b.w, b.priority);
    }
  }

  private drawSelectedBuilding(): void {
    const b = this.selectedBuilding >= 0 ? this.world.buildings.get(this.selectedBuilding) : undefined;
    if (!b) return;
    this.ctx.strokeStyle = '#ffe066';
    this.ctx.lineWidth = 2.5 / this.cam.zoom;
    this.ctx.strokeRect(b.x, b.y, b.w, b.h);
  }

  /** How open a door is right now (0..1); used by tests and the HUD. */
  doorOpenness(b: Building): number {
    return this.doorOpen.get(b.id) ?? 0;
  }

  private drawOrders(tx0: number, ty0: number, tx1: number, ty1: number, time: number): void {
    const g = this.world.grid;
    const z = this.cam.zoom;
    const showBadges = z >= 18;
    const drawn = new Set<number>();
    for (let y = ty0; y <= ty1; y++) {
      for (let x = tx0; x <= tx1; x++) {
        const id = g.order[y * g.w + x];
        if (id < 0 || drawn.has(id)) continue;
        const o = this.world.orders.get(id);
        if (!o) continue;
        drawn.add(id);
        // orders nobody can stand next to yet (buried) are drawn faded
        if (!o.active) this.ctx.globalAlpha = 0.45;
        this.drawOrder(o, time);
        if (showBadges) this.drawBadge(o);
        this.ctx.globalAlpha = 1;
      }
    }
  }

  /** Footprint bounds of an order (1x1 for tiles). */
  private orderBox(o: Order): { x: number; y: number; w: number; h: number } {
    if (o.cells.length <= 1) return { x: o.x, y: o.y, w: 1, h: 1 };
    const g = this.world.grid;
    const last = o.cells[o.cells.length - 1];
    return { x: o.x, y: o.y, w: g.cx(last) - o.x + 1, h: g.cy(last) - o.y + 1 };
  }

  private drawOrder(o: Order, time: number): void {
    const ctx = this.ctx;
    const { x, y, w, h } = this.orderBox(o);
    const lw = 1.5 / this.cam.zoom;
    if (o.kind === 'dig') {
      ctx.fillStyle = this.patterns.dig ?? 'rgba(255,150,40,0.35)';
      ctx.fillRect(x, y, 1, 1);
      ctx.strokeStyle = 'rgba(255,170,60,0.9)';
      ctx.lineWidth = lw;
      ctx.strokeRect(x + lw / 2, y + lw / 2, 1 - lw, 1 - lw);
    } else if (o.kind === 'deconstruct') {
      ctx.fillStyle = this.patterns.deconstruct ?? 'rgba(255,60,60,0.35)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255,80,80,0.95)';
      ctx.lineWidth = lw * 1.4;
      const cx = x + w / 2, cy = y + h / 2, s = 0.25;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
      ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
      ctx.stroke();
      ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
    } else if (o.kind === 'build') {
      // build on a natural tile: it gets dug out first, so show the dig hatch underneath
      if (this.world.grid.tile[o.cell] !== Tile.Empty && o.cells.length === 1) {
        ctx.save();
        ctx.globalAlpha *= 0.7;
        ctx.fillStyle = this.patterns.dig ?? 'rgba(255,150,40,0.35)';
        ctx.fillRect(x, y, 1, 1);
        ctx.restore();
      }
      const blocked = !o.paid && o.digWork === 0 && !this.world.canAfford(orderCost(o));
      const pulse = 0.55 + 0.15 * Math.sin(time * 3);
      const col = blocked ? RED : BLUE;
      this.drawGhostShape(o.build!, x, y, w, h, o.flip, col, pulse);
      ctx.strokeStyle = col + '0.95)';
      ctx.lineWidth = lw;
      ctx.setLineDash([0.15, 0.1]);
      ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
      ctx.setLineDash([]);
    }
    const total = o.work + o.digWork;
    const done = o.progress + o.digProgress;
    if (done > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + 0.1, y + h - 0.18, w - 0.2, 0.1);
      ctx.fillStyle = o.waitingClear ? '#ffd166' : '#7CFC9A';
      ctx.fillRect(x + 0.1, y + h - 0.18, (w - 0.2) * Math.min(1, done / total), 0.1);
    }
  }

  /** Translucent blueprint of what will be built (tile shape or building silhouette). */
  private drawGhostShape(kind: BuildKind, x: number, y: number, w: number, h: number, flip: boolean, col: string, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha *= alpha;
    const solid = col + '0.85)';
    if (kind === 'wall') {
      ctx.fillStyle = col + '0.45)';
      ctx.fillRect(x, y, 1, 1);
    } else if (kind === 'ladder') drawLadder(ctx, x, y, 1, solid);
    else if (kind === 'stairs') drawStairBlock(ctx, x, y, !flip, solid);
    else {
      ctx.fillStyle = col + '0.18)';
      ctx.fillRect(x, y, w, h);
      drawBuilding(ctx, kind, x, y, w, h, flip, 0, solid);
    }
    ctx.restore();
  }

  private drawBadge(o: Order): void {
    const { x, y, w } = this.orderBox(o);
    this.drawPrioBadge(x, y, w, o.priority);
  }

  /** Priority number in a dot at the top-right corner of a box (red "!" for Emergency). */
  private drawPrioBadge(x: number, y: number, w: number, priority: number): void {
    const ctx = this.ctx;
    const em = priority === EMERGENCY;
    ctx.fillStyle = em ? '#ff3b3b' : 'rgba(10,10,14,0.75)';
    ctx.beginPath();
    ctx.arc(x + w - 0.2, y + 0.2, 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 0.26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(em ? '!' : String(priority), x + w - 0.2, y + 0.21);
  }

  private drawPreview(): void {
    const p = this.preview;
    if (!p) return;
    const ctx = this.ctx;
    const g = this.world.grid;
    const r = p.rect;
    if (r && !p.ghosts) {
      for (let y = Math.max(0, r.y0); y <= Math.min(g.h - 1, r.y1); y++) {
        for (let x = Math.max(0, r.x0); x <= Math.min(g.w - 1, r.x1); x++) {
          if (!p.valid(y * g.w + x)) continue;
          if (p.tileKind === 'stairs' || p.tileKind === 'ladder') this.drawGhostShape(p.tileKind, x, y, 1, 1, !!p.flip, BLUE, 0.9);
          else {
            ctx.fillStyle = p.color.replace('ALPHA', '0.28');
            ctx.fillRect(x, y, 1, 1);
          }
        }
      }
    }
    if (p.ghosts) {
      for (const gh of p.ghosts) {
        const d = BUILDS[gh.kind];
        const col = gh.ok ? 'rgba(110,230,140,' : RED;
        this.drawGhostShape(gh.kind, gh.x, gh.y, d.w, d.h, gh.flip, col, 0.9);
        ctx.strokeStyle = col + '0.95)';
        ctx.lineWidth = 1.5 / this.cam.zoom;
        ctx.strokeRect(gh.x, gh.y, d.w, d.h);
      }
    }
    if (r) {
      ctx.strokeStyle = p.color.replace('ALPHA', '1');
      ctx.lineWidth = 2 / this.cam.zoom;
      ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
    }
  }

  private drawHover(): void {
    if (this.hoverCell < 0 || this.preview) return;
    const g = this.world.grid;
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5 / this.cam.zoom;
    ctx.strokeRect(g.cx(this.hoverCell), g.cy(this.hoverCell), 1, 1);
  }

  private drawColonist(c: Colonist, alpha: number, time: number): void {
    const ctx = this.ctx;
    const px = c.prevPx + (c.px - c.prevPx) * alpha;
    const py = c.prevPy + (c.py - c.prevPy) * alpha;
    const task = c.state === 'using' ? c.needTask : null;
    const sleeping = task?.kind === 'sleep';
    let tilt = 0;
    let bob = 0;
    if (c.state === 'moving') tilt = Math.sin(c.phase) * 0.15;
    else if (c.state === 'working') { tilt = Math.sin(c.phase * 1.5) * 0.1; bob = Math.abs(Math.sin(c.phase * 1.5)) * 0.04; }
    else if (c.state === 'falling') tilt = Math.sin(time * 25 + c.id) * 0.4;
    else if (c.state === 'scrambling') tilt = Math.sin(c.phase) * 0.3;
    else if (c.state === 'idle') tilt = Math.sin(time * 1.5 + c.id) * 0.025;
    else if (task && !sleeping) bob = Math.abs(Math.sin(c.phase * 3)) * 0.03;
    const dead = c.state === 'dead';

    ctx.save();
    if (sleeping) {
      // lie down: in a bed along the mattress towards the pillow, on the floor along facing
      const b = task!.buildingId >= 0 ? this.world.buildings.get(task!.buildingId) : undefined;
      const dir = b ? (b.flip ? -1 : 1) : c.facing;
      const lift = b ? 0.45 : 0.15;
      ctx.translate(px + 0.5 - 0.35 * dir, py + 1 - lift);
      ctx.rotate((Math.PI / 2) * dir);
    } else {
      ctx.translate(px + 0.5, py + 1);
      if (dead) ctx.rotate(Math.PI / 2 * (c.facing > 0 ? 1 : -1));
      else ctx.rotate(tilt * c.facing);
      ctx.translate(0, -bob);
    }

    if (c.id === this.selectedId) {
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = 2.5 / this.cam.zoom;
      ctx.beginPath();
      ctx.ellipse(0, -0.95, 0.55, 1.1, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const body = dead ? '#666' : c.tint;
    // legs
    ctx.fillStyle = dead ? '#444' : '#2c2a35';
    ctx.fillRect(-0.22, -0.42, 0.17, 0.42);
    ctx.fillRect(0.05, -0.42, 0.17, 0.42);
    // torso
    ctx.fillStyle = body;
    roundRect(ctx, -0.3, -1.22, 0.6, 0.86, 0.14);
    ctx.fill();
    // head
    ctx.fillStyle = dead ? '#999' : '#f1c8a0';
    ctx.beginPath();
    ctx.arc(0, -1.5, 0.3, 0, Math.PI * 2);
    ctx.fill();
    // eye (closed while asleep)
    ctx.fillStyle = '#222';
    if (dead || sleeping) ctx.fillRect(0.06 * c.facing - 0.05, -1.56, 0.1, 0.03);
    else ctx.fillRect(0.12 * c.facing - 0.03, -1.58, 0.07, 0.08);
    ctx.restore();

    if (dead) return;
    if (sleeping) this.drawZzz(px, py, time + c.id);
    if (c.health < MAX_HEALTH) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(px + 0.1, py - 1.1, 0.8, 0.1);
      ctx.fillStyle = c.health > 50 ? '#7CFC9A' : c.health > 25 ? '#ffd166' : '#ff5c5c';
      ctx.fillRect(px + 0.1, py - 1.1, 0.8 * (c.health / MAX_HEALTH), 0.1);
    }
    if (!sleeping) this.drawNeedIcon(c, px, py);
    if (c.sick > 0 || c.onBreak) this.drawStatusIcon(c, px, py, time);
  }

  private drawZzz(px: number, py: number, t: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(180,210,255,0.85)';
    ctx.font = 'bold 0.32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let k = 0; k < 2; k++) {
      const ph = (t * 0.6 + k * 0.5) % 1;
      ctx.globalAlpha = 1 - ph;
      ctx.fillText('z', px + 0.7 + ph * 0.3 + k * 0.15, py - 0.1 - ph * 0.7);
    }
    ctx.globalAlpha = 1;
  }

  /** A small bubble over the head for the worst urgent need. */
  /** Rooms tinted by type (Nice rooms brighter), the type name at the top of each. */
  private drawRooms(tx0: number, ty0: number, tx1: number, ty1: number): void {
    const ctx = this.ctx;
    const g = this.world.grid;
    for (const room of this.world.rooms.rooms.values()) {
      if (room.x1 < tx0 || room.x0 > tx1 || room.y1 < ty0 || room.y0 > ty1) continue;
      ctx.fillStyle = ROOM_COLOR[room.type];
      ctx.globalAlpha = room.nice ? 0.32 : 0.2;
      for (const c of room.cells) ctx.fillRect(c % g.w, (c / g.w) | 0, 1, 1);
      ctx.globalAlpha = 1;
      if (this.cam.zoom < 10) continue;
      const label = ROOM_LABEL[room.type] + (room.nice ? ' ★' : '');
      ctx.font = 'bold 0.42px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const cx = (room.x0 + room.x1 + 1) / 2;
      const wText = ctx.measureText(label).width + 0.3;
      ctx.fillStyle = 'rgba(10,10,14,0.75)';
      ctx.fillRect(cx - wText / 2, room.y0 + 0.08, wText, 0.56);
      ctx.fillStyle = ROOM_COLOR[room.type];
      ctx.fillText(label, cx, room.y0 + 0.14);
    }
  }

  /** Over the head: a green bug while sick, a storm cloud during a stress break. */
  private drawStatusIcon(c: Colonist, px: number, py: number, time: number): void {
    const ctx = this.ctx;
    const cx = px + 0.5 + 0.42, cy = py - 1.75 + Math.sin(time * 3 + c.id) * 0.04;
    ctx.fillStyle = 'rgba(15,12,14,0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, 0.2, 0, Math.PI * 2);
    ctx.fill();
    if (c.onBreak) {
      ctx.fillStyle = '#9aa3ab';
      ctx.beginPath();
      ctx.arc(cx - 0.06, cy - 0.02, 0.08, 0, Math.PI * 2);
      ctx.arc(cx + 0.06, cy - 0.03, 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 0.04;
      ctx.beginPath();
      ctx.moveTo(cx, cy + 0.04);
      ctx.lineTo(cx - 0.04, cy + 0.12);
      ctx.lineTo(cx + 0.02, cy + 0.12);
      ctx.lineTo(cx - 0.02, cy + 0.18);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#7cfc9a';
      ctx.beginPath();
      ctx.ellipse(cx, cy, 0.07, 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#7cfc9a';
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      for (const s of [-1, 1]) {
        ctx.moveTo(cx + s * 0.06, cy - 0.04); ctx.lineTo(cx + s * 0.14, cy - 0.08);
        ctx.moveTo(cx + s * 0.06, cy + 0.04); ctx.lineTo(cx + s * 0.14, cy + 0.08);
      }
      ctx.stroke();
    }
  }

  private drawNeedIcon(c: Colonist, px: number, py: number): void {
    const n = c.needs;
    let kind: 'hunger' | 'sleep' | 'bladder' | 'hygiene' | null = null;
    if (n.bladder < NEED_DEFS.bladder.urgent) kind = 'bladder';
    else if (n.hunger < NEED_DEFS.hunger.urgent) kind = 'hunger';
    else if (n.sleep < NEED_DEFS.sleep.urgent) kind = 'sleep';
    else if (n.hygiene < DIRTY_THRESHOLD) kind = 'hygiene';
    if (!kind) return;
    const ctx = this.ctx;
    const cx = px + 0.5, cy = py - 1.45;
    const colors = { hunger: '#f2a93b', sleep: '#5aafff', bladder: '#ffd166', hygiene: '#81b29a' };
    ctx.fillStyle = 'rgba(15,12,14,0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colors[kind];
    ctx.strokeStyle = colors[kind];
    ctx.lineWidth = 0.05;
    if (kind === 'hunger') {
      ctx.beginPath();
      ctx.arc(cx, cy + 0.02, 0.12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillRect(cx - 0.015, cy - 0.15, 0.03, 0.1);
    } else if (kind === 'sleep') {
      ctx.font = 'bold 0.3px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Z', cx, cy + 0.01);
    } else if (kind === 'bladder') {
      ctx.beginPath();
      ctx.moveTo(cx, cy - 0.15);
      ctx.quadraticCurveTo(cx + 0.14, cy + 0.02, cx, cy + 0.13);
      ctx.quadraticCurveTo(cx - 0.14, cy + 0.02, cx, cy - 0.15);
      ctx.fill();
    } else {
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        ctx.moveTo(cx + k * 0.08, cy + 0.12);
        ctx.quadraticCurveTo(cx + k * 0.08 + 0.05, cy, cx + k * 0.08, cy - 0.12);
      }
      ctx.stroke();
    }
  }

  colonistAt(tx: number, ty: number): Colonist | null {
    let best: Colonist | null = null;
    let bestD = 1e9;
    for (const c of this.world.colonists) {
      const cx = c.px + 0.5, cy = c.py; // body spans y in [py-1, py+1]
      const dx = Math.abs(tx - cx), dy = ty - (cy - 0);
      if (dx < 0.5 && dy > -1 && dy < 1) {
        const d = dx + Math.abs(dy);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    return best;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
