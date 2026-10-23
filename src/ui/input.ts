// Mouse + keyboard. Turns gestures into sim Commands and camera moves.
//   Left drag (tool mode)  -> rectangle command (Dig / Build / Deconstruct / Cancel)
//                             buildings: click places one, drag tiles copies side by side
//   Left click (no tool)   -> select colonist; left drag (no tool) -> pan
//   Right click            -> leave the current tool (or cancel an in-progress drag)
//   Right / middle drag    -> pan          Wheel or +/- -> zoom
//   WASD / arrows pan, G/B/X/C tools, R flip/rotate, Esc, 1-9 priority, 0 emergency, Space pause

import { buildingPlacements, canPlaceBuilding } from '../sim/buildings';
import { normRect } from '../sim/commands';
import { BUILDS, DEFAULT_PRIORITY, EMERGENCY, type BuildKind } from '../sim/defs';
import type { Rect } from '../sim/grid';
import { canPlaceBuild, canPlaceDeconstruct, canPlaceDig } from '../sim/orders';
import type { World } from '../sim/world';
import type { Renderer } from '../render/renderer';

export type ToolMode = 'select' | 'dig' | 'build' | 'deconstruct' | 'cancel';

export const MODE_COLOR: Record<ToolMode, string> = {
  select: 'rgba(255,255,255,ALPHA)',
  dig: 'rgba(255,160,50,ALPHA)',
  build: 'rgba(90,175,255,ALPHA)',
  deconstruct: 'rgba(255,80,80,ALPHA)',
  cancel: 'rgba(220,220,220,ALPHA)',
};

const PRIORITY_KEY = 'colony.priority';

function loadPriority(): number {
  try {
    const v = Number(localStorage.getItem(PRIORITY_KEY));
    if (v >= 1 && v <= EMERGENCY) return v;
  } catch { /* storage unavailable */ }
  return DEFAULT_PRIORITY;
}

export class ToolState {
  mode: ToolMode = 'select';
  build: BuildKind = 'wall';
  /** R toggles: stairs rise left instead of right; buildings are mirrored. */
  flip = false;
  /** Persistent: applies to every new order until changed. */
  priority = loadPriority();
  speed = 1;
  paused = false;
  listeners: (() => void)[] = [];

  set(patch: Partial<Pick<ToolState, 'mode' | 'build' | 'priority' | 'speed' | 'paused' | 'flip'>>): void {
    Object.assign(this, patch);
    if (patch.priority !== undefined) {
      try { localStorage.setItem(PRIORITY_KEY, String(patch.priority)); } catch { /* ignore */ }
    }
    for (const l of this.listeners) l();
  }
}

export class Input {
  private world: World;
  private r: Renderer;
  readonly tools: ToolState;
  private dragStart: { x: number; y: number } | null = null;
  private dragEnd: { x: number; y: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private pan: { sx: number; sy: number; cx: number; cy: number; moved: boolean; button: number } | null = null;
  private keys = new Set<string>();
  onSelect: (id: number) => void = () => {};

  constructor(world: World, renderer: Renderer, tools: ToolState) {
    this.world = world;
    this.r = renderer;
    this.tools = tools;
    const cv = renderer.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    tools.listeners.push(() => this.updatePreview());
  }

  private tileAt(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.r.canvas.getBoundingClientRect();
    const t = this.r.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
    return { x: Math.floor(t.x), y: Math.floor(t.y) };
  }

  private down(e: PointerEvent): void {
    if (e.button === 0) {
      const t = this.tileAt(e);
      if (this.tools.mode === 'select') {
        // drag pans the map (mouse and touch); a click without movement selects
        this.pan = { sx: e.clientX, sy: e.clientY, cx: this.r.cam.x, cy: this.r.cam.y, moved: false, button: 0 };
        return;
      }
      this.dragStart = t;
      this.dragEnd = t;
      this.updatePreview();
    } else if (e.button === 1 || e.button === 2) {
      if (e.button === 2 && this.dragStart) {
        // right click while dragging cancels the drag
        this.dragStart = this.dragEnd = null;
        this.updatePreview();
        return;
      }
      this.pan = { sx: e.clientX, sy: e.clientY, cx: this.r.cam.x, cy: this.r.cam.y, moved: false, button: e.button };
    }
  }

  private move(e: PointerEvent): void {
    const rect = this.r.canvas.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom;
    if (this.pan) {
      const dx = e.clientX - this.pan.sx, dy = e.clientY - this.pan.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.pan.moved = true;
      this.r.cam.x = this.pan.cx - dx / this.r.cam.zoom;
      this.r.cam.y = this.pan.cy - dy / this.r.cam.zoom;
      this.r.clampCamera();
    }
    const t = this.tileAt(e);
    const g = this.world.grid;
    this.r.hoverCell = inside && g.inBounds(t.x, t.y) ? g.idx(t.x, t.y) : -1;
    const moved = !this.hover || this.hover.x !== t.x || this.hover.y !== t.y;
    this.hover = inside ? t : null;
    if (this.dragStart) this.dragEnd = t;
    if (moved) this.updatePreview();
  }

  private up(e: PointerEvent): void {
    if (e.button === 0 && this.dragStart && this.dragEnd) {
      const rect = normRect(this.dragStart.x, this.dragStart.y, this.dragEnd.x, this.dragEnd.y);
      const p = this.tools.priority;
      switch (this.tools.mode) {
        case 'dig': this.world.issue({ type: 'dig', rect, priority: p }); break;
        case 'build':
          this.world.issue({ type: 'build', rect, kind: this.tools.build, priority: p, flip: this.tools.flip });
          break;
        case 'deconstruct': this.world.issue({ type: 'deconstruct', rect, priority: p }); break;
        case 'cancel': this.world.issue({ type: 'cancel', rect }); break;
      }
      this.dragStart = this.dragEnd = null;
      this.updatePreview();
    }
    if (this.pan && e.button === this.pan.button) {
      if (!this.pan.moved && this.pan.button === 2) this.tools.set({ mode: 'select' });
      if (!this.pan.moved && this.pan.button === 0) {
        const rect = this.r.canvas.getBoundingClientRect();
        const ft = this.r.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
        const c = this.r.colonistAt(ft.x, ft.y);
        this.onSelect(c ? c.id : -1);
      }
      this.pan = null;
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.r.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = this.r.screenToTile(sx, sy);
    this.zoomAt(Math.exp(-e.deltaY * 0.0015), sx, sy, before);
  }

  /** Zoom by factor keeping the tile under (sx, sy) fixed; defaults to the screen center. */
  zoomAt(factor: number, sx = this.r.viewW / 2, sy = this.r.viewH / 2, before = this.r.screenToTile(sx, sy)): void {
    this.r.cam.zoom *= factor;
    this.r.clampCamera();
    const after = this.r.screenToTile(sx, sy);
    this.r.cam.x += before.x - after.x;
    this.r.cam.y += before.y - after.y;
    this.r.clampCamera();
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
    const t = this.tools;
    if (/^Digit[1-9]$/.test(e.code)) t.set({ priority: Number(e.code.slice(5)) });
    else if (e.code === 'Digit0') t.set({ priority: EMERGENCY });
    else if (e.code === 'KeyG') t.set({ mode: 'dig' });
    else if (e.code === 'KeyB') t.set({ mode: 'build' });
    else if (e.code === 'KeyX') t.set({ mode: 'deconstruct' });
    else if (e.code === 'KeyC') t.set({ mode: 'cancel' });
    else if (e.code === 'KeyR') t.set({ flip: !t.flip });
    else if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoomAt(1.25);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoomAt(1 / 1.25);
    else if (e.code === 'Escape') {
      this.dragStart = this.dragEnd = null;
      t.set({ mode: 'select' });
    } else if (e.code === 'Space') {
      e.preventDefault();
      t.set({ paused: !t.paused });
    }
  }

  /** Per-frame: keyboard panning. */
  update(dt: number): void {
    let dx = 0, dy = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dy += 1;
    if (dx || dy) {
      const speed = 900 / this.r.cam.zoom; // tiles per second, ~constant on screen
      this.r.cam.x += dx * speed * dt;
      this.r.cam.y += dy * speed * dt;
      this.r.clampCamera();
    }
  }

  /** Rebuild the placement preview from the drag (or the hovered cell for building ghosts). */
  private updatePreview(): void {
    const mode = this.tools.mode;
    const kind = this.tools.build;
    const def = BUILDS[kind];
    const g = this.world.grid;
    const dragging = !!(this.dragStart && this.dragEnd);
    if (mode === 'select' || (!dragging && !(mode === 'build' && this.hover))) {
      this.r.preview = null;
      return;
    }
    const rect: Rect | null = dragging
      ? normRect(this.dragStart!.x, this.dragStart!.y, this.dragEnd!.x, this.dragEnd!.y)
      : null;

    if (mode === 'build' && def.shape === 'building') {
      const area = rect ?? { x0: this.hover!.x, y0: this.hover!.y, x1: this.hover!.x, y1: this.hover!.y };
      const ghosts = buildingPlacements(area, kind).map((p) => ({
        kind, x: p.x, y: p.y, flip: this.tools.flip, ok: canPlaceBuilding(g, kind, p.x, p.y),
      }));
      this.r.preview = { rect, color: MODE_COLOR.build, valid: () => false, ghosts };
      return;
    }
    if (!rect) {
      // hovering with a tile build: show its shape on the hovered cell
      const cell = g.inBounds(this.hover!.x, this.hover!.y) ? g.idx(this.hover!.x, this.hover!.y) : -1;
      this.r.preview = {
        rect: { x0: this.hover!.x, y0: this.hover!.y, x1: this.hover!.x, y1: this.hover!.y },
        color: MODE_COLOR.build, valid: (c) => c === cell && this.validTileBuild(c, kind), tileKind: kind, flip: this.tools.flip,
      };
      return;
    }
    const valid = (cell: number): boolean => {
      switch (mode) {
        case 'dig': return canPlaceDig(g, cell) || this.world.orders.at(cell)?.kind === 'dig';
        case 'build': return this.validTileBuild(cell, kind);
        case 'deconstruct': return canPlaceDeconstruct(g, cell) || g.bld[cell] >= 0;
        case 'cancel': return g.order[cell] >= 0;
        default: return false;
      }
    };
    this.r.preview = { rect, color: MODE_COLOR[mode], valid, tileKind: mode === 'build' ? kind : undefined, flip: this.tools.flip };
  }

  private validTileBuild(cell: number, kind: BuildKind): boolean {
    const g = this.world.grid;
    const ex = this.world.orders.at(cell);
    if (ex) return ex.kind === 'dig' && canPlaceBuild(g, cell, kind, true);
    return canPlaceBuild(g, cell, kind);
  }
}
