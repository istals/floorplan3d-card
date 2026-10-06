// Device badges (pure): integration logo, status dot, low battery. No DOM here.
import { isActive } from './registry.js';

export const LOW_BATTERY = 20;
export const BADGE_DEFAULTS = { integration: false, status: true, battery: true };

// Layout toggles, then the card YAML `badges:` per key.
export function badgeOptions(layoutBadges, yamlBadges) {
  const out = { ...BADGE_DEFAULTS };
  for (const src of [layoutBadges, yamlBadges]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of Object.keys(BADGE_DEFAULTS)) if (typeof src[k] === 'boolean') out[k] = src[k];
  }
  return out;
}

// device_id -> entity ids, built once per hass.entities object.
const indexCache = new WeakMap();
export function deviceIndex(entities) {
  if (!entities || typeof entities !== 'object') return new Map();
  let idx = indexCache.get(entities);
  if (idx) return idx;
  idx = new Map();
  for (const [eid, e] of Object.entries(entities)) {
    if (!e || !e.device_id) continue;
    if (!idx.has(e.device_id)) idx.set(e.device_id, []);
    idx.get(e.device_id).push(eid);
  }
  indexCache.set(entities, idx);
  return idx;
}

export function platformOf(entities, eid) {
  const e = entities && entities[eid];
  return e && typeof e.platform === 'string' && e.platform ? e.platform : null;
}

export function brandUrl(platform, dark = false) {
  return `https://brands.home-assistant.io/_/${encodeURIComponent(platform)}/${dark ? 'dark_icon' : 'icon'}.png`;
}

// Lowest numeric battery % of the device's battery sensors, or null.
export function batteryLevel(eids, states = {}) {
  let low = null;
  for (const eid of eids || []) {
    if (!eid.startsWith('sensor.')) continue;
    const st = states[eid];
    if (!st || !st.attributes || st.attributes.device_class !== 'battery') continue;
    const n = Number(st.state);
    if (st.state === '' || st.state === null || !Number.isFinite(n)) continue;
    if (low === null || n < low) low = n;
  }
  return low;
}

export function problemOn(eids, states = {}) {
  return (eids || []).some((eid) => {
    if (!eid.startsWith('binary_sensor.')) return false;
    const st = states[eid];
    return !!st && st.state === 'on' && st.attributes && st.attributes.device_class === 'problem';
  });
}

const BAD = new Set(['unavailable', 'unknown']);
// 'red' | 'yellow' | 'green' | 'grey' for a primary entity state.
export function statusKind(st, { lowBattery = false, problem = false } = {}) {
  if (!st || BAD.has(st.state)) return 'red';
  if (lowBattery || problem) return 'yellow';
  const domain = String(st.entity_id || '').split('.')[0];
  if (domain === 'sensor') return st.state !== '' && st.state !== null && st.state !== undefined ? 'green' : 'grey';
  return isActive(st) ? 'green' : 'grey';
}

// All badge inputs for a device / entity: { platform, status, battery (low % or null), sig }.
export function badgeInfo(hass, { entityId, deviceId }, opts = BADGE_DEFAULTS) {
  const states = hass.states || {};
  const eids = deviceId ? deviceIndex(hass.entities).get(deviceId) || [entityId] : [entityId];
  const level = opts.status || opts.battery ? batteryLevel(eids, states) : null;
  const low = level !== null && level < LOW_BATTERY;
  const platform = opts.integration ? platformOf(hass.entities, entityId) : null;
  const status = opts.status ? statusKind(states[entityId], { lowBattery: low, problem: problemOn(eids, states) }) : null;
  const battery = opts.battery && low ? Math.round(level) : null;
  return { platform, status, battery, sig: `${platform || ''}|${status || ''}|${battery ?? ''}` };
}
