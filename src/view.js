// Three.js scene for the floorplan: floors, rooms, cut-away walls, DOM markers, light glow.
// Plan (x, y, z) maps to world (x, floorElevation + z, -y) so north is up in top view.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries, deinterleaveAttribute } from 'three/addons/utils/BufferGeometryUtils.js';
import { centroid } from './placement.js';
import { wallSegments } from './layout.js';
import { levelVisible, measuredElevations } from './bindings.js';
import { buildManifest, threeAdapter } from './manifest.js';
import { outdoorShown, sectionLevels, unionBox, pivotCamera, rayPlaneY, orthoZoom, topZoom, nodeIndex, parseSelector, matches, viewTree, escapeName } from './views.js';
import { GroundCache } from './surface.js';
import { mergeGroups, namedGroups, mergedName } from './merge.js';
import { moonLight, moonLitRight, domeRadius, SUN_MIN_Y, SUN_DISC_M, MOON_DISC_M } from './sky.js';
import { mergeRender, recipeFar, skyLights, deviceShadowCap, lampShadowSlots } from './render-recipe.js';
import { cloudLight, cloudCount, coverageChanged, cloudSlots, cloudAzEl, dirFromAzEl, azElFromDir, cloudFade, cloudNear } from './weather.js';
import {
  castsShadow, shadowInfo, isCoplanarOverlay, coplanarWinners, depthRange, depthChanged, isOccluded, sunDirection, ghostMaterial, pickable,
} from './render-rules.js';

const TONE = {
  None: THREE.NoToneMapping, Linear: THREE.LinearToneMapping, Reinhard: THREE.ReinhardToneMapping, Cineon: THREE.CineonToneMapping,
  ACESFilmic: THREE.ACESFilmicToneMapping, AgX: THREE.AgXToneMapping, Neutral: THREE.NeutralToneMapping,
};
const TEX_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap', 'alphaMap'];

// Plan rectangle of a world-space box (used for rooms tagged without an outline).
export function fallbackOutline(box) {
  return [[box.min.x, -box.max.z], [box.max.x, -box.max.z], [box.max.x, -box.min.z], [box.min.x, -box.min.z]];
}

const WALL_THICKNESS = 0.12;
const GLOW_RADIUS = 2.2;
const TOOLBAR_PX = 48; // plan is framed below the card's toolbar
const COMPACT_PPM = 30;
const MAX_FRAME_MESH_M = 60; // meshes larger than this are left out when framing the model
const SHADOW_MESH_M = 30; // untagged models: meshes up to this size make the sun's shadow box
const SHADOW_MARGIN_M = 4;
const OCCLUSION_DELAY_MS = 150; // camera still this long -> occlusion pass
const OCCLUSION_MAX = 300; // markers per pass
const CLOUD_FRAME_MS = 333; // cloud drift: at most 3 frames per second
const CLOUD_NIGHT = new THREE.Color(0x4a5468); // clouds at night: dim grey-blue
const CLOUD_DAY = new THREE.Color(0xffffff);
const SKY_FRAME_MARGIN_M = 1; // top view: margin around a visible sun / moon disc
const OCCLUSION_SLICE_MS = 8; // a pass yields (setTimeout) after this long
const PICK_LINE_M = 0.02; // raycast threshold for lines / points (three's default is 1 m)
const MOWER_RAY_ABOVE_M = 1.5; // mower ground ray: starts this far over the lawn (overlay ground or floor)
const MOWER_RAY_M = 4.5; // ... and reaches 3 m below it

// fp.north (degrees) on the model root or its two top levels, else null
function northOf(root) {
  const q = [[root, 0]];
  while (q.length) {
    const [o, d] = q.shift();
    const n = o.userData && o.userData.fp && o.userData.fp.north;
    if (Number.isFinite(n)) return n;
    if (d < 2) for (const c of o.children) q.push([c, d + 1]);
  }
  return null;
}

// A mesh geometry baked into its owner's space (own copy: geometries can be shared), float, not
// interleaved, cut to its drawRange.
function bakedGeometry(mesh, toOwner) {
  const src = mesh.geometry, g = new THREE.BufferGeometry();
  const idx = src.index;
  const total = idx ? idx.count : src.attributes.position.count;
  const start = Math.max(0, src.drawRange.start || 0), end = Math.min(total, start + src.drawRange.count);
  const ranged = start > 0 || end < total;
  for (const [k, a0] of Object.entries(src.attributes)) {
    let a = a0.isInterleavedBufferAttribute ? deinterleaveAttribute(a0) : a0.clone();
    if (ranged && !idx) a = new THREE.BufferAttribute(a.array.slice(start * a.itemSize, end * a.itemSize), a.itemSize, a.normalized);
    g.setAttribute(k, a);
  }
  if (idx) g.setIndex(ranged ? new THREE.BufferAttribute(idx.array.slice(start, end), 1) : idx.clone());
  const m = new THREE.Matrix4().multiplyMatrices(toOwner, mesh.matrixWorld);
  g.applyMatrix4(m);
  if (m.determinant() < 0) { // mirrored part: three flips the face order at render time, a baked one has to be flipped here
    flipWinding(g);
    const t = g.attributes.tangent;
    if (t && t.itemSize === 4) for (let i = 0; i < t.count; i++) t.setW(i, -t.getW(i)); // and its handedness
  }
  return g;
}

function flipWinding(g) {
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i + 2 < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    return;
  }
  for (const a of Object.values(g.attributes)) {
    const n = a.itemSize, arr = a.array;
    for (let v = 0; v + 2 < a.count; v += 3) {
      for (let c = 0; c < n; c++) { const i = (v + 1) * n + c, j = (v + 2) * n + c, t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    }
  }
}

// Merges static model meshes (see merge.js: per owner, material, attribute set, shadow flags), in place.
// selectors: view rule selectors (layout / YAML / model views) whose node: matches must stay their own nodes.
// unitScale: model units -> metres (the model scale), for the 30 m / 10 m cell limits.
// Every node keeps its original path segment (userData.fpSeg / fpDup), so node: paths do not shift when
// siblings are merged away. Returns { groups, merged (source meshes), failed }.
export function mergeStaticMeshes(root, manifest, selectors = [], { unitScale = 1 } = {}) {
  root.updateMatrixWorld(true);
  const index = nodeIndex(threeAdapter(root), manifest);
  const pathOf = new Map();
  for (const n of index.nodes) {
    pathOf.set(n.node, n.path);
    n.node.userData.fpSeg = n.seg;
    if (n.dup !== null && n.dup !== undefined) n.node.userData.fpDup = n.dup;
  }
  const keep = new Set();
  for (const s of selectors) {
    const sel = parseSelector(s);
    if (sel && sel.kind === 'node') for (const n of index.nodes) if (matches(sel, n)) keep.add(n.node);
  }
  // groups the Views tab lists and named groups (furniture) keep their own parts
  const listed = new Set(viewTree(index).groups.flatMap((r) => r.nodes.map((i) => index.nodes[i].node)));
  const named = namedGroups(root);
  const roomLevels = new Set(manifest.rooms.map((r) => r.level));
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3(), rel = new THREE.Matrix4(), c = new THREE.Vector3(), sz = new THREE.Vector3();
  const groups = mergeGroups(meshes, {
    root, keep,
    kindOf: (n) => { const e = manifest.byNode.get(n); return e ? (e.kind === 'object' ? 'object' : 'tag') : null; },
    isOwner: (n) => listed.has(n) || named.has(n) || !!(n.userData && n.userData.fp && n.userData.fp.layer),
    boxOf: (m) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.copy(m.geometry.boundingBox).applyMatrix4(rel.multiplyMatrices(rootInv, m.matrixWorld));
      box.getCenter(c);
      box.getSize(sz);
      return { cx: c.x * unitScale, cz: c.z * unitScale, size: Math.max(sz.x, sz.y, sz.z) * unitScale };
    },
    // untagged owners (the root, layer / named groups, a level without rooms) merge per 10 m cell
    spatial: (o) => {
      const e = manifest.byNode.get(o);
      return o === root || !e || (e.kind === 'level' && !roomLevels.has(e.id));
    },
  });
  const sources = new Set();
  let merged = 0, failed = 0;
  const inv = new THREE.Matrix4();
  for (const grp of groups) {
    inv.copy(grp.owner.matrixWorld).invert();
    const geos = grp.meshes.map((m) => bakedGeometry(m, inv));
    const geometry = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!geometry) { failed++; continue; }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const first = grp.meshes[0];
    const out = new THREE.Mesh(geometry, first.material);
    let name = mergedName(first.material.name, grp.meshes.map((m) => pathOf.get(m) || m.name));
    for (let k = 2; grp.owner.children.some((x) => x.name === name); k++) name = name.replace(/(_\d+)?$/, '') + '_' + k; // hash clash among siblings
    out.name = name;
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.renderOrder = first.renderOrder;
    out.layers.mask = first.layers.mask;
    out.userData = { name, fpSeg: escapeName(name), merged: grp.meshes.length, seeThrough: false, ...(grp.layers.length ? { fp: { layer: [...grp.layers] } } : {}) };
    grp.owner.add(out);
    out.updateMatrixWorld(true);
    for (const m of grp.meshes) { sources.add(m.geometry); m.removeFromParent(); }
    merged += grp.meshes.length;
  }
  // source geometries still used by a mesh that stays (shared geometry) are kept
  const used = new Set();
  root.traverse((o) => { if (o.geometry) used.add(o.geometry); });
  for (const g of sources) if (!used.has(g)) g.dispose();
  return { groups: groups.length - failed, merged, failed };
}

const vecArr = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);

// World corners of the face a raycast hit ([[x, y, z] x 3]) or null.
function faceTriangle(hit) {
  const pos = hit.face && hit.object.geometry && hit.object.geometry.attributes.position;
  if (!pos) return null;
  return [hit.face.a, hit.face.b, hit.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld).toArray());
}

export function planToWorld(x, y, z, elevation = 0) {
  return new THREE.Vector3(x, elevation + z, -y);
}

// Headless test mode (the demo's ?test=1 sets window.__floorplan3dTest): cheaper rendering for the
// checks: pixel ratio 1, small shadow maps and sky textures, no cloud drift. Never set in HA.
export const testMode = () => typeof window !== 'undefined' && !!window.__floorplan3dTest;

let glowTexture = null;
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

// Sun sprite texture: warm disc (half the sprite) in a soft glow.
let sunTexture = null;
function getSunTexture() {
  if (sunTexture) return sunTexture;
  const c = document.createElement('canvas');
  const n = testMode() ? 64 : 128, r = n / 2;
  c.width = c.height = n;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, 'rgba(255,252,236,1)');
    grad.addColorStop(0.42, 'rgba(255,240,196,1)');
    grad.addColorStop(0.5, 'rgba(255,214,140,0.55)');
    grad.addColorStop(0.7, 'rgba(255,190,110,0.18)');
    grad.addColorStop(1, 'rgba(255,180,100,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  }
  sunTexture = new THREE.CanvasTexture(c);
  sunTexture.colorSpace = THREE.SRGBColorSpace;
  return sunTexture;
}

// Cloud sprite textures (3 variants, 2:1): overlapping soft white blobs, created once per page.
const cloudTextures = [];
function getCloudTexture(variant) {
  if (cloudTextures[variant]) return cloudTextures[variant];
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    let seed = variant * 9301 + 49297;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < 14; i++) {
      const x = 24 + rnd() * 80, y = 34 + (rnd() - 0.6) * 16, r = 10 + rnd() * 16;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.7)');
      grad.addColorStop(0.55, 'rgba(250,252,255,0.4)');
      grad.addColorStop(1, 'rgba(245,248,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 64);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  cloudTextures[variant] = tex;
  return tex;
}

// Moon disc (90 % of the canvas): lit part by illumination, lit on the right when `waxing`
// (see moonLitRight: waxing seen from the northern hemisphere), the dark part faint.
export function drawMoon(g, size, illumination, waxing) {
  const r = size * 0.45, cx = size / 2, cy = size / 2;
  g.clearRect(0, 0, size, size);
  g.fillStyle = 'rgba(120,135,170,0.22)';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  const k = Math.max(0, Math.min(1, illumination));
  if (k < 0.01) return;
  const side = waxing ? 1 : -1, ex = r * Math.abs(1 - 2 * k);
  g.fillStyle = 'rgba(236,240,250,1)';
  g.beginPath();
  // lit limb: half circle on the lit side, back along the terminator (an ellipse)
  g.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, side < 0);
  g.ellipse(cx, cy, ex, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0.5) === (side < 0));
  g.closePath();
  g.fill();
}

export class FloorplanView {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    // test mode: { drift } (checks of the cloud drift turn it back on); null in real use
    this.test = testMode() ? { drift: false } : null;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // render settings: the card's defaults, replaced by the model's fp.render recipe while one is loaded
    this.render = mergeRender(null);
    this.renderOption = 'model'; // card option render: model | default (ignore the recipe)
    this.renderFrom = null; // { keys } while the loaded model's recipe is in use
    this.renderer.setPixelRatio(this._pixelRatio());
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true; // model cut-away
    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', isolation: 'isolate' }); // own stacking context: label z-indexes stay under the popup
    container.append(this.renderer.domElement, this.labelRenderer.domElement);

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.3, 500);
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    this.ortho.up.set(0, 0, -1); // north up when looking straight down
    this.mode = '3d';
    this.camera = this.persp;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-12, 30, 18);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    // faint moonlight: always in the scene (a light added later recompiles every shader), 0 by day
    this.moonLight = new THREE.DirectionalLight(0xa8bcff, 0);
    this.moonLight.castShadow = false;
    this.scene.add(this.moonLight, this.moonLight.target);
    this.skyGroup = new THREE.Group(); // sun / moon sprites (not in the model: never merged)
    this.skyGroup.userData.helper = true;
    this.scene.add(this.skyGroup);
    this.skyBodies = { sun: null, moon: null }; // { dir: [x, y, z] world, phase?, illumination? }
    this.skySprites = { sun: null, moon: null };
    this._moonKey = null;
    this.skyRing = null; // compass ring on the ground at the dome radius, "N" at true north
    this._skyOn = false; // option sky_bodies (with a model)
    this._dome = null; // { centre: Vector3 (house centre on the ground), radius }
    this.daylight = true;
    this.sky = { night: 0, sunDir: null, sun: 1 };
    // weather: coverage % applied (null before the first), clouds option, drift time (s), last drift frame
    this.weather = { applied: null, show: true, t: 0, frameAt: 0, shown: 0 };
    this.onScreen = true; // the card is on screen (IntersectionObserver in the card); drift only then
    this._cloudSprites = null; // created on first coverage > 0, reused
    this._cloudMats = null; // one SpriteMaterial per texture variant

    this.staticGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.glowGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group(); // editor graphics, drawn on top
    this.mowerGroup = new THREE.Group(); // map image + trail
    this.stemGroup = new THREE.Group(); // edit mode: marker -> floor stems
    this.scene.add(this.staticGroup, this.mowerGroup, this.glowGroup, this.markerGroup, this.overlayGroup, this.stemGroup);
    this.stems = new Map(); // id -> { line, disc }
    this._stemsOn = false;
    this._stemRes = null; // shared geometries + materials of the current stems
    this.mapPlane = null;
    this.stripeArrow = null;
    this.onMapImage = null; // (image, width, height) -> processed { canvas, width, height } | null
    this.trail = null;
    this.warning = null; // { sprite, kind, floorId, timer }
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    this.objectsGroup = new THREE.Group(); // model objects: the light pool sub-group (ObjectLayer.lights) and object labels
    this.scene.add(this.objectsGroup);
    this.onRender = null; // called after every rendered frame
    this.objectLayer = null; // ObjectLayer (registers itself); reset when the model goes
    this.onObjectsInvalidate = null; // called when model placement or visibility changed
    this.model = null; // { id, root, manifest }
    this.mergeStats = null; // { enabled, before, after: { meshes, triangles, calls }, groups, merged } of the loaded model
    this.modelClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    this.sectionClip = null; // side section: global clipping plane (card world) or null
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = PICK_LINE_M;
    this.raycaster.params.Points.threshold = PICK_LINE_M;
    this._occRay = new THREE.Raycaster();
    this._occlusion = true; // dim markers behind model walls
    this._occTimer = null;
    this._occBoxes = null; // [{ mesh, box }] world boxes of occluding model meshes (cached per placement)
    this._surfMeshes = null; // [{ mesh, box }] model meshes devices stick to (cached per placement)
    this._ground = new GroundCache(); // ground seen from above the model, per 0.5 m cell (cleared with _surfMeshes)
    this._mowerGround = new GroundCache(); // ground under the mower: a bounded ray (eaves, canopies ignored)
    this._mapGround = null; // model ground under the map overlay centre
    this._groundLevel = null; // level id of the lawn under the map overlay
    this.mowerMarkerId = null; // the live mower's marker (shown with the outdoors)
    this._surfRay = new THREE.Raycaster();
    this._preview = null; // drag preview (ring, tinted face, label), created on first use
    this._bounds = null; // { house: Box3, centre: Vector3, radius } for the depth range
    this._occGen = 0; // occlusion pass generation (a new schedule cancels running slices)
    this._occFull = false; // a full pass is pending or running
    this._occIds = null; // marker ids waiting for a partial pass (live mower)
    this._occSig = null; // inputs of the last occlusion pass (shown markers, model visibility, cut, section)
    this._shadowSig = null; // inputs of the last shadow map render (model visibility, cut, section)
    this.stats = { occPasses: 0, occPartial: 0, occDone: 0, shadow: 0, frames: 0, shadowLights: 0, cloudFrames: 0 }; // counters for the headless checks (occDone: full passes finished; shadowLights: per-light map redraws requested)
    this._depth = null;

    this.floors = [];
    this.visibleFloor = 'all';
    this._visibleSet = null; // Set of floor ids, null = all
    this._markerStates = null;
    this._modelVisibility = null;
    this._cutOverride = undefined;
    this.cssObjects = []; // { obj, floorId }
    this.markerObjects = new Map(); // id -> { obj, floorId }
    this.glows = new Map(); // id -> { mesh, floorId }
    this.theme = { dark: false };
    this.wallHeight = 1.0;
    this.size = { w: 1, h: 1 };
    this.dirty = true;
    this._raf = null;
    this._zoomTo = 'center'; // zoom pivot: 'center' (controls target) or 'cursor'
    this.pivotMarker = null; // edit mode: small cross at the rotation centre
    this._onWheel = () => { this.dirty = true; };
    this.renderer.domElement.addEventListener('wheel', this._onWheel, { passive: true });
    this._makeControls();
  }

  _makeControls() {
    const prevTarget = this.controls && this.controls.target.clone();
    if (this.controls) this.controls.dispose();
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.05;
    c.screenSpacePanning = true;
    c.zoomToCursor = this._zoomTo === 'cursor';
    if (this.mode === 'top') {
      c.enableRotate = false;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.maxPolarAngle = Math.PI * 0.47;
      c.maxDistance = 130;
      c.minDistance = this._minDistance || 4;
    }
    c.addEventListener('change', () => {
      this.dirty = true;
      this._camMovedAt = performance.now();
      this._scheduleOcclusion();
      if (this.onCameraChange) this.onCameraChange();
    });
    c.addEventListener('start', () => { this._tween = null; });
    if (this.controls) c.enabled = this.controls.enabled;
    if (prevTarget) c.target.copy(prevTarget);
    this.controls = c;
  }

  // Zoom pivot: 'cursor' zooms towards the pointer, 'center' (default) zooms and rotates around the target.
  setZoomTo(mode) {
    this._zoomTo = mode === 'cursor' ? 'cursor' : 'center';
    this.controls.zoomToCursor = this._zoomTo === 'cursor';
  }

  // Rotation centre under a screen point: the model surface, else the horizontal plane at height y.
  pivotPoint(clientX, clientY, y = 0) {
    const pick = this.pickModel(clientX, clientY);
    if (pick && pick.hit) return pick.hit.point;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    return rayPlaneY(origin.toArray(), direction.toArray(), y);
  }

  // Move the rotation centre to a world point; the camera keeps its angle and distance (tweened).
  // Returns the new camera { position, target }.
  setPivot(point) {
    if (this.mode !== '3d' || !point) return null;
    const cam = pivotCamera(this.getCamera(), point);
    this.setCamera(cam);
    return cam;
  }

  // Edit mode: show the rotation centre as a small cross (three short lines, primary colour).
  setPivotMarker(on) {
    if (!on) {
      if (this.pivotMarker) {
        this.scene.remove(this.pivotMarker);
        this.pivotMarker.geometry.dispose();
        this.pivotMarker.material.dispose();
        this.pivotMarker = null;
        this.dirty = true;
      }
      return;
    }
    if (this.pivotMarker) return;
    const L = 0.25;
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-L, 0, 0, L, 0, 0, 0, -L, 0, 0, L, 0, 0, 0, -L, 0, 0, L], 3));
    const m = new THREE.LineBasicMaterial({ color: this.theme.primary || 0x03a9f4, depthTest: false, transparent: true });
    this.pivotMarker = new THREE.LineSegments(g, m);
    this.pivotMarker.renderOrder = 12;
    this.pivotMarker.userData.helper = true;
    this.pivotMarker.position.copy(this.controls.target);
    this.scene.add(this.pivotMarker);
    this.dirty = true;
  }

  setControlsEnabled(on) {
    this.controls.enabled = on;
  }

  // Plan point [x, y] under a screen position, on the horizontal plane at world height `height`.
  planPoint(clientX, clientY, height) {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), new THREE.Vector3());
    return hit ? [hit.x, -hit.z] : null;
  }

  // The map overlay under a screen position: the ray hits the overlay plane itself (clouds, helpers,
  // markers and the model are ignored). -> { u, v, x, y } (texture uv, v up; plan point) or null.
  mapHit(clientX, clientY) {
    const pl = this.mapPlane;
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!pl || !r.width || !r.height) return null;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    pl.updateMatrixWorld();
    const hit = this.raycaster.intersectObject(pl, false)[0];
    if (!hit || !hit.uv) return null;
    return { u: hit.uv.x, v: hit.uv.y, x: hit.point.x, y: -hit.point.z };
  }

  // Screen position (client px) of a plan point, the inverse of planPoint.
  screenPoint(x, y, z, floorId) {
    const v = planToWorld(x, y, z, this.floorElevation(floorId)).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }

  // Client px of a world point, null when it is behind the camera or outside the depth range.
  projectWorld(world) {
    const v = world.clone().project(this.camera);
    if (!(v.z >= -1 && v.z <= 1)) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }

  // Editor overlay. lines: [{points, closed, floorId, color}], fills: [{points, floorId, color, opacity}],
  // handles: [{element, x, y, floorId}] (DOM, CSS2D).
  setOverlay({ lines = [], fills = [], handles = [] } = {}) {
    this._clearGroup(this.overlayGroup);
    this.cssObjects = this.cssObjects.filter((c) => c.kind !== 'handle');
    for (const f of fills) {
      if (f.points.length < 3) continue;
      const geo = new THREE.ShapeGeometry(new THREE.Shape(f.points.map(([x, y]) => new THREE.Vector2(x, y))));
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: f.color, transparent: true, opacity: f.opacity ?? 0.18, depthTest: false, side: THREE.DoubleSide,
      }));
      mesh.position.y = this.floorElevation(f.floorId) + 0.02;
      mesh.renderOrder = 9;
      mesh.userData.floorId = f.floorId;
      mesh.userData.helper = true;
      this.overlayGroup.add(mesh);
    }
    for (const l of lines) {
      if (l.points.length < 2) continue;
      const pts = l.points.map(([x, y]) => new THREE.Vector3(x, 0, -y));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: l.color, depthTest: false, transparent: true });
      const line = l.closed ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
      line.position.y = this.floorElevation(l.floorId) + 0.03;
      line.renderOrder = 10;
      line.userData.floorId = l.floorId;
      line.userData.helper = true;
      this.overlayGroup.add(line);
    }
    for (const h of handles) {
      const obj = new CSS2DObject(h.element);
      obj.position.copy(planToWorld(h.x, h.y, 0.03, this.floorElevation(h.floorId)));
      this.overlayGroup.add(obj);
      this.cssObjects.push({ obj, floorId: h.floorId, kind: 'handle' });
    }
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // GLB underlay. opts: {url} or {id, data: ArrayBuffer | () => Promise<ArrayBuffer>}, plus
  // position: [x, y, z] plan metres, rotation: degrees CCW, scale, opacity.
  // Top-level nodes named "floor:<id>" are shown only with their floor; everything is cut at the
  // selected floor's cut-away height. Same url/id again only re-places the loaded model.
  // Resolves to null or an error message.
  _modelIdOf(opts) {
    const base = opts && (opts.id || opts.url);
    return base && opts.merge === false ? base + '#nomerge' : base; // merge on / off is a reload
  }

  // The model of opts is already shown / on its way (setModel would not fetch it again).
  isModelLoaded(opts) {
    const id = this._modelIdOf(opts);
    return !!id && !opts.reload && !!this.model && this.model.id === id;
  }

  isModelLoading(opts) {
    const id = this._modelIdOf(opts);
    return !!id && !opts.reload && this._modelId === id && !(this.model && this.model.id === id);
  }

  setModel(opts) {
    const id = this._modelIdOf(opts);
    if (id && opts.reload && this.model && this.model.id === id) this._disposeModel(true); // load again (e.g. merge with new keep rules)
    if (!id) {
      this._disposeModel();
      return Promise.resolve(null);
    }
    const place = () => {
      const g = this.modelGroup;
      const [x, y, z] = opts.position || [0, 0, 0];
      g.position.set(Number(x) || 0, Number(z) || 0, -(Number(y) || 0));
      g.rotation.y = ((opts.rotation || 0) * Math.PI) / 180;
      g.scale.setScalar(opts.scale || 1);
      const opacity = opts.opacity ?? 1;
      if (this.model) {
        // ghosted: blended but depth writes kept, so overlapping parts do not vanish; glass untouched
        this.model.root.traverse((o) => {
          if (!o.isMesh) return;
          for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
            const g = ghostMaterial(mat.userData, opacity);
            if (!g) continue;
            if (mat.alphaHash !== g.alphaHash || mat.transparent !== g.transparent) mat.needsUpdate = true;
            Object.assign(mat, g);
          }
        });
        this.model.opacity = opacity;
        this._occBoxes = null; this._surfMeshes = null; this._ground.clear(); this._mowerGround.clear(); // placement changed
        this._bounds = this._sceneBounds();
      }
      if (this.model) this._fitShadow();
      this._shadowDirty();
      this._applyFloorVisibility();
      this._scheduleOcclusion(0);
      this._objectsInvalid();
      this.dirty = true;
    };
    if (this.model && this.model.id === id) {
      place();
      return Promise.resolve(null);
    }
    if (this._modelId === id) return this._modelLoading; // already on its way
    this._disposeModel(true); // another model follows: keep the model look (no shader rebuild there and back)
    this._modelId = id;
    const label = opts.name || opts.url || 'model';
    this._modelLoading = new Promise((resolve) => {
      const fail = (err) => {
        console.warn('floorplan3d: could not load model', label, err);
        if (this._modelId === id) {
          this._modelId = null;
          if (!this.model && this._modelLook) this._applyLook(); // nothing follows: the no-model look
        }
        resolve(`Could not load model ${label}`);
      };
      const onLoad = (gltf) => {
        if (this._modelId !== id) return resolve(null);
        const root = gltf.scene;
        const manifest = buildManifest(threeAdapter(root));
        // legacy levels without order/elevation stack bottom-up by their lowest point
        for (const l of manifest.levels) {
          const lb = new THREE.Box3().setFromObject(l.node);
          l.minY = lb.isEmpty() ? 0 : lb.min.y; // set for every level
        }
        // rooms tagged without an outline: use their footprint (root is not placed yet, so world = model space)
        root.updateMatrixWorld(true);
        for (const r of manifest.rooms) {
          if (r.outline) continue;
          const box = new THREE.Box3().setFromObject(r.node);
          if (box.isEmpty()) continue;
          r.outline = fallbackOutline(box);
          r.outlineFallback = true;
        }
        // tagged models are never cut: no clipping plane (and no extra shader variant) at all
        const tagged = manifest.levels.some((l) => l.source === 'extras' || l.source === 'name');
        // heights a flat sheet can lie on: level floors, the terrain / floor layers, the model bottom
        const floorYs = [0];
        for (const l of manifest.levels) if (Number.isFinite(l.elevation)) floorYs.push(l.elevation);
        for (const m of Object.values(measuredElevations(manifest.levels))) floorYs.push(m.elevation);
        const all = new THREE.Box3();
        root.traverse((o) => {
          if (!o.isMesh) return;
          const b = new THREE.Box3().setFromObject(o);
          all.union(b);
          if (shadowInfo(o).layers.some((l) => /^(terrain|floor)$/i.test(l))) floorYs.push(b.max.y);
        });
        if (!all.isEmpty()) floorYs.push(all.min.y);
        this._useRecipe(manifest);
        const aniso = Math.min(this.render.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
        root.traverse((o) => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of mats) {
            if (!tagged) {
              mat.clippingPlanes = [this.modelClip];
              mat.clipShadows = true;
            }
            mat.userData.baseOpacity = mat.opacity;
            mat.userData.wasTransparent = mat.transparent;
            // glTF does not store anisotropic filtering: without it floor boards and tiles blur at grazing angles
            for (const key of TEX_KEYS) {
              const tex = mat[key];
              if (tex && tex.anisotropy !== aniso) { tex.anisotropy = aniso; tex.needsUpdate = true; }
            }
            mat.userData.baseDepthWrite = mat.depthWrite;
          }
          const box = new THREE.Box3().setFromObject(o);
          const info = shadowInfo(o, { size: box.getSize(new THREE.Vector3()).toArray(), bottom: box.min.y, floors: floorYs });
          o.receiveShadow = true;
          o.castShadow = castsShadow(info);
          o.userData.seeThrough = !!info.transparent || info.opacity < 0.6 || info.transmission > 0;
          if (isCoplanarOverlay(info)) {
            for (const mat of mats) Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
          }
        });
        this._modelVisibility = null;
        this.model = { id, root, manifest, tagged, north: northOf(root), opacity: 1 };
        this._liftTextured(root);
        this.modelGroup.add(root);
        this._applyLook();
        this.mergeStats = null;
        const unitScale = opts.scale || 1;
        if (opts.merge === false) {
          const st = this._modelStats();
          this.mergeStats = { enabled: false, before: st, after: st, groups: 0, merged: 0, keep: [] };
        } else {
          // the keep selectors come from the layout: merge now when it is there, else once it has loaded
          const keep = typeof opts.keep === 'function' ? opts.keep() : opts.keep || [];
          if (keep && typeof keep.then === 'function') {
            const model = this.model;
            keep.then((sels) => {
              if (this.model !== model) return;
              this._mergeModel(sels, unitScale);
              this._afterMerge();
              if (opts.onMerged) opts.onMerged();
            }, () => {});
          } else {
            this._mergeModel(keep, unitScale);
          }
        }
        place();
        resolve(null);
      };
      const loader = new GLTFLoader();
      if (opts.data === undefined && opts.url) loader.load(opts.url, onLoad, undefined, fail);
      else {
        // bytes from the card (its cache); external resources of a URL model resolve next to it
        const path = opts.url ? THREE.LoaderUtils.extractUrlBase(new URL(opts.url, location.href).href) : '';
        Promise.resolve(typeof opts.data === 'function' ? opts.data() : opts.data)
          .then((buf) => loader.parse(buf, path, onLoad, fail))
          .catch(fail);
      }
    });
    return this._modelLoading;
  }

  // Merge the loaded model's static meshes (keep: view rule selectors; the model's own views are added).
  _mergeModel(keep, unitScale) {
    const { root, manifest } = this.model;
    this._restoreModelVisibility(); // hidden by a view: still merged (the card re-applies visibility after)
    const before = this._modelStats();
    const sels = [...(keep || []), ...manifest.views.flatMap((v) => [...v.show, ...v.hide])];
    let res = null;
    try {
      res = mergeStaticMeshes(root, manifest, sels, { unitScale });
    } catch (err) {
      console.warn('floorplan3d: could not merge model meshes', err);
    }
    const after = res && res.merged ? this._modelStats() : before;
    this.mergeStats = { enabled: true, before, after, groups: res ? res.groups : 0, merged: res ? res.merged : 0, keep: sels };
  }

  // A textured flat sheet coplanar with an untextured one (paving under a plain zone floor) wins the
  // depth test: polygonOffset on its material (cloned when shared with other meshes), drawn after.
  _liftTextured(root) {
    root.updateMatrixWorld(true);
    const items = [], byId = new Map(), users = new Map();
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) users.set(m, (users.get(m) || 0) + 1);
      if (Array.isArray(o.material) || o.userData.liftedCoplanar) return;
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) return;
      byId.set(o.id, o);
      items.push({ id: o.id, min: b.min.toArray(), max: b.max.toArray(), textured: !!o.material.map });
    });
    for (const id of coplanarWinners(items)) {
      const o = byId.get(id);
      let m = o.material;
      if (users.get(m) > 1) {
        const planes = m.clippingPlanes; // Material.copy clones them: keep the live (cut-away) planes
        m = m.clone();
        if (planes) m.clippingPlanes = planes;
        o.material = m;
      }
      Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      m.userData.baseDepthWrite = m.depthWrite;
      o.renderOrder = (o.renderOrder || 0) + 1;
      o.userData.liftedCoplanar = true;
    }
  }

  // Caches that hold model meshes, after a merge on a placed model.
  _afterMerge() {
    if (this.model) this._liftTextured(this.model.root);
    this._occBoxes = null; this._surfMeshes = null; this._ground.clear(); this._mowerGround.clear();
    this._applyFloorVisibility(); // floor-only mode covers the merged meshes too
    this._bounds = this._sceneBounds();
    this._fitShadow();
    this._shadowDirty();
    this._scheduleOcclusion(0);
    this._objectsInvalid();
    this.dirty = true;
  }

  // Model meshes, triangles and draw calls (one render of the model alone, nothing culled, shadow pass
  // included) for mergeStats. Other scene content is hidden meanwhile (lights stay: same shaders).
  _modelStats() {
    const root = this.model.root, r = this.renderer;
    let meshes = 0, triangles = 0;
    const culled = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      if (g) triangles += Math.floor((g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0) / 3);
      if (o.frustumCulled) { o.frustumCulled = false; culled.push(o); }
    });
    // the object light pool stays (its group, not the rest of the objects): without its lights the model's
    // shaders would compile once more just for this render
    const pool = this.objectLayer && this.objectLayer.lights;
    const hidden = this.scene.children.filter((c) => c !== this.modelGroup && !c.isLight && c.visible && !(pool && c === pool.parent));
    if (pool && pool.parent && pool.parent.visible) hidden.push(...pool.parent.children.filter((c) => c !== pool && c.visible));
    for (const c of hidden) c.visible = false;
    let calls;
    try {
      if (r.shadowMap.enabled) r.shadowMap.needsUpdate = true;
      r.render(this.scene, this.camera);
      calls = r.info.render.calls;
    } finally {
      for (const c of hidden) c.visible = true;
      for (const o of culled) o.frustumCulled = true;
      this.dirty = true;
    }
    return { meshes, triangles, calls };
  }

  modelManifest() {
    return this.model ? this.model.manifest : null;
  }

  // level id -> { show, floor } from the card's bindings
  setModelLevels(assign) {
    this.modelLevels = assign || {};
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // The tagged part under a screen point: nearest tagged ancestor of the first visible hit below
  // the cut; untagged meshes come back as { kind: 'untagged' } so the UI can say so.
  pickModel(clientX, clientY) {
    const hit = this._modelHit(clientX, clientY);
    if (!hit) return null;
    const fn = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    const hitInfo = { point: hit.point.toArray(), object: hit.object, up: !fn || Math.abs(fn.y) >= Math.cos((25 * Math.PI) / 180) };
    const owner = this.model.manifest.ownerOf(hit.object);
    if (owner) return { ...owner, hit: hitInfo };
    const names = [];
    for (let p = hit.object; p && p !== this.model.root; p = p.parent) names.unshift((p.userData && p.userData.name) || p.name || '?');
    return { kind: 'untagged', node: hit.object, path: names.join('/'), hit: hitInfo };
  }

  // The model surface under a screen point (visible, opaque meshes below the cut, section respected):
  // { point, normal (unit, facing the camera), object, owner (manifest entry or null) } or null.
  surfaceAt(clientX, clientY) {
    const hit = this._modelHit(clientX, clientY);
    if (!hit) return null;
    const normal = hit.face
      ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize()
      : new THREE.Vector3(0, 1, 0);
    if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate(); // double-sided / flipped faces: the side we look at
    return { point: hit.point.clone(), normal, object: hit.object, owner: this.model.manifest.ownerOf(hit.object), tri: faceTriangle(hit) };
  }

  // Rays from a card-world point [x, y, z] in each direction (unit [x, y, z]) up to maxDist against the
  // model's surfaces: every mesh regardless of the current view (placement must not jump when the view
  // changes) except helpers, model objects (lamps, the mower) and glass. Returns the first hit per
  // direction: [{ point, normal (unit, raw face side), distance, dir }] (arrays, card world).
  surfaceRays(worldPoint, dirs, maxDist) {
    if (!this.model) return [];
    const meshes = this._surfaceMeshes();
    const ray = this._surfRay, out = [];
    const o = new THREE.Vector3(...worldPoint), end = new THREE.Vector3(), seg = new THREE.Box3();
    const nm = new THREE.Matrix3();
    for (const d of dirs) {
      const dir = new THREE.Vector3(...d).normalize();
      ray.set(o, dir);
      ray.near = 0;
      ray.far = maxDist;
      end.copy(dir).multiplyScalar(maxDist).add(o);
      seg.makeEmpty().expandByPoint(o).expandByPoint(end);
      let best = null;
      for (const { mesh, box } of meshes) {
        if (!box.intersectsBox(seg)) continue;
        const hit = ray.intersectObject(mesh, false)[0];
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
      if (!best) continue;
      const n = best.face
        ? best.face.normal.clone().applyNormalMatrix(nm.getNormalMatrix(best.object.matrixWorld)).normalize()
        : dir.clone().negate();
      out.push({ point: best.point.toArray(), normal: n.toArray(), distance: best.distance, dir: dir.toArray(), object: best.object });
    }
    return out;
  }

  _surfaceMeshes() {
    if (this._surfMeshes) return this._surfMeshes;
    const list = [];
    this.modelGroup.updateMatrixWorld(true);
    const manifest = this.model.manifest;
    this.model.root.traverse((o) => {
      if (!o.isMesh) return;
      for (let p = o; p && p !== this.model.root; p = p.parent) if (p.userData && p.userData.helper) return;
      const m = (Array.isArray(o.material) ? o.material[0] : o.material) || { userData: {} };
      const ud = m.userData || {};
      if (!pickable({ isMesh: true, helper: false, transparent: ud.wasTransparent ?? !!m.transparent, opacity: ud.baseOpacity ?? m.opacity ?? 1 })) return;
      if (o.userData.seeThrough) return;
      const owner = manifest.ownerOf(o);
      if (owner && owner.kind === 'object') return;
      const box = new THREE.Box3().setFromObject(o);
      if (!box.isEmpty()) list.push({ mesh: o, box });
    });
    this._surfMeshes = list;
    return list;
  }

  // Drag preview on the model surface: p = { point, normal, tri: [[x,y,z] x3] | null, label } (card world)
  // or null to hide. One ring, one tinted face and one label, created once and reused.
  setSurfacePreview(p) {
    if (!p) {
      if (this._preview && this._preview.visible) { this._preview.visible = false; this._previewLabel.element.hidden = true; this.dirty = true; }
      return;
    }
    if (!this._preview) this._buildPreview();
    const g = this._preview, color = this.theme.primary || 0x03a9f4;
    const pt = new THREE.Vector3(...vecArr(p.point)), n = new THREE.Vector3(...vecArr(p.normal)).normalize();
    this._previewRing.position.copy(pt).addScaledVector(n, 0.01);
    this._previewRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this._previewRing.material.color.set(color);
    const face = this._previewFace;
    if (p.tri) {
      const pos = face.geometry.attributes.position;
      p.tri.forEach((v, i) => pos.setXYZ(i, ...vecArr(v)));
      pos.needsUpdate = true;
      face.geometry.computeBoundingSphere();
      face.material.color.set(color);
      face.visible = true;
    } else face.visible = false;
    const label = this._previewLabel;
    label.element.textContent = p.label || '';
    label.element.hidden = !p.label;
    label.visible = !!p.label;
    label.position.copy(pt).addScaledVector(n, 0.05);
    g.visible = true;
    this.dirty = true;
  }

  _buildPreview() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.12, 40),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false }));
    ring.renderOrder = 12;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.25, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }));
    face.renderOrder = 11;
    const el = document.createElement('div');
    el.className = 'fp-attach-label';
    el.hidden = true;
    const label = new CSS2DObject(el);
    for (const o of [ring, face, label]) { o.userData.helper = true; o.raycast = () => {}; o.frustumCulled = false; }
    g.add(ring, face, label);
    g.userData.helper = true;
    g.visible = false;
    this._preview = g;
    this._previewRing = ring;
    this._previewFace = face;
    this._previewLabel = label;
    this.scene.add(g);
  }

  // First visible model intersection under a screen point (raycaster left set to that ray).
  _modelHit(clientX, clientY) {
    if (!this.model) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const candidate = (o) => {
      // the material as authored (glass), not as ghosted by the opacity slider
      const m = (Array.isArray(o.material) ? o.material[0] : o.material) || { userData: {} };
      const ud = m.userData || {};
      return pickable({
        isMesh: o.isMesh, helper: !!o.userData.helper,
        transparent: ud.wasTransparent ?? !!m.transparent, opacity: ud.baseOpacity ?? m.opacity ?? 1,
      });
    };
    const hit = this.raycaster.intersectObject(this.model.root, true)
      .find((h) => candidate(h.object) && shown(h.object) && h.point.y <= this.modelClip.constant + 1e-6 && !this._cutAway(h.point));
    return hit || null;
  }

  highlightModelNode(node) {
    if (this.pickHelper) {
      this.scene.remove(this.pickHelper);
      this.pickHelper.geometry.dispose();
      this.pickHelper.material.dispose();
      this.pickHelper = null;
    }
    if (node) {
      this.pickHelper = new THREE.BoxHelper(node, this.theme.primary || 0x03a9f4);
      this.pickHelper.material.depthTest = false;
      this.pickHelper.renderOrder = 11;
      this.pickHelper.userData.helper = true;
      this.scene.add(this.pickHelper);
    }
    this.dirty = true;
  }

  // keepLook: a model is about to replace this one, so the renderer keeps the model look (tone mapping,
  // shadows) meanwhile; switching to the no-model look and back would rebuild every shader twice.
  _disposeModel(keepLook = false) {
    this._modelId = null;
    this._modelVisibility = null;
    if (!this.model) {
      if (!keepLook && this._modelLook) this._applyLook();
      return;
    }
    this.highlightModelNode(null);
    if (this.objectLayer) this.objectLayer.setModel(null, { keepLights: keepLook }); // restores cloned materials before they are disposed
    this._clearGroup(this.modelGroup);
    this.model = null;
    this.mergeStats = null;
    this._occBoxes = null; this._surfMeshes = null; this._ground.clear(); this._mowerGround.clear();
    this._cancelOcclusion();
    this._clearOcclusion();
    if (!keepLook) { this.renderFrom = null; this._setRender(mergeRender(null)); this._applyLook(); }
    this.dirty = true;
  }

  // Card option render: 'model' (the model's fp.render recipe) or 'default' (ignore it). Applied at the next model load.
  // A change with a model loaded re-applies the look now (the lamp pool size follows at the next load).
  setRenderOption(opt) {
    const next = opt === 'default' ? 'default' : 'model';
    if (next === this.renderOption) return;
    this.renderOption = next;
    if (!this.model) return;
    this._useRecipe(this.model.manifest);
    if (this.objectLayer) this.objectLayer._shadowLook();
    this._applyLook();
  }

  // Pixel ratio: 1 in test mode, else the device's up to the recipe's pixelRatioMax.
  _pixelRatio() {
    return this.test ? 1 : Math.min(window.devicePixelRatio || 1, this.render.pixelRatioMax);
  }

  // Lamp shadow maps this device affords (see deviceShadowCap).
  shadowCap() {
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    return deviceShadowCap({ touch, dpr: window.devicePixelRatio || 1, cores: navigator.hardwareConcurrency });
  }

  // Shadow-capable lamp slots for the loaded settings: min(recipe max, device cap).
  lampShadowCount() {
    return lampShadowSlots(this.render.lampShadows.max, this.shadowCap());
  }

  // The loaded model's recipe (unless render: default) -> this.render; renderer pixel ratio and camera fov / near.
  _useRecipe(manifest) {
    const recipe = this.renderOption === 'default' ? null : manifest.render;
    this.renderFrom = recipe ? { keys: manifest.renderKeys || Object.keys(recipe).length } : null;
    this._setRender(mergeRender(recipe));
  }

  _setRender(render) {
    this.render = render;
    const pr = this._pixelRatio();
    if (this.renderer.getPixelRatio() !== pr) {
      this.renderer.setPixelRatio(pr);
      if (this.size) this.resize(this.size.w, this.size.h);
      if (this.onPixelRatio) this.onPixelRatio(pr);
    }
    const cam = this.persp;
    if (cam.fov !== render.camera.fov) { cam.fov = render.camera.fov; cam.updateProjectionMatrix(); }
  }

  setDaylight(day) {
    this.daylight = !!day;
    this.sky = { night: day ? 0 : 1, sunDir: null };
    if (this.model || !this._modelId) this._applyLook(); // a model on its way applies its look
  }

  // night 0..1 and the unit vector toward the sun (world) or null (fixed bearing from fp.north).
  // With a model only the light values change; shadows are re-rendered when the sun moved > 1 degree
  // or night entered / left 1 (sun.castShadow stays true, so no shader recompile).
  // shadow: false (time scrubber dragging): lights move now, the sun's shadow map is redrawn at the next
  // setSky with shadow true (the scrubber settled).
  setSky({ night = 0, sunDir = null, sun = 1 } = {}, { shadow = true } = {}) {
    const old = this.sky;
    this.sky = { night, sunDir, sun };
    this.daylight = night < 0.5;
    if (!this.model) { if (!this._modelId) this._applyLook(); return; } // a model on its way applies its look
    this._applyLights();
    const a = old.sunDir, b = sunDir;
    let moved = (!!a !== !!b);
    if (a && b) moved = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) > Math.PI / 180;
    if (moved) this._fitShadow({ redraw: shadow });
    else if (this._sunStale && shadow) this._sunShadow(); // the sun came up: its map was skipped while it was down
    this.dirty = true;
  }

  _applyLights() {
    const t = Math.max(0, Math.min(1, this.sky.night)), hemi = this.hemi, sun = this.sun;
    const k = skyLights(this.render, t); // the recipe's day / night colours and intensities
    hemi.color.setHex(k.hemiSky);
    hemi.groundColor.setHex(k.hemiGround);
    const L = cloudLight(this.weather.applied || 0, t);
    hemi.intensity = k.hemiIntensity * L.hemi;
    sun.color.setHex(k.sunColor);
    sun.intensity = k.sunIntensity * (this.sky.sun ?? 1) * L.sun;
    // softer, fainter sun shadow under clouds: uniforms only (radius has no effect with PCFSoftShadowMap)
    sun.shadow.radius = L.shadowRadius;
    sun.shadow.intensity = L.shadowIntensity;
    this._applyMoonLight();
    this._cloudLook();
    const day = new THREE.Color(0x2a2d30), night = new THREE.Color(0x0e0f10);
    this.renderer.setClearColor(day.lerp(night, t), 1);
  }

  // Sun / moon on a dome around the house: { sun: { dir } | null, moon: { dir, phase, illumination } | null,
  // north: [x, y, z] world unit vector of true north, on: sky_bodies }. Each body sits at house centre
  // + dir x dome radius, so its azimuth / elevation read off the compass ring (3D and top view).
  setSkyBodies({ sun = null, moon = null, north = null, on = true } = {}) {
    this._skyOn = !!on;
    this.skyBodies = on ? { sun: sun && sun.dir ? sun : null, moon: moon && moon.dir ? moon : null } : { sun: null, moon: null };
    if (this.skyBodies.sun && !this.skySprites.sun) this.skySprites.sun = this._skySprite(getSunTexture());
    if (this.skyBodies.moon) {
      if (!this.skySprites.moon) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        this.skySprites.moon = this._skySprite(tex);
      }
      this._paintMoon(this.skyBodies.moon);
    }
    this._cloudLook(); // a new disc gets its cloud opacity
    if (north) this._skyNorth = north;
    if (this._skyOn && !this.skyRing) this._makeSkyRing();
    if (this.model) this._applyMoonLight();
    this._placeSkyBodies();
    this.dirty = true;
  }

  // Unit ring (scaled to the dome radius) with a tick and an "N" on local +x (turned to true north).
  _makeSkyRing() {
    const g = new THREE.Group();
    const pts = [];
    for (let i = 0; i < 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
    const line = (opacity) => new THREE.LineBasicMaterial({ color: 0xffb74d, transparent: true, opacity, depthWrite: false, toneMapped: false, fog: false });
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), line(0.25));
    const tick = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.94, 0, 0), new THREE.Vector3(1.08, 0, 0)]), line(0.6));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(255,183,77,0.9)';
      ctx.font = 'bold 44px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', 32, 34);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    label.position.set(1.16, 0.02, 0);
    label.userData.ringLabel = true;
    for (const o of [ring, tick, label]) { o.userData.helper = true; o.raycast = () => {}; }
    g.add(ring, tick, label);
    g.userData.helper = true;
    g.visible = false;
    this.skyRing = g;
    this.skyGroup.add(g);
  }

  _skySprite(map) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    s.castShadow = s.receiveShadow = false;
    s.frustumCulled = false; // placed per frame
    s.visible = false;
    s.userData.helper = true;
    s.raycast = () => {}; // never picked
    this.skyGroup.add(s);
    return s;
  }

  // Redraw the moon texture only when the shape changes visibly (texture upload, no shader change).
  _paintMoon(moon) {
    const tex = this.skySprites.moon.material.map, ill = Math.round((Number(moon.illumination) || 0) * 50) / 50;
    const right = moonLitRight(moon.phase, moon.latitude); // mirrored south of the equator
    const key = ill + (right ? '+' : '-');
    if (key === this._moonKey) return;
    this._moonKey = key;
    const g = tex.image.getContext && tex.image.getContext('2d');
    if (g) drawMoon(g, tex.image.width, ill, right);
    tex.needsUpdate = true;
  }

  _applyMoonLight() {
    const l = this.moonLight, moon = this.skyBodies.moon;
    l.intensity = this.model ? moonLight(this.sky.night, moon) * cloudLight(this.weather.applied || 0).moon : 0;
    if (l.intensity > 0 && this._shadowBox) {
      const { centre, radius } = this._shadowBox;
      l.target.position.copy(centre);
      l.position.copy(centre).addScaledVector(new THREE.Vector3(...moon.dir), radius * 2.5);
      l.target.updateMatrixWorld();
    }
  }

  // Weather: { coverage 0..100, clouds: option clouds }. Applied only when the coverage moved >= 5 points
  // (or reached 0 / 100) or the option changed: light values, disc opacities, cloud sprites. Returns true when applied.
  setWeather({ coverage = 0, clouds = true } = {}) {
    const w = this.weather, show = clouds !== false, c = Math.max(0, Math.min(100, Number(coverage) || 0));
    if (!coverageChanged(w.applied, c) && show === w.show) return false;
    w.applied = c;
    w.show = show;
    if (this.model) this._applyLights();
    else this._cloudLook();
    this._placeSkyBodies();
    this.dirty = true;
    return true;
  }

  // Disc and cloud opacity / tint for the coverage and night (uniforms only, no shader change).
  _cloudLook() {
    const c = (this.weather.applied || 0) / 100, t = Math.max(0, Math.min(1, this.sky.night || 0)), L = cloudLight(c * 100, t);
    if (this.skySprites.sun) this.skySprites.sun.material.opacity = L.sunDisc;
    if (this.skySprites.moon) this.skySprites.moon.material.opacity = L.moon;
    if (this._cloudMats) {
      for (const m of this._cloudMats) {
        m.opacity = (0.4 + 0.55 * c) * (this._cloudFadeK ?? 1);
        m.color.copy(CLOUD_DAY).lerp(CLOUD_NIGHT, t);
      }
    }
  }

  _makeClouds() {
    this._cloudMats = [0, 1, 2].map((v) => new THREE.SpriteMaterial({ map: getCloudTexture(v), transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    this._cloudSprites = cloudSlots().map((slot) => {
      const s = new THREE.Sprite(this._cloudMats[slot.variant]);
      s.castShadow = s.receiveShadow = false;
      s.frustumCulled = false;
      s.visible = false;
      s.renderOrder = 1; // over the sun / moon discs
      s.userData.helper = true;
      s.userData.cloud = true;
      s.raycast = () => {};
      this.skyGroup.add(s);
      return s;
    });
    this._cloudLook();
  }

  // Clouds on the dome around the visible sun (else the moon), drifting with weather.t.
  // 3D only (top view looks down on the dome); they fade out in a high orbit (50..65 deg camera
  // elevation, one opacity for all: uniforms only), and a cloud the camera is inside is hidden.
  _placeClouds(on) {
    const w = this.weather, d = this._dome;
    const n = on && w.show && this.mode !== 'top' ? cloudCount(w.applied || 0) : 0;
    if (n && !this._cloudSprites) this._makeClouds();
    w.shown = n;
    if (!this._cloudSprites) return;
    const { sun, moon } = this.skyBodies;
    const body = sun && sun.dir[1] > SUN_MIN_Y ? sun : moon && moon.dir[1] > 0 ? moon : null;
    const anchor = body ? azElFromDir(body.dir) : { az: 200, el: 35 };
    const slots = cloudSlots(), cam = this.camera.position.toArray();
    const fade = n ? cloudFade(cam, d.centre.toArray()) : 1;
    if (fade !== this._cloudFadeK) { this._cloudFadeK = fade; this._cloudLook(); }
    this._cloudSprites.forEach((s, i) => {
      s.visible = i < n;
      if (!s.visible) return;
      const p = cloudAzEl(slots[i], anchor, w.t);
      s.position.copy(d.centre).addScaledVector(new THREE.Vector3(...dirFromAzEl(p.az, p.el)), d.radius * 0.985);
      const size = slots[i].size * d.radius;
      s.scale.set(size, size * 0.5, 1);
      if (!fade || cloudNear(cam, s.position.toArray(), size)) s.visible = false;
    });
  }

  // Sun / moon on the dome (house centre + dir x radius) as world-size discs, hidden below the horizon
  // (sun < -2 deg, moon < 0); the ring and both discs need a model and sky_bodies.
  _placeSkyBodies() {
    const d = this._dome, on = !!this.model && this._skyOn && !!d && !this.sectionClip; // the section's global plane would cut them
    const put = (sprite, body, minY, size) => {
      if (!sprite) return;
      const show = on && !!body && body.dir[1] > minY;
      sprite.visible = show;
      if (!show) return;
      sprite.position.copy(d.centre).addScaledVector(new THREE.Vector3(...body.dir).normalize(), d.radius);
      sprite.scale.setScalar(size);
    };
    put(this.skySprites.sun, this.skyBodies.sun, SUN_MIN_Y, SUN_DISC_M * 2); // disc = half the sprite
    put(this.skySprites.moon, this.skyBodies.moon, 0, MOON_DISC_M / 0.9); // disc = 90 % of the sprite
    this._placeClouds(on);
    const ring = this.skyRing;
    if (!ring) return;
    ring.visible = on;
    if (!on) return;
    ring.position.set(d.centre.x, d.centre.y + 0.02, d.centre.z);
    ring.scale.setScalar(d.radius);
    const n = this._skyNorth || [0, 0, -1];
    ring.rotation.y = Math.atan2(-n[2], n[0]); // local +x -> north
    const label = ring.children.find((o) => o.userData.ringLabel);
    if (label) label.scale.setScalar(1.4 / d.radius); // ~1.4 m in the world
  }

  // Renderer, light and shadow settings for model / no model and day / night.
  _applyLook() {
    const r = this.renderer, day = this.model ? this.daylight : true, sun = this.sun, hemi = this.hemi;
    this._modelLook = !!this.model;
    if (this.model) {
      const rd = this.render;
      r.toneMapping = TONE[rd.toneMapping] ?? THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = rd.exposure;
      r.outputColorSpace = rd.outputColorSpace === 'srgb-linear' ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      r.shadowMap.enabled = true;
      r.shadowMap.autoUpdate = false; // re-rendered on demand (needsUpdate), not every frame
      this._shadowDirty();
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      this._applyLights();
      sun.castShadow = true; // stays on (toggling recompiles shaders); night = intensity 0
      sun.shadow.autoUpdate = false; // redrawn only when flagged, and only while the sun is up
      const sm = this.test ? Math.min(512, rd.sun.shadowMapSize) : rd.sun.shadowMapSize;
      if (sun.shadow.mapSize.x !== sm) {
        sun.shadow.mapSize.set(sm, sm);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } // re-created at the new size
      }
      sun.shadow.bias = rd.sun.bias;
      sun.shadow.normalBias = rd.sun.normalBias; // against acne on roofs
      this._fitShadow();
    } else {
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.shadowMap.enabled = false;
      r.setClearColor(0x000000, 0);
      hemi.color.setHex(0xffffff);
      hemi.groundColor.setHex(0x8a8a8a);
      hemi.intensity = day ? 2.2 : 0.6;
      sun.color.setHex(0xffffff);
      sun.intensity = day ? 1.4 : 0;
      sun.castShadow = false;
      this.moonLight.intensity = 0;
      sun.position.set(-12, 30, 18);
      sun.target.position.set(0, 0, 0);
    }
    // toneMapping / shadowMap changes need the shaders rebuilt
    this.scene.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
    this.dirty = true;
  }

  // Fit the sun's shadow camera to the house: storey / basement / roof levels (untagged: meshes up
  // to 30 m across) + 4 m, not the whole plot, so the 2048² map stays sharp. Sun azimuth from fp.north.
  _fitShadow({ redraw = true } = {}) {
    if (!this.model) return;
    const sun = this.sun;
    this.modelGroup.updateMatrixWorld(true);
    let box = new THREE.Box3();
    for (const l of this.model.manifest.levels) {
      if (l.role === 'storey' || l.role === 'basement' || l.role === 'roof') box.union(new THREE.Box3().setFromObject(l.node));
    }
    if (box.isEmpty()) {
      this.model.root.traverse((o) => {
        if (!o.isMesh) return;
        const b = new THREE.Box3().setFromObject(o);
        if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) <= SHADOW_MESH_M) box.union(b);
      });
    }
    if (box.isEmpty()) box = new THREE.Box3().setFromObject(this.modelGroup);
    if (box.isEmpty()) return;
    const ground = Math.min(Math.max(0, box.min.y), box.max.y);
    const hc = box.getCenter(new THREE.Vector3());
    this._dome = { centre: new THREE.Vector3(hc.x, ground, hc.z), radius: domeRadius(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2) };
    this._placeSkyBodies();
    box.expandByScalar(SHADOW_MARGIN_M);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    this._shadowBox = { centre: centre.clone(), radius };
    this._applyMoonLight();
    const dir = new THREE.Vector3(...(this.sky.sunDir || sunDirection(this.model.north, this.modelGroup.rotation.y)));
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(dir, radius * 2.5);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.5;
    cam.far = radius * 5;
    cam.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
    if (redraw) this._sunShadow();
    else this._sunStale = true; // redrawn once the time scrubber settles
    this.stats.shadow++;
    this.dirty = true;
  }

  // True when the model's levels come from tags (extras / names), not the legacy heuristic.
  isTagged() {
    return !!this.model && this.model.tagged;
  }

  // World height of the model surface seen from above at plan (x, y) (cached per 0.5 m cell, one ray down
  // from over the model against the surface meshes: helpers, objects and glass ignored), or null.
  groundAt(x, y) {
    const g = this._groundHit(x, y);
    return g ? g.y : null;
  }

  // The ground height, else the floor's elevation (no model, or nothing under the point).
  groundHeight(x, y, floorId) {
    const g = this.groundAt(x, y);
    return g ?? this.floorElevation(floorId);
  }

  _groundHit(x, y) {
    if (!this.model) return null;
    return this._ground.get(x, y, this.model.id, (cx, cy) => this._groundRay(cx, cy));
  }

  // Ground under the mower (marker, model node, warning, trail): a ray down from 1.5 m over the map overlay's
  // ground (else the floor's elevation), at most MOWER_RAY_M long, so roofs, eaves, carports and tree canopies
  // over the mower are ignored. Falls back to the ray from above the model when that finds nothing.
  mowerGround(x, y, floorId) {
    if (!this.model) return null;
    const base = this._mapGround ?? this.floorElevation(floorId);
    const key = `${this.model.id}|${base}`;
    const g = this._mowerGround.get(x, y, key, (cx, cy) => {
      const from = base + MOWER_RAY_ABOVE_M;
      const hit = this.surfaceRays([cx, from, -cy], [[0, -1, 0]], MOWER_RAY_M)[0];
      return hit ? hit.point[1] : this._groundHit(cx, cy)?.y ?? null;
    });
    return g;
  }

  // mowerGround, else the floor's elevation
  mowerHeight(x, y, floorId) {
    return this.mowerGround(x, y, floorId) ?? this.floorElevation(floorId);
  }

  _groundRay(x, y) {
    const meshes = this._surfaceMeshes();
    if (!meshes.length) return null;
    let top = -Infinity, bottom = Infinity;
    for (const { box } of meshes) {
      if (box.max.y > top) top = box.max.y;
      if (box.min.y < bottom) bottom = box.min.y;
    }
    const from = top + 1;
    const hit = this.surfaceRays([x, from, -y], [[0, -1, 0]], from - bottom + 1)[0];
    if (!hit) return null;
    let level = null;
    const levels = this.model.manifest.levels || [];
    for (let o = hit.object; o && !level; o = o.parent) level = levels.find((l) => l.node === o) || null;
    return { y: hit.point[1], level: level ? level.id : null };
  }

  // Map, marker and trail of the mower: with a model, shown wherever the outdoors (an exterior level, or
  // the level holding the lawn) shows, whatever the mower's HA floor; else the floor rule.
  _mowerShows(floorId) {
    if (this.model) {
      const mv = this._modelVisibility;
      const o = outdoorShown(this.model.manifest.levels, mv && mv.index, mv && mv.flags, this._groundLevel);
      if (o !== null) return o;
    }
    return this._shows(floorId);
  }

  // Mower map image laid on the lawn. o: {url, x, y, rotation, width, opacity, floorId, heightOffset,
  // hidden} or null. x, y = image centre in plan metres, rotation in degrees counter-clockwise, top of
  // image = north. Height: the model surface under the centre + 2 cm (independent of the HA floor's
  // elevation), else the floor + 1.5 cm; plus heightOffset. hidden: loaded (detection reads it) but not drawn.
  setMapOverlay(o) {
    if (!o || !o.url) {
      if (this.mapPlane) {
        const u = this.mapPlane.userData;
        this.mowerGroup.remove(this.mapPlane);
        this.mapPlane.geometry.dispose();
        if (u.rawTex) u.rawTex.dispose();
        if (u.canvasTex) u.canvasTex.dispose();
        this.mapPlane.material.dispose();
        this.mapPlane = null;
        this.dirty = true;
      }
      this._mapGround = null;
      this.setStripeArrow(null);
      return;
    }
    if (!this.mapPlane) {
      // under objects: depth tested, pulled toward the camera against the lawn, drawn before other transparents
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      this.mapPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
      this.mapPlane.renderOrder = -1;
      this.mapPlane.visible = false; // until the first image arrives
      this.mowerGroup.add(this.mapPlane);
    }
    const plane = this.mapPlane;
    // per-push calls with the same overlay draw nothing
    const hit = this._groundHit(o.x || 0, o.y || 0); // cached: no ray per update
    const ground = hit ? hit.y : null;
    this._groundLevel = hit ? hit.level : null;
    this._mapGround = ground;
    const off = Number(o.heightOffset) || 0;
    const sig = [o.url, o.x, o.y, o.rotation, o.width, o.opacity, o.floorId, this.floorElevation(o.floorId), this._shows(o.floorId), ground, off, !!o.hidden].join('|');
    if (sig === plane.userData.sig) return;
    plane.userData.sig = sig;
    plane.userData.floorId = o.floorId;
    plane.userData.hidden = !!o.hidden;
    plane.position.copy(planToWorld(o.x || 0, o.y || 0, 0, 0));
    plane.position.y = (ground != null ? ground + 0.02 : this.floorElevation(o.floorId) + 0.015) + off;
    plane.rotation.y = ((o.rotation || 0) * Math.PI) / 180;
    plane.material.opacity = o.opacity ?? 0.6;
    const aspect = plane.userData.aspect || 1;
    const w = o.width || 20;
    plane.scale.set(w, 1, w * aspect);
    plane.userData.external = !!o.external;
    if (o.external) plane.userData.url = o.url; // the card draws the picture (setMapCanvas)
    if (plane.userData.url !== o.url) {
      plane.userData.url = o.url;
      // swap textures only once the new image has loaded, so camera refreshes don't flicker
      new THREE.TextureLoader().load(o.url, (tex) => {
        if (plane.userData.url !== o.url || this.mapPlane !== plane) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        const old = plane.userData.rawTex;
        plane.userData.rawTex = tex;
        // the size may change between refreshes: aspect from this picture
        const W = tex.image.naturalWidth || tex.image.width, H = tex.image.naturalHeight || tex.image.height;
        plane.userData.aspect = H / W;
        plane.userData.loaded = { url: o.url, image: tex.image, at: Date.now() };
        plane.scale.set(w, 1, w * plane.userData.aspect);
        if (old && old !== tex && plane.material.map === old) { // shown raw: switch now, nothing stale
          plane.material.map = tex;
          plane.material.needsUpdate = true;
        }
        if (old && old !== tex) old.dispose();
        this._applyMapImage(plane); // shown once the picture (processed or as loaded) is in place
        this.dirty = true;
      }, undefined, () => console.warn('floorplan3d: could not load mower map', o.url));
    }
    if (plane.material.map) plane.visible = this._mapShown(plane);
    this.dirty = true;
  }

  // The loaded picture through onMapImage (image, width, height) -> (a promise of) { canvas, width,
  // height } | null | undefined: a processed canvas is drawn through one reused CanvasTexture (new only
  // when its size changes), null draws the picture as loaded, undefined keeps what is shown. Results of
  // an older run (a newer picture or reprocess started since) are dropped.
  _applyMapImage(plane) {
    const ld = plane.userData.loaded;
    if (!ld) return;
    const img = ld.image;
    const seq = (this._mapSeq = (this._mapSeq || 0) + 1);
    let res = null;
    try {
      res = this.onMapImage ? this.onMapImage(img, img.naturalWidth || img.width, img.naturalHeight || img.height) : null;
    } catch (e) {
      console.warn('floorplan3d: could not process the mower map', e);
    }
    const done = (r) => {
      if (seq !== this._mapSeq || this.mapPlane !== plane) return;
      this._setMapTexture(plane, r);
    };
    if (res && typeof res.then === 'function') {
      res.then(done, (e) => { console.warn('floorplan3d: could not process the mower map', e); done(null); });
    } else done(res);
  }

  _setMapTexture(plane, res) {
    if (res === undefined && plane.material.map) return;
    const mat = plane.material;
    let next = plane.userData.rawTex;
    if (res && res.canvas) {
      let ct = plane.userData.canvasTex;
      if (ct && (ct.image !== res.canvas || ct.userData.w !== res.width || ct.userData.h !== res.height)) {
        ct.dispose();
        ct = null;
      }
      if (!ct) {
        ct = new THREE.CanvasTexture(res.canvas);
        ct.colorSpace = THREE.SRGBColorSpace;
        ct.userData = { w: res.width, h: res.height };
        plane.userData.canvasTex = ct;
      }
      ct.needsUpdate = true;
      next = ct;
    }
    if (mat.map !== next) {
      mat.map = next;
      mat.needsUpdate = true;
    }
    plane.visible = this._mapShown(plane);
    if (this.stripeArrow) this.stripeArrow.visible = plane.visible;
    this.dirty = true;
  }

  // External map (auto mode: the card decodes and processes the live map off the main thread): the
  // processed canvas (w x h) drawn for a picture of natW x natH; changed regions are already drawn into
  // it, so the one reused CanvasTexture is flagged once per batch. loaded: { image (raw picture for the
  // edit-mode pickers) | null, url }.
  setMapCanvas(canvas, natW, natH, loaded = null) {
    const plane = this.mapPlane;
    if (!plane || !plane.userData.external) return;
    const aspect = natH / natW;
    if (plane.userData.aspect !== aspect) {
      plane.userData.aspect = aspect;
      plane.scale.z = plane.scale.x * aspect;
    }
    const was = plane.userData.loaded;
    if (was && was.image && was.image !== (loaded && loaded.image) && was.image.close) was.image.close();
    plane.userData.loaded = { url: plane.userData.url, image: (loaded && loaded.image) || null, width: natW, height: natH, at: Date.now() };
    this._setMapTexture(plane, { canvas, width: canvas.width, height: canvas.height });
    this.stats.mapUploads = (this.stats.mapUploads || 0) + 1;
  }

  // Run the map processing again on the loaded picture (settings changed, no new image).
  reprocessMap() {
    if (this.mapPlane && this.mapPlane.userData.external) { if (this.onMapReprocess) this.onMapReprocess(); return; }
    if (this.mapPlane && this.mapPlane.userData.loaded) this._applyMapImage(this.mapPlane);
  }

  // Stripe direction arrow on the lawn: { x, y, angle (degrees ccw from east), length } or null.
  // A double-headed line just above the map.
  setStripeArrow(a) {
    const plane = this.mapPlane;
    const sig = a && plane ? [a.x, a.y, Math.round(a.angle * 10), a.length, plane.position.y, plane.visible].join('|') : '';
    if (this.stripeArrow && this.stripeArrow.userData.sig === sig) return;
    if (this.stripeArrow) {
      this.mowerGroup.remove(this.stripeArrow);
      this.stripeArrow.geometry.dispose();
      this.stripeArrow.material.dispose();
      this.stripeArrow = null;
      this.dirty = true;
    }
    if (!sig) return;
    const r = (a.angle * Math.PI) / 180, L = a.length / 2, hd = Math.min(0.6, a.length * 0.15);
    const pt = (d, side) => {
      const c = Math.cos(r), s = Math.sin(r);
      return new THREE.Vector3(a.x + c * d - s * side, plane.position.y + 0.05, -(a.y + s * d + c * side));
    };
    const pts = [pt(-L, 0), pt(L, 0)];
    for (const e of [1, -1]) pts.push(pt(e * L, 0), pt(e * (L - hd), hd * 0.6), pt(e * L, 0), pt(e * (L - hd), -hd * 0.6));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    // depth tested: the house and objects hide it; a helper (no picking / placement)
    this.stripeArrow = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: true }));
    this.stripeArrow.renderOrder = 3;
    this.stripeArrow.userData = { sig, helper: true };
    this.stripeArrow.visible = plane.visible;
    this.mowerGroup.add(this.stripeArrow);
    this.dirty = true;
  }

  _mapShown(plane) {
    return !plane.userData.hidden && this._mowerShows(plane.userData.floorId);
  }

  // Mower trail: plan points [[x, y], ...] on one floor, or null. One Line and one material for the
  // view's life (a new material per update would compile a new shader each time): the points go into a
  // reused position buffer (grown when full), drawRange says how many; null / < 2 points draws none.
  setTrail(points, floorId) {
    const n = points && points.length > 1 ? points.length : 0;
    if (!n && (!this.trail || !this.trail.geometry.drawRange.count)) return;
    if (!this.trail) {
      this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8, depthTest: false }));
      this.trail.renderOrder = 3;
      this.trail.frustumCulled = false; // the buffer is larger than the drawn part: no stale bounds
      this.trail.userData.helper = true;
      this.mowerGroup.add(this.trail);
    }
    const line = this.trail;
    let attr = line.geometry.getAttribute('position');
    if (n && (!attr || attr.count < n)) {
      const cap = Math.max(64, n, attr ? attr.count * 2 : 0);
      const geo = new THREE.BufferGeometry();
      attr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      line.geometry.dispose();
      line.geometry = geo;
    }
    // each point on the ground under it (the lawn, whatever the HA floor's elevation), 4 cm up
    for (let i = 0; i < n; i++) {
      const [x, y] = points[i];
      attr.setXYZ(i, x, this.mowerHeight(x, y, floorId) + 0.04, -y);
    }
    if (n) attr.needsUpdate = true;
    line.geometry.setDrawRange(0, n);
    line.material.color.set(this.theme.primary || 0x03a9f4); // a uniform: no recompile
    line.userData.floorId = floorId;
    line.visible = !!n && this._mowerShows(floorId);
    this.dirty = true;
  }

  _disposeTrail() {
    if (!this.trail) return;
    this.mowerGroup.remove(this.trail);
    this.trail.geometry.dispose();
    this.trail.material.dispose();
    this.trail = null;
  }

  // Warning over the mower: { kind: 'error' | 'stuck', x, y, floorId } or null. A world-size sprite 0.6 m
  // above the ground under the mower, pulsing at 2 Hz by a timer that exists only while it is shown
  // (the render loop stays idle otherwise).
  setMowerWarning(w) {
    const cur = this.warning;
    if (!w) {
      if (cur) {
        clearInterval(cur.timer);
        this.mowerGroup.remove(cur.sprite);
        cur.sprite.material.map.dispose();
        cur.sprite.material.dispose();
        this.warning = null;
        this.dirty = true;
      }
      return;
    }
    const y = this.mowerHeight(w.x, w.y, w.floorId) + 0.6;
    if (cur && cur.kind === w.kind) {
      const at = cur.sprite.position;
      if (at.x !== w.x || at.y !== y || at.z !== -w.y || cur.floorId !== w.floorId) {
        at.set(w.x, y, -w.y);
        cur.floorId = w.floorId;
        this._warningVisible();
        this.dirty = true;
      }
      return;
    }
    this.setMowerWarning(null);
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const col = w.kind === 'stuck' ? '#f5b800' : '#e53935';
    g.beginPath();
    g.moveTo(64, 10); g.lineTo(122, 112); g.lineTo(6, 112); g.closePath();
    g.fillStyle = col; g.fill();
    g.lineWidth = 8; g.lineJoin = 'round'; g.strokeStyle = '#ffffff'; g.stroke();
    g.fillStyle = w.kind === 'stuck' ? '#3a2e00' : '#ffffff';
    g.font = 'bold 66px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('!', 64, 80);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.scale.set(0.5, 0.5, 1);
    sprite.renderOrder = 20; // above objects
    sprite.position.set(w.x, y, -w.y);
    sprite.userData.helper = true; // never picked by the model ray
    sprite.raycast = () => {};
    this.mowerGroup.add(sprite);
    let bright = true;
    const timer = setInterval(() => {
      bright = !bright;
      sprite.material.opacity = bright ? 1 : 0.55;
      if (sprite.visible) this.dirty = true; // no frames for a warning on a hidden floor
    }, 500);
    this.warning = { sprite, kind: w.kind, floorId: w.floorId, timer };
    this._warningVisible();
    this.dirty = true;
  }

  // Chip next to the mower: { kind ('offline' | 'rain' | 'drying'), icon, text, x, y, floorId } or null.
  // A DOM label (CSS2D) 0.5 m above the ground under the mower; its element is removed with it.
  setMowerChip(c) {
    const cur = this.mowerChip;
    if (!c) {
      if (cur) { this.mowerGroup.remove(cur.obj); cur.obj.element.remove(); this.mowerChip = null; this.dirty = true; }
      return;
    }
    let obj = cur && cur.obj;
    if (!obj) {
      const el = document.createElement('div');
      el.innerHTML = '<ha-icon></ha-icon><span></span>';
      obj = new CSS2DObject(el);
      obj.userData.helper = true;
      obj.raycast = () => {};
      this.mowerGroup.add(obj);
      this.mowerChip = { obj };
    }
    const el = obj.element;
    el.className = `fp-mower-chip ${c.kind}`;
    const ic = el.querySelector('ha-icon');
    if (ic.getAttribute('icon') !== c.icon) ic.setAttribute('icon', c.icon);
    el.querySelector('span').textContent = c.text || '';
    obj.position.set(c.x, this.mowerHeight(c.x, c.y, c.floorId) + 0.5, -c.y);
    obj.visible = this._mowerShows(c.floorId);
    this.mowerChip.floorId = c.floorId;
    this.dirty = true;
  }

  _warningVisible() {
    this.warning.sprite.visible = this._mowerShows(this.warning.floorId);
  }

  // World position of the warning sprite while shown (the tap target), else null.
  warningWorld() {
    const w = this.warning;
    return w && w.sprite.visible ? w.sprite.position.clone() : null;
  }

  // Move one handle without rebuilding the overlay (vertex drag).
  moveHandle(element, x, y, floorId) {
    const c = this.cssObjects.find((o) => o.kind === 'handle' && o.obj.element === element);
    if (c) c.obj.position.copy(planToWorld(x, y, 0.03, this.floorElevation(floorId)));
    this.dirty = true;
  }

  moveMarker(id, x, y, z, floorId) {
    const m = this.markerObjects.get(id);
    if (!m) return;
    m.obj.position.copy(planToWorld(x, y, z, this.floorElevation(floorId)));
    const g = this.glows.get(id);
    if (g) g.mesh.position.copy(planToWorld(x, y, 0.03, this.floorElevation(floorId)));
    // only this marker: visibility (it may have crossed the section cut) and its own occlusion
    const c = this.cssObjects.find((o) => o.kind === 'marker' && o.id === id);
    if (c) c.obj.visible = this._markerVisible(c);
    if (g) g.mesh.visible = this._glowVisible(id, g);
    const st = this.stems.get(id);
    if (st) st.disc.visible = m.obj.visible;
    this._placeStem(id, m.obj.position, floorId);
    this._scheduleOcclusion(OCCLUSION_DELAY_MS, id);
    this.dirty = true;
  }

  setTheme(theme) {
    this.theme = theme;
    this._applyLook();
    for (const g of this.glows.values()) {
      g.mesh.material.blending = theme.dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      g.mesh.material.needsUpdate = true;
    }
    this.dirty = true;
  }

  // floors: [{id, elevation, height}], rooms: [{room, floorId, label}]
  setStructure(floors, rooms, { wallHeight = 1.0, walls = true, fills = true, outlines = true, labels = true } = {}) {
    this.floors = floors;
    this._rooms = rooms;
    this.wallHeight = wallHeight;
    this._clearGroup(this.staticGroup);
    this.cssObjects = this.cssObjects.filter((c) => c.kind !== 'label');
    const t = this.theme;
    // polygon offset: room floors win over a GLB model's slab at the same height (no z-fighting)
    const offset = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const floorMat = new THREE.MeshLambertMaterial({ color: t.floor, side: THREE.DoubleSide, ...offset });
    const outdoorMat = new THREE.MeshLambertMaterial({ color: t.outdoor, side: THREE.DoubleSide, transparent: true, opacity: 0.7, ...offset });
    const wallMat = new THREE.MeshLambertMaterial({ color: t.wall });
    const edgeMat = new THREE.LineBasicMaterial({ color: t.edge });

    for (const f of floors) {
      const group = new THREE.Group();
      group.userData.floorId = f.id;
      group.position.y = f.elevation;
      const own = rooms.filter((r) => r.floorId === f.id);
      for (const { room, label } of own) {
        if (!room.polygon || room.polygon.length < 3) continue;
        const shape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
        if (fills) {
          const geo = new THREE.ShapeGeometry(shape);
          geo.rotateX(-Math.PI / 2);
          const mesh = new THREE.Mesh(geo, room.outdoor ? outdoorMat : floorMat);
          mesh.position.y = room.outdoor ? -0.01 : 0;
          mesh.userData.roomId = room.id;
          group.add(mesh);
        }
        if (outlines) {
          const outline = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(room.polygon.map(([x, y]) => new THREE.Vector3(x, 0.005, -y))),
            edgeMat,
          );
          outline.userData.helper = true;
          group.add(outline);
        }
        if (label && labels) {
          const el = document.createElement('div');
          el.className = 'fp-room-label' + (room.outdoor ? ' outdoor' : '');
          el.textContent = label;
          const obj = new CSS2DObject(el);
          const [cx, cy] = centroid(room.polygon);
          obj.position.set(cx, 0.02, -cy);
          obj.center.set(0.5, 0.5);
          group.add(obj);
          this.cssObjects.push({ obj, floorId: f.id, kind: 'label' });
        }
      }
      for (const w of walls ? wallSegments(own.map((r) => r.room)) : []) {
        const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
        const len = Math.hypot(dx, dy);
        const box = new THREE.Mesh(new THREE.BoxGeometry(len + WALL_THICKNESS, wallHeight, WALL_THICKNESS), wallMat);
        box.position.set((w.a[0] + w.b[0]) / 2, wallHeight / 2, -(w.a[1] + w.b[1]) / 2);
        box.rotation.y = Math.atan2(dy, dx);
        group.add(box);
      }
      this.staticGroup.add(group);
    }
    this._bounds = this._sceneBounds();
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // markers: [{id, element, x, y, z, floorId}]
  setMarkers(markers) {
    for (const { obj } of this.markerObjects.values()) this._removeCss(obj);
    this.markerObjects.clear();
    this.cssObjects = this.cssObjects.filter((c) => c.kind !== 'marker');
    for (const m of markers) {
      const obj = new CSS2DObject(m.element);
      obj.position.copy(planToWorld(m.x, m.y, m.z, this.floorElevation(m.floorId)));
      this.markerGroup.add(obj);
      this.markerObjects.set(m.id, { obj, floorId: m.floorId });
      this.cssObjects.push({ obj, floorId: m.floorId, kind: 'marker', id: m.id });
    }
    if (this._stemsOn) this._buildStems();
    this._occSig = null; // new elements carry no occlusion state yet
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Edit mode: a thin vertical line from every shown marker down to its floor plus a small disc
  // on the floor, so a marker at mounting height reads as standing over one spot while orbiting.
  setStems(on) {
    this._stemsOn = !!on;
    if (on) this._buildStems();
    else this._disposeStems();
    this._applyFloorVisibility();
    this.dirty = true;
  }

  _stemColor() {
    const c = new THREE.Color('#03a9f4');
    try {
      const css = getComputedStyle(this.container).getPropertyValue('--primary-color').trim();
      if (/^(#|rgba?\(|hsla?\()/i.test(css)) c.setStyle(css);
    } catch { /* detached or unparsable: keep the fallback */ }
    return c;
  }

  _buildStems() {
    this._disposeStems();
    const color = this._stemColor();
    const res = {
      lineGeo: new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
      discGeo: new THREE.CircleGeometry(0.08, 24).rotateX(-Math.PI / 2),
      lineMat: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }),
      discMat: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
    };
    this._stemRes = res;
    for (const [id, m] of this.markerObjects) {
      const line = new THREE.Line(res.lineGeo, res.lineMat);
      const disc = new THREE.Mesh(res.discGeo, res.discMat);
      line.renderOrder = disc.renderOrder = 3;
      line.userData.stemId = disc.userData.stemId = id;
      line.userData.helper = disc.userData.helper = true;
      this.stemGroup.add(line, disc);
      this.stems.set(id, { line, disc });
      this._placeStem(id, m.obj.position, m.floorId);
    }
  }

  _placeStem(id, world, floorId) {
    const st = this.stems.get(id);
    if (!st) return;
    const floor = this.floorElevation(floorId);
    const h = Math.max(world.y - floor, 0);
    st.line.position.set(world.x, floor, world.z);
    st.line.scale.set(1, Math.max(h, 1e-4), 1);
    st.line.userData.height = h;
    st.disc.position.set(world.x, floor + 0.05, world.z); // above room fills (+0.02), glows, trail
    st.line.visible = st.disc.visible && h > 0.01;
  }

  _disposeStems() {
    for (const { line, disc } of this.stems.values()) this.stemGroup.remove(line, disc);
    this.stems.clear();
    if (this._stemRes) {
      for (const r of Object.values(this._stemRes)) r.dispose();
      this._stemRes = null;
    }
  }

  // glows: [{id, x, y, floorId, rgb, strength}] (lights that are on)
  setGlows(glows) {
    const seen = new Set();
    let changed = false;
    for (const g of glows) {
      seen.add(g.id);
      let entry = this.glows.get(g.id);
      if (!entry) {
        const mat = new THREE.MeshBasicMaterial({
          map: getGlowTexture(), transparent: true, depthWrite: false, toneMapped: false,
          blending: this.theme.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
        mesh.renderOrder = 2;
        this.glowGroup.add(mesh);
        entry = { mesh, floorId: g.floorId };
        this.glows.set(g.id, entry);
      }
      const sig = [g.x, g.y, g.floorId, this.floorElevation(g.floorId), g.rgb.join(), g.strength, this.theme.dark].join('|');
      const { mesh } = entry;
      const vis = this._glowVisible(g.id, entry);
      if (sig === entry.sig && vis === mesh.visible) continue; // nothing new for this glow
      entry.sig = sig;
      changed = true;
      entry.floorId = g.floorId;
      mesh.position.copy(planToWorld(g.x, g.y, 0.03, this.floorElevation(g.floorId)));
      mesh.visible = this._glowVisible(g.id, entry); // glows cast no shadow and hide no marker
      const r = GLOW_RADIUS * (0.6 + 0.4 * g.strength) * 2;
      mesh.scale.set(r, 1, r);
      mesh.material.color.setRGB(g.rgb[0] / 255, g.rgb[1] / 255, g.rgb[2] / 255, THREE.SRGBColorSpace);
      mesh.material.opacity = (this.theme.dark ? 0.75 : 0.55) * g.strength;
    }
    for (const [id, entry] of this.glows) {
      if (seen.has(id)) continue;
      this.glowGroup.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      this.glows.delete(id);
      changed = true;
    }
    if (changed) this.dirty = true; // per-push calls with the same glows draw nothing
  }

  setVisibleFloor(id) {
    this.setVisibleFloors(id === 'all' ? 'all' : [id]);
  }

  // ids: floor id array or 'all'. [] means 'none': all floor-bound markers/groups are hidden
  // (callers then set model flags + setCut). visibleFloor keeps the first id (or 'all') for existing callers.
  setVisibleFloors(ids) {
    const list = ids === 'all' || !Array.isArray(ids) ? null : ids;
    this._visibleSet = list ? new Set(list) : null;
    this.visibleFloor = list ? (list.length ? list[0] : 'none') : 'all';
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // flags[i] -> index.nodes[i].node.visible; null returns to the level rules.
  applyModelVisibility(index, flags) {
    this._restoreModelVisibility();
    if (flags && index) {
      index.nodes.forEach((n, i) => { n.node.visible = !!flags[i]; });
      // on only to keep a descendant (a kept lamp) visible: its own mesh neither renders, casts shadows nor
      // takes clicks (layers are per object, not inherited); restored with the visibility
      const masks = new Map();
      if (flags.selfHidden) index.nodes.forEach((n, i) => { if (flags.selfHidden[i] && n.node.isMesh) { masks.set(n.node, n.node.layers.mask); n.node.layers.mask = 0; } });
      this._modelVisibility = { index, flags, masks };
    } else {
      this._modelVisibility = null;
    }
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Set every node of the previously flagged index visible again.
  _restoreModelVisibility() {
    if (this._modelVisibility) {
      for (const n of this._modelVisibility.index.nodes) n.node.visible = true;
      for (const [node, mask] of this._modelVisibility.masks || []) node.layers.mask = mask;
    }
    this._modelVisibility = null;
  }

  // states: Map<markerId, {shown, faded}> or null (floor visibility rules). A marker (or glow)
  // whose id is missing from the map follows the floor rules.
  setMarkerStates(states) {
    this._markerStates = states || null;
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Clip height override (metres, world); null = no cut; undefined = automatic.
  setCut(height) {
    this._cutOverride = height;
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Side section: plane {normal, constant} (card world) clips everything (renderer.clippingPlanes);
  // model materials turn double-sided so cut walls read solid; markers and glows on the removed side
  // are hidden. null restores everything.
  setSection(plane) {
    if (plane) {
      if (!this.sectionClip) this.sectionClip = new THREE.Plane();
      this.sectionClip.normal.set(...plane.normal);
      this.sectionClip.constant = plane.constant;
      this.sectionClip.normalize();
      this.renderer.clippingPlanes = [this.sectionClip];
    } else {
      this.sectionClip = null;
      this.renderer.clippingPlanes = [];
    }
    this._sectionMaterials();
    this._placeSkyBodies();
    this._applyFloorVisibility(); // the section is part of the shadow / occlusion signatures
    this.dirty = true;
  }

  // double-sided model materials while the section is on (original side remembered in userData)
  _sectionMaterials() {
    if (!this.model) return;
    const on = !!this.sectionClip;
    this.model.root.traverse((o) => {
      if (!o.isMesh) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        if (on && mat.userData.sectionSide === undefined) {
          mat.userData.sectionSide = mat.side;
          mat.side = THREE.DoubleSide;
          mat.needsUpdate = true;
        } else if (!on && mat.userData.sectionSide !== undefined) {
          mat.side = mat.userData.sectionSide;
          delete mat.userData.sectionSide;
          mat.needsUpdate = true;
        }
      }
    });
  }

  // world-space bounding box of the placed model ({min, max} arrays) or null
  modelBox() {
    if (!this.model) return null;
    this.modelGroup.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(this.model.root);
    return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() };
  }

  // box framing the section: union of the storey/basement levels (the house), else the whole model
  sectionBox() {
    if (!this.model) return null;
    this.modelGroup.updateMatrixWorld(true);
    const boxes = sectionLevels(this.model.manifest.levels).map((l) => {
      const b = new THREE.Box3().setFromObject(l.node);
      return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() };
    });
    return unionBox(boxes) || this.modelBox();
  }

  // a plane given in model space (glTF scene coordinates) -> card world
  modelPlaneToWorld(plane) {
    if (!this.model) return plane;
    this.modelGroup.updateMatrixWorld(true);
    const p = new THREE.Plane(new THREE.Vector3(...plane.normal), plane.constant).applyMatrix4(this.model.root.matrixWorld);
    return { normal: p.normal.toArray(), constant: p.constant };
  }

  // a point in model world (glTF scene coordinates) -> card world, through the model's placement
  modelPointToWorld(p) {
    if (!this.model) return p;
    this.modelGroup.updateMatrixWorld(true);
    return new THREE.Vector3(...p).applyMatrix4(this.model.root.matrixWorld).toArray();
  }

  _cutAway(pos) {
    return !!this.sectionClip && this.sectionClip.distanceToPoint(pos) < 0;
  }

  getCamera() {
    if (this.mode === 'top' && this._lastCam3d) return this._lastCam3d;
    const r = (a) => a.toArray().map((x) => Math.round(x * 100) / 100);
    return { position: r(this.persp.position), target: r(this.controls.target) };
  }

  // Top view: ortho centre in plan metres + zoom (1 = 10 m half height), or null outside top mode.
  getTopCamera() {
    if (this.mode !== 'top') return null;
    const t = this.controls.target, r = (x) => Math.round(x * 100) / 100 + 0;
    return { center: [r(t.x), r(-t.z)], zoom: Math.round(topZoom(this.ortho.zoom, this._orthoHalf || 10) * 1000) / 1000 };
  }

  setTopCamera(c, { instant = false } = {}) {
    if (this.mode !== 'top' || !c) return;
    const target = new THREE.Vector3(c.center[0], this.controls.target.y, -c.center[1]);
    const zoom = orthoZoom(c.zoom, this._orthoHalf || 10);
    if (instant) {
      this._tween = null;
      this._placeOrtho(target, zoom);
    } else {
      this._tween = { top: true, t0: performance.now(), from: { target: this.controls.target.clone(), zoom: this.ortho.zoom }, to: { target, zoom } };
    }
    this.dirty = true;
  }

  _placeOrtho(target, zoom) {
    this.ortho.zoom = zoom;
    this.ortho.position.set(target.x, target.y + 60, target.z);
    this.ortho.lookAt(target);
    this.ortho.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
  }

  setCamera(cam, { instant = false } = {}) {
    if (this.mode !== '3d' || !cam) return;
    const pos = new THREE.Vector3(...cam.position), target = new THREE.Vector3(...cam.target);
    // saved cameras must not be clamped by the zoom limits; relaxed until the next fit()
    const d = pos.distanceTo(target);
    this.controls.minDistance = Math.min(this.controls.minDistance, d);
    this.controls.maxDistance = Math.max(this.controls.maxDistance, d);
    this._moveCamera(pos, target, instant);
  }

  // cam: {position, target} or null for the default framing.
  resetCamera(cam) {
    if (cam) this.setCamera(cam);
    else this.fit();
  }

  _moveCamera(pos, target, instant) {
    if (instant || !this._framed) {
      this._tween = null;
      this.persp.position.copy(pos);
      this.persp.lookAt(target);
      this._framed = true;
      this.controls.target.copy(target);
      this.controls.update();
    } else {
      this._tween = { t0: performance.now(), from: { pos: this.persp.position.clone(), target: this.controls.target.clone() }, to: { pos, target } };
    }
    this.dirty = true;
  }

  // World-space triangle vertices of a mesh (flat x,y,z list).
  meshTriangles(mesh) {
    const g = mesh.geometry;
    if (!g || !g.attributes.position) return [];
    mesh.updateWorldMatrix(true, false);
    const pos = g.attributes.position, idx = g.index, out = [], v = new THREE.Vector3();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
    return out;
  }

  // Plan-space bounding rectangle of a mesh (fallback when its floor cannot be traced).
  meshPlanRect(mesh) {
    const b = new THREE.Box3().setFromObject(mesh);
    const x0 = b.min.x, x1 = b.max.x, y0 = -b.max.z, y1 = -b.min.z;
    const r = (v) => Math.round(v / 0.05) * 0.05;
    return [[r(x0), r(y0)], [r(x1), r(y0)], [r(x1), r(y1)], [r(x0), r(y1)]].map((q) => q.map((v) => Math.round(v * 1000) / 1000));
  }

  floorElevation(floorId) {
    const f = this.floors.find((x) => x.id === floorId);
    return f ? f.elevation : 0;
  }

  _shows(floorId) {
    return this._visibleSet ? this._visibleSet.has(floorId) : this.visibleFloor === 'all' || this.visibleFloor === floorId;
  }

  _applyFloorVisibility() {
    for (const g of this.staticGroup.children) g.visible = this._shows(g.userData.floorId);
    // markers live in one group for all floors, so visibility is set per object
    const ms = this._markerStates;
    const stateOf = (id) => (ms && id !== undefined ? ms.get(id) : null);
    for (const c of this.cssObjects) c.obj.visible = this._markerVisible(c);
    for (const [id, g] of this.glows) g.mesh.visible = this._glowVisible(id, g);
    for (const [id, st] of this.stems) {
      const m = this.markerObjects.get(id);
      const shown = !!(m && m.obj.visible);
      st.disc.visible = shown;
      st.line.visible = shown && st.line.userData.height > 0.01;
    }
    for (const o of this.overlayGroup.children) if (!o.isCSS2DObject) o.visible = this._shows(o.userData.floorId);
    if (this.trail) this.trail.visible = this.trail.geometry.drawRange.count > 0 && this._mowerShows(this.trail.userData.floorId);
    if (this.warning) this._warningVisible();
    if (this.mowerChip) this.mowerChip.obj.visible = this._mowerShows(this.mowerChip.floorId);
    if (this.model) {
      const assign = this.modelLevels || {};
      if (!this._modelVisibility) {
        for (const l of this.model.manifest.levels) l.node.visible = levelVisible(assign[l.id], this.visibleFloor, (id) => this.floors.find((f) => f.id === id)?.elevation);
      }
      // everything above the cut-away height of the selected floor is clipped (roof, upper floors)
      // untagged: the top of the selected storey (wall_height is for drawn walls only)
      const vf = this.floors.find((f) => f.id === this.visibleFloor);
      const cut = this.visibleFloor === 'all' || this.isTagged() ? 1e6 : this.floorElevation(this.visibleFloor) + ((vf && vf.height) || 2.7);
      this.modelClip.constant = this._cutOverride === undefined ? cut : (this._cutOverride ?? 1e6);
      if (this.pickHelper) this.pickHelper.update();
    }
    // "top" = the highest floor that actually has markers (an empty attic must not fade everything)
    let top = null, topElev = -Infinity;
    for (const c of this.cssObjects) {
      if (c.kind !== 'marker') continue;
      const e = this.floorElevation(c.floorId);
      if (e > topElev) { topElev = e; top = c.floorId; }
    }
    for (const c of this.cssObjects) {
      if (c.kind !== 'marker') continue;
      const st = stateOf(c.id);
      c.obj.element.classList.toggle('fp-faded', st ? !!st.faded : !!this.model && this.visibleFloor === 'all' && c.floorId !== top);
    }
    if (this.mapPlane && this.mapPlane.material.map) this.mapPlane.visible = this._mapShown(this.mapPlane);
    if (this.stripeArrow) this.stripeArrow.visible = !!this.mapPlane && this.mapPlane.visible;
    // shadow map and occlusion only when their inputs changed (not on every state update)
    const model = this._modelSig();
    if (model !== this._shadowSig) {
      this._shadowSig = model;
      if (this.model) this._shadowDirty();
      this._objectsInvalid(); // lamps on hidden levels give their pool lights to visible ones
    }
    const occ = model + '|' + this.mode + '|' + this._shownMarkersSig();
    if (occ !== this._occSig) {
      this._occSig = occ;
      this._scheduleOcclusion(0);
    }
  }

  // css object (marker, label, handle) visibility: marker state, else its floor; section cut
  _markerVisible(c) {
    const st = c.kind === 'marker' && this._markerStates && c.id !== undefined ? this._markerStates.get(c.id) : null;
    const floorRule = c.kind === 'marker' && c.id === this.mowerMarkerId ? this._mowerShows(c.floorId) : this._shows(c.floorId);
    return (st ? !!st.shown : floorRule) && !(c.kind !== 'handle' && this._cutAway(c.obj.position));
  }

  _glowVisible(id, g) {
    const st = this._markerStates ? this._markerStates.get(id) : null;
    return (st ? !!st.shown : this._shows(g.floorId)) && !this._cutAway(g.mesh.position);
  }

  // What the shadow map depends on: the model, which of its nodes are shown, the cut, the section.
  _modelSig() {
    if (!this.model) return '';
    const mv = this._modelVisibility;
    const vis = mv ? mv.index.nodes.map((n) => (n.node.visible ? 1 : 0)).join('')
      : this.model.manifest.levels.map((l) => (l.node.visible ? 1 : 0)).join('');
    const s = this.sectionClip;
    return [this.model.id, vis, this.modelClip.constant, s ? [...s.normal.toArray(), s.constant].map((v) => v.toFixed(4)).join() : ''].join('|');
  }

  // Shown markers and where they are (occlusion input).
  _shownMarkersSig() {
    const out = [];
    for (const c of this.cssObjects) {
      if (c.kind !== 'marker' || !c.obj.visible) continue;
      const p = c.obj.position;
      out.push(`${c.id}@${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
    }
    return out.join(';');
  }

  // The shadow casters changed (model, visibility, cut, section): the sun's map (while it is up) and
  // every lit pool shadow map. Dark lights are redrawn when they light up.
  _shadowDirty() {
    this._sunShadow();
    if (this.objectLayer) this._flagShadows(this.objectLayer.shadowsStale());
    this.stats.shadow++;
  }

  // Sun map: redraw now when the sun is up, else once it rises (setSky).
  _sunShadow() {
    if (this.sun.intensity > 0) {
      this._sunStale = false;
      this._flagShadows([this.sun]);
    } else {
      this._sunStale = true;
    }
  }

  _flagShadows(lights) {
    if (!lights || !lights.length) return;
    for (const l of lights) l.shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.stats.shadowLights += lights.length;
  }

  markDirty() {
    this.dirty = true;
  }

  // lights: the pool lights whose shadow maps must be redrawn (lit, moved or reassigned).
  requestShadowUpdate(lights) {
    this._flagShadows(lights);
    this.stats.shadow++;
    this.dirty = true;
  }

  _objectsInvalid() {
    if (this.onObjectsInvalidate && this.model) this.onObjectsInvalidate();
  }

  // The 3D camera before switching to Top (null until then).
  get lastCamera3d() {
    return this._lastCam3d || null;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (this.mode === '3d') this._lastCam3d = this.getCamera();
    this.mode = mode;
    this.camera = mode === 'top' ? this.ortho : this.persp;
    if (mode === 'top') { this._cancelOcclusion(); this._clearOcclusion(); } // no occlusion in top view
    this._makeControls();
    this.fit();
    if (mode === '3d') this._scheduleOcclusion(0);
  }

  // Frame the rooms of the visible floor(s); the model when there are no rooms (or asked to).
  fit({ model = false, instant = false } = {}) {
    const box = new THREE.Box3();
    if (!model) {
      // rooms as data (independent of fills/outlines/walls flags), on the visible floors
      for (const { room, floorId } of this._rooms || []) {
        if (!this._shows(floorId) || !room.polygon || room.polygon.length < 3) continue;
        const f = this.floors.find((x) => x.id === floorId);
        const y0 = f ? f.elevation : 0, y1 = y0 + ((f && f.height) || 2.7);
        for (const [x, y] of room.polygon) {
          box.expandByPoint(new THREE.Vector3(x, y0, -y));
          box.expandByPoint(new THREE.Vector3(x, y1, -y));
        }
      }
    }
    if (box.isEmpty() && this.model) {
      // only the parts currently shown, and not above the cut
      this.modelGroup.updateMatrixWorld(true);
      this.model.root.traverse((o) => {
        if (!o.isMesh) return;
        for (let p = o; p; p = p.parent) if (!p.visible) return;
        const b = new THREE.Box3().setFromObject(o);
        // a world ground plane or a long road would frame the whole neighbourhood
        if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) > MAX_FRAME_MESH_M) return;
        b.max.y = Math.min(b.max.y, this.modelClip.constant);
        if (b.min.y <= b.max.y) box.union(b);
      });
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 0, 5));
    if (this.mode === 'top' && this.model && this._skyOn) { // top view: the house, plus a visible sun / moon disc (the ring may be cut)
      this._placeSkyBodies();
      for (const [s, disc] of [[this.skySprites.sun, SUN_DISC_M], [this.skySprites.moon, MOON_DISC_M]]) {
        if (!s || !s.visible) continue;
        const r = disc / 2 + SKY_FRAME_MARGIN_M;
        box.expandByPoint(new THREE.Vector3(s.position.x - r, box.min.y, s.position.z - r));
        box.expandByPoint(new THREE.Vector3(s.position.x + r, box.min.y, s.position.z + r));
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const aspect = this.size.w / this.size.h;
    const target = center.clone();
    this._minDistance = Math.max(size.x, size.z) < 10 ? 1 : 4;
    if (this.mode === '3d') { this.controls.minDistance = this._minDistance; this.controls.maxDistance = 130; }
    if (this.visibleFloor !== 'all') target.y = this.floorElevation(this.visibleFloor);

    if (this.mode === 'top') {
      const { h } = this.size;
      const half = Math.max(size.z / 2, size.x / 2 / aspect) * 1.08 * ((h + TOOLBAR_PX) / Math.max(h - TOOLBAR_PX, 1));
      this._tween = null;
      this._orthoHalf = half;
      this._updateOrtho();
      this.ortho.zoom = 1;
      this.ortho.position.set(target.x, target.y + 60, target.z);
      this.ortho.lookAt(target);
      this.ortho.updateProjectionMatrix();
    } else {
      const dir = this.model
        ? new THREE.Vector3(0.42, 0.616, 0.69).normalize() // 3/4 view
        : new THREE.Vector3(0.18, 0.95, 0.75).normalize(); // from the south, high up
      const corners = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
      // start far, then shrink until the projected corners fill ~85 % of the view
      let dist = Math.max(size.x, size.z, 4) * 3;
      for (let i = 0; i < 6; i++) {
        this.persp.position.copy(target).addScaledVector(dir, dist);
        this.persp.lookAt(target);
        this.persp.updateMatrixWorld();
        let extent = 0;
        for (const c of corners) {
          const p = c.clone().project(this.persp);
          extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
        }
        dist *= extent / 0.85;
      }
      const to = { pos: target.clone().addScaledVector(dir, dist), target: target.clone() };
      this._bounds = this._sceneBounds();
      this._moveCamera(to.pos, to.target, instant);
      this._updateDepth();
      return;
    }
    this.controls.target.copy(target);
    this.controls.update();
    this._bounds = this._sceneBounds();
    this._updateDepth();
    this.dirty = true;
  }

  // Depth-range bounds: the house box (rooms + model meshes up to 60 m) and the bounding sphere of
  // everything (terrain included).
  _sceneBounds() {
    const house = new THREE.Box3(), full = new THREE.Box3();
    for (const { room, floorId } of this._rooms || []) {
      if (!room.polygon || room.polygon.length < 3) continue;
      const f = this.floors.find((x) => x.id === floorId);
      const y0 = f ? f.elevation : 0, y1 = y0 + ((f && f.height) || 2.7);
      for (const [x, y] of room.polygon) house.expandByPoint(new THREE.Vector3(x, y0, -y)).expandByPoint(new THREE.Vector3(x, y1, -y));
    }
    full.union(house);
    if (this.model) {
      this.modelGroup.updateMatrixWorld(true);
      this.model.root.traverse((o) => {
        if (!o.isMesh) return;
        const b = new THREE.Box3().setFromObject(o);
        full.union(b);
        if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) <= MAX_FRAME_MESH_M) house.union(b);
      });
    }
    if (full.isEmpty()) full.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
    if (house.isEmpty()) house.copy(full);
    const sphere = full.getBoundingSphere(new THREE.Sphere());
    return { house, centre: sphere.center, radius: Math.max(sphere.radius, 5) };
  }

  // Near / far from the camera position (depth precision where the model is); only on > 1 % changes.
  _updateDepth() {
    const cam = this.camera, ortho = cam === this.ortho;
    const b = this._bounds || (this._bounds = this._sceneBounds());
    const p = cam.position;
    const next = depthRange({
      target: p.distanceTo(this.controls.target), house: b.house.distanceToPoint(p),
      centre: p.distanceTo(b.centre), radius: b.radius, ortho,
    });
    const d = this._dome;
    let needed = Math.round((p.distanceTo(b.centre) + Math.min(b.radius, 1e5)) * 1050) / 1000;
    if (d && this._skyOn && this.model && !ortho) {
      const dome = Math.round((p.distanceTo(d.centre) + d.radius + SUN_DISC_M) * 1050) / 1000; // the dome stays in front of far
      next.far = Math.max(next.far, dome);
      needed = Math.max(needed, dome);
    }
    if (!ortho && this.model && this.render.camera) next.far = recipeFar(next.far, needed, this.render.camera.far); // the recipe's far: an upper bound only
    if (!depthChanged({ near: cam.near, far: cam.far }, next)) return;
    cam.near = next.near;
    cam.far = next.far;
    cam.updateProjectionMatrix();
  }

  // Card option `occlusion`: markers behind model walls are dimmed (class fp-occluded).
  setOcclusion(on) {
    this._occlusion = on !== false;
    this._scheduleOcclusion(0);
  }

  // Occlusion pass once the camera has been still for 150 ms (debounced; never per frame). A new
  // schedule cancels the pending timer and any pass still running in slices.
  // id: only that marker (a moving live marker); a pending or running full pass already covers it.
  // Nothing runs while the card is detached (start() schedules a full pass again).
  _scheduleOcclusion(delay = OCCLUSION_DELAY_MS, id = null) {
    if (this._disposed || !this._raf) return;
    if (id !== null) {
      if (this._occFull) return;
      (this._occIds = this._occIds || new Set()).add(id);
    } else {
      this._occFull = true;
      this._occIds = null;
    }
    if (this._occTimer) clearTimeout(this._occTimer);
    this._occGen++;
    this._occTimer = setTimeout(() => this._runOcclusion(), delay);
  }

  _cancelOcclusion() {
    if (this._occTimer) clearTimeout(this._occTimer);
    this._occTimer = null;
    this._occGen++;
    this._occFull = false;
    this._occIds = null;
  }

  _clearOcclusion() {
    for (const c of this.cssObjects) if (c.kind === 'marker') c.obj.element.classList.remove('fp-occluded');
  }

  // World boxes of the model meshes that can hide a marker (not glass / see-through), cached.
  _occluders() {
    if (this._occBoxes) return this._occBoxes;
    this.modelGroup.updateMatrixWorld(true);
    const out = [];
    this.model.root.traverse((o) => {
      if (!o.isMesh || o.userData.seeThrough || o.userData.helper) return;
      const box = new THREE.Box3().setFromObject(o);
      if (!box.isEmpty()) out.push({ mesh: o, box });
    });
    this._occBoxes = out;
    return out;
  }

  // True when visible model geometry (not glass, not `own`'s meshes, below the cut, section respected)
  // hides a world point from the camera: object taps skip lamps behind walls. One raycast.
  pointHidden(world, own = null) {
    if (!this.model || (this.model.opacity ?? 1) < 0.6) return false; // a see-through model hides nothing
    const cam = this.camera;
    cam.updateMatrixWorld();
    const ndc = world.clone().project(cam);
    const rc = this._tapRay || (this._tapRay = new THREE.Raycaster());
    rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    const origin = rc.ray.origin, dist = origin.distanceTo(world);
    rc.near = 0;
    rc.far = dist; // isOccluded keeps a margin in front of the point
    const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const ownMesh = (o) => { for (let p = o; p && own; p = p.parent) if (p === own) return true; return false; };
    const cut = this.modelClip.constant, tmp = new THREE.Vector3();
    for (const { mesh, box } of this._occluders()) {
      if (ownMesh(mesh) || !shown(mesh)) continue;
      if (!box.containsPoint(origin)) {
        const at = rc.ray.intersectBox(box, tmp);
        if (!at || origin.distanceTo(at) > rc.far) continue;
      }
      const h = rc.intersectObject(mesh, false).find((x) => x.point.y <= cut + 1e-6 && !this._cutAway(x.point));
      if (h && isOccluded(h.distance, dist)) return true;
    }
    return false;
  }

  _runOcclusion() {
    this._occTimer = null;
    if (this._disposed) return;
    const full = this._occFull, ids = this._occIds;
    if (!this._occlusion || this.mode !== '3d' || !this.model || (this.model.opacity ?? 1) < 0.6) {
      this._occFull = false;
      this._occIds = null;
      this._clearOcclusion();
      return;
    }
    const since = performance.now() - (this._camMovedAt || 0);
    if (since < OCCLUSION_DELAY_MS) {
      const wait = OCCLUSION_DELAY_MS - since;
      if (full) this._scheduleOcclusion(wait);
      else { this._occIds = null; for (const id of ids || []) this._scheduleOcclusion(wait, id); }
      return;
    }
    this._occIds = null;
    if (full) this.stats.occPasses++;
    else this.stats.occPartial++;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const boxes = this._occluders().filter((b) => shown(b.mesh));
    const shownMarkers = this.cssObjects.filter((c) => c.kind === 'marker' && c.obj.visible && (full || (ids && ids.has(c.id))));
    const markers = shownMarkers.slice(0, OCCLUSION_MAX);
    // past the budget: not tested, so not dimmed (a stale fp-occluded would leave them unclickable)
    for (const c of shownMarkers.slice(OCCLUSION_MAX)) c.obj.element.classList.remove('fp-occluded');
    const gen = this._occGen;
    const rc = this._occRay, pos = new THREE.Vector3(), dir = new THREE.Vector3(), tmp = new THREE.Vector3();
    const cut = this.modelClip.constant;
    let i = 0;
    const slice = () => {
      this._occTimer = null;
      if (this._disposed || gen !== this._occGen) return; // cancelled (camera, view, model, dispose)
      const t0 = performance.now();
      for (; i < markers.length; i++) {
        if (performance.now() - t0 > OCCLUSION_SLICE_MS) { this._occTimer = setTimeout(slice, 0); return; }
        const c = markers[i];
        if (!c.obj.parent) continue; // removed meanwhile
        c.obj.getWorldPosition(pos);
        const dist = origin.distanceTo(pos);
        rc.set(origin, dir.subVectors(pos, origin).normalize());
        rc.near = 0;
        rc.far = Math.max(dist - 0.3, 0);
        let hitD = null;
        for (const { mesh, box } of boxes) {
          if (!box.containsPoint(origin)) { // inside the box: the ray may hit it anywhere, test the mesh
            const at = rc.ray.intersectBox(box, tmp);
            if (!at || origin.distanceTo(at) > rc.far) continue; // box pre-filter
          }
          const h = rc.intersectObject(mesh, false).find((x) => x.point.y <= cut + 1e-6 && !this._cutAway(x.point));
          if (h) { hitD = h.distance; break; }
        }
        c.obj.element.classList.toggle('fp-occluded', isOccluded(hitD, dist));
      }
      if (full) { this._occFull = false; this.stats.occDone++; }
    };
    slice();
  }

  _stepTween(now) {
    const tw = this._tween;
    const t = Math.min(1, (now - tw.t0) / 400);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    if (tw.top) {
      if (this.mode !== 'top') { this._tween = null; return; }
      this._placeOrtho(new THREE.Vector3().lerpVectors(tw.from.target, tw.to.target, e), tw.from.zoom + (tw.to.zoom - tw.from.zoom) * e);
      this.dirty = true;
      if (t === 1) this._tween = null;
      return;
    }
    this.persp.position.lerpVectors(tw.from.pos, tw.to.pos, e);
    this.controls.target.lerpVectors(tw.from.target, tw.to.target, e);
    this.controls.update();
    this.dirty = true;
    if (t === 1) this._tween = null;
  }

  _updateOrtho() {
    const half = this._orthoHalf || 10;
    const { w, h } = this.size;
    const aspect = w / (h + TOOLBAR_PX);
    Object.assign(this.ortho, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.ortho.setViewOffset(w, h + TOOLBAR_PX, 0, 0, w, h);
  }

  // Screen pixels per plan metre at the orbit target.
  pixelsPerMetre() {
    const { h } = this.size;
    if (this.mode === 'top') return (h * this.ortho.zoom) / (this.ortho.top - this.ortho.bottom);
    const dist = this.persp.position.distanceTo(this.controls.target);
    return h / (2 * dist * Math.tan((this.persp.fov * Math.PI) / 360));
  }

  resize(w, h) {
    if (!w || !h) return;
    this.size = { w, h };
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    // render the top part of a taller view, so the scene centre sits below the toolbar
    this.persp.aspect = w / (h + TOOLBAR_PX);
    this.persp.setViewOffset(w, h + TOOLBAR_PX, 0, 0, w, h);
    this._updateOrtho();
    this.dirty = true;
  }

  start() {
    if (this._raf) return;
    const loop = (ts) => {
      this._raf = requestAnimationFrame(loop);
      if (this.onTick) this.onTick(ts); // debug overlay: frame gaps
      if (this._tween) this._stepTween(performance.now());
      if (this.controls.update()) this.dirty = true; // damping still moving
      if (this.pivotMarker && !this.pivotMarker.position.equals(this.controls.target)) {
        this.pivotMarker.position.copy(this.controls.target);
        this.dirty = true;
      }
      if (this.pivotMarker && this.pivotMarker.visible === !!this.sectionClip) {
        this.pivotMarker.visible = !this.sectionClip; // no rotation-centre cross over the section camera
        this.dirty = true;
      }
      this._driftClouds();
      if (!this.dirty) return;
      this.dirty = false;
      this.stats.frames++;
      const t0 = this.onFrameTime ? performance.now() : 0;
      this._updateDepth();
      this._placeSkyBodies();
      this.labelRenderer.domElement.classList.toggle('compact', this.pixelsPerMetre() < COMPACT_PPM);
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
      if (this.onRender) this.onRender(); // e.g. the object popup follows its anchor
      if (this.onFrameTime) this.onFrameTime(performance.now() - t0);
    };
    this._raf = requestAnimationFrame(loop);
    this._scheduleOcclusion(0);
  }

  // Cloud drift: at most one frame per CLOUD_FRAME_MS, only while clouds show (3D, coverage > 0), the
  // card is on screen, the page visible and a cloud is inside the camera frustum.
  _driftClouds() {
    const w = this.weather;
    if (!w.shown || !this.onScreen || this.mode === 'top' || (this.test && !this.test.drift) || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) { w.frameAt = 0; return; }
    const now = performance.now();
    if (!w.frameAt) { w.frameAt = now; return; }
    if (now - w.frameAt < CLOUD_FRAME_MS) return;
    const dt = Math.min(1, (now - w.frameAt) / 1000);
    w.frameAt = now;
    if (!this._cloudsInView()) return; // time stands still off-frame: nothing to draw
    w.t += dt;
    this.stats.cloudFrames++;
    this.dirty = true;
  }

  _cloudsInView() {
    const cam = this.camera, f = this._cloudFrustum || (this._cloudFrustum = new THREE.Frustum());
    const m = this._cloudMat || (this._cloudMat = new THREE.Matrix4());
    cam.updateMatrixWorld();
    f.setFromProjectionMatrix(m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const sph = this._cloudSphere || (this._cloudSphere = new THREE.Sphere());
    return (this._cloudSprites || []).some((s) => {
      if (!s.visible) return false;
      sph.center.copy(s.position);
      sph.radius = s.scale.x / 2;
      return f.intersectsSphere(sph);
    });
  }

  setOnScreen(on) {
    this.onScreen = !!on;
    if (on) this.dirty = true;
  }

  stop() {
    this.weather.frameAt = 0;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._cancelOcclusion(); // a detached card runs no passes
  }

  _removeCss(obj) {
    if (obj.parent) obj.parent.remove(obj);
    // removing the object does not reliably remove its DOM element
    if (obj.element && obj.element.parentNode) obj.element.parentNode.removeChild(obj.element);
  }

  _clearGroup(group) {
    group.traverse((o) => {
      if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    group.clear();
  }

  dispose() {
    this.stop();
    this.setMowerChip(null);
    this._disposed = true;
    this._cancelOcclusion();
    this.renderer.domElement.removeEventListener('wheel', this._onWheel);
    this.controls.dispose();
    this._clearGroup(this.staticGroup);
    this._clearGroup(this.markerGroup);
    this._clearGroup(this.glowGroup);
    this._clearGroup(this.overlayGroup);
    this._disposeStems();
    this.setPivotMarker(false);
    this._disposeModel();
    if (this._preview) { this._clearGroup(this._preview); this.scene.remove(this._preview); this._preview = null; }
    if (this.objectLayer) this.objectLayer.dispose();
    this.onObjectsInvalidate = null;
    this.setMapOverlay(null);
    this._disposeTrail();
    this.setMowerWarning(null);
    for (const s of Object.values(this.skySprites)) {
      if (!s) continue;
      if (s.material.map !== sunTexture) s.material.map.dispose();
      s.material.dispose();
    }
    this.skySprites = { sun: null, moon: null };
    if (this._cloudMats) for (const m of this._cloudMats) m.dispose(); // the textures are shared per page
    this._cloudMats = null;
    this._cloudSprites = null;
    if (this.skyRing) {
      this.skyRing.traverse((o) => { if (o.material && o.material.map) o.material.map.dispose(); });
      this._clearGroup(this.skyRing);
    }
    this.skyRing = null;
    this.markerObjects.clear();
    this.glows.clear();
    this.cssObjects = [];
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}
