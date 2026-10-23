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

export type CropId = 'mushroom' | 'tuber' | 'sunberry';
export type ResourceId = 'matter' | 'coal' | 'radioactive' | CropId | 'food';
export const RESOURCES: ResourceId[] = ['matter', 'coal', 'radioactive', 'mushroom', 'tuber', 'sunberry', 'food'];
export const RESOURCE_LABEL: Record<ResourceId, string> = {
  matter: 'Matter',
  coal: 'Coal',
  radioactive: 'Radioactive',
  mushroom: 'Mushrooms',
  tuber: 'Tubers',
  sunberry: 'Sunberries',
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
  | 'door' | 'bed' | 'toilet' | 'sink' | 'shower' | 'table' // multi-tile buildings
  | 'printer' | 'planter' | 'stove' // food
  | 'crank' | 'coalgen' | 'battery' | 'reactor' | 'lamp'; // power

export type BuildCategory = 'structure' | 'furniture' | 'food' | 'power';

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
  /** 'ceiling': hangs under a solid tile instead of standing on a floor. */
  mount?: 'floor' | 'ceiling';
  /** Watts drawn while active (lamp: while on; workstation: while operated). */
  powerUse?: number;
  /** Watts produced while running. */
  powerGen?: number;
  /** Generator fuel burnt per second while running. */
  fuel?: { res: ResourceId; perSec: number };
  /** Battery capacity in joules. */
  capacity?: number;
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
    kind: 'printer', name: 'Ration Printer', category: 'food', shape: 'building', w: 2, h: 2,
    cost: { matter: 150 }, work: 8, solid: false, rotatable: true, slots: 1, powerUse: 200,
    hint: 'A colonist turns 100 matter into 1 meal (200 W while printing). Keeps a stock for everyone.',
  },
  planter: {
    kind: 'planter', name: 'Planter', category: 'food', shape: 'building', w: 1, h: 2,
    cost: { matter: 60 }, work: 4, solid: false, rotatable: false, slots: 1,
    hint: 'Grows one crop (click it to choose). Colonists sow and harvest it automatically.',
  },
  stove: {
    kind: 'stove', name: 'Cooking Station', category: 'food', shape: 'building', w: 2, h: 2,
    cost: { matter: 200 }, work: 6, solid: false, rotatable: true, slots: 1, powerUse: 150,
    hint: 'A colonist cooks crops into meals (150 W while cooking). Used before the printer.',
  },
  crank: {
    kind: 'crank', name: 'Manual Generator', category: 'power', shape: 'building', w: 2, h: 2,
    cost: { matter: 150 }, work: 5, solid: false, rotatable: true, slots: 1, powerGen: 400,
    hint: 'A colonist cranks it for 400 W when power runs short. Tiring: hunger and sleep drain twice as fast.',
  },
  coalgen: {
    kind: 'coalgen', name: 'Coal Generator', category: 'power', shape: 'building', w: 2, h: 2,
    cost: { matter: 300 }, work: 8, solid: false, rotatable: true, slots: 0, powerGen: 800,
    fuel: { res: 'coal', perSec: 0.1 },
    hint: '800 W, burns 0.1 coal/s from the stockpile. Runs only while power is needed or batteries are low.',
  },
  battery: {
    kind: 'battery', name: 'Battery', category: 'power', shape: 'building', w: 1, h: 2,
    cost: { matter: 200 }, work: 5, solid: false, rotatable: false, slots: 0, capacity: 20_000,
    hint: 'Stores 20 kJ of spare power (leaks slowly). Generators refill it.',
  },
  reactor: {
    kind: 'reactor', name: 'Reactor', category: 'power', shape: 'building', w: 3, h: 3,
    cost: { matter: 600, radioactive: 25 }, work: 15, solid: false, rotatable: false, slots: 0, powerGen: 3000,
    fuel: { res: 'radioactive', perSec: 0.01 },
    hint: '3000 W, burns 0.01 radioactive/s. Runs only while power is needed or batteries are low.',
  },
  lamp: {
    kind: 'lamp', name: 'Ceiling Lamp', category: 'power', shape: 'building', w: 1, h: 1,
    cost: { matter: 30 }, work: 2, solid: false, rotatable: false, slots: 0, powerUse: 10, mount: 'ceiling',
    hint: 'Hangs under a solid tile, 10 W. Lights 5 tiles around (walls block it): work there is 10% faster.',
  },
};
export const BUILD_LIST: BuildKind[] = [
  'wall', 'ladder', 'stairs', 'door', 'bed', 'toilet', 'sink', 'shower', 'table',
  'printer', 'planter', 'stove', 'crank', 'coalgen', 'battery', 'reactor', 'lamp',
];
export const DECONSTRUCT_WORK = 2;
export const DECONSTRUCT_REFUND = 0.5;

/** Ration printer recipe. */
export const PRINTER_MATTER = 100;
export const PRINTER_WORK = 10;

// ---------------------------------------------------------------- farming

export interface CropDef {
  name: string;
  /** Paid from the stockpile when the seed goes in. */
  sowCost: Partial<Record<ResourceId, number>>;
  /** Seconds from sowing to ripe while its needs are met. */
  growSeconds: number;
  /** Crop units per harvest. */
  yield: number;
  /** Grow lamp watts; the plant only grows while powered. */
  powerUse: number;
  /** Crop units the Cooking Station turns into 1 meal (also the size of one raw portion). */
  perMeal: number;
  hint: string;
}

export const CROPS: Record<CropId, CropDef> = {
  mushroom: {
    name: 'Mushroom', sowCost: {}, growSeconds: 3 * DAY_SECONDS, yield: 2, powerUse: 0, perMeal: 2,
    hint: 'Free and slow: 3 days for 2 mushrooms (1 meal).',
  },
  tuber: {
    name: 'Tuber', sowCost: { matter: 20 }, growSeconds: 2 * DAY_SECONDS, yield: 2, powerUse: 0, perMeal: 2,
    hint: '20 matter of fertilizer: 2 days for 2 tubers (1 meal).',
  },
  sunberry: {
    name: 'Sunberry', sowCost: { coal: 10 }, growSeconds: 1 * DAY_SECONDS, yield: 2, powerUse: 60, perMeal: 1,
    hint: '10 coal and a 60 W grow lamp: 1 day for 2 sunberries (2 meals).',
  },
};
export const CROP_LIST: CropId[] = ['mushroom', 'tuber', 'sunberry'];
export const DEFAULT_CROP: CropId = 'tuber';
export const SOW_WORK = 4;
export const HARVEST_WORK = 3;
export const COOK_WORK = 8;
export const FARM_PRIORITY = 6;
/** No meals left: a raw portion (perMeal crop units) restores this much hunger and takes longer. */
export const RAW_HUNGER = 60;
export const RAW_EAT_FACTOR = 1.5;

// ---------------------------------------------------------------- power

/** Power is settled once a second over one colony-wide pool (no wires yet). */
export const POWER_TICKS = 20;
/** Batteries lose this fraction of their charge per second. */
export const BATTERY_LEAK = 0.0002;
/** Fuel generators start when batteries drop below GEN_START of capacity, stop above GEN_STOP. */
export const GEN_START = 0.9;
export const GEN_STOP = 0.99;
/** Seconds of cranking per job, and how much faster hunger and sleep drain meanwhile. */
export const CRANK_WORK = 30;
export const CRANK_DRAIN = 2;
export const CRANK_PRIORITY = 7;
/** Crank when batteries are below this fraction and something draws power. */
export const CRANK_BELOW = 0.5;
/** A powered workstation job is only taken with this many seconds of its draw stored (or spare). */
export const POWER_RESERVE_SECONDS = 5;
/** Seconds a colonist waits at an unpowered workstation before giving the job up for a while. */
export const POWER_WAIT = 3;

// ---------------------------------------------------------------- light

export const LAMP_RADIUS = 5;
export const LIGHT_WORK_BONUS = 1.1;

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

export const START_RESOURCES: Record<ResourceId, number> = {
  matter: 300, coal: 0, radioactive: 0, mushroom: 0, tuber: 0, sunberry: 0, food: 6,
};

export const WALK_SPEED = 3; // tiles per second for a cost-1 edge
