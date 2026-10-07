// Builds demo/house.glb from the demo layout, tagged with fp userData (see docs/model-builder-guide.md):
// one wrapper group "house" carrying the model's views (fp.views), storey levels (level0 / level1)
// with a tagged room group per room, furniture on the "furniture" layer, a thin ceiling slab per
// storey on the "ceiling" layer (inside the storey above), an exterior level with the outdoor zones,
// a roof level, model objects (ceiling lamps, a facade lamp group, a spot, a light strip, climate, mower,
// dock, EV charger) and a window pane on the glass layer. Run: node scripts/make-demo-model.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { DEMO_LAYOUT } from '../demo/layout.js';
import { wallSegments } from '../src/layout.js';

// GLTFExporter reads blobs with FileReader, which Node lacks
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((r) => { this.result = r; this.onloadend && this.onloadend(); }); }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((r) => {
      this.result = `data:${blob.type};base64,` + Buffer.from(r).toString('base64');
      this.onloadend && this.onloadend();
    });
  }
};

// GLTFExporter draws textures on a canvas: a stub that keeps the RGBA data and writes it as a PNG
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { translate() {}, scale() {}, putImageData: (d) => { this.img = d; } }; }
  async convertToBlob() { return new Blob([encodePng(this.img)], { type: 'image/png' }); }
};
function encodePng({ data, width, height }) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => {
    const t = Buffer.concat([Buffer.from(type), body]), out = Buffer.alloc(t.length + 8);
    out.writeUInt32BE(body.length, 0); t.copy(out, 4); out.writeUInt32BE(crc(t), t.length + 4);
    return out;
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const floors = { ground: { elevation: 0, height: 2.7 }, first: { elevation: 3, height: 2.6 } };
const floorOf = (r) => r.floor_id || (['r-kids', 'r-landing', 'r-office', 'r-master', 'r-bath2'].includes(r.id) ? 'first' : 'ground');
const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
const slabMat = mat(0xd9cfc1), wallMat = mat(0xf2efe9), woodMat = mat(0x9b7653), fabricMat = mat(0x6f86a6), roofMat = mat(0x7a4b3a);

const scene = new THREE.Scene();
// the exporter writes the scene's children as top nodes: one wrapper keeps the views on a single root
const house = new THREE.Group();
house.name = 'house';
house.userData.fp = {
  // render recipe: what the card applies (tone mapping, camera, shadows, day / night light); see the guide
  render: {
    toneMapping: 'ACESFilmic', exposure: 1.1, outputColorSpace: 'srgb', pixelRatioMax: 1.5, anisotropy: 8,
    camera: { fov: 38, near: 0.3, far: 260 },
    sun: { shadowMapSize: 2048, bias: -0.0003, normalBias: 0.02 },
    lampShadows: { max: 6, mapSize: 1024, bias: -0.0008, normalBias: 0.04, radius: 3 },
    day: { hemi: ['#c4d6ff', '#2a2520', 0.9], sun: ['#fff0dc', 2.6] },
    night: { hemi: ['#9fb4e0', '#1a1714', 0.14], sun: ['#fff0dc', 0] },
    glowIntensityPerBrightness: 3,
  },
  views: [
    { id: 'exterior', label: 'Exterior', show: ['all'] },
    { id: 'ground', label: 'Ground floor', show: ['level:level0', 'role:exterior'], hide: ['role:roof'] },
    { id: 'first', label: 'First floor', show: ['level:level0', 'level:level1', 'role:exterior'], hide: ['role:roof'] },
  ],
};
scene.add(house);
for (const [id, f] of Object.entries(floors)) {
  const g = new THREE.Group();
  g.name = id === 'ground' ? 'level0' : 'level1'; // ids deliberately differ from HA floor ids
  g.userData.fp = { kind: 'level', id: g.name, role: 'storey', order: id === 'ground' ? 0 : 1, elevation: f.elevation, height: f.height };
  const rooms = DEMO_LAYOUT.rooms.filter((r) => floorOf(r) === id);
  for (const r of rooms.filter((x) => !x.outdoor)) {
    const shape = new THREE.Shape(r.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false }), slabMat);
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = f.elevation - 0.2;
    slab.name = 'slab:' + r.area_id;
    const rg = new THREE.Group();
    rg.name = r.area_id;
    rg.userData.fp = { kind: 'room', id: r.area_id, outline: r.polygon, doors: r.doors || [], suggest: { area: r.area_id } };
    rg.add(slab);
    g.add(rg);
  }
  for (const w of wallSegments(rooms)) {
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
    const wall = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(dx, dy) + 0.15, f.height, 0.15), wallMat);
    wall.position.set((w.a[0] + w.b[0]) / 2, f.elevation + f.height / 2, -(w.a[1] + w.b[1]) / 2);
    wall.rotation.y = Math.atan2(dy, dx);
    g.add(wall);
  }
  house.add(g);
}
const furniture = [
  ['sofa', 'ground', fabricMat, [1.2, 3.0], [2.2, 0.9, 0.45]],
  ['coffee_table', 'ground', woodMat, [2.6, 1.6], [1.2, 0.7, 0.45]],
  ['kitchen_table', 'ground', woodMat, [10.5, 2.5], [1.6, 0.9, 0.75]],
  ['bed', 'ground', fabricMat, [2.5, 7.5], [1.8, 2.0, 0.5]],
  ['master_bed', 'first', fabricMat, [2.5, 7.0], [1.6, 2.0, 0.5]],
  ['desk', 'first', woodMat, [10.5, 1.0], [1.6, 0.8, 0.75]],
];
// each piece is a named group on the furniture layer, so a click in 3D picks the piece
for (const [name, fid, m, [x, y], [w, d, h]] of furniture) {
  const piece = new THREE.Group();
  piece.name = name;
  piece.userData.fp = { layer: 'furniture' };
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  box.name = name + '_body';
  box.position.set(x, floors[fid].elevation + h / 2, -y);
  piece.add(box);
  house.getObjectByName(fid === 'ground' ? 'level0' : 'level1').add(piece);
}
// a window pane on the south facade (glass layer: casts no sun shadow, does not hide markers)
const pane = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 0.02),
  new THREE.MeshStandardMaterial({ color: 0xaaccee, roughness: 0.1, transparent: true, opacity: 0.35, name: 'glass' }));
pane.name = 'window_pane_living';
pane.userData.fp = { layer: 'glass' };
pane.position.set(1.3, 1.5, 0.09);
house.getObjectByName('level0').add(pane);
// ceilings: a thin slab under the next storey up, kept in that storey so it hides with it
const ceiling = (name, top, parent) => {
  const c = new THREE.Mesh(new THREE.BoxGeometry(12, 0.04, 9), mat(0xf7f5f0));
  c.name = name;
  c.position.set(6, top - 0.02, -4.5);
  c.userData.fp = { layer: 'ceiling' };
  parent.add(c);
};
// exterior level: the outdoor rooms as zones (one slab each)
const ext = new THREE.Group();
ext.name = 'exterior';
ext.userData.fp = { kind: 'level', id: 'exterior', role: 'exterior' };
for (const z of DEMO_LAYOUT.rooms.filter((x) => x.outdoor)) {
  const shape = new THREE.Shape(z.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
  const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false }), mat(0x9bb58a));
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = -0.1;
  slab.name = 'slab:' + z.area_id;
  const zg = new THREE.Group();
  zg.name = z.area_id;
  zg.userData.fp = { kind: 'zone', id: z.area_id, outline: z.polygon, doors: z.doors || [], suggest: { area: z.area_id } };
  zg.add(slab);
  ext.add(zg);
}
// ---- model objects (fp kind: object), see docs/model-builder-guide.md "Objects" ----
// glow meshes start dark (the card makes them emissive); one glow mesh per fixture
const glowMat = () => new THREE.MeshStandardMaterial({ color: 0xfff6e0, roughness: 0.4, emissive: 0x000000 });
const darkMat = mat(0x333333), metalMat = mat(0x8a8f96);
// an object node at plan (x, y), height z: a body mesh plus named child meshes (glow / led)
const object = (parent, fp, [x, y, z], parts) => {
  const g = new THREE.Group();
  g.name = fp.id;
  g.userData.fp = { kind: 'object', ...fp };
  g.position.set(x, z, -y);
  for (const [name, geo, m, [px, py, pz] = [0, 0, 0]] of parts) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.name = name;
    mesh.position.set(px, py, pz);
    g.add(mesh);
  }
  parent.add(g);
  return g;
};
const level0 = house.getObjectByName('level0');
const room = (area) => level0.getObjectByName(area);
// three ceiling lamps, one per room: a disc with a small glowing bulb under it
const CEILING = { beam: 'point', max: 20, distance: 8, decay: 2 };
for (const [id, label, area, at, entity] of [
  ['lamp_living', 'Living ceiling lamp', 'living_room', [2.5, 2.5], 'light.demo_living'],
  ['lamp_hall', 'Hall ceiling lamp', 'hall', [6.25, 2.5], 'light.demo_hall'],
  ['lamp_kitchen', 'Kitchen ceiling lamp', 'kitchen', [10, 2.5], 'light.demo_kitchen'],
]) {
  object(room(area), { id, type: 'light', label, glow: 'glow', hints: CEILING, suggest: { entity } }, [...at, 2.62], [
    [id + '_body', new THREE.CylinderGeometry(0.18, 0.18, 0.04, 16), metalMat],
    ['glow', new THREE.SphereGeometry(0.05, 12, 8), glowMat(), [0, -0.06, 0]],
  ]);
}
// a light strip under the kitchen cabinets: the whole strip is the glow mesh, no real light (no hints.max)
object(room('kitchen'), { id: 'kitchen_strip', type: 'light_strip', label: 'Kitchen strip', glow: 'strip', suggest: { entity: 'light.demo_strip' } },
  [9.75, 4.8, 0.9], [['strip', new THREE.BoxGeometry(3, 0.02, 0.03), glowMat()]]);
// a wall climate unit in the living room (label with the current temperature)
object(room('living_room'), { id: 'climate_living', type: 'climate', label: 'Living climate', glow: 'glow', suggest: { entity: 'climate.demo_living' } },
  [2.5, 4.82, 2.2], [
    ['climate_living_body', new THREE.BoxGeometry(0.8, 0.25, 0.2), mat(0xf4f4f4)],
    ['glow', new THREE.BoxGeometry(0.6, 0.02, 0.01), glowMat(), [0, -0.08, 0.1]],
  ]);
// facade: three wall lamps on the south wall, one circuit (group), downlights without shadows; the first one is
// nested in the terrace zone (as exporters do with lamps above a paved area: hiding the zone must keep it)
for (const [i, x] of [4, 6.25, 8.5].entries()) {
  object(i === 0 ? ext.getObjectByName('terrace') : ext, {
    id: `facade_${i + 1}`, type: 'light', label: `Facade lamp ${i + 1}`, group: 'facade', glow: 'glow',
    hints: { beam: 'down', max: 5, distance: 6, decay: 2, castShadow: false, offset: [0, 0, 0.1] },
    suggest: { entity: 'light.demo_facade' },
  }, [x, -0.12, 2.3], [
    [`facade_${i + 1}_body`, new THREE.BoxGeometry(0.12, 0.22, 0.09), darkMat],
    ['glow', new THREE.SphereGeometry(0.04, 12, 8), glowMat(), [0, -0.08, 0.05]],
  ]);
}
// two uplights at the foot of the south wall (group, beam up: spots aimed straight up the facade)
for (const [i, x] of [5.1, 7.4].entries()) {
  object(ext, {
    id: `wall_uplight_${i + 1}`, type: 'light', label: `Wall uplight ${i + 1}`, group: 'uplights', glow: 'glow',
    hints: { beam: 'up', max: 6, distance: 4, decay: 2, angle: 24, castShadow: false },
    suggest: { entity: 'light.demo_facade' },
  }, [x, -0.3, 0], [
    [`wall_uplight_${i + 1}_body`, new THREE.CylinderGeometry(0.06, 0.07, 0.08, 12), darkMat, [0, 0.04, 0]],
    ['glow', new THREE.CylinderGeometry(0.045, 0.045, 0.01, 12), glowMat(), [0, 0.085, 0]],
  ]);
}
// a terrace pole with a spot aimed at the terrace
object(ext, {
  id: 'terrace_spot', type: 'light', label: 'Terrace spot', glow: 'glow',
  hints: { beam: 'spot', max: 15, distance: 7, angle: 35, penumbra: 0.5, decay: 1.5, target: [2.5, 0, 1.5] },
  suggest: { entity: 'light.demo_terrace' },
}, [4.5, -2.5, 0], [
  ['terrace_spot_pole', new THREE.CylinderGeometry(0.04, 0.05, 2.3, 8), darkMat, [0, 1.15, 0]],
  ['glow', new THREE.SphereGeometry(0.06, 12, 8), glowMat(), [0, 2.32, 0]],
]);
// garden: the mower (follows its live position), its dock (LED lit while docked), an EV charger on the house wall
object(ext, { id: 'mower', type: 'mower', label: 'Mower', glow: 'glow', hints: { front: '+x' }, suggest: { entity: 'lawn_mower.demo' } },
  [13.8, 1.5, 0], [
    ['mower_body', new THREE.BoxGeometry(0.6, 0.25, 0.45), mat(0x3d4a3a), [0, 0.125, 0]],
    ['glow', new THREE.BoxGeometry(0.2, 0.02, 0.3), glowMat(), [0.1, 0.26, 0]],
  ]);
object(ext, { id: 'dock', type: 'dock', label: 'Mower dock', hints: { led: 'led' }, suggest: { entity: 'lawn_mower.demo' } },
  [13.0, 1.5, 0], [
    ['dock_body', new THREE.BoxGeometry(0.5, 0.3, 0.6), darkMat, [0, 0.15, 0]],
    ['led', new THREE.SphereGeometry(0.03, 8, 6), glowMat(), [0.26, 0.25, 0]],
  ]);
object(ext, { id: 'ev_charger', type: 'ev_charger', label: 'EV charger', hints: { led: 'led' }, suggest: { entity: 'sensor.demo_charger' } },
  [12.12, 7.5, 1.2], [
    ['ev_charger_body', new THREE.BoxGeometry(0.08, 0.35, 0.25), mat(0xe8e8e8)],
    ['led', new THREE.SphereGeometry(0.025, 8, 6), glowMat(), [0.045, 0.1, 0]],
  ]);
// paving test: a brick-textured sheet with a plain zone floor lying on the same plane (the textured one must win)
{
  const px = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) { const c = ((i & 7) + (i >> 3)) & 1 ? [178, 96, 74] : [140, 70, 55]; px.set([...c, 255], i * 4); }
  const tex = new THREE.DataTexture(px, 8, 8, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(6, 6); tex.needsUpdate = true;
  const sheet = (name, m) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), m);
    p.name = name; p.rotation.x = -Math.PI / 2; p.position.set(7, 0.004, 2.5);
    ext.add(p);
  };
  sheet('driveway_floor_1', mat(0xb8b8b0));
  sheet('exterior_floor_5', new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
}
house.add(ext);
const roof = new THREE.Group();
roof.name = 'roof';
roof.userData.fp = { kind: 'level', id: 'roof', role: 'roof' };
const r = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 7.8, 2.6, 4, 1), roofMat);
r.rotation.y = Math.PI / 4;
r.scale.set(1, 1, 0.75);
r.position.set(6, 5.6 + 1.3, -4.5);
roof.add(r);
house.add(roof);
ceiling('ceiling_ground', floors.ground.elevation + floors.ground.height, house.getObjectByName('level1'));
ceiling('ceiling_first', floors.first.elevation + floors.first.height, roof);

const glb = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true }));
fs.writeFileSync(new URL('../demo/house.glb', import.meta.url), Buffer.from(glb));
console.log('demo/house.glb', glb.byteLength, 'bytes');
