// Lamp light. Each powered lamp lights the cells within LAMP_RADIUS that it can see: solid tiles
// block the light (a lit wall face still counts, the cells behind it don't). Rebuilt from scratch
// only when lamps switch on/off or the grid changes near a lamp; lamps are few, so this is cheap.
// Work in a lit cell is faster; the renderer draws a warm glow from the same levels.

import { LAMP_RADIUS } from './defs';
import type { Grid } from './grid';

export class LightMap {
  /** Brightness per cell, 0 = dark, 255 = right under a lamp. */
  readonly level: Uint8Array;
  /** Cells with a non-zero level (so clearing doesn't touch the whole map). */
  private lit: number[] = [];

  constructor(g: Grid) {
    this.level = new Uint8Array(g.size);
  }

  get litCount(): number {
    return this.lit.length;
  }

  /** Is the colonist whose feet are in this cell (body = feet + the cell above) in the light? */
  lights(g: Grid, feet: number): boolean {
    return this.level[feet] > 0 || (feet >= g.w && this.level[feet - g.w] > 0);
  }

  rebuild(g: Grid, lamps: number[]): void {
    for (const i of this.lit) this.level[i] = 0;
    this.lit.length = 0;
    const R = LAMP_RADIUS;
    for (const lc of lamps) {
      const lx = g.cx(lc), ly = g.cy(lc);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > R + 0.5) continue;
          const x = lx + dx, y = ly + dy;
          if (!g.inBounds(x, y) || !lineOfSight(g, lx, ly, x, y)) continue;
          const v = Math.max(1, Math.round(255 * (1 - d / (R + 1))));
          const i = y * g.w + x;
          if (this.level[i] === 0) this.lit.push(i);
          if (v > this.level[i]) this.level[i] = v;
        }
      }
    }
  }
}

/**
 * Can light travel between the centers of two cells? Samples the segment (3 per cell step);
 * every cell it passes through, except the two ends, must be free.
 */
function lineOfSight(g: Grid, x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3;
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const x = Math.floor(x0 + 0.5 + (x1 - x0) * t);
    const y = Math.floor(y0 + 0.5 + (y1 - y0) * t);
    if ((x === x0 && y === y0) || (x === x1 && y === y1)) continue;
    if (g.solid(x, y)) return false;
  }
  return true;
}
