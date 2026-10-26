// Movement rules for 1-wide x 2-tall colonists. Position = feet cell; head is the cell above.
// The nav graph is never stored: edges are generated on demand from the grid, so a grid edit
// is instantly reflected (regions + path revalidation handle the caches built on top).

import { SAFE_FALL, STAIR_STEP_COST, Tile } from './defs';
import type { Grid } from './grid';

export const Move = {
  Walk: 0,
  Step: 1, // diagonal up/down by one tile
  Climb: 2, // vertical along stairs
  Fall: 3, // one-way drop of 2..SAFE_FALL tiles (planned), or any height (accidental)
  Jump: 4, // across a 1-wide gap to the same height (two tiles sideways)
  Scale: 5, // up a 2-high ledge (up two, over one) and the matching climb down
} as const;
export type MoveType = (typeof Move)[keyof typeof Move];

/** Jump ~0.7 s (like two walks); scaling a 2-high ledge ~1.3 s, slower than a ladder. */
export const MOVE_COST: Record<number, number> = { 0: 1, 1: 1.4, 2: 1.6, 3: 1, 4: 2.1, 5: 4 };
export function fallCost(h: number): number {
  return 1 + 0.3 * h;
}

/** Feet at (x,y): both body cells free, and supported by solid ground or stairs. */
export function canStand(g: Grid, x: number, y: number): boolean {
  if (!g.free(x, y) || !g.free(x, y - 1)) return false;
  return g.solid(x, y + 1) || g.hasStairs(x, y) || g.hasStairs(x, y + 1);
}

/** Body cells are free (the colonist fits here, supported or not). */
export function canOccupy(g: Grid, x: number, y: number): boolean {
  return g.free(x, y) && g.free(x, y - 1);
}

/** First y >= y0 (in column x) where a colonist can stand, scanning through free cells; -1 if blocked. */
export function landingY(g: Grid, x: number, y0: number): number {
  for (let y = y0; y < g.h; y++) {
    if (!g.free(x, y)) return -1;
    if (canStand(g, x, y)) return y;
  }
  return -1;
}

export const MAX_NEIGHBORS = 16;

/** Is (x,y) a stair block that rises in direction dx (+1 right, -1 left)? */
export function stairRises(g: Grid, x: number, y: number, dx: number): boolean {
  if (!g.inBounds(x, y)) return false;
  const i = y * g.w + x;
  return g.tile[i] === Tile.Stairs && (g.tileDir[i] === 1) === (dx > 0);
}

/**
 * Writes outgoing edges of the stand cell `cell` into the out buffers, returns the count.
 * Only edges a planner may use (falls <= SAFE_FALL).
 */
export function neighbors(
  g: Grid,
  cell: number,
  outCell: Int32Array,
  outType: Uint8Array,
  outCost: Float32Array,
): number {
  const w = g.w;
  const x = cell % w;
  const y = (cell / w) | 0;
  let n = 0;
  for (let dx = -1; dx <= 1; dx += 2) {
    const nx = x + dx;
    // Walk
    if (canStand(g, nx, y)) {
      outCell[n] = y * w + nx; outType[n] = Move.Walk; outCost[n] = MOVE_COST[Move.Walk]; n++;
    }
    // Step up: target stand cell one up, and room above our head to rise.
    // Along a stair block rising our way it is nearly as fast as walking.
    if (canStand(g, nx, y - 1) && g.free(x, y - 2)) {
      outCell[n] = (y - 1) * w + nx; outType[n] = Move.Step;
      outCost[n] = stairRises(g, nx, y, dx) ? STAIR_STEP_COST : MOVE_COST[Move.Step]; n++;
    }
    // Step down / walk off a ledge: we must first move sideways into (nx,y),(nx,y-1).
    if (canOccupy(g, nx, y)) {
      if (canStand(g, nx, y + 1)) {
        outCell[n] = (y + 1) * w + nx; outType[n] = Move.Step;
        outCost[n] = stairRises(g, x, y + 1, -dx) ? STAIR_STEP_COST : MOVE_COST[Move.Step]; n++;
      } else if (!canStand(g, nx, y)) {
        const ly = landingY(g, nx, y + 1);
        if (ly > 0 && ly - y <= SAFE_FALL) {
          outCell[n] = ly * w + nx; outType[n] = Move.Fall; outCost[n] = fallCost(ly - y); n++;
        }
        // Jump the 1-wide gap to the same height: the body passes through (nx,y),(nx,y-1) and
        // needs one more free cell above for the arc. Symmetric, so it is a two-way move.
        if (canStand(g, x + 2 * dx, y) && g.free(nx, y - 2) && g.free(x, y - 2) && g.free(x + 2 * dx, y - 2)) {
          outCell[n] = y * w + x + 2 * dx; outType[n] = Move.Jump; outCost[n] = MOVE_COST[Move.Jump]; n++;
        }
        // Climb down a 2-high ledge (the exact mirror of scaling it, below): sideways, then down two.
        if (canStand(g, nx, y + 2) && !canStand(g, x, y + 1)) {
          outCell[n] = (y + 2) * w + nx; outType[n] = Move.Scale; outCost[n] = MOVE_COST[Move.Scale]; n++;
        }
      }
    }
    // Scale a 2-high ledge: rise two in our own column (head needs (x,y-3)), then over onto it.
    // Conditions mirror the climb down exactly (regions treat non-fall moves as two-way).
    if (canStand(g, nx, y - 2) && !canStand(g, nx, y - 1) && g.free(x, y - 2) && g.free(x, y - 3) &&
        !canStand(g, x, y - 2) && !canStand(g, x, y - 1)) {
      outCell[n] = (y - 2) * w + nx; outType[n] = Move.Scale; outCost[n] = MOVE_COST[Move.Scale]; n++;
    }
  }
  // Climb up
  if ((g.hasStairs(x, y) || g.hasStairs(x, y - 1)) && canStand(g, x, y - 1)) {
    outCell[n] = (y - 1) * w + x; outType[n] = Move.Climb; outCost[n] = MOVE_COST[Move.Climb]; n++;
  }
  // Down through stairs (we are not on solid ground, the cell below is free)
  if (g.free(x, y + 1)) {
    if (canStand(g, x, y + 1)) {
      outCell[n] = (y + 1) * w + x; outType[n] = Move.Climb; outCost[n] = MOVE_COST[Move.Climb]; n++;
    } else {
      const ly = landingY(g, x, y + 1);
      if (ly > 0 && ly - y <= SAFE_FALL) {
        outCell[n] = ly * w + x; outType[n] = Move.Fall; outCost[n] = fallCost(ly - y); n++;
      }
    }
  }
  return n;
}

const tmpC = new Int32Array(MAX_NEIGHBORS);
const tmpT = new Uint8Array(MAX_NEIGHBORS);
const tmpK = new Float32Array(MAX_NEIGHBORS);

/** Is the edge from -> to (of the given type) still valid on the current grid? */
export function edgeValid(g: Grid, from: number, to: number, type: number): boolean {
  if (!canStand(g, from % g.w, (from / g.w) | 0)) return false;
  const n = neighbors(g, from, tmpC, tmpT, tmpK);
  for (let i = 0; i < n; i++) if (tmpC[i] === to && tmpT[i] === type) return true;
  return false;
}

/** Duration in seconds to traverse an edge. */
export function edgeDuration(type: number, cost: number, walkSpeed: number): number {
  if (type === Move.Fall) return 0.25 + 0.12 * cost;
  return cost / walkSpeed;
}
