// Pure logic for model objects: binding, chains, colour, budget, sun. No Three.js here.
const isOn = (s) => !!s && s.state === 'on';
const bad = (s) => !s || s.state === 'unavailable' || s.state === 'unknown';

const MOWER_TYPES = new Set(['mower', 'dock']);

// The lawn_mower entity behind the Mower tab entity: itself, else a lawn_mower of the same device, else as is.
export function mowerTabEntity(entity, entities = {}) {
  if (!entity) return null;
  if (entity.startsWith('lawn_mower.')) return entity;
  const reg = entities && entities[entity];
  if (reg && reg.device_id) {
    const sib = Object.keys(entities).find((e) => e.startsWith('lawn_mower.') && entities[e].device_id === reg.device_id);
    if (sib) return sib;
  }
  return entity;
}

// opts.mowerEntity: mower / dock objects without an explicit binding whose suggest.entity is missing
// (or not in HA) use it (auto, from: 'mower').
export function bindObjects(objects, layoutObjects = {}, states = {}, opts = {}) {
  const out = new Map();
  const me = opts.mowerEntity && states[opts.mowerEntity] ? opts.mowerEntity : null;
  for (const o of objects) {
    const saved = layoutObjects[o.id] || {};
    const hidden = !!saved.hidden;
    if (saved.entity !== undefined) {
      const entity = saved.entity || null;
      out.set(o.id, { entity: entity && states[entity] ? entity : null, auto: false, missing: !!entity && !states[entity], hidden });
      continue;
    }
    const s = (o.suggest || {}).entity;
    if (!(s && states[s]) && me && MOWER_TYPES.has(o.type)) {
      out.set(o.id, { entity: me, auto: true, missing: false, hidden, from: 'mower' });
      continue;
    }
    out.set(o.id, { entity: s && states[s] ? s : null, auto: true, missing: !!s && !states[s], hidden });
  }
  return out;
}

// Group controllers that exist in HA. A controller entity HA doesn't know (a typo, a removed
// entity, a literal "none") is ignored: the group behaves as if it had no controller.
export function effectiveGroups(groups = {}, states = {}) {
  const out = {};
  for (const [name, g] of Object.entries(groups || {})) {
    const e = g && typeof g.entity === 'string' ? g.entity : null;
    if (e && states[e]) out[name] = { ...g, entity: e };
  }
  return out;
}

/**
 * Chain object state through group controller. Callers gate on `lit`; `source` may be an off light.
 */
export function chainState(obj, binding, groups = {}, states = {}) {
  const ctrl = obj.group && groups[obj.group] && groups[obj.group].entity;
  const entities = [binding && binding.entity, ctrl].filter(Boolean);
  if (!entities.length) return { lit: false, unavailable: false, source: null, entities, reason: null };
  const sts = entities.map((e) => states[e]);
  const unavailable = sts.some(bad);
  const lit = !unavailable && sts.every(isOn);
  let reason = null;
  if (!lit && !unavailable && ctrl && !isOn(states[ctrl])) reason = `${ctrl} is off`;
  else if (!lit && !unavailable && binding && binding.entity && !isOn(states[binding.entity])) reason = null;
  const source = sts.find((s, i) => s && entities[i].startsWith('light.')) || null;
  return { lit, unavailable, source, entities, reason };
}

function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}

function kelvinToRgb(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))));
}

export function lightColor(s) {
  const a = (s && s.attributes) || {};
  if (Array.isArray(a.rgb_color)) return a.rgb_color.slice(0, 3);
  if (Array.isArray(a.hs_color)) return hsvToRgb(a.hs_color[0], a.hs_color[1] / 100, 1);
  if (a.color_temp_kelvin) return kelvinToRgb(a.color_temp_kelvin);
  return hsvToRgb(30, 0.5, 1); // warm white
}

export function lightLevel(s) {
  if (!isOn(s)) return 0;
  const b = s.attributes && s.attributes.brightness;
  return typeof b === 'number' ? Math.max(0, Math.min(1, b / 255)) : 1;
}

// Groups up to this size light each lamp (one real light per fixture) while the pool has room.
// Group lights never take a shadow slot when a non-shadow one is free (`grouped` in the result).
export const SMALL_GROUP = 6;
export function lightBudget(fixtures, { points = 8, spots = 4, shadows = 4 } = {}) {
  const cand = [];
  const groups = new Map();
  for (const f of fixtures) {
    if (!f.lit || !f.visible) continue;
    if (f.group) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); } else cand.push({ f, factor: 1 });
  }
  const small = [];
  const middle = (list) => {
    const sorted = list.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return sorted[Math.floor((sorted.length - 1) / 2)];
  };
  // every group competes with its middle fixture (factor 1.5); small groups may be expanded below
  for (const list of groups.values()) {
    const c = { f: middle(list), factor: 1.5, grouped: true };
    if (list.length <= SMALL_GROUP) small.push({ list, mid: c.f, max: Math.max(...list.map((f) => f.max || 0)) });
    cand.push(c);
  }
  const byMax = (a, b) => (b.max || 0) - (a.max || 0) || (a.id < b.id ? -1 : 1);
  cand.sort((a, b) => byMax(a.f, b.f));
  const real = new Map(), shadowSet = new Set();
  let p = 0, s = 0, gp = 0; // gp: grouped point lights, which belong in the non-shadow point slots
  const groupCap = points - shadows;
  const kindOf = (f) => (f.beam === 'spot' ? 'spot' : 'point');
  const room = (kind) => (kind === 'spot' ? s < spots : p < points);
  const take = (kind) => { if (kind === 'spot') s++; else p++; };
  for (const c of cand) {
    const kind = kindOf(c.f);
    if (!room(kind)) continue;
    take(kind);
    if (c.grouped && kind === 'point') gp++;
    real.set(c.f.id, c.grouped ? { kind, factor: c.factor, grouped: true } : { kind, factor: c.factor });
    if (!c.grouped && kind === 'point' && c.f.castShadow !== false && shadowSet.size < shadows) shadowSet.add(c.f.id);
  }
  // spare slots: small groups whose middle got a light, strongest first, get one light per lamp (factor 1)
  // when every other lamp fits — group lamps only in non-shadow point slots or spot slots, never partial
  small.sort((a, b) => b.max - a.max || (a.mid.id < b.mid.id ? -1 : 1));
  for (const { list, mid } of small) {
    if (!real.has(mid.id) || list.length < 2) continue;
    const rest = list.filter((f) => f !== mid);
    const needP = rest.filter((f) => kindOf(f) === 'point').length, needS = rest.length - needP;
    if (p + needP > points || gp + needP > groupCap || s + needS > spots) continue;
    for (const f of rest) { const kind = kindOf(f); take(kind); real.set(f.id, { kind, factor: 1, grouped: true }); }
    gp += needP;
    real.get(mid.id).factor = 1;
  }
  return { real, shadows: shadowSet };
}

export function nightFactor(elevation) {
  if (!Number.isFinite(elevation)) return 0;
  const t = Math.max(0, Math.min(1, (6 - elevation) / 12));
  return t * t * (3 - 2 * t);
}

// Bearing clockwise from model north = HA azimuth + fp.north; plan (x east, y north) → world (x, ·, −y);
// then the model alignment rotation (degrees, counter-clockwise seen from above).
export function sunVector(azimuth, elevation, north = 0, alignRotation = 0) {
  const d = Math.PI / 180;
  const b = (azimuth + north) * d, e = elevation * d;
  let px = Math.sin(b) * Math.cos(e), py = Math.cos(b) * Math.cos(e);
  const r = alignRotation * d;
  [px, py] = [px * Math.cos(r) - py * Math.sin(r), px * Math.sin(r) + py * Math.cos(r)];
  return [px, Math.sin(e), -py];
}

// Sun strength factor 0..1: smoothstep(-2, +4 degrees) so the sun is off at / under the horizon.
// A missing elevation is day (1), like nightFactor (0).
export function sunStrength(elevation) {
  if (!Number.isFinite(elevation)) return 1;
  const t = Math.max(0, Math.min(1, (elevation + 2) / 6));
  return t * t * (3 - 2 * t);
}

// Never light from underneath: y >= minY, renormalised.
export function clampSunDir(v, minY = 0.05) {
  if (!v) return v;
  let [x, y, z] = v;
  if (y >= minY) return [x, y, z];
  const h = Math.hypot(x, z);
  if (h < 1e-9) return [0, 1, 0];
  const k = Math.sqrt(1 - minY * minY) / h;
  return [x * k, minY, z * k];
}

export function screenNearest(points, x, y, radius) {
  let best = null, bd = radius;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (best === null ? d <= radius : d < bd) { bd = d; best = p.id; }
  }
  return best;
}

// Ids of the points within radius px of (x, y), nearest first (ties keep their order).
export function screenByDistance(points, x, y, radius) {
  return points.map((p, i) => ({ id: p.id, i, d: Math.hypot(p.x - x, p.y - y) }))
    .filter((p) => p.d <= radius)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((p) => p.id);
}

// ---------- magnetic drag ----------
const vec = (v) => (Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : v);
export const SNAP_OFFSET = 0.05; // markers float 5 cm off the surface they stick to

// A model surface hit ({ point, normal } in card world) -> plan pin 5 cm off the surface along its normal.
export function snapPin(hit, floorElevation, floorId) {
  const p = vec(hit.point), n = vec(hit.normal);
  const wx = p.x + n.x * SNAP_OFFSET, wy = p.y + n.y * SNAP_OFFSET, wz = p.z + n.z * SNAP_OFFSET;
  return { x: wx, y: -wz, z: wy - (floorElevation || 0), floor_id: floorId };
}

// Offset (world metres, mm) of a plan position { x, y, z } on a floor at floorElevation from an anchor.
export function attachOffset(anchor, pos, floorElevation) {
  const a = vec(anchor), r = (v) => Math.round(v * 1000) / 1000 || 0;
  return [r(pos.x - a.x), r((floorElevation || 0) + pos.z - a.y), r(-pos.y - a.z)];
}

// Plan position { x, y, z } of an attached marker: anchor + offset, z above floorElevation.
export function attachedPosition(anchor, offset, floorElevation) {
  if (!anchor || !Array.isArray(offset) || offset.length !== 3 || !offset.every(Number.isFinite)) return null;
  const a = vec(anchor);
  return { x: a.x + offset[0], y: -(a.z + offset[2]), z: a.y + offset[1] - (floorElevation || 0) };
}

// The floor a model hit at world height y stands on: the highest floor with elevation <= y + tol, else null.
export function floorAtHeight(floors, y, tol = 0.05) {
  let best = null;
  for (const f of floors || []) if (f.elevation <= y + tol && (!best || f.elevation > best.elevation)) best = f;
  return best ? best.id : null;
}
