// Milestone 4: skills (XP, levels, likes / loves / hates), building job priorities, the
// Priority tool and generator refuelling.
import { describe, expect, it } from 'vitest';
import { BUILDS, DEFAULT_PRIORITY, EMERGENCY, SKILLS, SKILL_SPEED_PER_LEVEL, TICK_HZ, levelXp } from '../src/sim/defs';
import { World } from '../src/sim/world';
import { cell, runUntil, worldFromAscii } from './helpers';

const R = (x0: number, y0: number, x1 = x0, y1 = y0) => ({ x0, y0, x1, y1 });
const SEC = TICK_HZ;

/** Room 20 wide with a dirt floor (diggable) and a colonist at (10,4). */
function room(): World {
  const w = worldFromAscii([
    'BBBBBBBBBBBBBBBBBBBBBB',
    'B....................B',
    'B....................B',
    'B....................B',
    'B.........@..........B',
    'B####################B',
    'BBBBBBBBBBBBBBBBBBBBBB',
  ]);
  w.resources.matter = 5000;
  return w;
}

/** The job the colonist picks right after the orders appear. */
function firstJob(w: World): string {
  const c = w.colonists[0];
  runUntil(w, () => !!c.job, 60);
  return c.job ? (c.job.kind === 'operate' ? c.job.task! : c.job.kind) : 'none';
}

describe('aptitudes', () => {
  it('every colonist is born with 1-2 likings; a love always comes with one hate', () => {
    const w = World.create({ seed: 7, colonists: 0 });
    let loves = 0;
    for (let i = 0; i < 300; i++) {
      const c = w.spawnColonist(w.spawn.x, w.spawn.y);
      const a = Object.values(c.aptitude);
      const liked = a.filter((x) => x === 'like' || x === 'love').length;
      expect(liked).toBeGreaterThanOrEqual(1);
      expect(liked).toBeLessThanOrEqual(2);
      const love = a.filter((x) => x === 'love').length;
      expect(a.filter((x) => x === 'hate').length).toBe(love);
      loves += love;
      for (const s of SKILLS) {
        const apt = c.aptitude[s];
        expect(c.level(s)).toBe(apt === 'love' ? 2 : apt === 'like' ? 1 : 0);
      }
    }
    expect(loves).toBeGreaterThan(40); // ~25%
    expect(loves).toBeLessThan(120);
  });

  it('aptitudes do not change the rest of the simulation (separate RNG stream)', () => {
    const a = World.create({ seed: 11, colonists: 3 });
    const b = World.create({ seed: 11, colonists: 3 });
    expect(a.colonists.map((c) => c.aptitude)).toEqual(b.colonists.map((c) => c.aptitude));
    expect(a.colonists.map((c) => c.tint)).toEqual(b.colonists.map((c) => c.tint));
  });
});

describe('likings and hates in job choice', () => {
  /** A dig order next to the colonist and a wall order farther away, at the given priorities. */
  function choice(digP: number, buildP: number, setup: (w: World) => void): string {
    const w = room();
    setup(w);
    w.issue({ type: 'dig', rect: R(11, 5), priority: digP });
    w.issue({ type: 'build', rect: R(18, 4), kind: 'wall', priority: buildP });
    return firstJob(w);
  }
  const likes = (s: 'building', a: 'like' | 'love' | 'hate') => (w: World) => { w.colonists[0].aptitude[s] = a; };

  it('a liked job counts one priority higher, a loved one two', () => {
    expect(choice(5, 5, () => {})).toBe('dig'); // nearer
    expect(choice(5, 5, likes('building', 'like'))).toBe('build');
    expect(choice(6, 5, likes('building', 'like'))).toBe('dig'); // tie: the real priority wins
    expect(choice(7, 5, likes('building', 'like'))).toBe('dig');
    expect(choice(6, 5, likes('building', 'love'))).toBe('build');
  });

  it('emergencies come first whatever the colonist likes', () => {
    expect(choice(EMERGENCY, 9, likes('building', 'love'))).toBe('dig');
  });

  it('a hated kind of work is never done', () => {
    const w = room();
    w.colonists[0].aptitude.digging = 'hate';
    w.issue({ type: 'dig', rect: R(11, 5), priority: 9 });
    w.run(30 * SEC);
    expect(w.grid.tile[cell(w, 11, 5)]).not.toBe(0);
    expect(w.colonists[0].job).toBe(null);
  });
});

describe('XP and levels', () => {
  it('work trains the skill (twice as fast when liked) and levels make work faster', () => {
    const rate = (liked: boolean, level: number) => {
      const w = room();
      const c = w.colonists[0];
      if (liked) c.aptitude.digging = 'like';
      c.xp.digging = levelXp(level);
      w.issue({ type: 'dig', rect: R(11, 5, 16, 5), priority: 6 });
      runUntil(w, () => c.state === 'working', 200);
      const o = c.job!, p0 = o.progress, xp0 = c.xp.digging;
      w.run(SEC);
      return { speed: o.progress - p0, xp: c.xp.digging - xp0 };
    };
    expect(rate(false, 0)).toEqual({ speed: expect.closeTo(1, 5), xp: expect.closeTo(1, 5) });
    expect(rate(true, 0).xp).toBeCloseTo(2, 5);
    expect(rate(false, 5).speed).toBeCloseTo(1 + 5 * SKILL_SPEED_PER_LEVEL, 5);
  });

  it('levelling up is announced', () => {
    const w = room();
    const c = w.colonists[0];
    c.xp.digging = levelXp(1) - 0.5;
    w.issue({ type: 'dig', rect: R(11, 5), priority: 6 });
    runUntil(w, () => c.level('digging') === 1, 400);
    expect(w.events.some((e) => e.type === 'message' && e.text.includes('Digging level 1'))).toBe(true);
  });
});

describe('building priorities', () => {
  it('work buildings start at their default priority; jobs there use it', () => {
    const w = room();
    w.resources.food = 50; // no meal jobs
    const crank = w.buildings.add('crank', 4, 3, false);
    const station = w.buildings.add('research', 7, 3, false);
    expect(crank.priority).toBe(BUILDS.crank.jobPriority);
    expect(station.priority).toBe(BUILDS.research.jobPriority);
    expect(w.buildings.add('bed', 14, 4, false).priority).toBe(DEFAULT_PRIORITY); // (not used)
  });

  it('a printer set to 9 beats a priority-8 dig; the pending job follows the change', () => {
    const w = room();
    w.resources.food = 0;
    const printer = w.buildings.add('printer', 4, 3, false);
    w.buildings.add('battery', 7, 3, false).charge = 20_000;
    const c = w.colonists[0];
    c.retryAt = Infinity; // keep it out of assignment; ask the job search directly
    w.issue({ type: 'configure', buildingId: printer.id, priority: 9 });
    w.issue({ type: 'dig', rect: R(11, 5), priority: 8 });
    w.run(SEC); // the machine update queues the print job
    expect(w.jobOf(printer.id)?.priority).toBe(9);
    expect(w.findJob(c)?.order.task).toBe('print');
    w.issue({ type: 'configure', buildingId: printer.id, priority: 3 });
    w.step();
    expect(printer.priority).toBe(3);
  });

  it('meal jobs are raised 2 while meals run short', () => {
    const w = room();
    w.resources.food = 0;
    const printer = w.buildings.add('printer', 4, 3, false);
    w.issue({ type: 'configure', buildingId: printer.id, priority: 4 });
    w.run(SEC);
    expect(w.jobOf(printer.id)?.priority).toBe(6);
  });

  it('the Priority tool re-prioritises orders and work buildings in the rectangle, nothing else', () => {
    const w = room();
    const station = w.buildings.add('research', 3, 3, false);
    const bed = w.buildings.add('bed', 6, 4, false);
    w.issue({ type: 'dig', rect: R(9, 5, 12, 5), priority: 6 });
    w.step();
    const n = w.orders.count;
    w.issue({ type: 'prioritize', rect: R(2, 2, 10, 5), priority: 2 });
    w.step();
    expect(station.priority).toBe(2);
    expect(bed.priority).toBe(DEFAULT_PRIORITY);
    const prios = [...w.orders.all()].filter((o) => o.kind === 'dig').map((o) => [o.x, o.priority]);
    expect(prios).toEqual(expect.arrayContaining([[9, 2], [10, 2], [11, 6], [12, 6]]));
    expect(w.orders.count).toBe(n);
  });
});

describe('generator fuel', () => {
  it('a colonist refills an empty tank from the stockpile; the generator then runs on it', () => {
    const w = room();
    w.resources.coal = 100;
    const gen = w.buildings.add('coalgen', 4, 3, false);
    const lamp = w.buildings.add('lamp', 8, 1, false);
    expect(gen.tank).toBe(0);
    w.run(2 * SEC);
    expect(lamp.powered).toBe(false);
    expect(w.jobOf(gen.id)?.task).toBe('refuel');
    const c = w.colonists[0];
    runUntil(w, () => gen.tank > 0, 60 * SEC);
    expect(gen.tank).toBe(BUILDS.coalgen.fuel!.tank);
    expect(w.resources.coal).toBe(100 - BUILDS.coalgen.fuel!.tank);
    expect(c.xp.operating).toBeGreaterThan(0);
    w.run(2 * SEC);
    expect(lamp.powered).toBe(true);
    expect(gen.tank).toBeLessThan(BUILDS.coalgen.fuel!.tank);
  });
});
