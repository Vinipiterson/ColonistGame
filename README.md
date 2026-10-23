# Colony Game

Side-view 2D tile colony sim (TypeScript + Canvas 2D). Milestone 2.

## Run
    npm install
    npm run dev        # play at http://localhost:5173  (add ?seed=123 for a fixed world)
    npm test           # unit + scenario tests + 500-colonist benchmark
    npm run build      # dist/index.html (single file) + dist/artifact.html
    npm run e2e        # drives the built game in Chromium (play + furnish), screenshots in e2e/shots/
                       # (first time on your machine: npx playwright install chromium)

## Controls
- G Dig · B Build (bar bottom-left) · X Deconstruct · C Cancel. Drag a rectangle to apply.
- Build: walls, ladders and stairs are painted with a rectangle (also onto dirt/coal: dug out first).
  Buildings (door, bed, toilet, sink, shower, mess table, ration printer) follow the cursor as a
  green/red ghost: click places one, dragging places copies side by side. R flips stairs and
  mirrors buildings.
- Priority widget bottom-right, or keys 1-9; 0 = Emergency. The selection sticks until changed (default 6).
  Dragging the same tool over existing orders re-prioritises them.
- Drag the map (no tool), right/middle drag or WASD to pan; wheel or +/- to zoom.
- Right-click or Esc leaves a tool. Space pauses. Click a colonist for details.

## Layout
    src/sim/      pure deterministic simulation (no DOM)
      defs.ts       tiles, buildables, needs, costs, tuning
      buildings.ts  multi-tile buildings, placement rules, use slots
      grid.ts       typed-array layers + dirty rects
      nav.ts        movement rules (walk, step, climb, fall)
      regions.ts    chunk regions + cached reachability
      pathfinder.ts budgeted multi-goal A*
      orders.ts     orders/jobs, spatial job index, placement rules, reach
      colonist.ts   colonist data
      world.ts      tick loop, commands, assignment, needs, revalidation, falls
      worldgen.ts   procedural world
    src/render/   canvas renderer (chunk cache, overlays, colonists) + art.ts (building art)
    src/ui/       input + HUD
    tests/        vitest (nav, regions, sim scenarios, building, needs, benchmark)
    e2e/          Playwright script
