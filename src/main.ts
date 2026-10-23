// Entry point: creates the world, renderer, input and HUD, and runs the fixed-step loop.
// The sim advances in fixed 50 ms ticks (speed 1x/2x/3x = more ticks per frame); the renderer
// interpolates colonist positions between ticks so motion stays smooth at any frame rate.

import './style.css';
import { DT } from './sim/defs';
import { World } from './sim/world';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { Input, ToolState } from './ui/input';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e9);

const world = World.create({ seed });
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new Renderer(canvas, world, seed);
const tools = new ToolState();
const input = new Input(world, renderer, tools);
const hud = new Hud(document.getElementById('hud')!, world, tools);
hud.onZoom = (f) => input.zoomAt(f);
input.onSelect = (id) => {
  hud.selectedId = id;
  renderer.selectedId = id;
};
input.onSelectBuilding = (id) => {
  hud.selectedBuilding = id;
  renderer.selectedBuilding = id;
};

const MAX_TICKS_PER_FRAME = 12;
let last = performance.now();
let acc = 0;
let time = 0;

function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  time += dt;
  if (!tools.paused && !world.gameOver) acc += dt * tools.speed;
  let n = 0;
  while (acc >= DT && n < MAX_TICKS_PER_FRAME) {
    world.step();
    acc -= DT;
    n++;
  }
  if (n === MAX_TICKS_PER_FRAME) acc = 0; // never spiral: drop time instead
  input.update(dt);
  renderer.draw(tools.paused ? 1 : acc / DT, time);
  hud.update();
  requestAnimationFrame(frame);
}

function resize(): void {
  renderer.resize();
}
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
hud.log(`Seed ${seed}. Three colonists have arrived.`);
hud.log(`Build a Toilet soon, then Beds, a Manual Generator and a Ration Printer: meals run out in a few days.`);
hud.log(`Planters grow crops; a Cooking Station turns them into meals. Click a building to configure it.`);

// Debug / test hook (used by the Playwright e2e script).
(window as unknown as Record<string, unknown>).__colony = { world, renderer, tools, hud, input };
