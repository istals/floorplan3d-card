// Plan drawing shown while the model loads: room outlines (plan metres, x east / y north) remembered per
// layout key, fitted into an SVG viewBox. Pure helpers plus a guarded localStorage read / write.
export const OUTLINE_CAP = 20 * 1024;
export const outlineKey = (layoutKey) => `fp3d-outline:${layoutKey}`;

const round = (v, step) => Math.round(v / step) * step;
const fix = (v) => Number(v.toFixed(2)); // 0.05 steps without float noise

// Round to `step`, drop repeated points and points that lie (nearly) on the line between their neighbours.
// -> polygon (no closing duplicate) or null when fewer than 3 points remain
export function simplifyPolygon(poly, step = 0.05, tol = 0.02) {
  if (!Array.isArray(poly)) return null;
  let pts = [];
  for (const p of poly) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = [fix(round(p[0], step)), fix(round(p[1], step))];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const dist = len ? Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / len : 0;
      if (dist <= tol) { pts.splice(i, 1); i--; changed = true; }
    }
  }
  return pts.length >= 3 ? pts : null;
}

// The polygons of the level with the most rooms (one floor reads as a plan; stacked floors would overlap).
// rooms: [{ polygon, floor_id }] -> [polygon]
export function pickOutline(rooms) {
  const byFloor = new Map();
  for (const r of rooms || []) {
    const poly = simplifyPolygon(r && r.polygon);
    if (!poly) continue;
    const k = (r && r.floor_id) || '';
    if (!byFloor.has(k)) byFloor.set(k, []);
    byFloor.get(k).push(poly);
  }
  let best = [];
  for (const list of byFloor.values()) if (list.length > best.length) best = list;
  return best;
}

// Stored string, dropping the last rooms until it fits the cap. -> string | null
export function serializeOutline(polys, cap = OUTLINE_CAP) {
  const list = (polys || []).slice();
  while (list.length) {
    const s = JSON.stringify(list);
    if (s.length <= cap) return s;
    list.pop();
  }
  return null;
}

export function parseOutline(text) {
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) return null;
    const out = v.filter((p) => Array.isArray(p) && p.length >= 3 && p.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])));
    return out.length ? out : null;
  } catch (e) {
    return null;
  }
}

export function saveOutline(layoutKey, polys, storage) {
  try {
    const s = serializeOutline(polys);
    if (!s) return false;
    (storage || localStorage).setItem(outlineKey(layoutKey), s);
    return true;
  } catch (e) {
    return false; // private mode, quota
  }
}

export function loadOutline(layoutKey, storage) {
  try {
    return parseOutline((storage || localStorage).getItem(outlineKey(layoutKey)));
  } catch (e) {
    return null;
  }
}

// Used when nothing is known yet: roof, walls and a door. Plan metres.
export const HOUSE_OUTLINE = [
  [[0, 0], [10, 0], [10, 6], [5, 10], [0, 6]],
  [[4, 0], [4, 3], [6, 3], [6, 0]],
];

export const polygonLength = (poly) => {
  let n = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    n += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return n;
};

// Fit closed polygons into a box of `size` units (longest side), y flipped (north up). `pad` units around.
// -> { viewBox, d, length, w, h }
export function fitOutline(polys, size = 100, pad = 2) {
  const pts = polys.flat();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const k = size / span;
  const w = (maxX - minX) * k + pad * 2, h = (maxY - minY) * k + pad * 2;
  const r = (v) => Math.round(v * 100) / 100;
  const sp = (p) => [r(pad + (p[0] - minX) * k), r(pad + (maxY - p[1]) * k)];
  const scaled = polys.map((poly) => poly.map(sp));
  const d = scaled.map((poly) => `M${poly.map((p) => p.join(' ')).join('L')}Z`).join('');
  const length = scaled.reduce((n, poly) => n + polygonLength(poly), 0);
  return { viewBox: `0 0 ${r(w)} ${r(h)}`, d, length: r(length), w: r(w), h: r(h) };
}
