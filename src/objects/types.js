// Object types: how a model object looks for its HA state. prepare() once per model load,
// update() when the object's state changed. Real lights come from the layer's fixed pool.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { lightColor, lightLevel } from './logic.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const vec3 = (a) => (Array.isArray(a) && a.length === 3 && a.every(fin) ? a.slice() : null);

// Invalid hints fall back to defaults; a down beam is a point light, an up beam a spot aimed up (up: true).
export function hintDefaults(hints) {
  const h = hints && typeof hints === 'object' ? hints : {};
  return {
    beam: h.beam === 'spot' || h.beam === 'up' ? 'spot' : 'point',
    up: h.beam === 'up',
    max: fin(h.max) && h.max >= 0 ? h.max : 5,
    distance: fin(h.distance) && h.distance >= 0 ? h.distance : 0,
    decay: fin(h.decay) && h.decay >= 0 ? h.decay : 2,
    angle: fin(h.angle) ? Math.min(80, Math.max(5, h.angle)) : 24,
    penumbra: fin(h.penumbra) && h.penumbra >= 0 && h.penumbra <= 1 ? h.penumbra : 0.6,
    target: vec3(h.target),
    castShadow: typeof h.castShadow === 'boolean' ? h.castShadow : true,
    offset: vec3(h.offset),
  };
}

const nameOf = (n) => (n.userData && n.userData.name) || n.name || '';

// First node named `name` (userData.name or name) under node, resolved to a mesh (itself or its first mesh).
export function findGlow(node, name) {
  if (!node || !name) return null;
  const firstMesh = (n) => {
    if (n.isMesh) return n;
    for (const c of n.children || []) { const m = firstMesh(c); if (m) return m; }
    return null;
  };
  const find = (n) => {
    if (nameOf(n) === name || n.name === name) { const m = firstMesh(n); if (m) return m; }
    for (const c of n.children || []) { const m = find(c); if (m) return m; }
    return null;
  };
  return find(node);
}

const matsOf = (mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

// The anchor in the model root's frame: glow centre, else fp anchor (node frame), else node box centre; + hints.offset.
// Only the node's ancestors and subtree are brought up to date (not the whole model).
function anchorOf(obj, glow, root, offset) {
  if (obj.node) obj.node.updateWorldMatrix(true, true);
  else root.updateWorldMatrix(true, false);
  const p = new THREE.Vector3();
  const box = new THREE.Box3();
  if (glow && !box.setFromObject(glow).isEmpty()) box.getCenter(p);
  else if (Array.isArray(obj.anchor)) obj.node.localToWorld(p.set(obj.anchor[0], obj.anchor[1], obj.anchor[2] || 0));
  else if (!box.setFromObject(obj.node).isEmpty()) box.getCenter(p);
  else obj.node.getWorldPosition(p);
  root.worldToLocal(p);
  if (offset) p.add(new THREE.Vector3(...offset));
  return p;
}

// A glow mesh can belong to several objects (e.g. two fixtures resolving to one mesh): its material is
// cloned once; every owner writes its level and the mesh shows the strongest owner.
const shared = new WeakMap(); // mesh -> { original, clones: Material[], owners: Set<part> }

// Claim a glow mesh for a part: clones its material once, shared between owners.
function claimGlow(part, glow) {
  if (!glow) return;
  let entry = shared.get(glow);
  if (!entry) {
    const original = glow.material;
    const clones = matsOf(glow).map((m) => {
      const c = m.clone();
      c.userData = { ...m.userData, baseEmissive: m.emissive ? m.emissive.getHex() : 0 };
      if (c.emissive) c.emissive.setRGB(0, 0, 0);
      c.emissiveIntensity = 0;
      return c;
    });
    glow.material = Array.isArray(original) ? clones : clones[0];
    entry = { original, clones, owners: new Set() };
    shared.set(glow, entry);
  }
  entry.owners.add(part);
}

function prepareLight(obj, { root }, pool) {
  const hints = hintDefaults(obj.hints);
  const glow = obj.node ? findGlow(obj.node, obj.glow || 'glow') : null;
  const part = { obj, glow, hints, pool, level: 0, color: null, anchor: null };
  claimGlow(part, glow);
  part.anchor = obj.node ? anchorOf(obj, glow, root, hints.offset) : new THREE.Vector3();
  return part;
}

function paint(glow) {
  const entry = glow && shared.get(glow);
  if (!entry) return;
  let best = null;
  for (const p of entry.owners) if (!best || p.level > best.level) best = p;
  const level = best ? best.level : 0, c = (best && best.color) || [0, 0, 0];
  for (const m of entry.clones) {
    if (m.emissive) m.emissive.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
    m.emissiveIntensity = level * 3;
  }
}

function updateLight(part, chain) {
  const level = chain.lit ? lightLevel(chain.source || { state: 'on', attributes: {} }) : 0;
  const color = lightColor(chain.source);
  part.level = level;
  part.color = color;
  paint(part.glow);
  return { lit: level > 0, level, color };
}

function disposeLight(part) {
  const entry = part.glow && shared.get(part.glow);
  if (!entry || !entry.owners.delete(part)) return;
  if (entry.owners.size) { paint(part.glow); return; }
  part.glow.material = entry.original;
  for (const m of entry.clones) m.dispose();
  shared.delete(part.glow);
}


// ---- status looks: mower / dock / ev_charger / climate ----
const MOWER_COLORS = { mowing: [76, 175, 80], returning: [255, 179, 0], error: [244, 67, 54] };
const CHARGER_COLORS = { charging: [76, 175, 80], ready: [33, 150, 243], available: [33, 150, 243], error: [244, 67, 54], faulted: [244, 67, 54] };
const CLIMATE_COLORS = { heating: [255, 120, 60], cooling: [80, 160, 255] };

// Status colour [r,g,b] or null (dim). For dock the value is the mower state; for climate the hvac_action.
export function statusColor(type, state) {
  const s = typeof state === 'string' ? state : '';
  const tables = { mower: MOWER_COLORS, ev_charger: CHARGER_COLORS, climate: CLIMATE_COLORS };
  if (type === 'dock') return s === 'docked' ? MOWER_COLORS.mowing.slice() : null;
  const t = tables[type];
  return t && Object.prototype.hasOwnProperty.call(t, s) ? t[s].slice() : null;
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const fmt = (v) => String(Math.round(v * 10) / 10);

// The separate power sensors a charger label may read (sensor.<name>_power / _charging_power).
export function chargerInputs(entity) {
  const base = typeof entity === 'string' ? entity.replace(/^[^.]*\./, '') : '';
  return base ? [`sensor.${base}_power`, `sensor.${base}_charging_power`] : [];
}

// Text shown beside an object (CSS2D label) or null: charger power while charging, climate current temperature.
export function objectLabel(type, states, entity) {
  const s = entity && states ? states[entity] : null;
  if (!s) return null;
  const a = s.attributes || {};
  if (type === 'climate') {
    const t = num(a.current_temperature);
    return Number.isFinite(t) ? `${fmt(t)} ${a.temperature_unit || '\u00b0C'}` : null;
  }
  if (type === 'ev_charger') {
    if (s.state !== 'charging') return null;
    const unit = a.power_unit || a.unit_of_measurement || 'kW';
    for (const k of Object.keys(a)) {
      if (!/power/i.test(k) || /unit/i.test(k)) continue;
      const v = num(a[k]);
      if (Number.isFinite(v)) return `${fmt(v)} ${unit}`;
    }
    for (const e of [entity, ...chargerInputs(entity)]) {
      const p = states[e];
      const v = p ? num(p.state) : NaN;
      if (Number.isFinite(v) && p.attributes && p.attributes.unit_of_measurement) return `${fmt(v)} ${p.attributes.unit_of_measurement}`;
    }
  }
  return null;
}

const stateOf = (ctx, entity) => {
  const s = entity && ctx && ctx.states ? ctx.states[entity] : null;
  return s ? s.state : null;
};
const ledName = (obj) => (obj.hints && obj.hints.led) || obj.glow || 'led';

function prepareStatus(obj, ctx, glowName, withLabel) {
  const glow = obj.node ? findGlow(obj.node, glowName) : null;
  const part = { obj, glow, hints: hintDefaults(obj.hints), pool: false, level: 0, color: null, anchor: null, root: ctx.root, view: ctx.view, levels: ctx.levels || [], label: null, text: null };
  claimGlow(part, glow);
  part.anchor = obj.node ? anchorOf(obj, glow, ctx.root, part.hints.offset) : new THREE.Vector3();
  if (withLabel && ctx.view && typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.className = 'fp-room-label fp-obj-label';
    const label = new CSS2DObject(el);
    label.center.set(0.5, 1.2);
    label.visible = false;
    ctx.view.objectsGroup.add(label);
    part.label = label;
    relayout(part);
  }
  return part;
}

function updateStatus(part, color) {
  part.color = color;
  part.level = color ? 1 : 0;
  paint(part.glow);
  return { lit: false, level: part.level, color };
}

function setLabel(part, text) {
  const next = text || null;
  if (next === part.text) return; // no DOM writes when nothing changed
  part.text = next;
  if (part.label) {
    part.label.element.textContent = part.text || '';
    part.label.visible = !!part.text;
  }
}

// The model moved: labels follow their anchor.
function relayout(part) {
  if (part.label && part.root) part.label.position.copy(part.root.localToWorld(part.anchor.clone()));
}

function disposeStatus(part) {
  disposeLight(part);
  if (part.label) {
    const el = part.label.element;
    if (part.label.parent) part.label.parent.remove(part.label);
    if (el && el.parentNode) el.parentNode.removeChild(el); // removing the object leaves its element behind
    part.label = null;
  }
}

// hints.front: which local axis of the node is its front; the yaw offset that turns it to the heading.
const FRONT_YAW = { '+x': 0, '-x': Math.PI, '+z': Math.PI / 2, '-z': -Math.PI / 2 };
const frontOf = (obj) => (obj.hints && Object.prototype.hasOwnProperty.call(FRONT_YAW, obj.hints.front) ? obj.hints.front : '+x');

// Mower node: world position from the plan point (x, base + own y offset, -y), turned to its heading. base: the
// ground under it (pose.ground, world y of the lawn) when known, else the HA floor's elevation.
// The node's own transform is remembered and restored on dispose / pose null.
function placeMower(part, pose) {
  const node = part.obj.node;
  if (!node || !node.parent) return;
  if (!part.origin) {
    node.updateWorldMatrix(true, false);
    const lv = part.levels.find((l) => l.id === part.obj.level);
    const base = lv && Number.isFinite(lv.elevation) ? lv.elevation : 0; // elevation of the floor the node stands on
    part.origin = { position: node.position.clone(), quaternion: node.quaternion.clone(), localY: node.getWorldPosition(new THREE.Vector3()).y - base };
  }
  if (!pose) { restoreMower(part); return; }
  const parent = node.parent;
  parent.updateWorldMatrix(true, false);
  const base = Number.isFinite(pose.ground) ? pose.ground : part.view ? part.view.floorElevation(pose.floorId) : 0;
  const world = new THREE.Vector3(pose.x, base + part.origin.localY, -pose.y);
  node.position.copy(parent.worldToLocal(world));
  if (Number.isFinite(pose.heading)) {
    // heading is an absolute plan angle: the node's own forward (+x of the model) turns to it, whatever the model alignment
    const pq = parent.getWorldQuaternion(new THREE.Quaternion());
    const rq = part.root.getWorldQuaternion(new THREE.Quaternion());
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.heading + FRONT_YAW[frontOf(part.obj)]);
    node.quaternion.copy(pq.clone().invert().multiply(yaw).multiply(rq.invert()).multiply(pq).multiply(part.origin.quaternion));
  }
  node.updateMatrixWorld(true);
  part.anchor = anchorOf(part.obj, part.glow, part.root, part.hints.offset);
}

function restoreMower(part) {
  const node = part.obj.node;
  if (!part.origin || !node) return;
  node.position.copy(part.origin.position);
  node.quaternion.copy(part.origin.quaternion);
  node.updateMatrixWorld(true);
  part.origin = null;
  part.anchor = anchorOf(part.obj, part.glow, part.root, part.hints.offset);
}

function disposeMower(part) {
  restoreMower(part);
  disposeStatus(part);
}

const generic = {
  prepare: (obj, ctx) => ({ obj, glow: null, hints: hintDefaults(obj.hints), pool: false, anchor: obj.node ? anchorOf(obj, null, ctx.root, null) : new THREE.Vector3() }),
  update: () => ({ lit: false, level: 0, color: null }),
  dispose: () => {},
  defaults: { tap_action: { action: 'more-info' }, hold_action: { action: 'popup' }, popup: ['state'] },
};

export const TYPES = {
  light: {
    prepare: (obj, ctx) => prepareLight(obj, ctx, true),
    update: updateLight, dispose: disposeLight,
    defaults: { tap_action: { action: 'toggle' }, hold_action: { action: 'popup' }, popup: ['toggle', 'brightness', 'color'] },
  },
  light_strip: {
    // real light only when the model asks for one (hints.max)
    prepare: (obj, ctx) => prepareLight(obj, ctx, !!obj.hints && fin(obj.hints.max) && obj.hints.max > 0),
    update: updateLight, dispose: disposeLight,
    defaults: { tap_action: { action: 'toggle' }, hold_action: { action: 'popup' }, popup: ['toggle', 'brightness', 'color'] },
  },
  mower: {
    prepare: (obj, ctx) => prepareStatus(obj, ctx, obj.glow || 'glow', false),
    update: (part, chain, ctx) => updateStatus(part, statusColor('mower', stateOf(ctx, ctx.entity))),
    place: placeMower, dispose: disposeMower,
    defaults: { tap_action: { action: 'popup' }, hold_action: { action: 'more-info' }, popup: ['state', 'battery', 'start', 'dock'] },
  },
  dock: {
    prepare: (obj, ctx) => prepareStatus(obj, ctx, ledName(obj), false),
    update: (part, chain, ctx) => updateStatus(part, statusColor('dock', stateOf(ctx, ctx.mowerEntity))),
    dispose: disposeStatus,
    defaults: { tap_action: { action: 'more-info' }, hold_action: { action: 'more-info' }, popup: ['state'] },
  },
  ev_charger: {
    prepare: (obj, ctx) => prepareStatus(obj, ctx, ledName(obj), true),
    update: (part, chain, ctx) => {
      const st = stateOf(ctx, ctx.entity);
      setLabel(part, objectLabel('ev_charger', ctx.states, ctx.entity));
      return updateStatus(part, statusColor('ev_charger', st));
    },
    inputs: chargerInputs, // the layer re-evaluates when the power sensor changes
    relayout, dispose: disposeStatus,
    defaults: { tap_action: { action: 'more-info' }, hold_action: { action: 'popup' }, popup: ['state', 'power', 'energy'] },
  },
  climate: {
    prepare: (obj, ctx) => prepareStatus(obj, ctx, obj.glow || 'glow', true),
    update: (part, chain, ctx) => {
      const s = ctx.entity && ctx.states ? ctx.states[ctx.entity] : null;
      setLabel(part, objectLabel('climate', ctx.states, ctx.entity));
      return updateStatus(part, statusColor('climate', s && s.attributes ? s.attributes.hvac_action : null));
    },
    relayout, dispose: disposeStatus,
    defaults: { tap_action: { action: 'more-info' }, hold_action: { action: 'popup' }, popup: ['temperature', 'mode'] },
  },
  generic,
};

export const typeOf = (type) => (Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : TYPES.generic);
