# \# Colony Game — notes for Claude Code

# 

# Side-view 2D colony sim (Oxygen Not Included style) in TypeScript + Canvas 2D, built with Vite.

# Design decisions and architecture: see the "Colony Game" Claude project doc `claude/architecture.md`

# (summary: deterministic 20 Hz sim in src/sim with no DOM; commands in, events out; renderer and DOM UI

# in src/render and src/ui).

# 

# \- Run: `npm install`, `npm run dev`. Tests: `npm test` (includes a 500-colonist benchmark, budget

# &#x20; 4 ms/tick). Browser checks: `npm run build \&\& npm run e2e`.

# \- Every push to `master` deploys to GitHub Pages (.github/workflows/deploy.yml).

# \- Owner preferences: discuss design options and trade-offs before writing code; send complete files.

# \- Keep the sim deterministic: no Math.random / Date.now inside src/sim (use world.rng).

