// Procedural world: dirt body with caves, coal veins, deep radioactive pockets,
// a bedrock border and a pre-dug starting chamber.

import { Tile } from './defs';
import { Grid } from './grid';
import { fbm, valueNoise } from './rng';

export interface GenResult {
  grid: Grid;
  /** Stand cells inside the start chamber where colonists spawn. */
  spawn: { x: number; y: number };
  chamber: { x0: number; y0: number; x1: number; y1: number };
}

export function generateWorld(w: number, h: number, seed: number): GenResult {
  const g = new Grid(w, h);
  const cx = Math.floor(w / 2);
  const floorY = Math.floor(h * 0.3); // feet row of the chamber
  const chamber = { x0: cx - 9, y0: floorY - 3, x1: cx + 9, y1: floorY };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let t: number = Tile.Dirt;
      const depth = y / h;
      // caves: low-frequency fbm with stretched x for horizontal caverns
      const cave = fbm(x / 18, y / 11, seed + 7, 4);
      if (cave > 0.66 - depth * 0.04) t = Tile.Empty;
      else {
        const coal = fbm(x / 7, y / 7, seed + 31, 3);
        if (coal > 0.67) t = Tile.Coal;
        if (depth > 0.55) {
          const rad = fbm(x / 6, y / 6, seed + 57, 3);
          if (rad > 0.7 - (depth - 0.55) * 0.15) t = Tile.Radioactive;
        }
      }
      // keep the area around the start solid and predictable
      const dx = x - cx, dy = (y - floorY) * 1.4;
      if (dx * dx + dy * dy < 15 * 15 && t === Tile.Empty) t = Tile.Dirt;
      // a little extra coal close to the start so the early game has some
      if (dx * dx + dy * dy < 26 * 26 && t === Tile.Dirt && valueNoise(x / 3, y / 3, seed + 99) > 0.86) t = Tile.Coal;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) t = Tile.Bedrock;
      g.tile[y * w + x] = t;
    }
  }
  // Starting chamber (4 tall) with a guaranteed dirt floor.
  for (let y = chamber.y0; y <= chamber.y1; y++)
    for (let x = chamber.x0; x <= chamber.x1; x++) g.tile[y * w + x] = Tile.Empty;
  for (let x = chamber.x0 - 1; x <= chamber.x1 + 1; x++) {
    const i = (floorY + 1) * w + x;
    if (g.tile[i] === Tile.Empty) g.tile[i] = Tile.Dirt;
  }
  g.touchAll();
  return { grid: g, spawn: { x: cx, y: floorY }, chamber };
}
