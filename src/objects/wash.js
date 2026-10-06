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

// 'down' (default), 'up', 'point' (an oval around the lamp) or 'spot' (a pool where it aims), from the model's hints.beam
export function washKind(hints) {
  const b = hints && hints.beam;
  return b === 'up' || b === 'point' || b === 'spot' ? b : 'down';
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
    return { surface, variant: 'pool', center: c, normal: n, width: size.pool, height: size.pool };
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
  // aimDir: a spot's direction (world, unit) or null.
  static surfaces(view, a, kind, aimDir = null) {
    const p = [a.x, a.y, a.z];
    const flat = (hits) => { const h = hits[0]; return h && Math.abs(h.normal[1]) > FLAT_NY ? h : null; };
    const out = { wall: null, floor: null, ceiling: null, aim: null };
    if (kind === 'spot') {
      if (aimDir) out.aim = view.surfaceRays(p, [aimDir], AIM_RANGE)[0] || null;
      if (!out.aim) out.floor = flat(view.surfaceRays(p, DOWN_DIR, DOWN_RANGE));
      return out;
    }
    out.wall = kind === 'up' || kind === 'down' || kind === 'point' ? chooseWall(view.surfaceRays(p, HORIZONTAL_DIRS, WALL_REACH)) : null;
    if (kind !== 'up') out.floor = flat(view.surfaceRays(p, DOWN_DIR, DOWN_RANGE));
    if (kind === 'up' && !out.wall) out.ceiling = flat(view.surfaceRays(p, UP_DIR, UP_RANGE));
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
