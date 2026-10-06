// Turns hass.entities / hass.devices / hass.areas into a list of markers.
// These registries live on the hass object and update by themselves, so a new device
// with an area shows up on the plan without any extra work.

import { SKIP_DOMAINS, domainPriority, sensorPriority } from './placement.js';

export function registrySignature(hass) {
  // Cheap identity check: HA replaces these objects when the registries change.
  return [hass.entities, hass.devices, hass.areas, hass.floors];
}

export function buildMarkers(hass, layout, opts = {}) {
  const groupBy = opts.group_by || 'device';
  const hidden = new Set(layout.hidden || []);
  const ents = hass.entities || {};
  const devs = hass.devices || {};
  const byMarker = new Map();

  for (const eid of Object.keys(ents)) {
    const e = ents[eid];
    if (!e || e.hidden || e.entity_category) continue;
    const domain = eid.split('.')[0];
    if (SKIP_DOMAINS.has(domain)) continue;
    const st = hass.states[eid];
    if (!st) continue;
    const dev = e.device_id ? devs[e.device_id] : null;
    const areaId = e.area_id || (dev && dev.area_id) || null;
    const id = groupBy === 'device' && e.device_id && !e.area_id ? 'device:' + e.device_id : 'entity:' + eid;
    if (hidden.has(id) || hidden.has(eid)) continue;
    const dc = st.attributes.device_class;
    const cand = { eid, domain, dc, prio: domainPriority(domain) * 100 + (domain === 'sensor' ? sensorPriority(dc) : 0) };
    const cur = byMarker.get(id);
    if (!cur) {
      byMarker.set(id, {
        id,
        areaId,
        deviceId: e.device_id || null,
        name: (dev && (dev.name_by_user || dev.name)) || st.attributes.friendly_name || eid,
        entities: [cand],
      });
    } else {
      cur.entities.push(cand);
    }
  }

  const markers = [];
  for (const m of byMarker.values()) {
    m.entities.sort((a, b) => a.prio - b.prio);
    const p = m.entities[0];
    m.entityId = p.eid;
    m.domain = p.domain;
    m.deviceClass = p.dc;
    // a secondary reading (e.g. temperature next to a switch) for value display
    const sec = m.entities.find((x) => x.domain === 'sensor' && x.eid !== p.eid);
    m.secondaryId = sec ? sec.eid : null;
    if (m.entities.length === 1 && m.id.startsWith('entity:')) {
      m.name = hass.states[p.eid].attributes.friendly_name || m.name;
    }
    markers.push(m);
  }
  return markers;
}

export function areaName(hass, areaId) {
  const a = hass.areas && hass.areas[areaId];
  return a ? a.name : areaId;
}

export function floorsFromHA(hass) {
  const f = hass.floors || {};
  return Object.values(f)
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
    .map((x) => ({ id: x.floor_id, name: x.name, level: x.level ?? 0 }));
}

const ICONS = {
  light: 'mdi:lightbulb', switch: 'mdi:toggle-switch-variant', fan: 'mdi:fan', cover: 'mdi:window-shutter',
  climate: 'mdi:thermostat', lock: 'mdi:lock', camera: 'mdi:cctv', media_player: 'mdi:speaker',
  vacuum: 'mdi:robot-vacuum', lawn_mower: 'mdi:robot-mower', water_heater: 'mdi:water-boiler',
  humidifier: 'mdi:air-humidifier', valve: 'mdi:valve', alarm_control_panel: 'mdi:shield-home',
  input_boolean: 'mdi:toggle-switch-variant',
};
const DC_ICONS = {
  temperature: 'mdi:thermometer', humidity: 'mdi:water-percent', carbon_dioxide: 'mdi:molecule-co2',
  illuminance: 'mdi:brightness-5', power: 'mdi:flash', energy: 'mdi:lightning-bolt', motion: 'mdi:motion-sensor',
  occupancy: 'mdi:account-eye', presence: 'mdi:account-eye', door: 'mdi:door', garage_door: 'mdi:garage',
  window: 'mdi:window-closed-variant', opening: 'mdi:door', smoke: 'mdi:smoke-detector', gas: 'mdi:gas-cylinder',
  moisture: 'mdi:water-alert', battery: 'mdi:battery', voltage: 'mdi:sine-wave', current: 'mdi:current-ac',
};

// binary_sensor icons by state (HA's): [on, off] per device class
const BINARY_ICONS = {
  door: ['mdi:door-open', 'mdi:door-closed'], garage_door: ['mdi:garage-open', 'mdi:garage'], window: ['mdi:window-open', 'mdi:window-closed'],
  opening: ['mdi:square-outline', 'mdi:square'], motion: ['mdi:motion-sensor', 'mdi:motion-sensor-off'], occupancy: ['mdi:home', 'mdi:home-outline'],
  presence: ['mdi:home', 'mdi:home-outline'], moisture: ['mdi:water', 'mdi:water-off'], smoke: ['mdi:smoke-detector-variant-alert', 'mdi:smoke-detector-variant'],
  gas: ['mdi:alert-circle', 'mdi:check-circle'], problem: ['mdi:alert-circle', 'mdi:check-circle'], safety: ['mdi:alert-circle', 'mdi:check-circle'],
  tamper: ['mdi:alert-circle', 'mdi:check-circle'], lock: ['mdi:lock-open', 'mdi:lock'], plug: ['mdi:power-plug', 'mdi:power-plug-off'],
  power: ['mdi:power-plug', 'mdi:power-plug-off'], connectivity: ['mdi:check-network-outline', 'mdi:close-network-outline'],
  battery: ['mdi:battery-outline', 'mdi:battery'], light: ['mdi:brightness-7', 'mdi:brightness-5'], vibration: ['mdi:vibrate', 'mdi:crop-portrait'],
};

export function iconFor(hass, eid) {
  const st = hass.states[eid];
  const e = hass.entities && hass.entities[eid];
  if (st && st.attributes.icon) return st.attributes.icon;
  if (e && e.icon) return e.icon;
  const d = eid.split('.')[0];
  const dc = st && st.attributes.device_class;
  if (d === 'binary_sensor' && st) {
    const pair = BINARY_ICONS[dc] || ['mdi:checkbox-marked-circle', 'mdi:radiobox-blank'];
    return st.state === 'on' ? pair[0] : pair[1];
  }
  return (dc && DC_ICONS[dc]) || ICONS[d] || 'mdi:checkbox-blank-circle-outline';
}

const ACTIVE = new Set(['on', 'open', 'opening', 'unlocked', 'playing', 'heat', 'cool', 'heat_cool', 'auto', 'cleaning', 'mowing', 'home']);
export function isActive(st) {
  return !!st && ACTIVE.has(st.state);
}

export function displayValue(hass, eid) {
  const st = hass.states[eid];
  if (!st) return '';
  const d = eid.split('.')[0];
  if (d === 'sensor') {
    const n = Number(st.state);
    const unit = st.attributes.unit_of_measurement || '';
    if (Number.isFinite(n)) return (Math.round(n * 10) / 10) + unit;
    return st.state;
  }
  if (d === 'climate') {
    const t = st.attributes.current_temperature;
    return t !== undefined && t !== null ? t + '°' : '';
  }
  return '';
}

export const TOGGLE_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock']);

// Marker look by role. control (tap toggles / acts): circle; sensor with a value: rounded square with the
// value; binary_sensor: rounded square (icon by state); alert classes: diamond, red / yellow while active;
// entity_picture (person, media_player, image, lawn_mower): circle with the picture; the rest: rounded
// square with a small "i" (tap opens more-info only).
const CONTROL_DOMAINS = new Set(['light', 'switch', 'input_boolean', 'fan', 'cover', 'lock', 'climate', 'media_player', 'valve', 'vacuum',
  'lawn_mower', 'humidifier', 'water_heater', 'siren', 'button', 'input_button', 'scene', 'script', 'alarm_control_panel', 'number', 'select', 'input_number', 'input_select']);
const PICTURE_DOMAINS = new Set(['person', 'media_player', 'image', 'lawn_mower']);
const ALERT_RED = new Set(['smoke', 'gas', 'safety', 'moisture', 'carbon_monoxide']);
const ALERT_YELLOW = new Set(['problem', 'tamper']);

export function markerLook(hass, m) {
  const st = hass.states[m.entityId];
  const out = { shape: 'square', kind: 'info', info: true, alert: null, picture: null, value: '' };
  if (!st) return out;
  const d = m.domain || m.entityId.split('.')[0];
  const a = st.attributes || {};
  const pic = PICTURE_DOMAINS.has(d) && typeof a.entity_picture === 'string' && a.entity_picture;
  if (pic) {
    const url = /^(data|blob):/.test(pic) || !hass.hassUrl ? pic : hass.hassUrl(pic);
    return { ...out, shape: 'circle', kind: 'picture', info: false, picture: url };
  }
  if (d === 'binary_sensor') {
    const dc = a.device_class;
    if (ALERT_RED.has(dc) || ALERT_YELLOW.has(dc)) {
      const on = st.state === 'on';
      return { ...out, shape: 'diamond', kind: 'alert', info: false, alert: on ? (ALERT_RED.has(dc) ? 'red' : 'yellow') : null };
    }
    return { ...out, kind: 'binary', info: false };
  }
  if (CONTROL_DOMAINS.has(d)) return { ...out, shape: 'circle', kind: 'control', info: false };
  if (d === 'sensor') {
    const bad = st.state === 'unavailable' || st.state === 'unknown' || st.state === '';
    const value = bad ? '' : displayValue(hass, m.entityId);
    if (value) return { ...out, kind: 'value', info: false, value };
  }
  return out;
}
