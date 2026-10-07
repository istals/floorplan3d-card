#!/usr/bin/env node
// Checks a house model against docs/model-builder-guide.md before it is uploaded to the card.
//   node tools/check-model.mjs house.glb          human-readable report, exit 1 on errors
//   node tools/check-model.mjs house.glb --json   JSON report, always exit 0 (read "ok")
// No dependencies: reads the GLB's JSON chunk, accessor bounds and embedded image headers.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildManifest, gltfAdapter, summarize } from '../src/manifest.js';

const MAX_MESH_M = 60;
const MAX_TEXTURE_PX = 2048;
const MAX_FILE_MB = 20;

function parseGlb(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF' || buf.readUInt32LE(4) !== 2) return null;
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  let bin = null;
  const binStart = 20 + jsonLen;
  if (buf.length >= binStart + 8 && buf.toString('latin1', binStart + 4, binStart + 8) === 'BIN\0') {
    bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart));
  }
  return { json, bin };
}

// 4x4 column-major matrices
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function local(n) {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function meshSize(json, meshIndex, world) {
  let min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  const mesh = (json.meshes || [])[meshIndex];
  if (!mesh) return 0;
  for (const p of mesh.primitives || []) {
    const acc = (json.accessors || [])[p.attributes && p.attributes.POSITION];
    if (!acc || !acc.min || !acc.max) continue;
    for (const cx of [acc.min[0], acc.max[0]]) for (const cy of [acc.min[1], acc.max[1]]) for (const cz of [acc.min[2], acc.max[2]]) {
      const [x, , z] = apply(world, [cx, cy, cz]);
      min = [Math.min(min[0], x), Math.min(min[1], z)];
      max = [Math.max(max[0], x), Math.max(max[1], z)];
    }
  }
  return Number.isFinite(min[0]) ? Math.max(max[0] - min[0], max[1] - min[1]) : 0;
}

function imageSize(bytes, mime) {
  if (mime === 'image/png' && bytes.length >= 24) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mime === 'image/jpeg') {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function checkGlb(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let parsed;
  try { parsed = parseGlb(buf); } catch (e) { parsed = null; }
  if (!parsed) return { ok: false, errors: ['not a binary glTF 2.0 (.glb) file'], warnings: [], summary: null, levels: [], rooms: [] };
  const { json, bin } = parsed;

  let m;
  try {
    m = buildManifest(gltfAdapter(json));
  } catch (e) {
    return { ok: false, errors: [`invalid node structure: ${e.message}`], warnings: [], summary: null, levels: [], rooms: [] };
  }

  const errors = [...m.errors], warnings = [...m.warnings];

  if (!m.levels.length && !m.rooms.length && !m.objects.length) warnings.push('no fp tags found: the card will show the model whole (see docs/model-builder-guide.md)');
  else {
    for (const role of ['exterior', 'roof']) if (!m.levels.some((l) => l.role === role)) warnings.push(`no level with role "${role}"`);
    for (const r of m.rooms) if (!r.outline) warnings.push(`${r.kind} "${r.id}" has no outline; the card uses its bounding box`);
  }

  // meshes larger than a plot inside storeys and basements
  try {
    const nodes = json.nodes || [];
    const storeyNodes = new Set(m.levels.filter((l) => l.role === 'storey' || l.role === 'basement').map((l) => l.node));
    const scene = (json.scenes || [])[json.scene ?? 0] || { nodes: [] };
    const walk = (i, parentWorld, inStorey, path, visited) => {
      if (visited.has(i) || !nodes[i]) return;
      visited.add(i);
      const n = nodes[i];
      const world = mul(parentWorld, local(n));
      const p = path ? `${path}/${n.name || i}` : (n.name || String(i));
      const storey = inStorey || storeyNodes.has(i);
      if (storey && n.mesh !== undefined) {
        const size = meshSize(json, n.mesh, world);
        if (size > MAX_MESH_M) warnings.push(`mesh ${p} is larger than ${MAX_MESH_M} m (${size.toFixed(0)} m) inside a storey; move ground planes and roads to the exterior level`);
      }
      for (const c of n.children || []) walk(c, world, storey, p, visited);
    };
    for (const i of scene.nodes || []) walk(i, IDENT, false, '', new Set());

    (json.images || []).forEach((img, i) => {
      const bv = json.bufferViews && json.bufferViews[img.bufferView];
      if (!bv || !bin) return;
      const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
      const size = imageSize(Buffer.from(bytes), img.mimeType);
      if (size && Math.max(...size) > MAX_TEXTURE_PX) warnings.push(`texture "${img.name || i}" is ${size[0]} × ${size[1]} px; keep textures at ${MAX_TEXTURE_PX} px or less`);
    });
    if (buf.length > MAX_FILE_MB * 1024 * 1024) warnings.push(`file is ${(buf.length / 1048576).toFixed(1)} MB; keep it under ${MAX_FILE_MB} MB`);
  } catch (e) {
    errors.push(`invalid model data: ${e.message}`);
  }

  return {
    ok: errors.length === 0, errors, warnings, summary: summarize(m),
    render: m.render ? { keys: m.renderKeys, recipe: m.render } : null,
    levels: m.levels.map((l) => ({ id: l.id, role: l.role, order: l.order, elevation: l.elevation })),
    rooms: m.rooms.map((r) => ({ kind: r.kind, id: r.id, level: r.level, area: (r.suggest && r.suggest.area) || null })),
  };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/check-model.mjs house.glb [--json]');
    return 2;
  }
  let r;
  try {
    r = checkGlb(fs.readFileSync(file));
  } catch (e) {
    const msg = `cannot read ${file}: ${e.message}`;
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, errors: [msg], warnings: [], summary: null, levels: [], rooms: [] }, null, 2));
      return 0;
    }
    console.log('ERROR ' + msg);
    return 1;
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (r.summary) {
    const objs = Object.entries(r.summary.objects).map(([t, n]) => `${n} ${t}`).join(', ') || 'none';
    console.log(`${file}: ${r.summary.levels} levels, ${r.summary.rooms} rooms, ${r.summary.zones} zones, objects: ${objs}`);
    if (r.render) console.log(`  render recipe: ${r.render.keys} key(s) (${Object.keys(r.render.recipe).join(', ')})`);
    for (const l of r.levels) console.log(`  level ${l.id} (${l.role}${l.order !== null ? ', order ' + l.order : ''}${l.elevation !== null ? ', elevation ' + l.elevation : ''})`);
  }
  for (const e of r.errors) console.log('ERROR ' + e);
  for (const w of r.warnings) console.log('warning ' + w);
  console.log(r.ok ? 'OK' : `${r.errors.length} error(s)`);
  return r.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
