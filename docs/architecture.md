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
- Building priorities (M4): every building colonists work at (printer, stove, planter, manual / coal generator, reactor, research stations) has its own job priority, set in the inspector or with the Priority tool (P: drag a rectangle, only priorities change, for orders and work buildings). Defaults: food/farm/fuel 6, crank 7, research 5; meal jobs +2 while meals run short. Beds, toilets, showers, tables etc. have none. Outhouse cleaning stays at 7.
- Build menu (M4): locked buildings are hidden until researched; a category tab with nothing unlocked is hidden.
- Fuel (M4): coal generators and reactors burn from a tank (30 coal / 10 radioactive) that colonists refill from the stockpile (Operating job, at the generator's priority) when it is below half.
- Skills (M4): colonists level skills by working; nobody assigns skills by hand. Each is born with 1–2 likings; ~1 in 4 has a love instead, which always comes with a hate (that work is never done). Like: +1 job priority, 2× XP, starts at level 1. Love: +2, 3× XP, level 2. Emergencies still come first. The Advanced Research Station needs Research level 3.
- Power (M3): one colony-wide pool, no wires (matches the global stockpile). Buildings keep enough state that per-network wiring can be added later.
- Food (M3): harvests give raw crops (own resources); a powered Cooking Station turns them into meals and is used before the Ration Printer. With no meals, colonists eat a raw portion (the amount that makes a meal): +60 hunger, 1.5× slower.
- Ration Printer needs power (200 W while printing), so the first power source is usually a Manual Generator; the colony starts with 6 meals.
- Research (M3b): most buildings and crops are unlocked by research. Starting kit: Wall, Ladder, Stairs, Door, Bed, Outhouse, Sink, Mess Table, Ration Printer, Manual Generator, Research Station. Research Station (100 W) does tier 1 only; tier 1 includes Advanced Research, which unlocks the Advanced Research Station (200 W) for tier 2. Tiered point costs slow progress down. A skill/level requirement for the advanced station waits for M4 skills.
- Outhouse: dirty after 5 uses, unusable until a colonist cleans it (automatic job, priority 7). The Flush Toilet (Advanced Furniture) cleans itself.
- Grow lamp: a researched planter upgrade (inspector switch): 60 W, +50% growth for any crop; sunberries only grow under it.
- Lamps: light radius 5, blocked by solid tiles (line of sight); +10% work speed in lit cells.

## Farming & power (M3)
| Crop | Seed | Grow | Yield | Needs | Cook ratio |
|---|---|---|---|---|---|
| Mushroom | — | 3 days | 2 | nothing | 2 → 1 meal |
| Tuber | 20 matter | 2 days | 2 | nothing | 2 → 1 meal |
| Sunberry | 10 coal | 1 day | 2 | powered grow lamp | 1 → 1 meal |

| Building | Size | Power | Notes |
|---|---|---|---|
| Planter | 1×2 | 60 W with grow lamp | crop picked in the inspector (changing it uproots); auto sow / harvest jobs |
| Cooking Station | 2×2 | 150 W while cooking | crop with the most meals' worth in stock |
| Ration Printer | 2×2 | 200 W while printing | 100 matter → 1 meal |
| Manual Generator | 2×2 | +400 W while cranked | crank jobs (30 s, priority 7) while power is short; hunger and sleep drain 2× |
| Coal Generator | 2×2 | +800 W | 0.1 coal/s |
| Reactor | 3×3 | +3000 W | 0.01 radioactive/s, no hazard yet |
| Battery | 1×2 | stores 20 kJ | leaks 0.02%/s |
| Ceiling Lamp | 1×1 | 10 W | hangs under a solid tile |

- Settled once a second (src/sim/world.ts `updatePower`): cranked energy counts; fuel generators (building id order) run while batteries are below 90% (keep running to 99%) or can't cover the deficit; consumers are served in building id order from generation + storage (brownout: the rest go dark and show a ⚡ badge); surplus charges batteries.
- Workstations draw power only while a colonist works there. Their jobs are only taken with power available (≥ 5 s of draw stored, or spare generation); a colonist at an unpowered one gives up after 3 s. Skipped/unmet power triggers crank jobs.
- Automatic jobs are operate orders with a task (print / cook / sow / harvest / crank) and their own cost, one per building (`opOrders`). Meals: stoves then printers top the stock up to max(4, 2×colonists).
- Light map (src/sim/light.ts): rebuilt only when a lamp's powered state changes or the grid changes near a lit lamp.
- Inspector: clicking a building shows status + controls (crop, grow lamp, on/off) and issues `configure` commands.

## Rooms + happiness (M4b)
- Rooms (src/sim/rooms.ts): open cells closed off on every side by **built** walls, stair blocks or doors, 12–120 cells. Natural tiles (dirt, coal, bedrock) leak. Local updates once a second around grid edits and building changes; floods stop at the first natural tile or at 121 cells.
- Types by contents: Laboratory (research station; research +10%), Farm (2+ planters; growth +20%), Barracks (beds, no workstation; sleep +25%, mood), Mess Hall (tables, no beds; mood), Washroom (toilet/sink/shower; mood), else Room. Nice = decor ≥ 0.5 per cell (Potted Plant 10, Painting 25): room moodlets ×2. Overlay: V / Rooms button.
- Mood = 50 + moodlets (0–100), updated once a second. ≥70: +10% work; <30: −15%; <10: stress break (drops its job, takes none for a game hour, then "let off steam" +15).

| Moodlet | Value | Lasts |
|---|---|---|
| Cooked meal / ration / raw crops | +6 / 0 / −8 | ½ day |
| At a table / standing / in a mess hall | +3 / −3 / +4 | ½ day |
| Slept in a barracks / sore back (floor) | +5 / −8 and −10% work | 1 day |
| Nice washroom (toilet, shower) | +3 | ½ day |
| Cleaned an outhouse | −4 | ½ day |
| Did loved work | +2 | ¼ day |
| A colonist died | −15 | 2 days |
| Smelly (hygiene < 20) / stomach bug | −10 / −10 | while it lasts |

- Stomach bug: while hygiene < 20, 30% chance per day; −30% work, lasts 1.5 days (twice as fast sleeping in a bed). Hygiene < 20 also keeps its −25% work speed.
- Meals: printer → Rations (`food`), Cooking Station → Cooked meals (`meal`); both count toward the stock target; colonists eat cooked, then rations, then raw.
- Batteries rebalanced: 10 kJ, 300 matter + 20 coal, leak 0.1%/s.
- Right-click during a drag cancels the selection and leaves the tool (a second button pressed mid-drag arrives as a pointermove, so it's detected from `buttons`).

## Skills (M4)
| Skill | Jobs |
|---|---|
| Digging | dig orders, digging out tiles under builds |
| Building | build, deconstruct |
| Farming | sow, harvest |
| Cooking | print rations, cook |
| Research | research |
| Operating | crank, refuel, clean the outhouse |

- XP: 1 per second of work (× aptitude rate). Level n needs 100·n² XP, max 10; +6% work speed per level. Level-ups are logged.
- Job search (`World.findJob`): Emergency bucket first (any non-hated skill); then by effective priority e = p + bonus from 11 down, and at equal e the higher real priority first. `OrderStore.availSkill` counts available orders per priority and skill so a filtered bucket scan stops as soon as it has seen every matching order (bench: ~0.1 ms/tick for the new search, ~0.85 ms total with rolled aptitudes).
- Aptitudes use their own RNG stream (seed-derived), so they don't shift the rest of the simulation. Tests use neutral colonists (tests/helpers.ts) unless they test skills.

## Research (M3b)
| Tier | Project | Cost | Needs | Unlocks |
|---|---|---|---|---|
| 1 | Basic Farming | 300 | — | Planter, Mushroom |
| 1 | Batteries | 300 | — | Battery |
| 1 | Electric Lighting | 300 | — | Ceiling Lamp |
| 1 | Showers | 300 | — | Shower |
| 1 | Advanced Research | 600 | — | Advanced Research Station |
| 2 | Tuber Cultivation | 800 | Basic Farming, Adv. Research | Tuber |
| 2 | Cooking | 800 | Basic Farming, Adv. Research | Cooking Station |
| 2 | Coal Power | 1000 | Batteries, Adv. Research | Coal Generator |
| 2 | Grow Lamps | 1500 | Basic Farming, Lighting, Adv. Research | planter grow lamp |
| 2 | Advanced Furniture | 1500 | Showers, Adv. Research | Flush Toilet |
| 2 | Sunberries | 2000 | Tubers, Grow Lamps | Sunberry |
| 2 | Nuclear Power | 4000 | Coal Power | Reactor |

- Points = seconds of research work (light bonus applies). One active project; progress is kept per project. Stations get automatic 30 s research jobs (priority 5) while a project they can do is active; powered like other workstations. Data in `RESEARCH` (src/sim/defs.ts); `World.research`, `isUnlocked`, `cropUnlocked`, `completeResearch`, `unlockAll` (tests).
- Build commands for locked kinds are refused by the sim; the build bar greys them out. Research panel: T, the toolbar button or the research chip.

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
- Render: chunk bitmap cache (tiles + static buildings) redrawn only when dirty; animated machines (doors, generators, batteries), plants, light glow, no-power badges, orders, ghosts, colonists and need icons per frame. Shared vector art (src/render/art.ts) also generates build-bar icons. UI is DOM; the build bar has one tab per category (Structure, Furniture, Food, Power & light).
- E2E: Playwright scripts in e2e/ launch the container Chromium, else Playwright's bundled one, else an installed Edge/Chrome (e2e/launch.mjs).
- Saves: JSON with base64 typed arrays, plus file export/import (M5).
- Perf budget: 500 colonists, 256×192 map, ≤4 ms per tick average (tests/bench.test.ts).

## Milestones
1. DONE. World gen, camera, movement (walk/fall/ladder/scramble), Dig, Build (wall, ladder; into natural tiles), Deconstruct, Cancel, priority widget + Emergency, path revalidation, resources.
2. DONE. Multi-tile buildings + placement validation, rotatable stair blocks (R), automatic doors, needs + need buildings, Ration Printer, deaths, anti-trap rules, lose screen. 45 unit/scenario tests + 2 browser runs; benchmark ~1.5 ms/tick avg.
3. DONE. Planters with three crops, raw crops + Cooking Station, raw eating; power pool with manual/coal generators, reactor, batteries, brownouts; powered printer; ceiling lamps with occluded light and a work bonus; building inspector; build bar tabs. 56 unit/scenario tests + 3 browser runs; benchmark ~0.65 ms/tick avg.
3b. DONE. Research: Research / Advanced Research Stations, two-tier tree gating most buildings and crops, research panel; Outhouse that needs cleaning + Flush Toilet; planter grow lamp upgrade. 64 unit/scenario tests + 3 browser runs; benchmark ~0.65 ms/tick avg.
4. DONE. Skills with XP/levels and likes/loves/hates (job pull, faster XP, never doing hated work); Research level gate on the Advanced station; per-building job priorities + Priority tool; generator fuel tanks + refuel jobs; locked buildings hidden from the build menu. 76 unit/scenario tests + 3 browser runs; benchmark ~0.85 ms/tick avg.
4b. DONE. Rooms (built walls, types, decor, bonuses, overlay) + happiness (moodlets, mood speed, stress breaks, stomach bugs, sore back), rations vs cooked meals, battery rebalance, right-click cancels drags. 87 unit/scenario tests + 3 browser runs; benchmark ~0.9 ms/tick avg.
5. NEXT. Arrivals + beacon, save/load, performance pass to 500 colonists.
