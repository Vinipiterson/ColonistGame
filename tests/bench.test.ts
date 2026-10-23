// Performance benchmark: 500 colonists on a 256x192 map with thousands of dig orders.
// Budget from the architecture: <= 4 ms average per tick.
import { expect, it } from 'vitest';
import { Tile } from '../src/sim/defs';
import { World } from '../src/sim/world';

it('500 colonists stay within the tick budget', () => {
  const w = World.create({ seed: 99, w: 256, h: 192, colonists: 0 });
  const g = w.grid;
  // Carve a multi-floor base: 10 halls of 5 rows each, dirt floors 2 thick, stair shafts.
  const X0 = 16, X1 = 240;
  for (let f = 0; f < 10; f++) {
    const top = 20 + f * 7;
    for (let y = top; y < top + 5; y++) for (let x = X0; x <= X1; x++) g.rawSetTile(x, y, Tile.Empty);
    for (let y = top + 5; y < top + 7; y++) for (let x = X0; x <= X1; x++) g.rawSetTile(x, y, Tile.Dirt);
  }
  for (let sx = X0 + 10; sx < X1; sx += 40) {
    for (let y = 20; y < 20 + 7 * 10 - 2; y++) {
      g.rawSetTile(sx, y, Tile.Empty);
      g.stairs[g.idx(sx, y)] = 1;
    }
  }
  g.touchAll();
  for (let i = 0; i < 500; i++) {
    const f = i % 10;
    const x = X0 + 2 + ((i * 37) % (X1 - X0 - 4));
    w.spawnColonist(x, 20 + f * 7 + 4);
  }
  // Dig everything below the base and in the lower floor slabs, priorities mixed.
  for (let p = 1; p <= 9; p++) {
    const y0 = 20 + 70 + (p - 1) * 4;
    w.issue({ type: 'dig', rect: { x0: X0, y0, x1: X1, y1: y0 + 3 }, priority: p });
  }
  w.issue({ type: 'dig', rect: { x0: X0, y0: 20, x1: X1, y1: 90 }, priority: 5 });
  w.step();
  const orders0 = w.orders.count;

  const N = 2400; // 2 minutes of game time
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    w.step();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / N;
  const p99 = times[Math.floor(N * 0.99)];
  const busy = w.colonists.filter((c) => c.state !== 'idle').length;
  console.log(
    `bench: orders ${orders0} -> ${w.orders.count}, busy ${busy}/500, avg ${avg.toFixed(2)} ms, ` +
      `p99 ${p99.toFixed(2)} ms, max ${times[N - 1].toFixed(2)} ms, searches ${w.paths.stats.searches}, ` +
      `expanded ${w.paths.stats.expanded}, regions ${w.regions.regionCount}`,
  );
  expect(orders0 - w.orders.count).toBeGreaterThan(500);
  expect(avg).toBeLessThan(4);
}, 120_000);
