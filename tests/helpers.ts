// Build small worlds from ASCII art for tests.
//   '#' dirt   'c' coal   'r' radioactive   'B' bedrock   'W' built concrete wall
//   'H' stairs (in empty cell)   '.' empty   '@' colonist feet (empty cell)
import { Tile } from '../src/sim/defs';
import { Grid } from '../src/sim/grid';
import type { Colonist } from '../src/sim/colonist';
import { World } from '../src/sim/world';

export function worldFromAscii(rows: string[], seed = 1): World {
  const h = rows.length, w = rows[0].length;
  const g = new Grid(w, h);
  const spawns: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const i = y * w + x;
      switch (ch) {
        case '#': g.tile[i] = Tile.Dirt; break;
        case 'c': g.tile[i] = Tile.Coal; break;
        case 'r': g.tile[i] = Tile.Radioactive; break;
        case 'B': g.tile[i] = Tile.Bedrock; break;
        case 'W': g.tile[i] = Tile.Concrete; g.built[i] = 1; break;
        case 'H': g.stairs[i] = 1; break;
        case '@': spawns.push([x, y]); break;
      }
    }
  }
  const world = new World(g, seed);
  for (const [x, y] of spawns) neutral(world.spawnColonist(x, y));
  return world;
}

/** No likings / hates and no XP, so scripted scenarios don't depend on rolled aptitudes. */
export function neutral(c: Colonist): Colonist {
  c.aptitude = {};
  for (const s of Object.keys(c.xp) as (keyof typeof c.xp)[]) c.xp[s] = 0;
  return c;
}

export function cell(world: World, x: number, y: number): number {
  return world.grid.idx(x, y);
}

/** Run until predicate or tick limit; returns ticks used or -1. */
export function runUntil(world: World, pred: () => boolean, maxTicks: number): number {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return i;
    world.step();
  }
  return pred() ? maxTicks : -1;
}
