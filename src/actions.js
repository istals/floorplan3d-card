// HA-style actions (tap_action / hold_action / double_tap_action) for model objects and markers.
// Pure: resolution (type defaults < model fp.ui < layout ui < card YAML `actions:`), a description of
// what to do (actionCall; the card executes it), popup link rows and the double-tap sequencer.

export const KINDS = ['toggle', 'more-info', 'navigate', 'url', 'perform-action', 'assist', 'popup', 'none'];
const KIND_SET = new Set(KINDS);
export const WHICH = ['tap', 'hold', 'double_tap'];
export const DOUBLE_TAP_MS = 250;
const TOGGLE_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean']);
// services that are commonly called without any target
const TARGETLESS = new Set(['script', 'notify', 'persistent_notification']);
const TARGET_KEYS = ['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id'];

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const domainOf = (e) => String(e).split('.')[0];

// [domain, service, data] toggling an entity (domains without their own toggle use homeassistant.toggle).
export function toggleCall(entity) {
  const d = domainOf(entity);
  return TOGGLE_DOMAINS.has(d) ? [d, 'toggle', { entity_id: entity }] : ['homeassistant', 'toggle', { entity_id: entity }];
}

/** One action in HA's shape { action, ... }; a bare string is the action name; legacy call-service accepted. Invalid: null. */
export function normAction(v) {
  if (typeof v === 'string') return KIND_SET.has(v) ? { action: v } : null;
  if (!plain(v)) return null;
  if (v.action === 'call-service') {
    const { service, service_data: sd, ...rest } = v;
    const out = { ...rest, action: 'perform-action' };
    if (service !== undefined && out.perform_action === undefined) out.perform_action = service;
    if (sd !== undefined && out.data === undefined) out.data = sd;
    return out;
  }
  return KIND_SET.has(v.action) ? { ...v } : null;
}

// The actions one ui-like source sets: `<which>_action`, else the legacy `<which>` key.
function fromSource(ui) {
  const out = {};
  if (!plain(ui)) return out;
  for (const w of WHICH) {
    const a = normAction(ui[`${w}_action`] !== undefined ? ui[`${w}_action`] : ui[w]);
    if (a) out[w] = a;
  }
  if (Array.isArray(ui.popup)) out.popup = ui.popup;
  return out;
}

/**
 * { tap, hold, double_tap, popup }: each action normalised ({ action, ... }); double_tap null when there
 * is none (or it is `none`): taps on that target are then never delayed. Later sources win:
 * type defaults < model fp.ui < layout.objects[id].ui < YAML `actions:` (device:<id> < <entity_id> < object:<id>).
 */
export function resolveActions({ modelUi, layoutUi, yaml, kind = 'object', id, entityId, deviceId, typeDefaults } = {}) {
  const y = plain(yaml) ? yaml : {};
  const keys = [deviceId && `device:${deviceId}`, entityId, kind === 'object' && id && `object:${id}`].filter(Boolean);
  const sources = [typeDefaults, modelUi, layoutUi, ...keys.map((k) => y[k])].map(fromSource);
  const out = { tap: { action: 'none' }, hold: { action: 'none' }, double_tap: null, popup: ['state'] };
  for (const s of sources) Object.assign(out, s);
  if (out.double_tap && out.double_tap.action === 'none') out.double_tap = null;
  return out;
}

const hasTarget = (o) => plain(o) && TARGET_KEYS.some((k) => o[k] !== undefined && o[k] !== null && o[k] !== '' && !(Array.isArray(o[k]) && !o[k].length));

/** A message for an action missing a required field, else null (entity-based actions are checked at run time). */
export function validateAction(a) {
  if (!a) return null;
  switch (a.action) {
    case 'navigate': return a.navigation_path ? null : 'navigate needs navigation_path';
    case 'url': return a.url_path ? null : 'url needs url_path';
    case 'perform-action': {
      const s = a.perform_action;
      if (!s) return 'perform-action needs perform_action (domain.action)';
      if (typeof s !== 'string' || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(s)) return `perform_action "${s}" is not domain.action`;
      if (!TARGETLESS.has(domainOf(s)) && !hasTarget(a.target) && !hasTarget(a.data)) return `${s} needs a target (entity_id, device_id or area_id)`;
      return null;
    }
    default: return null;
  }
}

function confirmText(a, call) {
  const c = a.confirmation;
  if (!c || call.kind === 'none' || call.kind === 'error') return null;
  if (plain(c) && typeof c.text === 'string' && c.text) return c.text;
  const what = {
    service: () => `run ${call.domain}.${call.service}`,
    navigate: () => `open ${call.path}`,
    url: () => `open ${call.url}`,
  }[call.kind];
  return `Are you sure you want to ${what ? what() : a.action}?`;
}

/**
 * What to do for an action. ctx.entity: the entity toggle / more-info act on by default.
 * Returns { kind: 'service', domain, service, data, target? } | { kind: 'more-info', entityId } |
 * { kind: 'navigate', path, replace } | { kind: 'url', url, newTab } | { kind: 'assist', action } |
 * { kind: 'popup' } | { kind: 'none' } | { kind: 'error', message }; each with confirm (text | null).
 */
export function actionCall(action, ctx = {}) {
  const a = normAction(action);
  let call;
  const missing = a && validateAction(a);
  if (!a) call = { kind: 'none' };
  else if (missing) call = { kind: 'error', message: missing };
  else {
    const entity = a.entity || ctx.entity || null;
    switch (a.action) {
      case 'toggle': {
        if (!entity) { call = { kind: 'error', message: 'Nothing to toggle: no entity' }; break; }
        const [domain, service, data] = toggleCall(entity);
        call = { kind: 'service', domain, service, data };
        break;
      }
      case 'more-info':
        call = entity ? { kind: 'more-info', entityId: entity } : { kind: 'error', message: 'more-info needs an entity' };
        break;
      case 'navigate':
        call = { kind: 'navigate', path: String(a.navigation_path), replace: !!a.navigation_replace };
        break;
      case 'url': {
        const url = String(a.url_path);
        call = { kind: 'url', url, newTab: !url.startsWith('/') };
        break;
      }
      case 'perform-action': {
        const [domain, service] = a.perform_action.split('.');
        call = { kind: 'service', domain, service, data: plain(a.data) ? { ...a.data } : {} };
        if (plain(a.target)) call.target = { ...a.target };
        break;
      }
      case 'assist': call = { kind: 'assist', action: a }; break;
      case 'popup': call = { kind: 'popup' }; break;
      default: call = { kind: 'none' };
    }
  }
  call.confirm = a ? confirmText(a, call) : null;
  return call;
}

const ENTITY_LINKS = {
  history: (e) => ({ label: 'History', action: { action: 'navigate', navigation_path: `/history?entity_id=${encodeURIComponent(e)}` } }),
  logbook: (e) => ({ label: 'Logbook', action: { action: 'navigate', navigation_path: `/logbook?entity_id=${encodeURIComponent(e)}` } }),
  // HA's more-info dialog shows the history / statistics graph
  statistics: (e) => ({ label: 'Statistics', action: { action: 'more-info', entity: e } }),
};

/** Link rows of a popup list: history / logbook / statistics (need entity) and custom { label, navigate | url }. */
export function popupLinks(list, entity) {
  const rows = [];
  for (const k of Array.isArray(list) ? list : []) {
    if (typeof k === 'string' && ENTITY_LINKS[k]) {
      if (entity) rows.push({ kind: 'link', ...ENTITY_LINKS[k](entity) });
    } else if (plain(k) && k.label && (k.navigate || k.url)) {
      rows.push({
        kind: 'link', label: String(k.label),
        action: k.navigate ? { action: 'navigate', navigation_path: String(k.navigate) } : { action: 'url', url_path: String(k.url) },
      });
    }
  }
  return rows;
}

/**
 * Single vs double tap per target key. Without a double tap action the single tap runs at once;
 * with one it waits DOUBLE_TAP_MS for a second tap. Pending keys are independent.
 */
export class TapSequencer {
  constructor(ms = DOUBLE_TAP_MS) {
    this.ms = ms;
    this.pending = new Map(); // key -> timer
  }

  tap(key, hasDouble, onSingle, onDouble) {
    if (!hasDouble) { onSingle(); return; }
    const t = this.pending.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.pending.delete(key);
      onDouble();
      return;
    }
    this.pending.set(key, setTimeout(() => { this.pending.delete(key); onSingle(); }, this.ms));
  }

  cancel() {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
