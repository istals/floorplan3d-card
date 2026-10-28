// Wall washes: every lit lamp lights the wall (or floor / ceiling) next to it with a soft additive decal,
// at no real-light cost (only a few pool lights exist). Pure placement + texels (unit-tested) and the
// Three.js layer: four shared materials made once (compiled on the first frame through invisible warm-up
// meshes), one small quad per lamp made the first time it is lit; per update only `visible`, the
// transform and the quad's vertex colours change, so toggling lamps never recompiles a shader.
import * as THREE from 'three';
import { HORIZONTAL_DIRS } from '../surface.js';

export const WALL_REACH = 0.6; // a wall within this distance (m) of the lamp gets the wash
const WALL_NY = 0.3; // |n.y| below: a wall
const FLAT_NY = 0.7; // |n.y| above: a floor / ceiling
const OFFSET = 0.01; // decal 1 cm off the surface
const DOWN_RANGE = 6, UP_RANGE = 3, AIM_RANGE = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

// 'down' (default), 'up', 'both' (updown), 'point' (an oval around the lamp) or 'spot' (a pool where it aims),
// from the model's hints.beam
export function washKind(hints) {
  const b = hints && hints.beam;
  if (b === 'updown' || b === 'both') return 'both';
  return b === 'up' || b === 'point' || b === 'spot' ? b : 'down';
}

// "Light on wall" settings (layout.objects[id].wash, layout.tags[name].wash).
export const WASH_DIRS = ['down', 'up', 'both', 'none'];
export const washSetting = (v) => (WASH_DIRS.includes(v) ? v : null);

// The wash kind of a lamp: its own setting, else the first of its tags with a setting, else the model's beam.
export function resolveWash(hints, own, tagNames, tagSettings) {
  const o = washSetting(own);
  if (o) return o;
  for (const t of Array.isArray(tagNames) ? tagNames : []) {
    const s = tagSettings && Object.prototype.hasOwnProperty.call(tagSettings, t) && tagSettings[t] ? washSetting(tagSettings[t].wash) : null;
    if (s) return s;
  }
  return washKind(hints);
}

// The real point light kept at least `min` m off the wall it faces (no hot spot on the wall / door right behind it).
// wall: { point, normal (towards the lamp) } or null; returns a new [x, y, z].
export function clearOfWall(pos, wall, min = 0.15) {
  const p = toArr(pos).slice();
  if (!wall) return p;
  const w = toArr(wall.point), n = toArr(wall.normal);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const d = ((p[0] - w[0]) * n[0] + (p[1] - w[1]) * n[1] + (p[2] - w[2]) * n[2]) / len;
  if (d >= min) return p;
  return p.map((v, i) => v + (n[i] / len) * (min - d));
}

// Decal size (m) from hints.max (strength) and hints.distance (reach).
export function washSize(h) {
  const max = h && fin(h.max) && h.max >= 0 ? h.max : 5;
  let width = clamp(0.4 + 0.3 * max, 0.8, 2.5), height = clamp(0.6 + 0.4 * max, 1, 3);
  const pool = clamp(0.5 + 0.3 * max, 0.8, 2.5);
  if (h && fin(h.distance) && h.distance > 0) {
    height = Math.min(height, Math.max(1, h.distance * 0.6));
    width = Math.min(width, Math.max(0.8, h.distance * 0.5));
  }
  return { width, height, pool };
}

export const washOpacity = (level, real) => (level > 0 ? level * 0.6 * (real ? 0.5 : 1) : 0);

const toArr = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
const facing = (hit) => {
  const n = toArr(hit.normal), d = hit.dir ? toArr(hit.dir) : null;
  return d && n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0 ? n.map((v) => -v || 0) : n.slice();
};

// The nearest wall among horizontal ray hits ({ point, normal, distance, dir }): { point, normal (towards the lamp) } or null.
export function chooseWall(hits, reach = WALL_REACH) {
  let best = null;
  for (const h of hits || []) {
    if (!h || !fin(h.distance) || h.distance > reach) continue;
    const n = toArr(h.normal);
    if (Math.abs(n[1]) >= WALL_NY) continue;
    if (!best || h.distance < best.distance) best = h;
  }
  return best ? { point: toArr(best.point).slice(), normal: facing(best) } : null;
}

/**
 * Where a lamp's wash goes. anchor: lamp [x, y, z] (card world). surfaces: { wall, floor, ceiling, aim } hits
 * ({ point, normal facing the lamp }). Returns { surface, variant, center, normal, width, height } or null.
 * Walls: down beams hang below the lamp (cut at the floor), up beams rise above it, point lamps centre on it.
 * No wall: a pool on the floor (down / point) or the ceiling (up); spots: a pool where they aim.
 */
export function placeWash(kind, anchor, size, { wall = null, floor = null, ceiling = null, aim = null } = {}) {
  const off = (hit) => { const p = toArr(hit.point), n = facing(hit); return { c: p.map((v, i) => v + n[i] * OFFSET), n }; };
  const pool = (hit, surface) => {
    const { c, n } = off(hit);
    const d = fin(hit.pool) ? hit.pool : size.pool; // fitted to the surface (fitPool), else the full size
    return { surface, variant: 'pool', center: c, normal: n, width: d, height: d };
  };
  if (kind === 'spot') {
    if (aim) return pool(aim, 'aim');
    return floor ? pool(floor, 'floor') : null;
  }
  if (wall) {
    const { c, n } = off(wall);
    const y = anchor[1];
    let height = size.height, cy;
    if (kind === 'up') cy = y - 0.15 + height / 2;
    else if (kind === 'point') cy = y;
    else {
      const top = y + 0.15;
      const fy = floor ? toArr(floor.point)[1] : -Infinity;
      if (top - height < fy) height = Math.max(0.2, top - fy);
      cy = top - height / 2;
    }
    return { surface: 'wall', variant: kind === 'up' ? 'up' : kind === 'point' ? 'oval' : 'down', center: [c[0], cy, c[2]], normal: n, width: size.width, height };
  }
  if (kind === 'up') return ceiling ? pool(ceiling, 'ceiling') : null;
  return floor ? pool(floor, 'floor') : null;
}

// Every wash quad of a lamp: 'both' = a down and an up wash (two quads, each with its own cone), 'none' = none.
// An uplight's light comes back down off what it lights: a faint pool on the floor around it, at this share.
export const BOUNCE = 0.3;

export function placeWashes(kind, anchor, size, surfaces = {}) {
  if (kind === 'none') return [];
  if (kind === 'spot') {
    const main = placeWash('spot', anchor, size, surfaces);
    const { aim, floor } = surfaces;
    if (!main || !aim || !floor || toArr(aim.point)[1] <= anchor[1]) return main ? [main] : [];
    const bounce = placeWash('down', anchor, size, { floor }); // no wall: a pool on the floor
    return bounce ? [main, { ...bounce, surface: 'bounce', k: BOUNCE }] : [main];
  }
  const kinds = kind === 'both' ? ['down', 'up'] : [kind];
  return kinds.map((k) => placeWash(k, anchor, size, surfaces)).filter(Boolean);
}

// Pool fitting: probes around a candidate centre must land on the centre's plane. fits(d) -> the best
// placement for a pool of diameter d, or null. Tries the full size, 60 % and 35 % of `pool`, then POOL_MIN;
// null when not even POOL_MIN fits (a narrow beam or post: the wash goes on the next surface instead of
// hanging in the air).
export const POOL_MIN = 0.5;
const PROBE_BACK = 0.3; // probes start this far before the surface (clear of posts and the lamp's mount)
const PLANE_TOL = 0.08;
const MAX_STEP = 0.2; // a moved pool stays within 20 cm (along the beam) of the surface it hit
const MAX_SHIFT = 1; // a pool moves at most 1 m off the beam's axis
export function fitPool(pool, fits) {
  const sizes = [1, 0.6, 0.35].map((k) => pool * k).filter((d) => d >= POOL_MIN);
  if (pool >= POOL_MIN) sizes.push(POOL_MIN);
  for (const d of sizes) { const f = fits(d); if (f) return { ...f, pool: d }; }
  return null;
}

// A wall wash needs a wall: probes WALL_PROBE m to each side and up / down of the hit must land on its plane,
// at least one per axis (a window on one side is fine; a post fails both sides, a beam both up and down).
const WALL_PROBE = 0.4;
export const wallWide = ({ left, right, up, down }) => (left || right) && (up || down);

// Of the candidate placements that fit, the flattest surface (|normal.y|), then the least shifted.
export function bestCandidate(list) {
  let best = null;
  for (const c of list) {
    if (!c) continue;
    const ny = Math.abs(c.normal[1]);
    if (!best || ny > best.ny + 0.05 || (Math.abs(ny - best.ny) <= 0.05 && c.shift < best.shift)) best = { ...c, ny };
  }
  if (!best) return null;
  const { ny, ...rest } = best; // eslint-disable-line no-unused-vars
  return rest;
}

const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// RGBA texels (white, alpha = strength) of a wash texture, row 0 = the bottom (v = 0).
// down: a cone from the top centre widening downwards; up: mirrored; oval: soft ellipse; pool: soft disc.
export function washTexels(variant, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w * 2 - 1; // -1..1
      const v = (y + 0.5) / h; // 0 bottom .. 1 top
      let a;
      if (variant === 'pool' || variant === 'oval') {
        const r = Math.hypot(u, v * 2 - 1);
        a = r >= 1 ? 0 : Math.pow(1 - smooth(0, 1, r), 1.6);
      } else {
        const t = variant === 'up' ? v : 1 - v; // 0 at the lamp end .. 1 at the far end
        const spread = 0.18 + 0.82 * Math.sqrt(t);
        const side = 1 - smooth(0.35 * spread, spread, Math.abs(u));
        const along = Math.pow(1 - t, 1.4) * smooth(0, 0.08, t + 0.02);
        a = side * along;
      }
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 255;
      out[i + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  return out;
}

const VARIANTS = { down: [32, 64], up: [32, 64], oval: [32, 32], pool: [32, 32] };
const UP_DIR = [[0, 1, 0]], DOWN_DIR = [[0, -1, 0]];

export class WashLayer {
  constructor(parent, clipPlanes = null) {
    this.group = new THREE.Group();
    this.group.name = 'fp-washes';
    this.group.userData.helper = true;
    parent.add(this.group);
    this.materials = {};
    this.textures = [];
    for (const [variant, [w, h]] of Object.entries(VARIANTS)) {
      const tex = new THREE.DataTexture(washTexels(variant, w, h), w, h, THREE.RGBAFormat);
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.textures.push(tex);
      const m = new THREE.MeshBasicMaterial({
        map: tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
        side: THREE.DoubleSide, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      if (clipPlanes) m.clippingPlanes = clipPlanes; // the model cut-away (same planes as the model's materials)
      this.materials[variant] = m;
      // warm-up: a zero-area quad, never culled, so the program is compiled on the first frame, not on the first toggle
      const warm = new THREE.Mesh(this._quad(), m);
      warm.scale.set(0, 0, 0);
      warm.frustumCulled = false;
      warm.raycast = () => {};
      warm.userData.helper = true;
      warm.renderOrder = 2;
      this.group.add(warm);
    }
    this.meshes = new Set();
    this.stats = { created: 0, placed: 0 };
  }

  _quad() {
    const g = new THREE.PlaneGeometry(1, 1);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
    return g;
  }

  // The wash surfaces around a lamp at world point a: rays through the view's model surfaces.
  // The nearest wall around world point a (horizontal rays within WALL_REACH) or null.
  // A beam or post beside the lamp is no wall (wallWide): the next nearest hit is tried.
  static wall(view, a) {
    const hits = view.surfaceRays([a.x, a.y, a.z], HORIZONTAL_DIRS, WALL_REACH)
      .filter((h) => chooseWall([h])).sort((x, y) => x.distance - y.distance);
    for (const h of hits) {
      const c = new THREE.Vector3(...h.point), n = new THREE.Vector3(...h.normal), d = new THREE.Vector3(...h.dir);
      const t = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).normalize(), up = new THREE.Vector3(0, 1, 0);
      const back = c.clone().addScaledVector(d, -PROBE_BACK);
      const lands = (o, k) => {
        const q = back.clone().addScaledVector(o, k * WALL_PROBE).toArray();
        const g = view.surfaceRays(q, [h.dir], PROBE_BACK + 0.3)[0];
        return !!g && Math.abs(new THREE.Vector3(...g.point).sub(c).dot(n)) < PLANE_TOL;
      };
      if (wallWide({ left: lands(t, -1), right: lands(t, 1), down: lands(up, -1), up: lands(up, 1) })) return chooseWall([h]);
    }
    return null;
  }

  // The first surface along a ray from p (dir unit) that a pool of diameter `pool` fits on: the hit (centre
  // moved up to the pool's radius sideways when the lamp stands at the surface's edge) + .pool, or null.
  // Narrower surfaces (a beam, a post top) are passed through. flatOnly: a floor / ceiling, never a wall.
  static poolHit(view, p, dir, range, pool, flatOnly = false) {
    const d = new THREE.Vector3(...dir).normalize();
    const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const w = new THREE.Vector3().crossVectors(d, u);
    const sides = [];
    for (let i = 0; i < 8; i++) {
      const t = (i * Math.PI) / 4;
      sides.push(u.clone().multiplyScalar(Math.cos(t)).addScaledVector(w, Math.sin(t)));
    }
    const cast = (q, len) => view.surfaceRays(q.toArray(), [d.toArray()], len)[0] || null;
    const onPlane = (h, c, n) => !!h && Math.abs(new THREE.Vector3(...h.point).sub(c).dot(n)) < PLANE_TOL;
    let from = new THREE.Vector3(...p), left = range;
    for (let i = 0; i < 4 && left > 0; i++) {
      const hit = cast(from, left);
      if (!hit) return null;
      const c0 = new THREE.Vector3(...hit.point);
      const back = c0.clone().addScaledVector(d, -PROBE_BACK);
      const fits = (dia, flat = flatOnly) => {
        const r = dia / 2, found = [];
        // centred first, then moved by one and two radii (at most MAX_SHIFT) towards each side
        for (const [k, o] of [[0, null], ...sides.map((s) => [1, s]), ...sides.map((s) => [2, s])]) {
          const shift = Math.min(k * r, MAX_SHIFT);
          const h = o ? cast(back.clone().addScaledVector(o, shift), PROBE_BACK + 0.6) : hit;
          if (!h || (flat && Math.abs(h.normal[1]) <= FLAT_NY)) continue;
          if (Math.abs(new THREE.Vector3(...h.point).sub(c0).dot(d)) > MAX_STEP) continue; // not a lower lawn / higher roof
          const c = new THREE.Vector3(...h.point), n = new THREE.Vector3(...h.normal);
          const start = c.clone().addScaledVector(d, -PROBE_BACK);
          if (sides.filter((_, j) => j % 2 === 0).every((s) => onPlane(cast(start.clone().addScaledVector(s, r), PROBE_BACK + 0.5), c, n))) {
            found.push({ ...h, shift });
          }
          if (found.length && found[0].shift === 0 && Math.abs(found[0].normal[1]) > FLAT_NY) break; // centred and flat: done
        }
        return bestCandidate(found);
      };
      // a flat soffit / floor beats a slope (a sloped eave would put the pool higher than its neighbours')
      let fit = fitPool(pool, fits);
      if (fit && Math.abs(fit.normal[1]) <= FLAT_NY) fit = fitPool(pool, (dia) => fits(dia, true)) || fit;
      if (fit) { const { shift, ...rest } = fit; return rest; } // eslint-disable-line no-unused-vars
      left -= hit.distance + 0.02;
      from = c0.addScaledVector(d, 0.02);
    }
    return null;
  }

  // aimDir: a spot's direction (world, unit) or null. wall: a cached wall hit (undefined: cast the rays).
  // pool: the pool diameter (washSize); floor / ceiling / aim pools only land on a surface wide enough for one.
  static surfaces(view, a, kind, aimDir = null, wall = undefined, pool = 1) {
    const p = [a.x, a.y, a.z];
    const out = { wall: null, floor: null, ceiling: null, aim: null };
    const floor = () => WashLayer.poolHit(view, p, DOWN_DIR[0], DOWN_RANGE, pool, true);
    if (kind === 'spot') {
      if (aimDir) out.aim = WashLayer.poolHit(view, p, aimDir, AIM_RANGE, pool);
      if (!out.aim || aimDir[1] > 0.5) out.floor = floor(); // no aim: the floor instead; an uplight: its bounce
      return out;
    }
    out.wall = wall !== undefined ? wall : WashLayer.wall(view, a);
    // on a wall the floor only cuts the down wash: the first floor below, however small
    const cut = () => { const h = view.surfaceRays(p, DOWN_DIR, DOWN_RANGE)[0]; return h && Math.abs(h.normal[1]) > FLAT_NY ? h : null; };
    if (kind !== 'up') out.floor = out.wall ? cut() : floor();
    if ((kind === 'up' || kind === 'both') && !out.wall) out.ceiling = WashLayer.poolHit(view, p, UP_DIR[0], UP_RANGE, pool, true);
    return out;
  }

  // A mesh for a placement (made once per lamp, moved when the placement changes).
  place(mesh, placement) {
    const variant = placement ? placement.variant : 'pool';
    if (!mesh) {
      mesh = new THREE.Mesh(this._quad(), this.materials[variant]);
      mesh.raycast = () => {};
      mesh.userData.helper = true;
      mesh.renderOrder = 2;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.meshes.add(mesh);
      this.stats.created++;
    }
    if (!placement) { mesh.visible = false; return mesh; }
    mesh.material = this.materials[variant];
    const n = new THREE.Vector3(...placement.normal).normalize();
    // the quad's +Z is the normal; its +Y is up along the wall (or any direction on a flat pool)
    const ref = Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(ref, n).normalize();
    const y = new THREE.Vector3().crossVectors(n, x).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
    mesh.position.set(...placement.center);
    mesh.scale.set(placement.width, placement.height, 1);
    mesh.updateMatrixWorld();
    this.stats.placed++;
    return mesh;
  }

  // Colour (sRGB 0-255) x opacity into the quad's vertex colours; hidden at 0.
  paint(mesh, color, opacity) {
    if (!mesh) return;
    const show = opacity > 0.002;
    mesh.visible = show;
    if (!show) return;
    const c = new THREE.Color().setRGB(color[0] / 255, color[1] / 255, color[2] / 255, THREE.SRGBColorSpace);
    const attr = mesh.geometry.attributes.color;
    for (let i = 0; i < 4; i++) attr.setXYZ(i, c.r * opacity, c.g * opacity, c.b * opacity);
    attr.needsUpdate = true;
  }

  remove(mesh) {
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.geometry.dispose();
    this.meshes.delete(mesh);
  }

  clear() {
    for (const m of [...this.meshes]) this.remove(m);
  }

  dispose() {
    this.clear();
    for (const c of [...this.group.children]) { this.group.remove(c); if (c.geometry) c.geometry.dispose(); }
    for (const m of Object.values(this.materials)) m.dispose();
    for (const t of this.textures) t.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
