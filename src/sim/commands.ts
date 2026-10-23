// Everything the player can do to the simulation is a Command. The UI never mutates sim state
// directly; commands are queued and applied at the start of the next tick. This keeps the sim
// deterministic and replayable (tests drive the game with the same commands the UI sends).

import type { BuildKind } from './defs';
import type { Rect } from './grid';

export type Command =
  | { type: 'dig'; rect: Rect; priority: number }
  | { type: 'build'; rect: Rect; kind: BuildKind; priority: number; flip?: boolean }
  | { type: 'deconstruct'; rect: Rect; priority: number }
  | { type: 'cancel'; rect: Rect };

export type SimEvent =
  | { type: 'death'; colonistId: number; name: string; cause: string }
  | { type: 'fall'; colonistId: number; name: string; height: number; damage: number }
  | { type: 'needFail'; colonistId: number; name: string; text: string }
  | { type: 'gameOver' }
  | { type: 'message'; text: string };

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}
