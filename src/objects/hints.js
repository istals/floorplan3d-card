// Tap hints: a small dot at every tappable model object (filled = reachable, hollow grey = offline or a
// controller is off). Pure parts (mode, reachability, fade) are unit-tested; TapHints draws them as two
// shared THREE.Points (filled / hollow, materials made once), drawn a little towards the camera so the
// lamp's own mesh does not hide its dot while walls in front still do.
import * as THREE from 'three';
import { controllersOf } from './logic.js';

export const HINT_RADIUS = 120; // px: near-pointer mode shows dots within this distance
export const HINT_PX = 6;
export const HINT_OPACITY = 0.35;
export const TOUCH_SHOW_MS = 3000;

export function tapHintsMode(layout) {
  const v = layout && layout.tap_hints;
  return v === 'always' || v === 'off' ? v : 'near';
}

const bad = (s) => !s || s.state === 'unavailable' || s.state === 'unknown';
const nameOf = (states, e) => (states[e] && states[e].attributes && states[e].attributes.friendly_name) || e;

// Can a tap act on the object? { ok, reason } with the toast text when not: a controller off ("Turn on
// first: <label>", label = tag label, else the controller's name), else something offline.
export function reachability(obj, binding, chain, states = {}, tags = {}) {
  if (!binding || binding.hidden) return { ok: false, reason: 'Not reachable (offline)' };
  const ctrls = chain && chain.controllers ? chain.controllers : controllersOf(obj, binding, tags);
  const off = ctrls.find((c) => !bad(states[c.entity]) && states[c.entity].state !== 'on');
  if (off) {
    const t = tags[off.tag];
    return { ok: false, reason: `Turn on first: ${(t && typeof t.label === 'string' && t.label) || nameOf(states, off.entity)}` };
  }
  const own = binding.entity;
  if ((own && bad(states[own])) || ctrls.some((c) => bad(states[c.entity])) || (!own && !ctrls.length)) return { ok: false, reason: 'Not reachable (offline)' };
  return { ok: true, reason: null };
}

// Near-pointer fade: 1 within half the radius, 0 from the radius on (smooth, in 0.1 steps).
export function hintAlpha(d, radius = HINT_RADIUS) {
  const t = Math.min(1, Math.max(0, (radius - d) / (radius * 0.5)));
  return Math.round(t * t * (3 - 2 * t) * 10) / 10;
}

function dotTexels(hollow, n = 16) {
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const a = hollow ? Math.max(0, 1 - Math.abs(r - 0.72) / 0.2) : Math.min(1, Math.max(0, (1 - r) / 0.15));
      const i = (y * n + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 255;
      out[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return out;
}

const MAX = 256;

export class TapHints {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'fp-tap-hints';
    this.group.userData.helper = true;
    this.group.renderOrder = 12;
    parent.add(this.group);
    this.layers = {};
    this.textures = [];
    for (const kind of ['filled', 'hollow']) {
      const tex = new THREE.DataTexture(dotTexels(kind === 'hollow'), 16, 16, THREE.RGBAFormat);
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.textures.push(tex);
      const mat = new THREE.PointsMaterial({ size: HINT_PX, sizeAttenuation: false, map: tex, vertexColors: true, transparent: true,
        depthWrite: false, depthTest: true, toneMapped: false, fog: false });
      // drawn 0.3 m towards the camera: the lamp's own glass does not hide its dot, walls in front still do
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.xyz += normalize(-mvPosition.xyz) * 0.3;\ngl_Position = projectionMatrix * mvPosition;');
      };
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 4), 4));
      geo.setDrawRange(0, 0);
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.raycast = () => {};
      pts.userData.helper = true;
      pts.renderOrder = 12;
      this.group.add(pts);
      this.layers[kind] = pts;
    }
    this.items = []; // [{ id, world: Vector3, ok, color: [r,g,b] }]
    this.alpha = new Map(); // id -> 0..1 (near mode fade)
    this.sig = null;
  }

  setPixelRatio(pr) {
    for (const p of Object.values(this.layers)) p.material.size = HINT_PX * (pr || 1);
  }

  // items: [{ id, world, ok, color }]; unchanged signature: nothing to do. True when the dots changed.
  setItems(items) {
    const sig = items.map((i) => `${i.id}:${i.ok ? 1 : 0}:${i.color ? i.color.join(',') : ''}:${i.world.x.toFixed(3)},${i.world.y.toFixed(3)},${i.world.z.toFixed(3)}`).join(';');
    if (sig === this.sig) return false;
    this.sig = sig;
    this.items = items.slice(0, MAX);
    this._write();
    return true;
  }

  // Per-dot fade (near mode): alpha(id) -> 0..1. True when anything changed.
  setAlpha(alphaOf) {
    let changed = false;
    for (const it of this.items) {
      const a = alphaOf(it);
      if (this.alpha.get(it.id) !== a) { this.alpha.set(it.id, a); changed = true; }
    }
    if (changed) this._write();
    return changed;
  }

  _write() {
    const fill = this.layers.filled, hollow = this.layers.hollow;
    let nf = 0, nh = 0;
    const c = new THREE.Color();
    for (const it of this.items) {
      const a = (this.alpha.has(it.id) ? this.alpha.get(it.id) : 1) * HINT_OPACITY;
      const layer = it.ok ? fill : hollow;
      const k = it.ok ? nf++ : nh++;
      layer.geometry.attributes.position.setXYZ(k, it.world.x, it.world.y, it.world.z);
      const rgb = it.ok ? it.color || [255, 255, 255] : [158, 158, 158];
      c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      layer.geometry.attributes.color.setXYZW(k, c.r, c.g, c.b, a);
    }
    for (const [layer, n] of [[fill, nf], [hollow, nh]]) {
      layer.geometry.setDrawRange(0, n);
      layer.geometry.attributes.position.needsUpdate = true;
      layer.geometry.attributes.color.needsUpdate = true;
    }
  }

  setVisible(on) {
    if (this.group.visible === on) return false;
    this.group.visible = on;
    return true;
  }

  dispose() {
    for (const p of Object.values(this.layers)) { p.geometry.dispose(); p.material.dispose(); }
    for (const t of this.textures) t.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
