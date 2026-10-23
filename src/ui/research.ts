// Research panel (T): the tech tree by branch. Click an available project to have the research
// stations work on it (click it again to pause). Cards are built once; update() only touches
// classes, text and progress bars, so clicks never land on a re-rendered element.

import { BUILDS, CROPS, RESEARCH, RESEARCH_LIST, type ResearchBranch, type ResearchId } from '../sim/defs';
import type { World } from '../sim/world';

const BRANCHES: ResearchBranch[] = ['Science', 'Farming', 'Power', 'Comfort'];

interface Card {
  card: HTMLButtonElement;
  bar: HTMLElement;
  status: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** What a project unlocks, for its card and the completion message. */
export function unlockText(id: ResearchId): string {
  const d = RESEARCH[id];
  const parts = [...(d.builds ?? []).map((k) => BUILDS[k].name), ...(d.crops ?? []).map((c) => CROPS[c].name)];
  if (d.growLamp) parts.push('Planter grow lamp');
  return parts.join(', ');
}

export class ResearchPanel {
  readonly el: HTMLElement;
  private world: World;
  private cards = new Map<ResearchId, Card>();
  private note: HTMLElement;

  constructor(world: World, onClose: () => void) {
    this.world = world;
    this.el = el('div', 'hud-research panel hidden');
    const head = el('div', 'rs-head');
    head.append(el('div', 'rs-title', 'Research'));
    const close = el('button', 'btn rs-close', '✕');
    close.title = 'Close (T or Esc)';
    close.onclick = onClose;
    head.append(close);
    this.note = el('div', 'rs-note');
    const cols = el('div', 'rs-cols');
    for (const br of BRANCHES) {
      const col = el('div', 'rs-col');
      col.append(el('div', 'rs-branch', br));
      const ids = RESEARCH_LIST.filter((id) => RESEARCH[id].branch === br)
        .sort((a, b) => RESEARCH[a].tier - RESEARCH[b].tier || RESEARCH[a].cost - RESEARCH[b].cost);
      for (const id of ids) col.append(this.makeCard(id));
      cols.append(col);
    }
    this.el.append(head, this.note, cols);
  }

  private makeCard(id: ResearchId): HTMLButtonElement {
    const d = RESEARCH[id];
    const card = el('button', 'rcard');
    card.dataset.rid = id;
    card.title = d.hint;
    const top = el('div', 'rc-top');
    top.append(el('span', 'rc-name', d.name), el('span', `rc-tier t${d.tier}`, `T${d.tier}`));
    const bar = el('i');
    const barWrap = el('div', 'rc-bar');
    barWrap.append(bar);
    const status = el('div', 'rc-status');
    card.append(top, el('div', 'rc-unlock', unlockText(id) || d.hint), barWrap, status);
    card.onclick = () => {
      const r = this.world.research;
      if (r.active === id) this.world.issue({ type: 'research', id: null });
      else if (this.world.researchAvailable(id)) this.world.issue({ type: 'research', id });
    };
    this.cards.set(id, { card, bar, status });
    return card;
  }

  update(): void {
    if (this.el.classList.contains('hidden')) return;
    const w = this.world;
    const r = w.research;
    const hasBasic = w.buildings.ofKind('research').size > 0;
    const hasAdv = w.buildings.ofKind('advresearch').size > 0;
    for (const [id, c] of this.cards) {
      const d = RESEARCH[id];
      const pts = Math.floor(r.progress[id] ?? 0);
      const done = r.done.has(id);
      const active = r.active === id;
      const avail = w.researchAvailable(id);
      let status: string;
      if (done) status = 'Done';
      else if (active) {
        status = `Researching · ${pts} / ${d.cost}`;
        if (d.tier === 2 && !hasAdv) status = 'Needs an Advanced Research Station';
        else if (!hasBasic && !hasAdv) status = 'Build a Research Station';
      } else if (avail) status = `${pts} / ${d.cost} pts · click to research`;
      else status = `Needs ${d.needs.filter((n) => !r.done.has(n)).map((n) => RESEARCH[n].name).join(', ')}`;
      if (c.status.textContent !== status) c.status.textContent = status;
      c.card.classList.toggle('done', done);
      c.card.classList.toggle('active', active);
      c.card.classList.toggle('locked', !done && !avail);
      const width = `${Math.round(Math.min(1, pts / d.cost) * 100)}%`;
      if (c.bar.style.width !== width) c.bar.style.width = width;
    }
    const note = r.active
      ? `Researching ${RESEARCH[r.active].name}. Click it again to pause.`
      : 'Pick a project. Tier 1 runs on any Research Station; tier 2 needs the Advanced Research Station.';
    if (this.note.textContent !== note) this.note.textContent = note;
  }
}
