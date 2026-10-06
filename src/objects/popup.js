// Object popup: a small panel next to a model object with its controls (toggle, brightness,
// colour, the group chain) and read-only values. popupRows() is the pure part (unit-tested).
import { typeOf } from './types.js';
import { controllersOf } from './logic.js';
import { toggleCall, popupLinks } from '../actions.js';
import { applyBadges } from '../badge-dom.js';

export { toggleCall };
const KINDS = new Set(['toggle', 'brightness', 'color', 'state', 'battery', 'power', 'energy', 'temperature', 'mode', 'start_dock']);
const COLOR_MODES = new Set(['hs', 'rgb', 'xy', 'rgbw', 'rgbww']);
export const SWATCHES = [
  [255, 59, 48], [255, 149, 0], [255, 214, 10], [52, 199, 89], [48, 213, 200], [10, 132, 255], [175, 82, 222], [255, 55, 145],
];
const LABELS = {
  toggle: 'On / off', brightness: 'Brightness', color: 'Colour', state: 'State', battery: 'Battery', power: 'Power',
  energy: 'Energy', temperature: 'Temperature', mode: 'Mode', start_dock: 'Mower',
};

const domainOf = (e) => String(e).split('.')[0];
const bad = (s) => !s || s.state === 'unavailable' || s.state === 'unknown';
const nameOf = (states, e) => (states[e] && states[e].attributes && states[e].attributes.friendly_name) || e;
const withUnit = (v, u) => (u ? `${v} ${u}` : String(v));

// The entity a toggle / more-info acts on: the object's own entity, else its first tag controller.
// With states: an unavailable own entity (a bulb behind an off relay) falls back to a usable controller.
export function actionTarget(obj, binding, groups = {}, states = null) {
  if (binding && binding.hidden) return null;
  const ctrls = controllersOf(obj, binding, groups).map((c) => c.entity);
  const own = (binding && binding.entity) || null;
  if (own && states && bad(states[own])) { const ok = ctrls.find((c) => !bad(states[c])); if (ok) return ok; }
  return own || ctrls[0] || null;
}

function readValue(kind, e, s) {
  const a = s.attributes || {};
  const unit = a.unit_of_measurement;
  switch (kind) {
    case 'state': return withUnit(s.state, unit);
    case 'battery': {
      const v = a.battery_level ?? a.battery;
      if (v !== undefined && v !== null) return `${v} %`;
      return a.device_class === 'battery' ? withUnit(s.state, unit) : null;
    }
    case 'power': {
      if (unit === 'W' || unit === 'kW') return withUnit(s.state, unit);
      const v = a.current_power_w ?? a.power;
      return v !== undefined && v !== null ? `${v} W` : null;
    }
    case 'energy': {
      if (unit === 'kWh' || unit === 'Wh') return withUnit(s.state, unit);
      const v = a.energy ?? a.total_energy_kwh;
      return v !== undefined && v !== null ? `${v} kWh` : null;
    }
    case 'temperature': {
      const v = a.current_temperature;
      if (v !== undefined && v !== null) return a.temperature_unit ? `${v} ${a.temperature_unit}` : `${v}°`;
      return unit === '°C' || unit === '°F' ? withUnit(s.state, unit) : null;
    }
    case 'mode': return domainOf(e) === 'climate' ? s.state : a.mode ?? a.preset_mode ?? null;
    default: return null;
  }
}

/**
 * Popup rows for an object: the popup list (resolved from fp.ui / layout / YAML; default fp.ui.popup or the
 * type default), plus the group chain, then link rows (history / logbook / statistics / custom) at the bottom.
 * groups (tag settings) tell the controllers apart from the object's own entity.
 * Unavailable / unbound: a single state row "unavailable" (and the links).
 */
export function popupRows(obj, chain, states = {}, groups = {}, popup = null) {
  const ui = Array.isArray(popup) ? popup : obj.ui && Array.isArray(obj.ui.popup) ? obj.ui.popup : typeOf(obj.type).defaults.popup;
  const firstEntity = chain && chain.entities ? chain.entities[0] || null : null;
  const unavailable = [{ kind: 'state', label: 'State', value: 'unavailable' }, ...popupLinks(ui, firstEntity)];
  if (!chain || !chain.entities || !chain.entities.some((e) => !bad(states[e]))) return unavailable;
  // controllers: from the chain (tags), else the legacy fp.group lookup
  const ctrls = (chain.controllers || controllersOf(obj, null, groups)).filter((c) => chain.entities.includes(c.entity));
  const isCtrl = (e) => ctrls.some((c) => c.entity === e);
  const own = chain.entities.find((e) => !isCtrl(e)) || null;
  const ctrl = ctrls.length ? ctrls[0].entity : null;
  const ownBad = !!own && bad(states[own]);
  // an unavailable own entity: only the (usable) controller row and the reason
  const main = ownBad ? null : own || ctrl;
  const light = chain.entities.find((e) => e.startsWith('light.') && !bad(states[e])) || null;
  const ls = light ? states[light] : null;
  const modes = ls && Array.isArray(ls.attributes.supported_color_modes) ? ls.attributes.supported_color_modes : null;
  const want = [];
  for (const k of ui) {
    const kind = k === 'start' || k === 'dock' ? 'start_dock' : k;
    if (KINDS.has(kind) && !want.includes(kind)) want.push(kind);
  }
  const rows = [];
  for (const kind of main ? want : []) {
    const label = LABELS[kind];
    if (kind === 'toggle') rows.push({ kind, entity: main, label, value: states[main].state === 'on' });
    else if (kind === 'brightness') {
      if (!ls || (modes && modes.every((m) => m === 'onoff'))) continue;
      const b = ls.attributes.brightness;
      rows.push({ kind, entity: light, label, value: ls.state === 'on' && typeof b === 'number' ? b : ls.state === 'on' ? 255 : 0 });
    } else if (kind === 'color') {
      if (!modes || !modes.some((m) => COLOR_MODES.has(m))) continue;
      rows.push({ kind, entity: light, label, value: Array.isArray(ls.attributes.rgb_color) ? ls.attributes.rgb_color.slice(0, 3) : null });
    } else if (kind === 'start_dock') {
      if (domainOf(main) === 'lawn_mower') rows.push({ kind, entity: main, label, value: states[main].state });
    } else {
      const value = readValue(kind, main, states[main]);
      if (value !== null && value !== undefined) rows.push({ kind, entity: main, label, value });
    }
  }
  // a row per controller: the tag's label (layout.tags[name].label) when set, else the entity's name
  const labelOf = (c) => { const g = groups[c.tag]; return (g && typeof g.label === 'string' && g.label) || nameOf(states, c.entity); };
  for (const c of ctrls) if (c.entity !== main) rows.push({ kind: 'chain', entity: c.entity, label: labelOf(c), value: !bad(states[c.entity]) && states[c.entity].state === 'on' });
  let reason = null;
  const off = ctrls.find((c) => !bad(states[c.entity]) && states[c.entity].state !== 'on');
  if (off) reason = `${labelOf(off)} is off`;
  else if (ownBad) reason = `${nameOf(states, own)} is unavailable`;
  else if (!chain.lit && chain.reason) {
    reason = chain.reason;
    for (const e of chain.entities) if (reason.startsWith(e + ' ')) reason = nameOf(states, e) + reason.slice(e.length);
  }
  if (reason) rows.push({ kind: 'reason', label: reason });
  rows.push(...popupLinks(ui, own || ctrl));
  return rows;
}

// Row layout key: a change rebuilds the rows; the label is part of it for link and info rows, so a
// label never stays next to another row's value (the per-row update only writes values).
export function rowsKey(rows) {
  return rows.map((r) => `${r.kind}:${r.entity || ''}${r.kind === 'link' || r.kind === 'info' ? `:${r.label}` : ''}`).join('|');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STOP = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'click', 'dblclick', 'contextmenu',
  'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchmove', 'wheel', 'keydown'];

/**
 * The DOM popup. root: the stage (position: relative). opts:
 *   onAction(domain, service, data), onLink(action) (a link row: an HA action { action, ... }),
 *   project(world: Vector3) -> [clientX, clientY] | null,
 *   resolve(id) -> { obj, chain, states, groups, popup? } | null (current data for the open object).
 */
export class ObjectPopup {
  constructor(root, { onAction, onLink, project, resolve, anchor } = {}) {
    this.root = root;
    this.onLink = onLink || (() => {});
    this.anchorOf = anchor || null; // (id) -> world Vector3, re-read on every reposition
    this.onAction = onAction || (() => {});
    this.project = project || (() => null);
    this.resolve = resolve || (() => null);
    this.el = null;
    this._id = null;
    this._anchor = null;
    this._key = null;
    this._sliding = false;
    this.closedBy = null; // the outside pointerdown that closed the popup (that gesture must not act)
    this._onOutside = (e) => {
      if (!this.el || e.composedPath().includes(this.el)) return;
      this.closedBy = e;
      this.close();
    };
    this._onRelease = () => { this._sliding = false; };
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
  }

  get isOpen() { return !!this.el; }
  get objectId() { return this._id; }

  open(obj, anchorWorld) {
    this.close();
    this._id = obj.id;
    this._anchor = anchorWorld && anchorWorld.clone ? anchorWorld.clone() : anchorWorld;
    const el = document.createElement('div');
    el.className = 'fp-popup';
    el.innerHTML = `<div class="fp-pop-head"><span class="fp-pop-badges"></span><span class="fp-pop-title"></span><button class="fp-pop-x" title="Close">×</button></div><div class="fp-pop-rows"></div>`;
    el.querySelector('.fp-pop-title').textContent = obj.label || obj.id;
    for (const t of STOP) el.addEventListener(t, (e) => e.stopPropagation()); // no HA long-press / orbit / marker
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); }); // window never sees it (stopped)
    el.addEventListener('click', (e) => this._click(e));
    el.addEventListener('change', (e) => this._change(e));
    el.addEventListener('pointerdown', (e) => { if (e.target.type === 'range') this._sliding = true; });
    el.querySelector('.fp-pop-x').addEventListener('click', () => this.close());
    this.el = el;
    this.root.append(el);
    window.addEventListener('pointerdown', this._onOutside, true);
    window.addEventListener('pointerup', this._onRelease, true); // a slider released outside the popup
    window.addEventListener('pointercancel', this._onRelease, true);
    window.addEventListener('keydown', this._onKey);
    this.update();
    this.position();
  }

  _rows() {
    const r = this._id ? this.resolve(this._id) : null;
    if (!r) return null;
    this._links = [];
    this._badge = r.badge || null;
    this._dark = !!r.dark;
    const rows = popupRows(r.obj, r.chain, r.states || {}, r.groups || {}, r.popup || null);
    // read-only rows from the card (e.g. the mower's Stripes / Mowed), above the links
    if (Array.isArray(r.extra) && r.extra.length) {
      const at = rows.findIndex((x) => x.kind === 'link');
      rows.splice(at < 0 ? rows.length : at, 0, ...r.extra.map((x) => ({ kind: 'info', label: x.label, value: x.value })));
    }
    for (const row of rows) if (row.kind === 'link') this._links.push(row.action);
    return rows;
  }

  // Re-read the object's rows; same row layout: values only (a slider being dragged keeps its value).
  update() {
    if (!this.el) return;
    const rows = this._rows();
    if (!rows) { this.close(); return; }
    applyBadges(this.el.querySelector('.fp-pop-badges'), this._badge || null, !!this._dark);
    const key = rowsKey(rows);
    const box = this.el.querySelector('.fp-pop-rows');
    if (key !== this._key) {
      this._key = key;
      box.innerHTML = rows.map((r) => this._rowHtml(r)).join('');
    }
    rows.forEach((r, i) => {
      const row = box.children[i];
      if (!row) return;
      row.dataset.entity = r.entity || '';
      if (r.kind === 'toggle' || r.kind === 'chain') {
        const b = row.querySelector('.fp-switch');
        b.classList.toggle('on', !!r.value);
        b.setAttribute('aria-checked', String(!!r.value));
        if (r.kind === 'chain') row.querySelector('.fp-pop-label').textContent = r.label;
      } else if (r.kind === 'brightness') {
        const input = row.querySelector('input');
        if (!this._sliding) input.value = String(Math.max(1, r.value));
        row.classList.toggle('off', !r.value);
      } else if (r.kind === 'color') {
        const v = r.value ? r.value.join(',') : '';
        for (const s of row.querySelectorAll('.fp-swatch')) s.classList.toggle('on', !!v && s.dataset.rgb === v);
      } else if (r.kind === 'reason') {
        row.textContent = r.label;
      } else if (r.kind !== 'start_dock' && r.kind !== 'link') {
        row.querySelector('.fp-pop-value').textContent = r.value;
      }
    });
  }

  _rowHtml(r) {
    const label = `<span class="fp-pop-label">${esc(r.label)}</span>`;
    switch (r.kind) {
      case 'toggle': case 'chain':
        return `<div class="fp-pop-row ${r.kind}">${label}<button class="fp-switch" role="switch" data-act="toggle"><span></span></button></div>`;
      case 'brightness':
        return `<div class="fp-pop-row brightness">${label}<input type="range" min="1" max="255" step="1"></div>`;
      case 'color':
        return `<div class="fp-pop-row color">${SWATCHES.map((c) => `<button class="fp-swatch" data-act="rgb" data-rgb="${c.join(',')}" style="background:rgb(${c.join(',')})"></button>`).join('')}`
          + '<button class="fp-swatch white" data-act="white" title="Warm white"></button></div>';
      case 'start_dock':
        return `<div class="fp-pop-row start_dock">${label}<span class="fp-pop-btns"><button data-act="start">Start</button><button data-act="dock">Dock</button></span></div>`;
      case 'reason':
        return `<div class="fp-pop-row reason">${esc(r.label)}</div>`;
      case 'link':
        return `<div class="fp-pop-row link"><button class="fp-pop-link" data-act="link">${esc(r.label)}</button></div>`;
      default:
        return `<div class="fp-pop-row value">${label}<span class="fp-pop-value"></span></div>`;
    }
  }

  _click(e) {
    const b = e.target.closest && e.target.closest('[data-act]');
    const row = b && b.closest('.fp-pop-row');
    if (b && b.dataset.act === 'link') {
      const links = [...this.el.querySelectorAll('.fp-pop-row.link')];
      const a = (this._links || [])[links.indexOf(row)];
      if (a) this.onLink(a);
      return;
    }
    const entity = row && row.dataset.entity;
    if (!b || !entity) return;
    const act = b.dataset.act;
    if (act === 'toggle') this.onAction(...toggleCall(entity));
    else if (act === 'rgb') this.onAction('light', 'turn_on', { entity_id: entity, rgb_color: b.dataset.rgb.split(',').map(Number) });
    else if (act === 'white') this.onAction('light', 'turn_on', { entity_id: entity, color_temp_kelvin: 2700 });
    else if (act === 'start') this.onAction('lawn_mower', 'start_mowing', { entity_id: entity });
    else if (act === 'dock') this.onAction('lawn_mower', 'dock', { entity_id: entity });
  }

  // brightness: one call when the slider is released ('change'), not per 'input' step
  _change(e) {
    if (e.target.type !== 'range') return;
    this._sliding = false;
    const row = e.target.closest('.fp-pop-row');
    const entity = row && row.dataset.entity;
    if (entity) this.onAction('light', 'turn_on', { entity_id: entity, brightness: Math.round(Number(e.target.value)) });
  }

  // Next to the object's anchor (called after every render), kept inside the stage; hidden while
  // the anchor is off-screen or behind the camera.
  position() {
    if (!this.el) return;
    const world = (this.anchorOf && this.anchorOf(this._id)) || this._anchor;
    const p = world ? this.project(world) : null;
    const r = this.root.getBoundingClientRect();
    const ax = p ? p[0] - r.left : 0, ay = p ? p[1] - r.top : 0;
    if (!p || ax < 0 || ay < 0 || ax > r.width || ay > r.height) { this.el.style.visibility = 'hidden'; return; }
    this.el.style.maxHeight = `${Math.max(60, r.height - 16)}px`;
    const w = this.el.offsetWidth, h = this.el.offsetHeight, gap = 18, pad = 8;
    let x = ax + gap;
    if (x + w > r.width - pad) x = ax - gap - w; // no room on the right: left of the object
    x = Math.max(pad, Math.min(x, r.width - w - pad));
    const y = Math.max(pad, Math.min(ay - h / 2, r.height - h - pad));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.el.style.visibility = '';
  }

  close() {
    if (!this.el) return;
    window.removeEventListener('pointerdown', this._onOutside, true);
    window.removeEventListener('pointerup', this._onRelease, true);
    window.removeEventListener('pointercancel', this._onRelease, true);
    window.removeEventListener('keydown', this._onKey);
    this.el.remove();
    this.el = null;
    this._id = null;
    this._anchor = null;
    this._key = null;
    this._sliding = false;
  }
}
