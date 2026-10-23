# Colony Game — notes for Claude Code

Side-view 2D colony sim (Oxygen Not Included style) in TypeScript + Canvas 2D, built with Vite.
**Read `docs/architecture.md` first**: all design decisions, the architecture and the milestone plan.
Summary: deterministic 20 Hz sim in src/sim with no DOM; commands in, events out; renderer and DOM UI
in src/render and src/ui.

- Run: `npm install`, `npm run dev`. Tests: `npm test` (includes a 500-colonist benchmark, budget
  4 ms/tick). Browser checks: `npm run build && npm run e2e`.
- Every push to `master` deploys to GitHub Pages (.github/workflows/deploy.yml).
- Owner preferences: discuss design options and trade-offs before writing code; ask the open design
  questions of a milestone before implementing it; send/write complete files.
- Keep the sim deterministic: no Math.random / Date.now inside src/sim (use world.rng).
- After finishing a milestone: run tests + build + e2e, update docs/architecture.md, commit and push to master.
