// Pure edit operations on the layout. Every function returns new objects (the card compares
// layout identity to decide what to rebuild) and never mutates its input.

import { snap } from './placement.js';
import { normalise } from './storage.js';
import { transformPoint, inverseTransformPoint } from './bindings.js';

export const GRID = 0.05;
export const SNAP_RADIUS = 0.25;

const round = (v) => Math.round(v * 1000) / 1000;

// Snap a plan point: to an existing vertex within radius, else align x / y with a nearby
// vertex (straight walls), else to the grid.
export function snapPoint(p, { vertices = [], radius = SNAP_RADIUS, grid = GRID } = {}) {
  let best = null, bestD = radius;
  for (const v of vertices) {
    const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
    if (d <= bestD) { best = v; bestD = d; }
  }
  if (best) return { point: [best[0], best[1]], kind: 'vertex' };
  let x = round(snap(p[0], grid)), y = round(snap(p[1], grid));
  let ax = radius, ay = radius, aligned = false;
  for (const v of vertices) {
    const dx = Math.abs(v[0] - p[0]), dy = Math.abs(v[1] - p[1]);
    if (dx < ax) { ax = dx; x = v[0]; aligned = true; }
    if (dy < ay) { ay = dy; y = v[1]; aligned = true; }
  }
  return { point: [x, y], kind: aligned ? 'align' : 'grid' };
}

// All room vertices on one floor, for snapping. `skip` = {roomId, index} to leave out.
export function floorVertices(rooms, floorIdOf, floorId, skip) {
  const out = [];
  for (const r of rooms) {
    if (floorIdOf(r) !== floorId || !r.polygon) continue;
    r.polygon.forEach((v, i) => {
      if (!skip || skip.roomId !== r.id || skip.index !== i) out.push(v);
    });
  }
  return out;
}

export function nearestEdge(poly, p) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const q = [a[0] + dx * t, a[1] + dy * t];
    const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!best || dist < best.dist) best = { index: i, point: q, t, dist };
  }
  return best;
}

// ---------- rooms ----------
export function newRoomId(layout) {
  const ids = new Set((layout.rooms || []).map((r) => r.id));
  let n = 1;
  while (ids.has('r' + n)) n++;
  return 'r' + n;
}

export function upsertRoom(layout, room) {
  const rooms = layout.rooms || [];
  const i = rooms.findIndex((r) => r.id === room.id);
  return { ...layout, rooms: i === -1 ? [...rooms, room] : rooms.map((r, j) => (j === i ? room : r)) };
}

export function deleteRoom(layout, id) {
  return { ...layout, rooms: (layout.rooms || []).filter((r) => r.id !== id) };
}

export function moveVertex(room, i, p) {
  return { ...room, polygon: room.polygon.map((v, j) => (j === i ? [p[0], p[1]] : v)) };
}

export function insertVertex(room, edgeIndex, p) {
  const polygon = [...room.polygon];
  polygon.splice(edgeIndex + 1, 0, [p[0], p[1]]);
  return { ...room, polygon };
}

export function removeVertex(room, i) {
  if (room.polygon.length <= 3) return room;
  return { ...room, polygon: room.polygon.filter((_, j) => j !== i) };
}

// Door on the nearest edge, if the click is within maxDist of it.
export function addDoor(room, p, maxDist = 0.6) {
  const e = nearestEdge(room.polygon, p);
  if (!e || e.dist > maxDist) return room;
  const door = [round(snap(e.point[0], GRID)), round(snap(e.point[1], GRID))];
  // snapping can pull the door off a diagonal wall, keep the exact projection then
  const d = nearestEdge(room.polygon, door).dist < 0.02 ? door : e.point.map(round);
  return { ...room, doors: [...(room.doors || []), d] };
}

export function removeDoor(room, i) {
  return { ...room, doors: (room.doors || []).filter((_, j) => j !== i) };
}

// Drop consecutive duplicates and a closing point equal to the first.
export function cleanPolygon(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) out.push([p[0], p[1]]);
  }
  if (out.length > 1) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) out.pop();
  }
  return out;
}

// ---------- devices ----------
// grid: false keeps the exact position (mm), e.g. a marker stuck to a model surface.
export function setPin(layout, id, pin, { grid = true } = {}) {
  const g = (v) => round(grid ? snap(v, GRID) : v);
  const p = { x: g(pin.x), y: g(pin.y), z: round(pin.z), floor_id: pin.floor_id };
  if (pin.on_model) p.on_model = true; // placed on the model: follows its alignment (realignPins)
  return { ...layout, pins: { ...(layout.pins || {}), [id]: p } };
}

// Attach a marker to a model object: it follows the object's anchor + offset (world metres).
// `at` (plan position at drop time) is kept as the fallback while the object is not there.
export function attachPin(layout, id, objectId, offset, at) {
  const prev = (layout.pins || {})[id] || {};
  const src = at || prev;
  const p = { x: round(src.x ?? 0), y: round(src.y ?? 0), z: round(src.z ?? 1.2), floor_id: src.floor_id ?? prev.floor_id,
    on_model: true, attach: objectId, offset: offset.map((v) => round(v)) };
  return { ...layout, pins: { ...(layout.pins || {}), [id]: p } };
}

// The model was moved / rotated / scaled from oldAlign to newAlign: pins placed on the model
// keep their spot on it (p' = T_new(T_old^-1(p)), height scales with the model). Other pins stay.
export function realignPins(layout, oldAlign, newAlign) {
  const pins = layout.pins || {};
  const os = (oldAlign && oldAlign.scale) || 1, ns = (newAlign && newAlign.scale) || 1;
  let changed = false;
  const out = {};
  for (const [id, p] of Object.entries(pins)) {
    // attached pins follow their object; only their fallback position (object missing) is realigned
    if (!p || !p.on_model) { out[id] = p; continue; }
    const [x, y] = transformPoint(inverseTransformPoint([p.x, p.y], oldAlign), newAlign);
    const z = p.z * (ns / os);
    // micrometre precision: slider ticks realign step by step, mm rounding would accumulate drift
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const q = { ...p, x: r6(x), y: r6(y), z: r6(z) };
    if (q.x !== p.x || q.y !== p.y || q.z !== p.z) changed = true;
    out[id] = q;
  }
  return changed ? { ...layout, pins: out } : layout;
}

export function clearPin(layout, id) {
  const pins = { ...(layout.pins || {}) };
  delete pins[id];
  return { ...layout, pins };
}

export function hide(layout, id) {
  const hidden = layout.hidden || [];
  return hidden.includes(id) ? layout : { ...layout, hidden: [...hidden, id] };
}

export function unhide(layout, id) {
  return { ...layout, hidden: (layout.hidden || []).filter((h) => h !== id) };
}

// ---------- floors ----------
// Stored floor entries are overrides for HA floors or standalone floors.
export function upsertFloor(layout, floor) {
  const floors = layout.floors || [];
  const i = floors.findIndex((f) => f.id === floor.id);
  const merged = i === -1 ? floor : { ...floors[i], ...floor };
  return { ...layout, floors: i === -1 ? [...floors, merged] : floors.map((f, j) => (j === i ? merged : f)) };
}

export function deleteFloor(layout, id) {
  return { ...layout, floors: (layout.floors || []).filter((f) => f.id !== id) };
}

export function newFloorId(layout, floors) {
  const ids = new Set([...(layout.floors || []), ...floors].map((f) => f.id));
  let n = 1;
  while (ids.has('floor_' + n)) n++;
  return 'floor_' + n;
}

// ---------- import ----------
const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Not valid JSON: ' + e.message, { cause: e });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a layout object');
  if (data.version !== undefined && data.version !== 1) throw new Error('Unsupported layout version ' + data.version);
  const l = normalise(data);
  l.rooms.forEach((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`Room ${i + 1} is not an object`);
    if (!Array.isArray(r.polygon) || r.polygon.length < 3 || !r.polygon.every(isPoint)) {
      throw new Error(`Room ${r.id || i + 1}: polygon needs at least 3 [x, y] points`);
    }
    if (r.doors !== undefined && (!Array.isArray(r.doors) || !r.doors.every(isPoint))) {
      throw new Error(`Room ${r.id || i + 1}: doors must be [x, y] points`);
    }
  });
  const ids = new Set();
  l.rooms = l.rooms.map((r) => {
    let id = r.id || 'r';
    while (ids.has(id)) id += '_';
    ids.add(id);
    return { ...r, id };
  });
  for (const f of l.floors) if (!f || !f.id) throw new Error('Every floor needs an id');
  return l;
}

// Fit an imported layout to this Home Assistant: floor ids HA doesn't have are mapped bottom-up
// onto unused HA floors (rooms, pins and floor overrides follow); floors left over stay as
// layout floors. haFloors: [{id, elevation}] from HA only.
// Returns { layout, floorMap: {imported: haId}, unknownAreas: [...] }.
export function fitImport(layout, haFloors, haAreaIds) {
  const ha = new Set(haFloors.map((f) => f.id));
  const imported = layout.floors || [];
  const used = new Set(imported.filter((f) => ha.has(f.id)).map((f) => f.id));
  for (const r of layout.rooms) if (ha.has(r.floor_id)) used.add(r.floor_id);
  const free = haFloors.filter((f) => !used.has(f.id)).sort((a, b) => a.elevation - b.elevation);
  const foreign = imported.filter((f) => !ha.has(f.id)).sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  const floorMap = {};
  foreign.forEach((f, i) => { if (free[i]) floorMap[f.id] = free[i].id; });
  const mapId = (id) => floorMap[id] || id;
  const floors = imported.map((f) => (floorMap[f.id] ? { ...f, id: floorMap[f.id], name: undefined } : f))
    .map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)));
  const rooms = layout.rooms.map((r) => (r.floor_id && floorMap[r.floor_id] ? { ...r, floor_id: mapId(r.floor_id) } : r));
  const pins = Object.fromEntries(Object.entries(layout.pins || {}).map(([k, p]) => [k, p.floor_id && floorMap[p.floor_id] ? { ...p, floor_id: mapId(p.floor_id) } : p]));
  const areas = new Set(haAreaIds);
  const unknownAreas = [...new Set(layout.rooms.map((r) => r.area_id).filter((a) => a && !areas.has(a)))];
  const out = { ...layout, floors, rooms, pins };
  // views link HA floors too
  if (layout.views && typeof layout.views === 'object') {
    out.views = Object.fromEntries(Object.entries(layout.views).map(([id, v]) => [id,
      v && Array.isArray(v.floors) && v.floors.some((f) => floorMap[f]) ? { ...v, floors: v.floors.map(mapId) } : v]));
  }
  return { layout: out, floorMap, unknownAreas };
}

const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Parts a plan export may leave out are kept from the current layout: the uploaded model, the
// mower setup, the view settings (rules, cameras, sections, order), the model object bindings and
// group controllers (they belong to the kept model). raw: the parsed file as is.
export function mergeImport(imported, raw, current) {
  const l = { ...imported };
  const cur = current || {};
  for (const k of ['objects', 'groups']) {
    if (plainObject(raw[k])) continue;
    if (plainObject(cur[k])) l[k] = cur[k];
    else delete l[k];
  }
  if (!('model' in raw)) l.model = cur.model || null;
  if (!('mower' in raw) || raw.mower === null) l.mower = cur.mower || null;
  if (!('views' in raw)) l.views = cur.views;
  if (!('view_order' in raw)) l.view_order = cur.view_order;
  for (const k of ['views', 'view_order']) if (l[k] === undefined) delete l[k];
  return l;
}

// v0.2.x pins (no on_model) on floors bound to a model level start following the model, once:
// on the first alignment change (layout.model.pins_migrated). boundFloors: HA floor ids.
export function migrateLegacyPins(layout, boundFloors) {
  const m = layout.model || {};
  if (m.pins_migrated) return layout;
  const bound = new Set(boundFloors || []);
  const pins = Object.fromEntries(Object.entries(layout.pins || {}).map(([id, p]) => [id,
    p && !p.on_model && bound.has(p.floor_id) ? { ...p, on_model: true } : p]));
  return { ...layout, pins, model: { ...m, pins_migrated: true } };
}

// layout.objects[id] = { entity?, hidden? }: merge a patch. `entity: undefined` removes the key
// (back to automatic binding); `hidden: false` drops the flag. An entry with nothing left is removed.
export function setObject(layout, id, patch) {
  const cur = { ...((layout.objects || {})[id] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || (k === 'hidden' && !v)) delete cur[k];
    else cur[k] = v;
  }
  const objects = { ...(layout.objects || {}) };
  if (Object.keys(cur).length) objects[id] = cur;
  else delete objects[id];
  return { ...layout, objects };
}

// layout.objects[id].ui[<which>_action] (which: tap | hold | double_tap): set, or null removes it
// (back to the model / type default). An empty ui is dropped, an empty entry too.
export function setObjectUi(layout, id, which, action) {
  const cur = ((layout.objects || {})[id] || {}).ui || {};
  const ui = { ...cur };
  if (action) ui[`${which}_action`] = action;
  else delete ui[`${which}_action`];
  return setObject(layout, id, { ui: Object.keys(ui).length ? ui : undefined });
}

// layout.groups[name] = { entity }: the optional controller of a fixture group. No entity (empty or
// "none"): no entry.
export function setGroup(layout, name, patch) {
  const cur = { ...((layout.groups || {})[name] || {}), ...patch };
  if (typeof cur.entity === 'string') cur.entity = cur.entity.trim();
  if (!cur.entity || typeof cur.entity !== 'string' || cur.entity.toLowerCase() === 'none') delete cur.entity;
  const groups = { ...(layout.groups || {}) };
  if (Object.keys(cur).length) groups[name] = cur;
  else delete groups[name];
  return { ...layout, groups };
}
