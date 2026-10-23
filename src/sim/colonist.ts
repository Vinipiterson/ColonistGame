// Colonist data. Behaviour lives in world.ts (it needs the grid, orders and path service).
// Plain objects on purpose: at hundreds of colonists the cost is in pathing / job search,
// not in property access, and objects keep the AI readable.

import { MAX_HEALTH, type CropId, type NeedId } from './defs';
import type { OperateTask, Order } from './orders';
import type { Path, PathRequest } from './pathfinder';

export type ColonistState =
  | 'idle' | 'pathing' | 'moving' | 'working' | 'using' | 'scrambling' | 'falling' | 'dead';
export type GoalKind = 'job' | 'evacuate' | 'need' | null;

/** What a colonist does to satisfy a need. */
export type NeedTaskKind = 'eat' | 'sleep' | 'toilet' | 'sink' | 'shower';

export interface NeedTask {
  kind: NeedTaskKind;
  /** Building used (-1 = none: eating standing up or napping on the floor). */
  buildingId: number;
  slot: number;
  /** Seconds spent using it so far. */
  timer: number;
  /** Eating: no meals, so a raw portion of this crop (null = a meal). */
  raw: CropId | null;
}

export const NAMES = [
  'Ada', 'Bram', 'Cleo', 'Dario', 'Edda', 'Faro', 'Gilda', 'Hugo', 'Ines', 'Jory', 'Kesi', 'Lio',
  'Mara', 'Nico', 'Odile', 'Pim', 'Quill', 'Rosa', 'Sven', 'Tula', 'Ugo', 'Vera', 'Wren', 'Xavi',
  'Yara', 'Zeno', 'Alba', 'Bento', 'Cora', 'Dell', 'Enzo', 'Fia', 'Gus', 'Hana', 'Ivo', 'Juno',
];

export const TINTS = ['#e07a5f', '#81b29a', '#f2cc8f', '#3d85c6', '#c77dff', '#ef476f', '#06d6a0', '#ffd166', '#118ab2'];

export class Colonist {
  readonly id: number;
  name: string;
  tint: string;

  cell = 0;
  x = 0;
  y = 0;
  /** Continuous feet position (tile units) and the previous tick's, for render interpolation. */
  px = 0;
  py = 0;
  prevPx = 0;
  prevPy = 0;

  state: ColonistState = 'idle';
  health = MAX_HEALTH;
  deathCause: string | null = null;

  /** 100 = fully satisfied, 0 = desperate. */
  needs: Record<NeedId, number> = { hunger: 100, sleep: 100, bladder: 100, hygiene: 100 };
  /** Seconds spent at 0 bladder (death at BLADDER_HOLD_LIMIT). */
  bladderHold = 0;
  needTask: NeedTask | null = null;
  /** Wash hands next (set after using a toilet). */
  sinkPending = false;
  /** Job given up to handle a need; taken back afterwards if still free. */
  resumeOrder: Order | null = null;

  job: Order | null = null;
  goal: GoalKind = null;
  req: PathRequest | null = null;
  path: Path | null = null;
  /** Bounding box of the current path, used to skip revalidation cheaply. */
  pathBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  pathI = 0;
  edgeFrom = 0;
  edgeT = 0;
  edgeDur = 0;

  fallFromY = 0;
  vy = 0;

  /** Ground vanished: seconds spent hanging on, and the side cell being scrambled to (-1 = none). */
  scrambleTime = 0;
  scrambleFrom = 0;
  scrambleTo = -1;
  scrambleT = 0;

  /** Don't re-run the evacuation search before this tick. */
  evacRetryAt = 0;
  /** Don't look for a need building again before this tick (none was reachable). */
  needRetryAt = 0;
  /** Cut off from the colony (can't walk to the spawn or any toilet/bed/printer and back). */
  stuck = false;

  retryAt = 0;
  /** Consecutive failed job searches (drives retry backoff). */
  failCount = 0;
  inQueue = false;
  facing = 1;
  /** Animation phase for the tilt wobble (render only, but kept in sim for determinism). */
  phase = 0;

  constructor(id: number, name: string, tint: string) {
    this.id = id;
    this.name = name;
    this.tint = tint;
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  placeAt(cell: number, w: number): void {
    this.cell = cell;
    this.x = cell % w;
    this.y = (cell / w) | 0;
    this.px = this.prevPx = this.x;
    this.py = this.prevPy = this.y;
  }

  /** Short label for the UI. */
  activity(): string {
    switch (this.state) {
      case 'dead': return `Dead (${this.deathCause ?? 'unknown'})`;
      case 'falling': return 'Falling!';
      case 'scrambling': return 'Losing footing!';
      case 'idle': return 'Idle';
      case 'pathing': return 'Planning route';
      case 'moving':
        if (this.goal === 'evacuate') return 'Making room';
        if (this.goal === 'need' && this.needTask) return `Going to ${NEED_TASK_LABEL[this.needTask.kind].toLowerCase()}`;
        return `Going to ${this.jobLabel().toLowerCase()}`;
      case 'working': return this.jobLabel();
      case 'using': {
        const t = this.needTask;
        if (!t) return 'Busy';
        if (t.kind === 'sleep' && t.buildingId < 0) return 'Napping on the floor';
        if (t.kind === 'eat' && t.raw) return 'Eating raw crops';
        if (t.kind === 'eat' && t.buildingId < 0) return 'Eating standing up';
        return NEED_TASK_LABEL[t.kind];
      }
    }
  }

  private jobLabel(): string {
    const j = this.job;
    if (!j) return 'Work';
    if (j.kind === 'dig') return 'Digging';
    if (j.kind === 'build') return `Building ${j.build}`;
    if (j.kind === 'operate') return OPERATE_LABEL[j.task ?? 'print'];
    return 'Deconstructing';
  }
}

const OPERATE_LABEL: Record<OperateTask, string> = {
  print: 'Printing rations',
  cook: 'Cooking',
  sow: 'Sowing',
  harvest: 'Harvesting',
  crank: 'Cranking the generator',
};

export const NEED_TASK_LABEL: Record<NeedTaskKind, string> = {
  eat: 'Eating',
  sleep: 'Sleeping',
  toilet: 'Using the toilet',
  sink: 'Washing hands',
  shower: 'Showering',
};
