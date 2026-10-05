// Pure render decisions for the model view (shadows, depth range, ghosting, picking, occlusion, sun).
// Kept free of three.js objects so they can be unit tested.

// glass / glazing / pane(s) as a word (underscores, digits and spaces separate words), or "window"
// unless it is a window frame or sill. Panel, fiberglass and the like don't count.
export const GLASS_RE = /(?<![a-z])(glass|glazing|panes?)(?![a-z])|window(?![_ ]?(frame|sill))/i;
export const OVERLAY_RE = /decal|edging|overlay/i;
const NO_CAST_LAYERS = ['terrain', 'floor', 'decal', 'label'];
const FLAT_M = 0.02; // thinner than this in y and wider than 5x that: a flat sheet
const ON_FLOOR_M = 0.05; // a flat sheet this close to a floor / the terrain is an overlay

const hasLayer = (layers, l) => (layers || []).some((x) => String(x).toLowerCase() === l);
const matsOf = (o) => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);

// Shadow facts of a mesh-like node: its own name + material names (not its ancestors' names: a group
// "Windows" holds frames too), fp.layer of the node and its ancestors, material state, plus
// geo: { size: [x, y, z], bottom: min y, floors: [floor / terrain heights] }.
export function shadowInfo(o, geo = {}) {
  const mats = matsOf(o);
  const layers = [];
  for (let p = o; p; p = p.parent) {
    const l = p.userData && p.userData.fp && p.userData.fp.layer;
    if (Array.isArray(l)) layers.push(...l.map(String));
    else if (typeof l === 'string') layers.push(l);
  }
  return {
    names: [o.name, ...mats.map((m) => m.name)].filter((n) => typeof n === 'string' && n),
    layers,
    transparent: mats.some((m) => !!m.transparent),
    opacity: mats.length ? Math.min(...mats.map((m) => m.opacity ?? 1)) : 1,
    transmission: mats.length ? Math.max(...mats.map((m) => m.transmission || 0)) : 0,
    ...geo,
  };
}

// m: shadowInfo(...). Glass, ground layers and flat sheets lying on a floor cast no shadow.
export function castsShadow(m) {
  const layers = (m.layers || []).map((x) => String(x).toLowerCase());
  if (layers.some((l) => NO_CAST_LAYERS.includes(l) || l.includes('glass'))) return false;
  if (m.transparent || (Number.isFinite(m.opacity) && m.opacity < 0.99) || m.transmission > 0) return false;
  if ((m.names || []).some((n) => GLASS_RE.test(n || ''))) return false;
  const s = m.size;
  const flat = s && s[1] < FLAT_M && Math.max(s[0], s[2]) > FLAT_M * 5;
  if (flat && Number.isFinite(m.bottom) && (m.floors || []).some((f) => Math.abs(m.bottom - f) <= ON_FLOOR_M)) return false;
  return true;
}

// Decals / edging lying on another surface: pulled forward in depth (polygonOffset).
export function isCoplanarOverlay(m) {
  return hasLayer(m.layers, 'decal') || hasLayer(m.layers, 'edging') || (m.names || []).some((n) => OVERLAY_RE.test(n || ''));
}

// Camera depth range. Distances from the camera: target (orbit pivot), house (the house box, 0 inside),
// centre (centre of the whole model's bounding sphere, terrain included) and that sphere's radius
// (capped at 300 m). Near shrinks when the camera is close to the house even with a far pivot.
export const MAX_SCENE_RADIUS = 300;
export function depthRange({ target, house = target, centre = target, radius, ortho = false }) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const r = Math.min(Math.max(radius || 0, 0), MAX_SCENE_RADIUS);
  return {
    near: ortho ? 0.1 : r3(Math.max(0.2, Math.min(target, house) / 200)),
    far: r3(Math.max(50, centre + r) * 1.05),
  };
}

export const depthChanged = (a, b) => !a || Math.abs(a.near - b.near) > a.near * 0.01 || Math.abs(a.far - b.far) > a.far * 0.01;

export const OCCLUSION_MARGIN = 0.3;
// hitDistance: nearest model hit along camera->marker (null = none); markerDistance: camera->marker
export const isOccluded = (hitDistance, markerDistance, margin = OCCLUSION_MARGIN) =>
  hitDistance !== null && hitDistance !== undefined && hitDistance < markerDistance - margin;

// Unit vector towards the sun (card world). north: degrees of the model's fp.north or null for the
// default; azimuth = north + 0.35 rad at ~42° elevation, turned with the model's rotation (rad, about y).
export function sunDirection(north, modelRotation = 0) {
  let v;
  if (Number.isFinite(north)) {
    const a = (north * Math.PI) / 180 + 0.35;
    v = [-Math.sin(a) * 38, 34, Math.cos(a) * 38];
    const c = Math.cos(modelRotation), s = Math.sin(modelRotation);
    v = [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  } else {
    v = [-0.4, 1, 0.35];
  }
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}

// Material settings for the model opacity slider. ud: { wasTransparent, baseOpacity, baseDepthWrite }.
// Ghosted (< 1): blended but depth writes kept, so overlapping parts don't vanish. (Alpha hash was
// tried: it dithers visibly on the card's transparent canvas, e.g. at the demo's 0.95.)
// null = leave as is (originally transparent materials such as glass).
export function ghostMaterial(ud, opacity) {
  if (ud.wasTransparent) return null;
  const ghost = opacity < 1;
  return {
    transparent: ghost, alphaHash: false, depthWrite: ghost ? true : ud.baseDepthWrite !== false,
    opacity: ghost ? opacity : ud.baseOpacity ?? 1, alphaToCoverage: false,
  };
}

// Model pick candidate: a mesh, not a helper, not see-through glass.
export const pickable = (o) => !!o.isMesh && !o.helper && !(o.transparent && o.opacity < 0.6);

// Coplanar duplicates: flat horizontal sheets (thickness < FLAT_THIN) whose boxes match within BOX_TOL in
// x / z and whose heights are within PLANE_TOL. items: [{ id, min: [x,y,z], max: [x,y,z], textured }].
// Returns the ids of the textured sheets whose partner is untextured (exactly one of the pair has a map):
// those get pulled forward in depth, so a plain zone floor does not hide a textured paving under it.
// Sorted by min x, each sheet is compared only with the ones within BOX_TOL in x.
export const COPLANAR = { FLAT_THIN: 0.01, BOX_TOL: 0.02, PLANE_TOL: 0.005 };
export function coplanarWinners(items) {
  const { FLAT_THIN, BOX_TOL, PLANE_TOL } = COPLANAR;
  const flat = items.filter((i) => i.max[1] - i.min[1] < FLAT_THIN && i.max[0] - i.min[0] > BOX_TOL && i.max[2] - i.min[2] > BOX_TOL)
    .sort((a, b) => a.min[0] - b.min[0]);
  const win = new Set();
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i];
    for (let j = i + 1; j < flat.length && flat[j].min[0] - a.min[0] <= BOX_TOL; j++) {
      const b = flat[j];
      if (!!a.textured === !!b.textured) continue;
      const near = (k) => Math.abs(a.min[k] - b.min[k]) <= BOX_TOL && Math.abs(a.max[k] - b.max[k]) <= BOX_TOL;
      if (!near(0) || !near(2)) continue;
      if (Math.abs((a.min[1] + a.max[1]) / 2 - (b.min[1] + b.max[1]) / 2) > PLANE_TOL) continue;
      win.add((a.textured ? a : b).id);
    }
  }
  return win;
}
