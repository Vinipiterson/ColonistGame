// Static game data: tiles, resources, buildables, needs, priorities, tuning constants.
// Everything here is plain data so balancing never requires touching logic.

export const TICK_HZ = 20;
export const DT = 1 / TICK_HZ;
export const DAY_SECONDS = 600;

/** Max fall height (in tiles) that does no damage. Pathing never plans a fall above this. */
export const SAFE_FALL = 3;
export const GRAVITY = 30; // tiles / s^2
export const MAX_HEALTH = 100;

/** Damage for a fall of h tiles: 0 up to SAFE_FALL, then 4*(h-3)^2 (8 tiles = 100 = lethal). */
export function fallDamage(h: number): number {
  const over = h - SAFE_FALL;
  return over <= 0 ? 0 : 4 * over * over;
}

export const Tile = {
  Empty: 0,
  Dirt: 1,
  Coal: 2,
  Radioactive: 3,
  Bedrock: 4,
  Concrete: 5,
  /** Minecraft-style stair block: solid, with a facing (grid.tileDir: 1 = rises to the right). */
  Stairs: 6,
} as const;
export type TileId = (typeof Tile)[keyof typeof Tile];

export type ResourceId = 'matter' | 'coal' | 'radioactive' | 'food';
export const RESOURCES: ResourceId[] = ['matter', 'coal', 'radioactive', 'food'];
export const RESOURCE_LABEL: Record<ResourceId, string> = {
  matter: 'Matter',
  coal: 'Coal',
  radioactive: 'Radioactive',
  food: 'Meals',
};

export interface TileInfo {
  name: string;
  solid: boolean;
  /** Can be marked by the Dig tool (natural, not bedrock). */
  diggable: boolean;
  /** Seconds of work at skill level 0. */
  digWork: number;
  yieldRes?: ResourceId;
  yieldAmount?: number;
}

export const TILE_INFO: Record<number, TileInfo> = {
  [Tile.Empty]: { name: 'Empty', solid: false, diggable: false, digWork: 0 },
  [Tile.Dirt]: { name: 'Dirt', solid: true, diggable: true, digWork: 2.5, yieldRes: 'matter', yieldAmount: 50 },
  [Tile.Coal]: { name: 'Coal', solid: true, diggable: true, digWork: 3.5, yieldRes: 'coal', yieldAmount: 50 },
  [Tile.Radioactive]: { name: 'Radioactive matter', solid: true, diggable: true, digWork: 5, yieldRes: 'radioactive', yieldAmount: 25 },
  [Tile.Bedrock]: { name: 'Bedrock', solid: true, diggable: false, digWork: 0 },
  [Tile.Concrete]: { name: 'Concrete wall', solid: true, diggable: false, digWork: 0 },
  [Tile.Stairs]: { name: 'Stairs', solid: true, diggable: false, digWork: 0 },
};

/** Lookup table for the hot path (nav) — avoids object lookups per cell. */
export const SOLID: Uint8Array = (() => {
  const a = new Uint8Array(256);
  for (const k of Object.keys(TILE_INFO)) a[+k] = TILE_INFO[+k].solid ? 1 : 0;
  return a;
})();

// ---------------------------------------------------------------- buildables

export type BuildKind =
  | 'wall' | 'ladder' | 'stairs' // per-tile structures
  | 'door' | 'bed' | 'toilet' | 'sink' | 'shower' | 'table' | 'printer'; // multi-tile buildings

export type BuildCategory = 'structure' | 'furniture';

export interface BuildDef {
  kind: BuildKind;
  name: string;
  category: BuildCategory;
  /** 'tile' = one cell per order, painted with a rectangle; 'building' = footprint w x h. */
  shape: 'tile' | 'building';
  w: number;
  h: number;
  cost: Partial<Record<ResourceId, number>>;
  work: number; // seconds
  /** Completing it makes the cell(s) solid (needs them clear of colonists). */
  solid: boolean;
  /** R flips it (stairs direction, which end of the bed is the head...). */
  rotatable: boolean;
  /** Use slots: how many colonists can use it at once (cells along the bottom row). */
  slots: number;
  hint: string;
}

export const BUILDS: Record<BuildKind, BuildDef> = {
  wall: {
    kind: 'wall', name: 'Concrete Wall', category: 'structure', shape: 'tile', w: 1, h: 1,
    cost: { matter: 50 }, work: 3, solid: true, rotatable: false, slots: 0,
    hint: 'Solid tile. Nicer than raw dirt; rooms need it later.',
  },
  ladder: {
    kind: 'ladder', name: 'Ladder', category: 'structure', shape: 'tile', w: 1, h: 1,
    cost: { matter: 25 }, work: 2, solid: false, rotatable: false, slots: 0,
    hint: 'Vertical shaft. Compact but slow to climb.',
  },
  stairs: {
    kind: 'stairs', name: 'Stairs', category: 'structure', shape: 'tile', w: 1, h: 1,
    cost: { matter: 40 }, work: 3, solid: true, rotatable: true, slots: 0,
    hint: 'Solid step block. Place them diagonally for a staircase (needs headroom above each step).',
  },
  door: {
    kind: 'door', name: 'Door', category: 'structure', shape: 'building', w: 1, h: 2,
    cost: { matter: 60 }, work: 4, solid: false, rotatable: false, slots: 0,
    hint: 'Opens by itself when a colonist walks through.',
  },
  bed: {
    kind: 'bed', name: 'Bed', category: 'furniture', shape: 'building', w: 2, h: 1,
    cost: { matter: 80 }, work: 5, solid: false, rotatable: true, slots: 1,
    hint: 'Restores sleep twice as fast as the floor.',
  },
  toilet: {
    kind: 'toilet', name: 'Toilet', category: 'furniture', shape: 'building', w: 1, h: 2,
    cost: { matter: 80 }, work: 5, solid: false, rotatable: true, slots: 1,
    hint: 'Relieves bladder. Holding it too long is fatal.',
  },
  sink: {
    kind: 'sink', name: 'Sink', category: 'furniture', shape: 'building', w: 1, h: 1,
    cost: { matter: 40 }, work: 3, solid: false, rotatable: true, slots: 1,
    hint: 'Wash hands after the toilet for a hygiene bonus.',
  },
  shower: {
    kind: 'shower', name: 'Shower', category: 'furniture', shape: 'building', w: 1, h: 2,
    cost: { matter: 100 }, work: 5, solid: false, rotatable: false, slots: 1,
    hint: 'Restores hygiene. Dirty colonists work slower.',
  },
  table: {
    kind: 'table', name: 'Mess Table', category: 'furniture', shape: 'building', w: 2, h: 1,
    cost: { matter: 60 }, work: 4, solid: false, rotatable: false, slots: 2,
    hint: 'Two seats. Eating at a table is faster.',
  },
  printer: {
    kind: 'printer', name: 'Ration Printer', category: 'furniture', shape: 'building', w: 2, h: 2,
    cost: { matter: 150 }, work: 8, solid: false, rotatable: true, slots: 1,
    hint: `A colonist turns ${100} matter into 1 meal. Keeps a stock for everyone.`,
  },
};
export const BUILD_LIST: BuildKind[] = ['wall', 'ladder', 'stairs', 'door', 'bed', 'toilet', 'sink', 'shower', 'table', 'printer'];
export const DECONSTRUCT_WORK = 2;
export const DECONSTRUCT_REFUND = 0.5;

/** Ration printer recipe. */
export const PRINTER_MATTER = 100;
export const PRINTER_WORK = 10;

/** Movement cost of a step up/down taken along a stair block (a bare ledge costs 1.4). */
export const STAIR_STEP_COST = 1.05;

// ---------------------------------------------------------------- needs

export type NeedId = 'hunger' | 'sleep' | 'bladder' | 'hygiene';
export const NEEDS: NeedId[] = ['hunger', 'sleep', 'bladder', 'hygiene'];
export const NEED_LABEL: Record<NeedId, string> = { hunger: 'Food', sleep: 'Rest', bladder: 'Bladder', hygiene: 'Hygiene' };

export interface NeedDef {
  /** Points lost per second (100 = fully satisfied). */
  decay: number;
  /** Below this: handle it when the current job is done. */
  want: number;
  /** Below this: drop the job (unless Emergency) and handle it now. */
  urgent: number;
  /** Below this: even Emergency work is interrupted. */
  critical: number;
}

export const NEED_DEFS: Record<NeedId, NeedDef> = {
  hunger: { decay: 100 / (1.5 * DAY_SECONDS), want: 40, urgent: 20, critical: 6 },
  sleep: { decay: 100 / (1.2 * DAY_SECONDS), want: 30, urgent: 15, critical: 5 },
  bladder: { decay: 100 / (0.8 * DAY_SECONDS), want: 35, urgent: 15, critical: 6 },
  hygiene: { decay: 100 / (2 * DAY_SECONDS), want: 30, urgent: 0, critical: 0 },
};

/** Health lost per second while starving / exhausted (100 health = about half a day at 0). */
export const STARVE_DAMAGE = 100 / (0.5 * DAY_SECONDS);
export const EXHAUST_DAMAGE = 100 / (0.4 * DAY_SECONDS);
/** Seconds a colonist can hold it at 0 bladder before dying. */
export const BLADDER_HOLD_LIMIT = 0.3 * DAY_SECONDS;
/** Below this hygiene, work speed drops. */
export const DIRTY_THRESHOLD = 20;
export const DIRTY_WORK_SPEED = 0.75;

/** Seconds to use things, and what they restore. */
export const EAT_TIME_TABLE = 5;
export const EAT_TIME_STANDING = 9;
export const TOILET_TIME = 6;
export const SINK_TIME = 3;
export const SINK_HYGIENE = 12;
export const SKIP_SINK_HYGIENE = -8;
export const SHOWER_TIME = 10;
/** Sleep restored per second in a bed; the floor restores half. */
export const BED_SLEEP_RATE = 100 / 150;
export const FLOOR_SLEEP_FACTOR = 0.5;
/** Health regained per second while asleep. */
export const SLEEP_HEAL = 100 / DAY_SECONDS;

/** Priorities 1..9 (9 highest), 10 = Emergency. */
export const EMERGENCY = 10;
export const DEFAULT_PRIORITY = 6;
/** Priority of the automatic Ration Printer jobs (raised when meals run short). */
export const PRINTER_PRIORITY = 6;
export const PRINTER_PRIORITY_SHORT = 8;

export const START_RESOURCES: Record<ResourceId, number> = { matter: 300, coal: 0, radioactive: 0, food: 6 };

export const WALK_SPEED = 3; // tiles per second for a cost-1 edge
