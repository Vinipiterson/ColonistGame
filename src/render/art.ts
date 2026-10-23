// Vector art for structures and buildings, drawn in tile units (1 unit = 1 tile).
// Shared by the world renderer (chunk cache, ghosts, doors) and the build bar icons.

import type { BuildKind, CropId } from '../sim/defs';

export const PALETTE = {
  wood: '#8a5a32', woodDark: '#5e3b1f', woodLight: '#b07d45',
  metal: '#9aa3ab', metalDark: '#5d656c', metalLight: '#cfd6dc',
  porcelain: '#e9ece8', porcelainShade: '#b9c0bc',
  fabric: '#3d85c6', fabricLight: '#7fb2e0', pillow: '#f1ede4',
  glass: 'rgba(170,220,255,0.35)', water: '#6ec6ff',
  screen: '#7cfc9a', screenDark: '#1f3a2a',
  concrete: '#bdb8b0', concreteLine: '#8f8b85', concreteHi: '#dcd8d1',
  soil: '#3d2a1c', leaf: '#5fae4a', leafDark: '#3e7d33', ember: '#ff8a3d', glow: '#ffd27a', rad: '#7dff5a',
};

/** Buildings drawn every frame (they animate) instead of into the cached chunk bitmaps. */
export const ANIMATED: ReadonlySet<BuildKind> = new Set<BuildKind>(['door', 'crank', 'coalgen', 'battery', 'reactor']);

/** Minecraft-style stair block: bottom half full, top half on the high side. */
export function drawStairBlock(ctx: CanvasRenderingContext2D, x: number, y: number, risesRight: boolean, tint?: string): void {
  const base = tint ?? PALETTE.concrete;
  ctx.fillStyle = base;
  ctx.fillRect(x, y + 0.5, 1, 0.5);
  ctx.fillRect(risesRight ? x + 0.5 : x, y, 0.5, 0.5);
  if (tint) return;
  ctx.fillStyle = PALETTE.concreteHi;
  // tread highlights (top surfaces)
  ctx.fillRect(risesRight ? x : x + 0.5, y + 0.5, 0.5, 0.06);
  ctx.fillRect(risesRight ? x + 0.5 : x, y, 0.5, 0.06);
  ctx.fillStyle = PALETTE.concreteLine;
  // riser edge
  ctx.fillRect(x + 0.5 - 0.03, y + (risesRight ? 0 : 0), 0.06, 0.5);
  ctx.fillRect(x, y + 0.97, 1, 0.03);
}

/** Ladder (vertical shaft piece). */
export function drawLadder(ctx: CanvasRenderingContext2D, x: number, y: number, alpha = 1, tint?: string): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = tint ?? PALETTE.woodDark;
  ctx.fillRect(x + 0.12, y, 0.1, 1);
  ctx.fillRect(x + 0.78, y, 0.1, 1);
  ctx.fillStyle = tint ?? PALETTE.woodLight;
  for (let k = 0; k < 3; k++) ctx.fillRect(x + 0.12, y + 0.12 + k * 0.33, 0.76, 0.09);
  ctx.globalAlpha = 1;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw a building with top-left (x,y). `flip` mirrors it. `anim` animates some kinds: door
 * openness 0..1, manual generator wheel angle (radians), battery charge 0..1, fuel generator /
 * reactor running (> 0, also the flicker phase), lamp lit (1).
 * `tint` draws a flat silhouette in that colour (for blueprint ghosts).
 */
export function drawBuilding(
  ctx: CanvasRenderingContext2D, kind: BuildKind, x: number, y: number, w: number, h: number,
  flip: boolean, anim = 0, tint?: string,
): void {
  const open = anim;
  ctx.save();
  if (flip) {
    ctx.translate(x * 2 + w, 0);
    ctx.scale(-1, 1);
  }
  const P = PALETTE;
  const col = (c: string) => tint ?? c;
  switch (kind) {
    case 'bed': {
      // frame, mattress, pillow at the right end (head), blanket
      ctx.fillStyle = col(P.woodDark);
      ctx.fillRect(x + 0.05, y + 0.55, w - 0.1, 0.3);
      ctx.fillRect(x + 0.05, y + 0.85, 0.12, 0.15);
      ctx.fillRect(x + w - 0.17, y + 0.85, 0.12, 0.15);
      ctx.fillRect(x + w - 0.2, y + 0.2, 0.15, 0.65); // headboard
      ctx.fillStyle = col(P.pillow);
      rr(ctx, x + w - 0.62, y + 0.38, 0.4, 0.2, 0.08);
      ctx.fill();
      ctx.fillStyle = col(P.fabric);
      rr(ctx, x + 0.1, y + 0.42, w - 0.72, 0.18, 0.06);
      ctx.fill();
      ctx.fillStyle = col(P.fabricLight);
      ctx.fillRect(x + 0.1, y + 0.42, w - 0.72, 0.05);
      break;
    }
    case 'toilet': {
      // outhouse: plank booth with a crescent moon, a bucket seat inside the open side
      ctx.fillStyle = col(P.woodDark);
      ctx.fillRect(x + 0.05, y + 0.1, 0.9, 0.12); // roof
      ctx.fillRect(x + 0.1, y + 0.2, 0.1, 1.8);
      ctx.fillRect(x + 0.8, y + 0.2, 0.1, 1.8);
      ctx.fillStyle = col(P.wood);
      for (let k = 0; k < 3; k++) ctx.fillRect(x + 0.62, y + 0.25 + k * 0.58, 0.18, 0.52); // back planks
      ctx.fillStyle = col(P.woodLight);
      ctx.fillRect(x + 0.2, y + 1.45, 0.42, 0.12); // seat
      ctx.fillStyle = col(P.woodDark);
      ctx.fillRect(x + 0.26, y + 1.57, 0.3, 0.43);
      if (!tint) {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(x + 0.71, y + 0.55, 0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = P.wood;
        ctx.beginPath();
        ctx.arc(x + 0.75, y + 0.53, 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'flushtoilet': {
      // tank on the wall (back = right), bowl, seat
      ctx.fillStyle = col(P.porcelainShade);
      rr(ctx, x + 0.55, y + 0.55, 0.32, 0.65, 0.06);
      ctx.fill();
      ctx.fillStyle = col(P.porcelain);
      rr(ctx, x + 0.12, y + 1.25, 0.7, 0.28, 0.12);
      ctx.fill();
      ctx.fillRect(x + 0.32, y + 1.5, 0.32, 0.5);
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.6, y + 0.68, 0.14, 0.04); // flush handle
      ctx.fillStyle = col(P.porcelainShade);
      ctx.fillRect(x + 0.12, y + 1.22, 0.7, 0.05);
      if (!tint) {
        ctx.fillStyle = P.water; // self-cleaning nozzle light
        ctx.fillRect(x + 0.64, y + 0.82, 0.08, 0.08);
      }
      break;
    }
    case 'research':
    case 'advresearch': {
      // desk with a microscope (basic) or a console with twin screens (advanced)
      const adv = kind === 'advresearch';
      ctx.fillStyle = col(adv ? P.metalDark : P.woodDark);
      ctx.fillRect(x + 0.1, y + 1.05, w - 0.2, 0.12); // desk top
      ctx.fillRect(x + 0.18, y + 1.17, 0.12, 0.83);
      ctx.fillRect(x + w - 0.3, y + 1.17, 0.12, 0.83);
      ctx.fillStyle = col(adv ? P.metal : P.wood);
      ctx.fillRect(x + 0.1, y + 1.05, w - 0.2, 0.04);
      if (adv) {
        ctx.fillStyle = col(P.metalDark);
        rr(ctx, x + 0.15, y + 0.2, 0.75, 0.6, 0.05);
        rr(ctx, x + 1.05, y + 0.2, 0.75, 0.6, 0.05);
        ctx.fill();
        ctx.fillRect(x + 0.45, y + 0.8, 0.12, 0.25);
        ctx.fillRect(x + 1.35, y + 0.8, 0.12, 0.25);
        if (!tint) {
          ctx.fillStyle = '#c77dff';
          ctx.fillRect(x + 0.22, y + 0.27, 0.61, 0.46);
          ctx.fillStyle = P.screen;
          ctx.fillRect(x + 1.12, y + 0.27, 0.61, 0.46);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          for (let k = 0; k < 3; k++) ctx.fillRect(x + 1.18, y + 0.34 + k * 0.12, 0.3 + (k % 2) * 0.15, 0.04);
        }
      } else {
        // microscope on the left, notes and a flask on the right
        ctx.fillStyle = col(P.metalDark);
        ctx.fillRect(x + 0.35, y + 0.95, 0.4, 0.1);
        ctx.fillRect(x + 0.5, y + 0.45, 0.1, 0.5);
        ctx.save();
        ctx.translate(x + 0.55, y + 0.5);
        ctx.rotate(-0.4);
        ctx.fillStyle = col(P.metal);
        ctx.fillRect(-0.06, -0.3, 0.12, 0.4);
        ctx.restore();
        ctx.fillStyle = col(P.pillow);
        ctx.fillRect(x + 0.9, y + 0.98, 0.4, 0.07);
        ctx.fillStyle = col(P.glass);
        ctx.beginPath();
        ctx.moveTo(x + 1.5, y + 0.6);
        ctx.lineTo(x + 1.6, y + 0.6);
        ctx.lineTo(x + 1.72, y + 1.05);
        ctx.lineTo(x + 1.38, y + 1.05);
        ctx.closePath();
        ctx.fill();
        if (!tint) {
          ctx.fillStyle = P.rad;
          ctx.fillRect(x + 1.42, y + 0.88, 0.26, 0.16);
        }
      }
      break;
    }
    case 'sink': {
      ctx.fillStyle = col(P.porcelainShade);
      ctx.fillRect(x + 0.42, y + 0.55, 0.16, 0.45); // pedestal
      ctx.fillStyle = col(P.porcelain);
      rr(ctx, x + 0.1, y + 0.32, 0.8, 0.26, 0.1);
      ctx.fill();
      ctx.fillStyle = col(P.metal);
      ctx.fillRect(x + 0.62, y + 0.12, 0.08, 0.22); // faucet
      ctx.fillRect(x + 0.48, y + 0.12, 0.2, 0.06);
      if (!tint) {
        ctx.fillStyle = P.water;
        ctx.fillRect(x + 0.2, y + 0.36, 0.6, 0.05);
      }
      break;
    }
    case 'shower': {
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.82, y + 0.1, 0.07, 1.8); // pipe
      ctx.fillRect(x + 0.45, y + 0.1, 0.44, 0.06);
      ctx.fillStyle = col(P.metal);
      rr(ctx, x + 0.32, y + 0.12, 0.26, 0.12, 0.04); // head
      ctx.fill();
      ctx.fillStyle = col(P.porcelain);
      ctx.fillRect(x + 0.04, y + 1.86, 0.92, 0.14); // tray
      if (!tint) {
        ctx.fillStyle = P.glass;
        ctx.fillRect(x + 0.04, y + 0.3, 0.06, 1.56);
        ctx.strokeStyle = 'rgba(110,198,255,0.6)';
        ctx.lineWidth = 0.03;
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          ctx.moveTo(x + 0.36 + k * 0.06, y + 0.3);
          ctx.lineTo(x + 0.33 + k * 0.08, y + 0.75);
        }
        ctx.stroke();
      }
      break;
    }
    case 'table': {
      ctx.fillStyle = col(P.woodLight);
      ctx.fillRect(x + 0.05, y + 0.38, w - 0.1, 0.12);
      ctx.fillStyle = col(P.wood);
      ctx.fillRect(x + 0.05, y + 0.5, w - 0.1, 0.05);
      ctx.fillStyle = col(P.woodDark);
      ctx.fillRect(x + 0.2, y + 0.55, 0.1, 0.45);
      ctx.fillRect(x + w - 0.3, y + 0.55, 0.1, 0.45);
      if (!tint) {
        ctx.fillStyle = P.porcelain; // plates
        ctx.fillRect(x + 0.35, y + 0.33, 0.3, 0.05);
        ctx.fillRect(x + w - 0.65, y + 0.33, 0.3, 0.05);
      }
      break;
    }
    case 'printer': {
      ctx.fillStyle = col(P.metalDark);
      rr(ctx, x + 0.08, y + 0.15, w - 0.16, h - 0.15, 0.1);
      ctx.fill();
      ctx.fillStyle = col(P.metal);
      rr(ctx, x + 0.16, y + 0.24, w - 0.32, h - 0.42, 0.08);
      ctx.fill();
      ctx.fillStyle = col(P.screenDark);
      ctx.fillRect(x + w - 0.75, y + 0.38, 0.45, 0.32); // display on the operator side
      if (!tint) {
        ctx.fillStyle = P.screen;
        ctx.fillRect(x + w - 0.7, y + 0.44, 0.2, 0.05);
        ctx.fillRect(x + w - 0.7, y + 0.53, 0.3, 0.05);
      }
      ctx.fillStyle = col('#2b2a2e');
      ctx.fillRect(x + 0.3, y + h - 0.7, 0.8, 0.28); // output slot
      ctx.fillStyle = col('#f2a93b');
      ctx.fillRect(x + 0.4, y + h - 0.6, 0.25, 0.12); // a meal waiting
      ctx.fillStyle = col(P.metalLight);
      ctx.fillRect(x + 0.08, y + 0.15, w - 0.16, 0.06);
      break;
    }
    case 'door': {
      // frame stays, the panel slides up into the ceiling as it opens
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.05, y, 0.12, h);
      ctx.fillRect(x + 0.83, y, 0.12, h);
      ctx.fillRect(x + 0.05, y, 0.9, 0.1);
      const panelH = (h - 0.1) * (1 - open);
      if (panelH > 0.02) {
        ctx.fillStyle = col(P.metal);
        ctx.fillRect(x + 0.2, y + 0.1, 0.6, panelH);
        ctx.fillStyle = col(P.metalLight);
        ctx.fillRect(x + 0.2, y + 0.1, 0.6, Math.min(panelH, 0.05));
        if (!tint && panelH > 1) {
          ctx.fillStyle = '#f2a93b';
          ctx.fillRect(x + 0.62, y + 0.1 + panelH * 0.55, 0.08, 0.08); // sensor light
        }
      }
      break;
    }
    case 'planter': {
      // wooden box with soil in the bottom cell; the plant is drawn on top (drawPlant)
      ctx.fillStyle = col(P.woodDark);
      ctx.fillRect(x + 0.06, y + 1.5, 0.88, 0.5);
      ctx.fillStyle = col(P.wood);
      ctx.fillRect(x + 0.1, y + 1.55, 0.8, 0.4);
      ctx.fillStyle = col(P.woodLight);
      ctx.fillRect(x + 0.06, y + 1.5, 0.88, 0.06);
      ctx.fillStyle = col(P.soil);
      ctx.fillRect(x + 0.12, y + 1.44, 0.76, 0.08);
      break;
    }
    case 'stove': {
      // counter with an oven door, a hob and a pot
      ctx.fillStyle = col(P.metalDark);
      rr(ctx, x + 0.08, y + 0.85, w - 0.16, h - 0.85, 0.06);
      ctx.fill();
      ctx.fillStyle = col(P.metal);
      ctx.fillRect(x + 0.08, y + 0.82, w - 0.16, 0.1);
      ctx.fillStyle = col('#2b2a2e');
      rr(ctx, x + 0.25, y + 1.1, 0.9, 0.6, 0.05);
      ctx.fill();
      ctx.fillStyle = col(P.metalLight);
      ctx.fillRect(x + 0.3, y + 1.15, 0.8, 0.05); // oven handle
      ctx.fillStyle = col(P.screenDark);
      ctx.fillRect(x + w - 0.6, y + 1.15, 0.35, 0.22); // control panel (operator side)
      if (!tint) {
        ctx.fillStyle = P.ember;
        ctx.fillRect(x + w - 0.55, y + 1.22, 0.1, 0.05);
      }
      ctx.fillStyle = col('#4a4f55'); // pot
      rr(ctx, x + 0.35, y + 0.42, 0.6, 0.4, 0.06);
      ctx.fill();
      ctx.fillRect(x + 0.28, y + 0.42, 0.74, 0.06);
      break;
    }
    case 'crank': {
      // treadle base and a big wheel with a handle; anim = wheel angle
      ctx.fillStyle = col(P.woodDark);
      ctx.fillRect(x + 0.1, y + 1.75, w - 0.2, 0.25);
      ctx.fillRect(x + 0.55, y + 0.95, 0.12, 0.85);
      ctx.fillStyle = col(P.metalDark);
      rr(ctx, x + w - 0.75, y + 1.1, 0.6, 0.65, 0.06); // dynamo
      ctx.fill();
      if (!tint) {
        ctx.fillStyle = anim ? P.glow : '#6b5d3a';
        ctx.fillRect(x + w - 0.55, y + 1.25, 0.2, 0.08);
      }
      const cx = x + 0.61, cy = y + 0.9, r = 0.55;
      ctx.strokeStyle = col(P.wood);
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = anim + (k * Math.PI) / 2;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.stroke();
      ctx.fillStyle = col(P.metalLight);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(anim) * r, cy + Math.sin(anim) * r, 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'coalgen': {
      // furnace box with a fire window (glows while running) and a chimney
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.2, y, 0.25, 0.5); // chimney
      rr(ctx, x + 0.08, y + 0.45, w - 0.16, h - 0.45, 0.08);
      ctx.fill();
      ctx.fillStyle = col(P.metal);
      ctx.fillRect(x + 0.08, y + 0.45, w - 0.16, 0.08);
      ctx.fillStyle = col('#1e1b1a');
      rr(ctx, x + 0.3, y + 0.9, 0.8, 0.6, 0.06);
      ctx.fill();
      if (!tint && anim > 0) {
        const f = 0.75 + 0.25 * Math.sin(anim * 9);
        ctx.fillStyle = `rgba(255,138,61,${f})`;
        rr(ctx, x + 0.36, y + 1.1, 0.68, 0.36, 0.05);
        ctx.fill();
        ctx.fillStyle = P.glow;
        ctx.fillRect(x + 0.5, y + 1.25, 0.4, 0.08);
      }
      ctx.fillStyle = col(P.woodDark); // coal hopper
      ctx.fillRect(x + w - 0.65, y + 0.7, 0.45, 0.3);
      ctx.fillStyle = col('#191716');
      ctx.fillRect(x + w - 0.6, y + 0.66, 0.35, 0.1);
      break;
    }
    case 'battery': {
      // casing with terminals and a charge gauge (anim = charge 0..1)
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.3, y + 0.12, 0.12, 0.1);
      ctx.fillRect(x + 0.58, y + 0.12, 0.12, 0.1);
      rr(ctx, x + 0.15, y + 0.2, 0.7, h - 0.2, 0.08);
      ctx.fill();
      ctx.fillStyle = col('#1e2a22');
      ctx.fillRect(x + 0.3, y + 0.4, 0.4, h - 0.6);
      if (!tint) {
        const ch = Math.max(0, Math.min(1, anim));
        const full = h - 0.64;
        ctx.fillStyle = ch > 0.25 ? P.screen : P.ember;
        ctx.fillRect(x + 0.32, y + 0.42 + full * (1 - ch), 0.36, full * ch);
      }
      break;
    }
    case 'reactor': {
      // rounded containment vessel with a core window (green glow while running) and pipes
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.1, y + h - 0.3, w - 0.2, 0.3);
      ctx.fillStyle = col(P.metal);
      rr(ctx, x + 0.35, y + 0.15, w - 0.7, h - 0.4, 0.6);
      ctx.fill();
      ctx.fillStyle = col(P.metalLight);
      ctx.fillRect(x + 0.6, y + 0.25, w - 1.2, 0.08);
      ctx.fillStyle = col('#16201a');
      rr(ctx, x + 0.95, y + 0.85, w - 1.9, 1.1, 0.25);
      ctx.fill();
      if (!tint && anim > 0) {
        const f = 0.7 + 0.3 * Math.sin(anim * 4);
        ctx.fillStyle = `rgba(125,255,90,${f})`;
        rr(ctx, x + 1.05, y + 0.95, w - 2.1, 0.9, 0.2);
        ctx.fill();
      }
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.05, y + 1.2, 0.35, 0.15);
      ctx.fillRect(x + w - 0.4, y + 1.6, 0.35, 0.15);
      // trefoil-ish warning dots
      if (!tint) {
        ctx.fillStyle = '#ffd166';
        for (let k = 0; k < 3; k++) {
          const a = (k * Math.PI * 2) / 3 - Math.PI / 2;
          ctx.beginPath();
          ctx.arc(x + w / 2 + Math.cos(a) * 0.14, y + 2.3 + Math.sin(a) * 0.14, 0.07, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'lamp': {
      // ceiling mount, rod and shade; bulb lit when anim = 1
      ctx.fillStyle = col(P.metalDark);
      ctx.fillRect(x + 0.3, y, 0.4, 0.06);
      ctx.fillRect(x + 0.47, y, 0.06, 0.3);
      ctx.fillStyle = col(P.metal);
      ctx.beginPath();
      ctx.moveTo(x + 0.2, y + 0.55);
      ctx.lineTo(x + 0.35, y + 0.3);
      ctx.lineTo(x + 0.65, y + 0.3);
      ctx.lineTo(x + 0.8, y + 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = col(anim ? P.glow : '#8a826f');
      ctx.beginPath();
      ctx.arc(x + 0.5, y + 0.57, 0.11, 0, Math.PI);
      ctx.fill();
      break;
    }
    case 'wall':
    case 'ladder':
    case 'stairs':
      break;
  }
  ctx.restore();
}

/** The grow lamp bar over a planter whose top-left is (x,y); pink glow when powered. */
export function drawGrowLamp(ctx: CanvasRenderingContext2D, x: number, y: number, on: boolean): void {
  ctx.fillStyle = PALETTE.metalDark;
  ctx.fillRect(x + 0.1, y + 0.05, 0.8, 0.08);
  ctx.fillRect(x + 0.08, y + 0.05, 0.05, 0.4);
  ctx.fillStyle = on ? '#ff9ef5' : '#6a5a68';
  ctx.fillRect(x + 0.15, y + 0.13, 0.7, 0.05);
  if (on) {
    ctx.fillStyle = 'rgba(255,158,245,0.10)';
    ctx.fillRect(x + 0.1, y + 0.18, 0.8, 1.26);
  }
}

/**
 * A planter's plant, from sprout (growth 0) to ripe (1), standing on the soil of the planter
 * whose top-left is (x,y).
 */
export function drawPlant(ctx: CanvasRenderingContext2D, crop: CropId, x: number, y: number, growth: number): void {
  const P = PALETTE;
  const g = Math.max(0, Math.min(1, growth));
  const ripe = g >= 1;
  const base = y + 1.45;
  if (crop === 'mushroom') {
    const n = 1 + Math.round(g * 2);
    for (let k = 0; k < n; k++) {
      const cx = x + 0.3 + k * 0.2, s = 0.08 + g * 0.12 - k * 0.02;
      const stem = 0.08 + g * 0.3 - k * 0.05;
      ctx.fillStyle = '#e8dcc8';
      ctx.fillRect(cx - 0.03, base - stem, 0.06, stem);
      ctx.fillStyle = ripe ? '#c0503a' : '#a77b5a';
      ctx.beginPath();
      ctx.ellipse(cx, base - stem, s * 1.3, s, 0, Math.PI, 0);
      ctx.fill();
      if (ripe) {
        ctx.fillStyle = '#f4eee2';
        ctx.fillRect(cx - s * 0.5, base - stem - s * 0.6, 0.04, 0.04);
      }
    }
    return;
  }
  const hgt = 0.2 + g * (crop === 'sunberry' ? 1.0 : 0.75);
  // stem + leaves alternating up the stem
  ctx.strokeStyle = P.leafDark;
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, base);
  ctx.lineTo(x + 0.5, base - hgt);
  ctx.stroke();
  const leaves = 1 + Math.floor(g * 4);
  for (let k = 0; k < leaves; k++) {
    const ly = base - 0.1 - (k / Math.max(1, leaves)) * hgt;
    const side = k % 2 ? -1 : 1;
    ctx.fillStyle = k % 2 ? P.leaf : P.leafDark;
    ctx.beginPath();
    ctx.ellipse(x + 0.5 + side * 0.14, ly, 0.15, 0.06, side * -0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!ripe) return;
  if (crop === 'tuber') {
    ctx.fillStyle = '#b5835a';
    ctx.beginPath();
    ctx.ellipse(x + 0.35, base - 0.02, 0.12, 0.08, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 0.62, base - 0.01, 0.1, 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#ff7a4d';
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(x + 0.3 + (k % 2) * 0.38, base - hgt * (0.35 + k * 0.15), 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Small icon for the build bar (drawn into a fresh canvas, returned as a data URL). */
export function buildIcon(kind: BuildKind, w: number, h: number): string {
  const px = 40;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const span = Math.max(w, h, 1);
  const s = (px - 6) / span;
  ctx.setTransform(s, 0, 0, s, (px - w * s) / 2, (px - h * s) / 2);
  if (kind === 'wall') {
    ctx.fillStyle = PALETTE.concrete;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = PALETTE.concreteLine;
    ctx.fillRect(0, 0.48, 1, 0.05);
    ctx.fillRect(0.5, 0, 0.05, 0.5);
    ctx.fillRect(0.2, 0.5, 0.05, 0.5);
    ctx.fillStyle = PALETTE.concreteHi;
    ctx.fillRect(0, 0, 1, 0.06);
  } else if (kind === 'ladder') drawLadder(ctx, 0, 0);
  else if (kind === 'stairs') drawStairBlock(ctx, 0, 0, true);
  else {
    // show machines running / charged / lit
    const anim = kind === 'door' ? 0 : kind === 'crank' ? 0.6 : kind === 'battery' ? 0.7 : 1;
    drawBuilding(ctx, kind, 0, 0, w, h, false, anim);
    if (kind === 'planter') drawPlant(ctx, 'tuber', 0, 0, 0.8);
  }
  return c.toDataURL();
}
