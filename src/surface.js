// Devices on model surfaces: which surface a device type sticks to, which model hit to use and
// where the marker goes (5 cm off the surface). Pure: hits come from the view's surfaceRays().
// World = card world: (x, elevation + z, -y) of plan metres.

import { ruleFor, pointInPolygon } from './placement.js';

export const SURFACE_OFFSET = 0.05; // markers float 5 cm off the surface
export const WALL_RANGE = 2.5; // horizontal search for a wall (m)
export const CEILING_RANGE = 4; // up
export const FLOOR_RANGE = 3; // down
export const STICK_DISTANCE = 0.15; // "Stick all": pins farther than this from any surface move
const WALL_NY = 0.3; // |n.y| below: a wall
const FLAT_NY = 0.7; // |n.y| above: a ceiling / floor

export const HORIZONTAL_DIRS = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  const r = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  return [r(Math.cos(a)), 0, r(Math.sin(a))];
});
const UP = [[0, 1, 0]];
const DOWN = [[0, -1, 0]];

// The surface a device type sticks to (placement.js rules): wall / corner / door anchors -> 'wall',
// the ceiling grid -> 'ceiling', floor-standing centre devices (vacuum, mower) -> 'floor'.
export function surfaceKind(domain, deviceClass) {
  const r = ruleFor(domain, deviceClass);
  if (r.anchor !== 'center') return 'wall';
  if (r.z === 'ceiling') return 'ceiling';
  return Number.isFinite(r.z) && r.z < 0.5 ? 'floor' : null;
}

// The rays to cast for a kind ('all' = every direction, for the distance to any surface).
export function rayGroups(kind) {
  const wall = { dirs: HORIZONTAL_DIRS, max: WALL_RANGE };
  const up = { dirs: UP, max: CEILING_RANGE };
  const down = { dirs: DOWN, max: FLOOR_RANGE };
  if (kind === 'wall') return [wall];
  if (kind === 'ceiling') return [up];
  if (kind === 'floor') return [down];
  if (kind === 'all' || kind === 'any') return [wall, up, down];
  return [];
}

const arr = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);

// hits: [{ point, normal, distance, dir }] (arrays or {x,y,z}). Returns the hit to stick to
// ({ point: 5 cm off the surface, normal facing the ray origin, distance }) or null (keep the point).
// kind 'any' takes the nearest hit of any orientation. opts.accept(point) can reject candidates.
export function chooseSurface(kind, hits, { accept = null } = {}) {
  if (!kind || !Array.isArray(hits)) return null;
  let best = null;
  for (const hit of hits) {
    if (!hit || !Number.isFinite(hit.distance)) continue;
    const p = arr(hit.point), d = arr(hit.dir);
    let n = arr(hit.normal);
    if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0) n = n.map((v) => -v || 0); // the side the ray came from
    let ok;
    if (kind === 'wall') ok = Math.abs(n[1]) < WALL_NY && Math.abs(d[1]) < 1e-6 && hit.distance <= WALL_RANGE;
    else if (kind === 'ceiling') ok = n[1] < -FLAT_NY && d[1] > 0 && hit.distance <= CEILING_RANGE;
    else if (kind === 'floor') ok = n[1] > FLAT_NY && d[1] < 0 && hit.distance <= FLOOR_RANGE;
    else ok = kind === 'any';
    if (!ok || (best && best.distance <= hit.distance)) continue;
    const point = p.map((v, i) => v + n[i] * SURFACE_OFFSET);
    if (accept && !accept(point)) continue;
    best = { point, normal: n, distance: hit.distance };
  }
  return best;
}

export function nearestDistance(hits) {
  let d = Infinity;
  for (const h of hits || []) if (h && Number.isFinite(h.distance) && h.distance < d) d = h.distance;
  return d;
}

// "Stick all to surfaces": a free (not attached) pin with a surface nearby, but not on it.
export function needsStick(pin, nearest, threshold = STICK_DISTANCE) {
  return !!pin && !pin.attach && Number.isFinite(nearest) && nearest > threshold;
}

// Where "Stick all" moves a pin: the surface its type sticks to when that is at most twice as far
// as the nearest surface, else the nearest one (a floor lamp pinned in a corner goes to the wall,
// not up to the ceiling). hits: every ray (rayGroups('all')).
export function stickSurface(kind, hits) {
  const near = chooseSurface('any', hits);
  const typed = kind && chooseSurface(kind, hits);
  return typed && near && typed.distance <= 2 * near.distance ? typed : near;
}

export function worldOf(p, elevation = 0) {
  return [p.x, elevation + p.z, -p.y || 0];
}

export function planOf(w, elevation = 0) {
  const r = (v) => Math.round(v * 1e9) / 1e9 || 0;
  return { x: r(w[0]), y: r(-w[2]), z: r(w[1] - elevation) };
}

// Inside the polygon or within margin of one of its edges (no polygon: anywhere).
export function nearPolygon(pt, poly, margin) {
  if (!poly || poly.length < 3) return true;
  if (pointInPolygon(pt, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2)) : 0;
    if (Math.hypot(a[0] + dx * t - pt[0], a[1] + dy * t - pt[1]) <= margin) return true;
  }
  return false;
}

// Cache key of one computed point (mm): a changed room, height or floor computes it again.
export function surfaceKey(kind, floorId, p) {
  const mm = (v) => Math.round(v * 1000);
  return `${kind}|${floorId}|${mm(p.x)},${mm(p.y)},${mm(p.z)}`;
}
