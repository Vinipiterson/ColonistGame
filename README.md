# Colony Game

Side-view 2D tile colony sim (TypeScript + Canvas 2D). Milestone 4 (skills, likings, building priorities).

**Play it:** https://vinipiterson.github.io/ColonistGame/ (deployed from `master` on every push)

## Run
    npm install
    npm run dev        # play at http://localhost:5173  (add ?seed=123 for a fixed world)
    npm test           # unit + scenario tests + 500-colonist benchmark
    npm run build      # dist/index.html (single file) + dist/artifact.html
    npm run e2e        # drives the built game in a browser (play, furnish, farm), screenshots in e2e/shots/
                       # (first time on your machine: npx playwright install chromium; falls back to Edge/Chrome)

## Controls
- G Dig · B Build (bar bottom-left, one tab per category) · X Deconstruct · C Cancel · P Priority ·
  T Research. Drag a rectangle to apply. The Priority tool only changes priorities (orders and work
  buildings in the rectangle).
- Build: walls, ladders and stairs are painted with a rectangle (also onto dirt/coal: dug out first).
  Buildings follow the cursor as a green/red ghost: click places one, dragging places copies side
  by side. R flips stairs and mirrors buildings. Most buildings and crops need research first.
- Priority widget bottom-right, or keys 1-9; 0 = Emergency. The selection sticks until changed (default 6).
  Dragging the same tool over existing orders re-prioritises them.
- Click a colonist for details (needs, skills: ★ like, ♥ love, ✕ hate), or a building for its
  inspector (job priority, crop, grow lamp, on/off, status).
- Drag the map (no tool), right/middle drag or WASD to pan; wheel or +/- to zoom.
- Right-click or Esc leaves a tool. Space pauses.

## Layout
    src/sim/      pure deterministic simulation (no DOM)
      defs.ts       tiles, buildables, crops, research tree, needs, costs, tuning
      buildings.ts  multi-tile buildings, placement rules, use slots, machine state
      grid.ts       typed-array layers + dirty rects
      nav.ts        movement rules (walk, step, climb, fall)
      regions.ts    chunk regions + cached reachability
      pathfinder.ts budgeted multi-goal A*
      orders.ts     orders/jobs, spatial job index, placement rules, reach
      colonist.ts   colonist data
      light.ts      lamp light map (line of sight)
      world.ts      tick loop, commands, assignment, needs, power, farms, research, revalidation
      worldgen.ts   procedural world
    src/render/   canvas renderer (chunk cache, overlays, colonists) + art.ts (building art)
    src/ui/       input, HUD, research panel
    tests/        vitest (nav, regions, sim scenarios, building, needs, farm/power, research, skills, benchmark)
    e2e/          Playwright scripts
    docs/architecture.md  design decisions, architecture, milestones
