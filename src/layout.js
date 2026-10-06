// Pure layout helpers shared by the view and the editor: floors, room floors, walls, positions.
// Plan metres: x = east, y = north, z = height above the floor.

import { autoPlace, signedArea } from './placement.js';
import { floorsFromHA } from './registry.js';

export const DEFAULT_FLOOR_HEIGHT = 2.7;
export const LEVEL_SPACING = 3;

// HA floors (auto-synced, elevation = level * 3) overlaid with what the layout stores.
// Layout-only floors are kept. Never returns an empty list.
export function mergeFloors(hass, layout) {
  const stored = new Map();
  for (const f of layout.floors || []) stored.set(f.id, { ...stored.get(f.id), ...f }); // merge per id
  const out = floorsFromHA(hass).map((f) => {
    const s = stored.get(f.id) || {};
    stored.delete(f.id);
    return {
      id: f.id,
      name: f.name,
      elevation: s.elevation ?? f.level * LEVEL_SPACING,
      height: s.height ?? DEFAULT_FLOOR_HEIGHT,
    };
  });
  for (const s of stored.values()) {
    out.push({ id: s.id, name: s.name || s.id, elevation: s.elevation ?? 0, height: s.height ?? DEFAULT_FLOOR_HEIGHT });
  }
  if (!out.length) out.push({ id: 'ground', name: 'Ground floor', elevation: 0, height: DEFAULT_FLOOR_HEIGHT });
  return out.sort((a, b) => a.elevation - b.elevation);
}

// room.floor_id, else the area's floor, else the lowest floor.
export function roomFloorId(room, hass, floors) {
  if (room.floor_id && floors.some((f) => f.id === room.floor_id)) return room.floor_id;
  const area = hass.areas && hass.areas[room.area_id];
  if (area && area.floor_id && floors.some((f) => f.id === area.floor_id)) return area.floor_id;
  return floors[0].id;
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return { d: Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]), t };
}

const ptKey = (p) => Math.round(p[0] * 100) + ',' + Math.round(p[1] * 100);

// Wall segments for the indoor rooms of one floor. Edges shared by two rooms are emitted once
// and doors (points near an edge) cut a gap of doorWidth into it.
export function wallSegments(rooms, { doorWidth = 0.9, doorSnap = 0.3 } = {}) {
  const edges = new Map();
  const doors = [];
  for (const r of rooms) {
    if (r.outdoor || !r.polygon || r.polygon.length < 3) continue;
    for (const d of r.doors || []) doors.push(d);
    const poly = r.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
      const ka = ptKey(a), kb = ptKey(b);
      const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (!edges.has(key)) edges.set(key, [a, b]);
    }
  }
  // doors also apply to outdoor rooms (terrace door in an indoor wall)
  for (const r of rooms) if (r.outdoor) for (const d of r.doors || []) doors.push(d);

  const out = [];
  for (const [a, b] of edges.values()) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const gaps = [];
    for (const d of doors) {
      const { d: dist, t } = distToSegment(d, a, b);
      if (dist > doorSnap) continue;
      const half = doorWidth / 2 / len;
      gaps.push([Math.max(0, t - half), Math.min(1, t + half)]);
    }
    gaps.sort((g, h) => g[0] - h[0]);
    let start = 0;
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (const [g0, g1] of gaps) {
      if (g0 > start + 1e-6) out.push({ a: at(start), b: at(g0) });
      start = Math.max(start, g1);
    }
    if (start < 1 - 1e-6) out.push({ a: at(start), b: at(1) });
  }
  return out;
}

// Positions for all markers: pins win, otherwise auto placement inside the first room drawn
// for the marker's area. Returns Map id -> {x, y, z, floorId, auto}. Markers without a room
// and without a pin are left out (the editor lists them). attachAt(pin, floorId) resolves pins
// attached to a model object ({ x, y, z } or null = object not there: the stored position).
export function markerPositions(markers, layout, hass, floors, attachAt = null) {
  const out = new Map();
  const floorById = new Map(floors.map((f) => [f.id, f]));
  const roomByArea = new Map();
  for (const r of layout.rooms || []) if (r.area_id && !roomByArea.has(r.area_id)) roomByArea.set(r.area_id, r);

  const perRoom = new Map();
  for (const m of markers) {
    const pin = layout.pins && layout.pins[m.id];
    if (pin) {
      const floorId = floorById.has(pin.floor_id) ? pin.floor_id : floors[0].id;
      const at = pin.attach && attachAt ? attachAt(pin, floorId) : null;
      out.set(m.id, at ? { x: at.x, y: at.y, z: at.z, floorId, auto: false, attached: pin.attach }
        : { x: pin.x, y: pin.y, z: pin.z ?? 1.2, floorId, auto: false });
      continue;
    }
    const room = roomByArea.get(m.areaId);
    if (!room) continue;
    if (!perRoom.has(room)) perRoom.set(room, []);
    perRoom.get(room).push(m);
  }
  for (const [room, ms] of perRoom) {
    const floorId = roomFloorId(room, hass, floors);
    const placed = autoPlace(room, ms, floorById.get(floorId).height);
    for (const [id, p] of placed) out.set(id, { ...p, floorId });
  }
  return out;
}

// Light glow: colour from rgb_color (or a warm white), strength from brightness.
export function lightGlow(stateObj) {
  if (!stateObj || stateObj.state !== 'on') return null;
  const a = stateObj.attributes || {};
  const rgb = Array.isArray(a.rgb_color) && a.rgb_color.length === 3 ? a.rgb_color : [255, 196, 120];
  const b = Number.isFinite(a.brightness) ? a.brightness / 255 : 1;
  return { rgb, strength: 0.25 + 0.75 * Math.max(0, Math.min(1, b)) };
}

// Room label text: name plus size (bounding width × depth for rectangles, area otherwise).
// Room label mode: card YAML room_labels wins over the layout's (Edit -> Rooms); default name and size.
export function roomLabelMode(config, layout) {
  const v = (config && config.room_labels) || (layout && layout.room_labels) || 'size';
  return ['size', 'name', 'none'].includes(v) ? v : 'size';
}

export function roomLabel(name, polygon, mode = 'size') {
  if (mode === 'none') return '';
  if (mode === 'name' || !polygon || polygon.length < 3) return name || '';
  const axis = polygon.length === 4 && polygon.every((p, i) => {
    const q = polygon[(i + 1) % 4];
    return Math.abs(p[0] - q[0]) < 0.01 || Math.abs(p[1] - q[1]) < 0.01;
  });
  let rect = axis;
  if (!rect && polygon.length === 4) {
    // Check for rotated rectangle with right angles using normalized edge directions
    const edges = [];
    for (let i = 0; i < 4; i++) {
      const p = polygon[i], q = polygon[(i + 1) % 4];
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      edges.push([dx / len, dy / len]);
    }
    rect = edges.every((e, i) => {
      const next = edges[(i + 1) % 4];
      const dot = e[0] * next[0] + e[1] * next[1];
      return Math.abs(dot) < 0.01;
    });
  }
  let size;
  if (rect && polygon.length === 4) {
    // For rectangles, use edge lengths
    const e0 = Math.hypot(polygon[1][0] - polygon[0][0], polygon[1][1] - polygon[0][1]);
    const e1 = Math.hypot(polygon[2][0] - polygon[1][0], polygon[2][1] - polygon[1][1]);
    const one = (v) => (Math.round(v * 10) / 10).toFixed(1);
    size = `${one(e0)} × ${one(e1)} m`;
  } else {
    const one = (v) => (Math.round(v * 10) / 10).toFixed(1); // toFixed alone rounds 2.65 down to 2.6
    size = `${one(Math.abs(signedArea(polygon)))} m²`;
  }
  return name ? `${name} · ${size}` : size;
}
