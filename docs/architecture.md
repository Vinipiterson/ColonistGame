# Colony Game — Architecture & Decisions

## Stack
TypeScript (strict) + Canvas 2D, Vite (single-file build), Vitest (headless sim tests + benchmark), Playwright/Chromium (e2e + screenshots). Deployed to GitHub Pages on every push to `master`.

## Design decisions (answered by Vinipi)
- Growth: periodic arrivals (pick 1 of 3 candidates), gated by enough food + a free bed; a powered beacon building shortens the interval.
- Walls: room bonuses. An enclosed room (built walls/doors, size cap) gets a type from its contents: Barracks (beds → better sleep), Mess Hall (tables → faster eating), Farm (plantations → faster growth).
- Radioactive matter: fuel for a reactor (high power). No hazard for now.
- Plants: several crops, data-driven (e.g. a slow crop on regular matter, a faster crop needing coal + power).
- Fall damage: scaled. ≤3 tiles safe; damage = 4·(h−3)², so 8 tiles is lethal. Health regens while sleeping. Pathing never plans falls >3.
- Losing footing: when the ground vanishes, a colonist hangs on up to 1 s and pulls itself onto a side tile (level, one up, one down), ONI-style; otherwise it falls.
- Build on natural tiles: wall/ladder/stairs orders may go on dirt/coal/radioactive; the job digs the tile out first (normal yield), then builds. A build replaces a pending dig order on the cell. Builds never target player-built tiles (use Deconstruct).
- Manual generator: costs time + faster sleep and hunger drain.
- Resources: global stockpile (no hauling); the model leaves room to add hauling later.
- Verticality: ladders (vertical shafts, slow) + Minecraft-style stair blocks (solid step blocks with a facing; R flips). Free 1-tile stepping kept: stairs make steps ~25% cheaper (cost 1.05 vs 1.4) and the planner prefers them.
- Doors: 1×2, not solid, slide open (render-only) when a colonist is within ~1 tile. Count as wall for rooms in M4. Lockable doors possible later.
- Food before farms: Ration Printer (2×2): a colonist turns 100 matter into 1 meal (10 s); colony keeps max(4, 2×colonists) meals; colony starts with 6 meals. Stays as a fallback after farms.
- No bed: floor nap at half speed. Exhaustion only kills if a colonist really can't rest.
- No plumbing/water for now: toilets, sinks, showers just cost matter.
- Colonists: 1 wide × 2 tall; position = feet cell. Work reach: ±1 tile horizontally, from 3 above the feet to 1 below.
- Priorities: 1–9 (9 highest) + Emergency (preempts). Bottom-right widget or keys 1–9 (0 = Emergency). Selection persists (also across reloads); default 6. Re-dragging a tool over existing orders re-prioritises them.

## Needs
| Need | Satisfied by | At zero |
|---|---|---|
| Hunger (0 in 1.5 days) | a meal; Mess Table 5 s, standing 9 s | starvation damage → death (~0.5 day) |
| Sleep (1.2 days) | Bed (2×1), floor at half speed | exhaustion damage → death |
| Bladder (0.8 day) | Toilet (1×2) then Sink (1×1, +hygiene; skipping it −8) | hold timer 0.3 day → death |
| Hygiene (2 days) | Shower (1×2) | no death; < 20 → work at 75% speed |

Thresholds per need: want (handle after the current job), urgent (drop the job, unless Emergency, and come back to it), critical (even Emergency). Checked once per second per colonist, staggered. Buildings have use slots (Mess Table 2) with reservations.

## Architecture
- Sim is pure TS, deterministic (seeded RNG), fixed 20 Hz tick; speeds 1×/2×/3× run more ticks per frame. Commands in, events out. The UI never mutates sim state directly.
- Grid: typed-array layers (tile, built flag, ladder, stair facing, building id, order id).
- Buildings: BuildingStore with footprints (x,y top-left, w×h, flip), not solid, use cells on the bottom row. Placement: footprint empty + solid floor under the bottom row. Drag places copies side by side.
- Nav: stand cell = 2 free cells + support. Edges generated on demand: walk, step ±1 (cheaper along a stair block), climb ladder, fall (one-way; planned only if ≤3).
- Regions: 16×16 chunks → connected components over two-way moves; edges store target cells (resolved at query time). Reachability = cached BFS per source region per version. Incremental chunk rebuilds.
- PathService: multi-goal A*, binary heap, generation stamps, node budget per tick, region pre-check.
- Revalidation: moving colonists whose remaining path crosses a dirty area re-check edges; broken → re-path; unreachable → next-best job.
- Orders: dig / build (tile or building footprint) / deconstruct (tile or building) / operate (automatic printer jobs). Indexed by priority and 16×16 chunk; only "active" orders (some stand cell in reach) are indexed. Idle retries back off 1 s → 6 s.
- Anti-trap rules: a job's work spot must be walk-there-and-back from the colonist (spots inside planned walls exempt). A solid build is deferred if it would cut a nearby colonist off from places it can reach today (dry-run region update). Walls over colonists: ask them to step out, after 2 s build anyway and push them up; stacks fill bottom-up; never seal a neighbouring planned wall. A colonist that still ends up cut off triggers a one-time "stuck" warning.
- Render: chunk bitmap cache (tiles + static buildings) redrawn only when dirty; doors, orders, ghosts, colonists and need icons per frame. Shared vector art (src/render/art.ts) also generates build-bar icons. UI is DOM.
- Saves: JSON with base64 typed arrays, plus file export/import (M5).
- Perf budget: 500 colonists, 256×192 map, ≤4 ms per tick average (tests/bench.test.ts).

## Milestones
1. DONE. World gen, camera, movement (walk/fall/ladder/scramble), Dig, Build (wall, ladder; into natural tiles), Deconstruct, Cancel, priority widget + Emergency, path revalidation, resources.
2. DONE. Multi-tile buildings + placement validation, rotatable stair blocks (R), automatic doors, needs + need buildings, Ration Printer, deaths, anti-trap rules, lose screen. 45 unit/scenario tests + 2 browser runs; benchmark ~1.5 ms/tick avg.
3. NEXT. Plants/food (several crops), power (manual generator, coal generator, battery, reactor).
4. Skills/XP/likings, rooms + bonuses.
5. Arrivals + beacon, save/load, performance pass to 500 colonists.
