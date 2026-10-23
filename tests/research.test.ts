// Research (stations, tiers, unlocks), outhouse cleaning and the planter grow lamp.
import { describe, expect, it } from 'vitest';
import { CROPS, GROW_LAMP_BONUS, OUTHOUSE_USES, RESEARCH, TICK_HZ } from '../src/sim/defs';
import type { World } from '../src/sim/world';
import { runUntil, worldFromAscii } from './helpers';

const R = (x0: number, y0: number, x1 = x0, y1 = y0) => ({ x0, y0, x1, y1 });
const SEC = TICK_HZ;

function room(colonist = true): World {
  return worldFromAscii([
    'BBBBBBBBBBBBBBBBBBBBBB',
    'B....................B',
    'B....................B',
    'B....................B',
    colonist ? 'B.@..................B' : 'B....................B',
    'BBBBBBBBBBBBBBBBBBBBBB',
  ]);
}

/** Step n ticks keeping needs topped up (no toilets or beds in these rooms). */
function runFed(w: World, n: number, until?: () => boolean): number {
  for (let i = 0; i < n; i++) {
    if (until && until()) return i;
    if (i % 100 === 0) for (const c of w.colonists) for (const k of Object.keys(c.needs) as (keyof typeof c.needs)[]) c.needs[k] = 100;
    w.step();
  }
  return until && until() ? n : -1;
}

/** Plenty of power: a coal generator with coal (placed directly, research skipped). */
function powered(w: World, x = 16): void {
  w.resources.coal = 1000;
  w.buildings.add('coalgen', x, 3, false);
}

const buildOrders = (w: World) => [...w.orders.all()].filter((o) => o.kind === 'build').map((o) => o.build);

describe('research', () => {
  it('only the starting kit can be built; locked buildings and crops are refused', () => {
    const w = room();
    w.resources.matter = 5000;
    w.issue({ type: 'build', rect: R(4, 4), kind: 'planter', priority: 6 });
    w.issue({ type: 'build', rect: R(6, 4), kind: 'research', priority: 6 });
    w.issue({ type: 'build', rect: R(9, 4), kind: 'toilet', priority: 6 });
    w.issue({ type: 'build', rect: R(11, 4), kind: 'shower', priority: 6 });
    w.step();
    expect(buildOrders(w).sort()).toEqual(['research', 'toilet']);
    const p = w.buildings.add('planter', 14, 3, false);
    w.issue({ type: 'configure', buildingId: p.id, crop: 'tuber' });
    w.issue({ type: 'configure', buildingId: p.id, lamp: true });
    w.step();
    expect(p.crop).toBe('mushroom');
    expect(p.lamp).toBe(false);
  });

  it('a colonist researches the selected project at a powered station, which unlocks it', () => {
    const w = room();
    w.resources.matter = 1000;
    powered(w);
    w.buildings.add('research', 6, 3, false);
    w.issue({ type: 'research', id: 'tubers' }); // needs Basic Farming + Advanced Research first
    w.step();
    expect(w.research.active).toBe(null);
    w.issue({ type: 'research', id: 'farming' });
    const c = w.colonists[0];
    runFed(w, 30 * SEC, () => c.job?.task === 'research' && c.state === 'working');
    expect(c.activity()).toBe('Researching');
    const t = runFed(w, 400 * SEC, () => w.research.done.has('farming'));
    expect(t).toBeGreaterThan(0);
    expect(w.research.active).toBe(null);
    expect([...w.orders.all()].some((o) => o.task === 'research')).toBe(false);
    expect(w.events.some((e) => e.type === 'message' && e.text.includes('Basic Farming'))).toBe(true);
    expect(w.isUnlocked('planter')).toBe(true);
    expect(w.cropUnlocked('mushroom')).toBe(true);
    expect(w.cropUnlocked('tuber')).toBe(false);
    w.issue({ type: 'build', rect: R(10, 4), kind: 'planter', priority: 6 });
    w.step();
    expect(buildOrders(w)).toContain('planter');
  });

  it('research needs power: without it the station stays idle', () => {
    const w = room();
    w.buildings.add('research', 6, 3, false);
    w.issue({ type: 'research', id: 'batteries' });
    runFed(w, 60 * SEC);
    expect(w.research.progress.batteries ?? 0).toBe(0);
  });

  it('tier 2 projects only run on the Advanced Research Station', () => {
    const w = room();
    powered(w);
    w.buildings.add('research', 6, 3, false);
    w.completeResearch('farming');
    w.completeResearch('advresearch');
    w.issue({ type: 'research', id: 'tubers' });
    runFed(w, 60 * SEC);
    expect(w.research.active).toBe('tubers');
    expect(w.research.progress.tubers ?? 0).toBe(0);
    w.buildings.add('advresearch', 10, 3, false);
    runFed(w, 90 * SEC);
    expect(w.research.progress.tubers).toBeGreaterThan(20);
    // switching projects keeps the points
    const pts = w.research.progress.tubers!;
    w.issue({ type: 'research', id: 'batteries' });
    runFed(w, 60 * SEC);
    expect(w.research.progress.tubers).toBe(pts);
    expect(w.research.progress.batteries).toBeGreaterThan(0);
  });

  it('every tier 2 project depends on Advanced Research (directly or through another one)', () => {
    const deps = (id: keyof typeof RESEARCH): Set<string> => {
      const out = new Set<string>();
      for (const n of RESEARCH[id].needs) {
        out.add(n);
        for (const m of deps(n)) out.add(m);
      }
      return out;
    };
    for (const [id, d] of Object.entries(RESEARCH)) {
      if (d.tier === 2) expect(deps(id as keyof typeof RESEARCH).has('advresearch')).toBe(true);
    }
  });
});

describe('outhouse', () => {
  it('gets dirty after 5 uses, is skipped while dirty, and a colonist cleans it', () => {
    const w = room();
    const out = w.buildings.add('toilet', 8, 3, false);
    const c = w.colonists[0];
    out.uses = OUTHOUSE_USES - 1;
    c.needs.bladder = 10;
    runUntil(w, () => out.dirty, 60 * SEC);
    expect(out.dirty).toBe(true);
    // the clean job goes up and gets done
    const t = runUntil(w, () => !out.dirty, 60 * SEC);
    expect(t).toBeGreaterThan(0);
    expect(out.uses).toBe(0);
  });

  it('a dirty outhouse is not used; the flush toilet never gets dirty', () => {
    const w = room();
    const out = w.buildings.add('toilet', 3, 3, false);
    const flush = w.buildings.add('flushtoilet', 12, 3, false);
    out.dirty = true; // closer, but dirty (the need check at tick 19 comes before the clean job)
    const c = w.colonists[0];
    c.needs.bladder = 10;
    runUntil(w, () => c.needTask?.kind === 'toilet', 60 * SEC);
    expect(c.needTask?.buildingId).toBe(flush.id);
    for (let i = 0; i < 6; i++) {
      c.needs.bladder = 10;
      runUntil(w, () => c.needs.bladder > 90, 60 * SEC);
    }
    expect(flush.dirty).toBe(false);
  });
});

describe('grow lamp', () => {
  it('needs research; when powered, any crop grows 50% faster', () => {
    const w = room(false);
    powered(w);
    const plain = w.buildings.add('planter', 3, 3, false);
    const lit = w.buildings.add('planter', 4, 3, false);
    plain.planted = lit.planted = true;
    w.issue({ type: 'configure', buildingId: lit.id, lamp: true });
    w.step();
    expect(lit.lamp).toBe(false); // not researched yet
    w.completeResearch('growlamps');
    w.issue({ type: 'configure', buildingId: lit.id, lamp: true });
    w.run(2 * SEC);
    const g0 = lit.growth, p0 = plain.growth;
    w.run(100 * SEC);
    expect(lit.powered).toBe(true);
    expect((lit.growth - g0) / (plain.growth - p0)).toBeCloseTo(GROW_LAMP_BONUS, 5);
    expect(plain.growth - p0).toBeCloseTo(100 / CROPS.mushroom.growSeconds, 5);
  });
});
