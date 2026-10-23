// DOM HUD: resources + power, speed, tool bar + build bar (bottom-left), priority widget
// (bottom-right), colonist panel / building inspector, event log and the game-over screen.
// Reads sim state each frame; writes only to ToolState, or issues sim Commands (inspector).

import {
  BUILDS, BUILD_LIST, CROPS, CROP_LIST, DAY_SECONDS, EMERGENCY, NEEDS, NEED_DEFS, NEED_LABEL, RESOURCE_LABEL,
  RESOURCES, type BuildCategory, type BuildKind, type CropId,
} from '../sim/defs';
import type { Building } from '../sim/buildings';
import { buildIcon } from '../render/art';
import type { World } from '../sim/world';
import type { ToolMode, ToolState } from './input';

const TOOL_BUTTONS: { mode: ToolMode; label: string; key: string; hint: string }[] = [
  { mode: 'dig', label: 'Dig', key: 'G', hint: 'Drag over natural tiles to dig them out.' },
  { mode: 'build', label: 'Build', key: 'B', hint: 'Pick something to build, then click or drag to place it.' },
  { mode: 'deconstruct', label: 'Deconstruct', key: 'X', hint: 'Drag over things you built to remove them (refunds half).' },
  { mode: 'cancel', label: 'Cancel', key: 'C', hint: 'Drag to cancel pending orders.' },
];

const RES_COLOR: Record<string, string> = {
  matter: '#a7764a', coal: '#4a4643', radioactive: '#7dff5a',
  mushroom: '#c0503a', tuber: '#b5835a', sunberry: '#ff7a4d', food: '#f2a93b',
};
const CATEGORY_LABEL: Record<BuildCategory, string> = {
  structure: 'Structure', furniture: 'Furniture', food: 'Food', power: 'Power & light',
};
/** Buildings with an on/off switch in the inspector. */
const SWITCHABLE = new Set<BuildKind>(['planter', 'printer', 'stove', 'crank', 'coalgen', 'reactor', 'lamp']);
const CROP_SET = new Set<string>(CROP_LIST);

const kJ = (j: number) => (j / 1000).toFixed(j < 10_000 ? 1 : 0);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Hud {
  private world: World;
  private tools: ToolState;
  private resEls: Record<string, HTMLElement> = {};
  private resChips: Record<string, HTMLElement> = {};
  private powerChip!: HTMLElement;
  private powerEl!: HTMLElement;
  private popEl!: HTMLElement;
  private dayEl!: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private toolBtns = new Map<ToolMode, HTMLButtonElement>();
  private buildBar!: HTMLElement;
  private buildCat: BuildCategory = 'structure';
  private tabBtns = new Map<BuildCategory, HTMLButtonElement>();
  private catRows = new Map<BuildCategory, HTMLElement>();
  private buildBtns = new Map<string, HTMLButtonElement>();
  private prioBtns = new Map<number, HTMLButtonElement>();
  private hintEl!: HTMLElement;
  private panel!: HTMLElement;
  private bpanel!: HTMLElement;
  private bpStatic!: HTMLElement;
  private bpDyn!: HTMLElement;
  private logEl!: HTMLElement;
  private overlay!: HTMLElement;
  selectedId = -1;
  selectedBuilding = -1;
  onZoom: (factor: number) => void = () => {};

  constructor(root: HTMLElement, world: World, tools: ToolState) {
    this.world = world;
    this.tools = tools;
    this.build(root);
    tools.listeners.push(() => this.syncTools());
    this.syncTools();
  }

  private build(root: HTMLElement): void {
    // top-left: resources
    const top = el('div', 'hud-top panel');
    for (const r of RESOURCES) {
      const chip = el('div', 'chip');
      const sw = el('span', 'swatch');
      sw.style.background = RES_COLOR[r];
      chip.append(sw, el('span', 'chip-label', RESOURCE_LABEL[r]));
      const v = el('span', 'chip-val', '0');
      chip.append(v);
      this.resEls[r] = v;
      this.resChips[r] = chip;
      top.append(chip);
    }
    this.powerChip = el('div', 'chip chip-power hidden');
    this.powerChip.title = 'Power: produced / used, and stored in batteries';
    this.powerChip.append(el('span', 'chip-label', '⚡ Power'));
    this.powerEl = el('span', 'chip-val', '');
    this.powerChip.append(this.powerEl);
    top.append(this.powerChip);
    const pop = el('div', 'chip');
    pop.append(el('span', 'chip-label', 'Colonists'));
    this.popEl = el('span', 'chip-val', '3');
    pop.append(this.popEl);
    this.dayEl = el('div', 'chip chip-day', 'Day 1');
    top.append(pop, this.dayEl);
    root.append(top);

    // top-right: speed
    const speed = el('div', 'hud-speed panel');
    const labels = ['❚❚', '1×', '2×', '3×'];
    labels.forEach((l, i) => {
      const b = el('button', 'btn', l);
      b.title = i === 0 ? 'Pause (Space)' : `Speed ${i}×`;
      b.dataset.speed = String(i);
      b.onclick = () => (i === 0 ? this.tools.set({ paused: !this.tools.paused }) : this.tools.set({ speed: i, paused: false }));
      this.speedBtns.push(b);
      speed.append(b);
    });
    const zoomOut = el('button', 'btn zoom', '−');
    zoomOut.title = 'Zoom out (-)';
    zoomOut.onclick = () => this.onZoom(1 / 1.25);
    const zoomIn = el('button', 'btn zoom', '+');
    zoomIn.title = 'Zoom in (=)';
    zoomIn.onclick = () => this.onZoom(1.25);
    speed.append(zoomOut, zoomIn);
    root.append(speed);

    // right: colonist panel
    this.panel = el('div', 'hud-colonist panel hidden');
    root.append(this.panel);
    // right: building inspector (same slot; buttons live in the static part so they survive updates)
    this.bpanel = el('div', 'hud-colonist hud-building panel hidden');
    this.bpStatic = el('div', 'bp-static');
    this.bpDyn = el('div', 'bp-dyn');
    this.bpanel.append(this.bpStatic, this.bpDyn);
    this.bpanel.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      const b = this.world.buildings.get(this.selectedBuilding);
      if (!t || !b) return;
      if (t.dataset.act === 'crop') this.world.issue({ type: 'configure', buildingId: b.id, crop: t.dataset.crop as CropId });
      else if (t.dataset.act === 'toggle') this.world.issue({ type: 'configure', buildingId: b.id, on: !b.on });
    });
    root.append(this.bpanel);

    // left: event log
    this.logEl = el('div', 'hud-log');
    root.append(this.logEl);

    // bottom-left: tools + build bar (one category tab at a time, so it stays short)
    const bl = el('div', 'hud-bl');
    this.buildBar = el('div', 'buildbar panel hidden');
    const tabs = el('div', 'btabs');
    this.buildBar.append(tabs);
    for (const cat of ['structure', 'furniture', 'food', 'power'] as BuildCategory[]) {
      const tab = el('button', 'btn btab', CATEGORY_LABEL[cat]);
      tab.dataset.cat = cat;
      tab.onclick = () => {
        this.buildCat = cat;
        this.syncTools();
      };
      this.tabBtns.set(cat, tab);
      tabs.append(tab);
      const row = el('div', 'bgroup-row');
      row.dataset.cat = cat;
      this.catRows.set(cat, row);
      for (const k of BUILD_LIST) {
        const d = BUILDS[k];
        if (d.category !== cat) continue;
        const b = el('button', 'btn build-btn');
        b.dataset.build = k;
        b.dataset.cat = cat;
        const icon = el('img', 'bicon');
        icon.alt = '';
        icon.src = buildIcon(k, d.w, d.h);
        const cost = Object.entries(d.cost).map(([r, n]) => `${n} ${RESOURCE_LABEL[r as keyof typeof RESOURCE_LABEL]}`).join(', ');
        const size = d.shape === 'building' ? `${d.w}×${d.h} · ` : '';
        b.append(icon, el('span', 'bname', d.name), el('span', 'bcost', size + cost));
        b.title = d.hint + (d.rotatable ? ' Press R to flip.' : '');
        b.onclick = () => this.tools.set({ build: k, mode: 'build' });
        this.buildBtns.set(k, b);
        row.append(b);
      }
      this.buildBar.append(row);
    }
    const toolbar = el('div', 'toolbar panel');
    for (const t of TOOL_BUTTONS) {
      const b = el('button', `btn tool tool-${t.mode}`);
      b.dataset.mode = t.mode;
      b.append(el('span', 'tool-label', t.label), el('kbd', '', t.key));
      b.title = t.hint;
      b.onclick = () => this.tools.set({ mode: this.tools.mode === t.mode ? 'select' : t.mode });
      this.toolBtns.set(t.mode, b);
      toolbar.append(b);
    }
    this.hintEl = el('div', 'hud-hint');
    bl.append(this.hintEl, this.buildBar, toolbar);
    root.append(bl);

    // bottom-right: priority widget
    const pr = el('div', 'hud-priority panel');
    pr.append(el('div', 'prio-title', 'Priority'));
    const grid = el('div', 'prio-grid');
    for (let p = 1; p <= 9; p++) {
      const b = el('button', 'btn prio', String(p));
      b.dataset.priority = String(p);
      b.title = `Priority ${p} (key ${p})`;
      b.style.setProperty('--p', String((p - 1) / 8));
      b.onclick = () => this.tools.set({ priority: p });
      this.prioBtns.set(p, b);
      grid.append(b);
    }
    const em = el('button', 'btn prio prio-em', '! Emergency');
    em.dataset.priority = String(EMERGENCY);
    em.title = 'Emergency: interrupts current work (key 0)';
    em.onclick = () => this.tools.set({ priority: EMERGENCY });
    this.prioBtns.set(EMERGENCY, em);
    pr.append(grid, em);
    root.append(pr);

    // game over
    this.overlay = el('div', 'overlay hidden');
    const box = el('div', 'overlay-box panel');
    box.append(el('h1', '', 'The colony has fallen'), el('p', 'overlay-text', ''));
    const again = el('button', 'btn', 'Start a new colony');
    again.onclick = () => location.reload();
    box.append(again);
    this.overlay.append(box);
    root.append(this.overlay);
  }

  private syncTools(): void {
    const t = this.tools;
    for (const [m, b] of this.toolBtns) b.classList.toggle('active', t.mode === m);
    this.buildBar.classList.toggle('hidden', t.mode !== 'build');
    for (const [k, b] of this.buildBtns) b.classList.toggle('active', t.build === k);
    for (const [c, b] of this.tabBtns) b.classList.toggle('active', this.buildCat === c);
    for (const [c, r] of this.catRows) r.classList.toggle('hidden', this.buildCat !== c);
    for (const [p, b] of this.prioBtns) b.classList.toggle('active', t.priority === p);
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', i === 0 ? t.paused : !t.paused && t.speed === i));
    const tb = TOOL_BUTTONS.find((x) => x.mode === t.mode);
    const pl = t.priority === EMERGENCY ? 'Emergency' : `priority ${t.priority}`;
    let hint = tb?.hint ?? '';
    if (t.mode === 'build') {
      const d = BUILDS[t.build];
      hint = `${d.name}: ${d.hint}`;
      if (d.shape === 'tile' && d.kind !== 'ladder') hint += ' Works on dirt and coal too (dug out first).';
      if (d.rotatable) {
        const dir = d.kind === 'stairs' ? (t.flip ? 'rising left' : 'rising right') : (t.flip ? 'mirrored' : 'normal');
        hint += ` R flips (${dir}).`;
      }
    }
    this.hintEl.textContent = tb
      ? `${hint} New orders: ${pl}. Right-click or Esc to exit.`
      : 'Pick a tool below. Drag the map or use WASD to pan, wheel to zoom, click a colonist or building for details.';
    this.hintEl.classList.toggle('mode', !!tb);
  }

  log(text: string, kind: 'info' | 'bad' = 'info'): void {
    const e = el('div', `log-line ${kind}`, text);
    this.logEl.prepend(e);
    while (this.logEl.children.length > 6) this.logEl.lastChild!.remove();
    setTimeout(() => e.classList.add('fade'), 7000);
    setTimeout(() => e.remove(), 9000);
  }

  update(): void {
    const w = this.world;
    for (const r of RESOURCES) {
      const v = String(Math.floor(w.resources[r]));
      if (this.resEls[r].textContent !== v) this.resEls[r].textContent = v;
      // crops only show up once there are some
      if (CROP_SET.has(r)) this.resChips[r].classList.toggle('hidden', w.resources[r] < 1);
    }
    const p = w.power;
    const anyPower = p.capacity > 0 || p.gen > 0 || p.use > 0 || p.unmet > 0 || p.spare > 0;
    this.powerChip.classList.toggle('hidden', !anyPower);
    if (anyPower) {
      const txt = `${Math.round(p.gen)}/${Math.round(p.use + p.unmet)} W` + (p.capacity > 0 ? ` · ${kJ(p.stored)}/${kJ(p.capacity)} kJ` : '');
      if (this.powerEl.textContent !== txt) this.powerEl.textContent = txt;
      this.powerChip.classList.toggle('bad', p.unmet > 0);
    }
    const pop = `${w.aliveCount}`;
    if (this.popEl.textContent !== pop) this.popEl.textContent = pop;
    const secs = w.seconds;
    const day = Math.floor(secs / DAY_SECONDS) + 1;
    const frac = (secs % DAY_SECONDS) / DAY_SECONDS;
    const hh = Math.floor(frac * 24), mm = Math.floor((frac * 24 - hh) * 60);
    const dayText = `Day ${day} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (this.dayEl.textContent !== dayText) this.dayEl.textContent = dayText;

    for (const ev of w.events.splice(0)) {
      if (ev.type === 'death') this.log(`${ev.name} died: ${ev.cause}.`, 'bad');
      else if (ev.type === 'fall') this.log(`${ev.name} fell ${ev.height} tiles (−${ev.damage} health).`, 'bad');
      else if (ev.type === 'message') this.log(ev.text);
      else if (ev.type === 'needFail') this.log(`${ev.name} ${ev.text}.`, 'bad');
      else if (ev.type === 'gameOver') {
        this.overlay.classList.remove('hidden');
        const t = this.overlay.querySelector('.overlay-text')!;
        t.textContent = `Every colonist has died. You survived until day ${day}.`;
      }
    }
    this.updatePanel();
    this.updateBuildingPanel();
  }

  private updateBuildingPanel(): void {
    const b = this.selectedBuilding >= 0 ? this.world.buildings.get(this.selectedBuilding) : undefined;
    if (!b || this.selectedId >= 0) {
      this.bpanel.classList.add('hidden');
      return;
    }
    this.bpanel.classList.remove('hidden');
    const d = BUILDS[b.kind];
    let s = `<div class="cp-name">${d.name}</div><div class="bp-hint">${d.hint}</div>`;
    if (b.kind === 'planter') {
      s += `<div class="bp-crops">` + CROP_LIST.map((k) =>
        `<button class="btn bp-crop${b.crop === k ? ' active' : ''}" data-act="crop" data-crop="${k}">${CROPS[k].name}</button>`,
      ).join('') + `</div><div class="bp-hint">${CROPS[b.crop].hint}</div>`;
    }
    if (SWITCHABLE.has(b.kind)) {
      s += `<button class="btn bp-toggle${b.on ? ' active' : ''}" data-act="toggle">${b.on ? 'On · click to switch off' : 'Off · click to switch on'}</button>`;
    }
    if (this.bpStatic.innerHTML !== s) this.bpStatic.innerHTML = s;
    const dyn = this.buildingStatus(b);
    if (this.bpDyn.innerHTML !== dyn) this.bpDyn.innerHTML = dyn;
  }

  /** Live rows for the inspector: growth, power, charge, fuel, who is working there. */
  private buildingStatus(b: Building): string {
    const w = this.world;
    const d = BUILDS[b.kind];
    const row = (k: string, v: string) => `<div class="cp-row"><span>${k}</span><b>${v}</b></div>`;
    const bar = (f: number, cls = '') => `<div class="cp-bar ${cls}"><i style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></i></div>`;
    const job = w.jobOf(b.id);
    const worker = job && job.claimedBy >= 0 ? w.colonists.find((c) => c.id === job.claimedBy)?.name : undefined;
    const jobText = job ? (worker ? `${worker}` : 'Waiting for a colonist') : '—';
    let out = '';
    switch (b.kind) {
      case 'planter': {
        const crop = CROPS[b.crop];
        const state = !b.on ? 'Switched off' : !b.planted ? 'Waiting to be sown'
          : b.growth >= 1 ? 'Ripe' : crop.powerUse > 0 && !b.powered ? 'No power: not growing' : 'Growing';
        out += row('Status', state);
        if (b.planted) out += row('Growth', `${Math.floor(b.growth * 100)}%`) + bar(b.growth);
        if (crop.powerUse > 0) out += row('Grow lamp', `${crop.powerUse} W`);
        if (job) out += row(job.task === 'sow' ? 'Sowing' : 'Harvest', jobText);
        break;
      }
      case 'printer':
      case 'stove':
        out += row('Power', `${d.powerUse} W while working`);
        out += row('Job', job ? `${job.task === 'cook' ? 'Cook' : 'Print'} a meal: ${jobText}` : 'Meal stock is full');
        if (job && worker && !b.powered) out += row('Status', 'Waiting for power');
        break;
      case 'lamp':
        out += row('Status', !b.on ? 'Switched off' : b.powered ? `Lit (${d.powerUse} W)` : 'No power');
        break;
      case 'crank':
        out += row('Output', b.powered ? `${d.powerGen} W (cranked)` : 'Idle');
        out += row('Job', job ? `Crank: ${jobText}` : 'Power is fine');
        break;
      case 'coalgen':
      case 'reactor': {
        const f = d.fuel!;
        const fuelLeft = w.resources[f.res] < f.perSec ? 'No fuel' : 'Idle (power is fine)';
        out += row('Status', !b.on ? 'Switched off' : b.powered ? `Running: ${d.powerGen} W` : fuelLeft);
        out += row('Fuel', `${RESOURCE_LABEL[f.res]} ${Math.floor(w.resources[f.res])} (−${f.perSec}/s)`);
        break;
      }
      case 'battery':
        out += row('Charge', `${kJ(b.charge)} / ${kJ(d.capacity!)} kJ`) + bar(b.charge / d.capacity!);
        break;
    }
    return out;
  }

  private updatePanel(): void {
    const c = this.world.colonists.find((k) => k.id === this.selectedId);
    if (!c) {
      this.panel.classList.add('hidden');
      return;
    }
    this.panel.classList.remove('hidden');
    const html =
      `<div class="cp-name"><span class="swatch" style="background:${c.tint}"></span>${c.name}</div>` +
      `<div class="cp-row"><span>Activity</span><b>${c.activity()}</b></div>` +
      `<div class="cp-row"><span>Health</span><b>${Math.round(c.health)} / 100</b></div>` +
      `<div class="cp-bar"><i style="width:${Math.max(0, c.health)}%"></i></div>` +
      (c.job ? `<div class="cp-row"><span>Job priority</span><b>${c.job.priority === EMERGENCY ? 'Emergency' : c.job.priority}</b></div>` : '') +
      (c.alive
        ? `<div class="cp-needs">` + NEEDS.map((n) => {
          const v = Math.round(c.needs[n]);
          const d = NEED_DEFS[n];
          const cls = v < d.urgent ? 'bad' : v < d.want ? 'warn' : 'ok';
          return `<div class="cp-need ${cls}"><span>${NEED_LABEL[n]}</span><i><b style="width:${v}%"></b></i><em>${v}</em></div>`;
        }).join('') + `</div>`
        : '');
    if (this.panel.innerHTML !== html) this.panel.innerHTML = html;
  }
}
