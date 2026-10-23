// Vector art for structures and buildings, drawn in tile units (1 unit = 1 tile).
// Shared by the world renderer (chunk cache, ghosts, doors) and the build bar icons.

import type { BuildKind } from '../sim/defs';

export const PALETTE = {
  wood: '#8a5a32', woodDark: '#5e3b1f', woodLight: '#b07d45',
  metal: '#9aa3ab', metalDark: '#5d656c', metalLight: '#cfd6dc',
  porcelain: '#e9ece8', porcelainShade: '#b9c0bc',
  fabric: '#3d85c6', fabricLight: '#7fb2e0', pillow: '#f1ede4',
  glass: 'rgba(170,220,255,0.35)', water: '#6ec6ff',
  screen: '#7cfc9a', screenDark: '#1f3a2a',
  concrete: '#bdb8b0', concreteLine: '#8f8b85', concreteHi: '#dcd8d1',
};

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
 * Draw a building with top-left (x,y). `flip` mirrors it. For doors, `open` in [0,1].
 * `tint` draws a flat silhouette in that colour (for blueprint ghosts).
 */
export function drawBuilding(
  ctx: CanvasRenderingContext2D, kind: BuildKind, x: number, y: number, w: number, h: number,
  flip: boolean, open = 0, tint?: string,
): void {
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
    case 'wall':
    case 'ladder':
    case 'stairs':
      break;
  }
  ctx.restore();
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
  else drawBuilding(ctx, kind, 0, 0, w, h, false, 0);
  return c.toDataURL();
}
