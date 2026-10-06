// Reads the fp tags of a house model (docs/model-builder-guide.md). Works on any node tree
// through an adapter, so the card (three.js nodes) and tools/check-model.mjs (glTF JSON) share it.
import { normSection, normTopCamera } from './views.js';
import { badTargets, aimWarning } from './objects/aim.js';

export const KINDS = ['level', 'room', 'zone', 'object'];
export const ROLES = ['storey', 'basement', 'exterior', 'roof'];
export const ID_RE = /^[a-z0-9_-]{1,64}$/;

const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const num = (v) => (Number.isFinite(v) ? v : null);

// Tag of one node: extras.fp, else an "fp:<kind|type>:<id>" name, else (top level only) the
// legacy names "floor:<id>", "roof" and "site".
export function readTag(name, extras, { topLevel = false } = {}) {
  const fp = extras && extras.fp;
  if (fp && typeof fp === 'object' && !Array.isArray(fp)) return { ...fp, source: 'extras' };
  const m = /^fp:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(name || '');
  if (m) {
    const k = m[1].toLowerCase();
    return KINDS.includes(k) ? { kind: k, id: m[2], source: 'name' } : { kind: 'object', type: k, id: m[2], source: 'name' };
  }
  if (topLevel) {
    const f = /^floor[:_](.+)$/.exec(name || '');
    if (f) return { kind: 'level', id: f[1], role: 'storey', source: 'legacy' };
    if (name === 'roof') return { kind: 'level', id: 'roof', role: 'roof', source: 'legacy' };
    if (name === 'site') return { kind: 'level', id: 'site', role: 'exterior', source: 'legacy' };
  }
  return null;
}

export function buildManifest(adapter) {
  const m = { levels: [], rooms: [], objects: [], views: [], errors: [], warnings: [], byNode: new Map() };
  const seen = { level: new Set(), room: new Set(), object: new Set() };
  m.ownerOf = (node) => {
    for (let n = node; n !== null && n !== undefined; n = adapter.parent(n)) {
      if (m.byNode.has(n)) return m.byNode.get(n);
    }
    return null;
  };

  // an fp object without a kind (layer-only, views-only) is not a tag
  const tagOf = (node, topLevel) => {
    const t = readTag(adapter.name(node), adapter.extras(node), { topLevel });
    return t && t.kind === undefined ? readTag(adapter.name(node), null, { topLevel }) : t;
  };
  let tops = adapter.roots();
  if (tops.length === 1 && !tagOf(tops[0], true)) {
    tops = adapter.children(tops[0]); // a single untagged wrapper (e.g. "Scene")
  }

  const viewHolder = adapter.roots().find((r) => { const e = adapter.extras(r); return e && e.fp && Array.isArray(e.fp.views); });
  const isNum3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  for (const v of viewHolder ? adapter.extras(viewHolder).fp.views : []) {
    if (!v || typeof v.id !== 'string' || !ID_RE.test(v.id)) { m.warnings.push(`view "${v && v.id}": invalid id`); continue; }
    if (m.views.some((x) => x.id === v.id)) { m.warnings.push(`view "${v.id}": duplicate id`); continue; }
    const cam = v.camera && isNum3(v.camera.position) && isNum3(v.camera.target) ? { position: v.camera.position, target: v.camera.target } : null;
    const view = { id: v.id, label: typeof v.label === 'string' ? v.label : v.id, show: strs(v.show), hide: strs(v.hide), camera: cam };
    const section = normSection(v.section);
    if (section) view.section = section;
    else if (v.section !== undefined) m.warnings.push(`view "${v.id}": invalid section (needs normal [x, y, z] and a constant)`);
    const top = normTopCamera(v.camera_top);
    if (top) view.camera_top = top;
    else if (v.camera_top !== undefined) m.warnings.push(`view "${v.id}": invalid camera_top (needs center [x, y] and zoom > 0)`);
    m.views.push(view);
  }

  const add = (node, tag, ctx, path) => {
    const where = `${tag.kind} "${tag.id}"`;
    if (!KINDS.includes(tag.kind)) { m.errors.push(`${path}: unknown kind "${tag.kind}"`); return null; }
    if (typeof tag.id !== 'string' || (tag.source !== 'legacy' && !ID_RE.test(tag.id))) {
      m.errors.push(`${path}: invalid id "${tag.id}" (use a-z, 0-9, _ and -, at most 64)`);
      return null;
    }
    const ns = tag.kind === 'zone' ? 'room' : tag.kind; // rooms and zones share one id namespace
    if (seen[ns].has(tag.id)) {
      m.errors.push(`${path}: duplicate ${ns === 'room' ? 'room/zone' : tag.kind} id "${tag.id}"`);
      return null;
    }
    seen[ns].add(tag.id);
    const base = { kind: tag.kind, id: tag.id, label: tag.label || tag.id, node, path, source: tag.source };
    let entry;
    if (tag.kind === 'level') {
      let role = tag.role || 'storey';
      if (!ROLES.includes(role)) { m.warnings.push(`${where}: unknown role "${role}", using storey`); role = 'storey'; }
      if (ctx.level) m.warnings.push(`${where} is inside level "${ctx.level}"; levels should be top-level`);
      entry = { ...base, role, order: num(tag.order), elevation: num(tag.elevation), height: num(tag.height) };
      m.levels.push(entry);
    } else if (tag.kind === 'room' || tag.kind === 'zone') {
      if (!ctx.level) m.errors.push(`${where} is not inside a level`);
      let outline = null;
      if (tag.outline !== undefined) {
        if (Array.isArray(tag.outline) && tag.outline.length >= 3 && tag.outline.every(isPoint)) outline = tag.outline.map((p) => [p[0], p[1]]);
        else m.warnings.push(`${where}: outline needs at least 3 [x, y] points`);
      }
      const doors = Array.isArray(tag.doors) ? tag.doors.filter(isPoint).map((p) => [p[0], p[1]]) : [];
      entry = { ...base, level: ctx.level, outline, doors, suggest: tag.suggest || {} };
      m.rooms.push(entry);
    } else {
      if (!ctx.level) m.errors.push(`${where} is not inside a level`);
      entry = {
        ...base, type: tag.type || 'generic', level: ctx.level, room: ctx.room, group: tag.group || null,
        glow: tag.glow || null, anchor: isPoint(tag.anchor) ? tag.anchor : null, hints: tag.hints || {},
        suggest: tag.suggest || {}, ui: tag.ui || {},
      };
      m.objects.push(entry);
    }
    m.byNode.set(node, entry);
    return entry;
  };

  const walk = (node, ctx, parentPath, topLevel) => {
    const name = adapter.name(node);
    const path = parentPath ? `${parentPath}/${name}` : name;
    const tag = tagOf(node, topLevel);
    let next = ctx;
    if (tag) {
      const e = add(node, tag, ctx, path);
      if (e && e.kind === 'level') next = { level: e.id, room: null };
      else if (e && (e.kind === 'room' || e.kind === 'zone')) next = { ...ctx, room: e.id };
    }
    for (const c of adapter.children(node)) walk(c, next, path, false);
  };
  for (const t of tops) walk(t, { level: null, room: null }, '', true);
  if (adapter.position) {
    const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    const spots = m.objects.filter((o) => o.hints && (o.hints.beam === 'spot' || o.hints.beam === 'up') && v3(o.hints.target))
      .map((o) => ({ id: o.id, group: o.group, pos: adapter.position(o.node), target: o.hints.target, distance: o.hints.distance }));
    const w = aimWarning(badTargets(spots));
    if (w) m.warnings.push(w);
  }
  return m;
}

// p (node frame) -> parent frame: scale, rotate (quaternion [x, y, z, w]), translate; or a column-major matrix.
function toParent(p, { t, q, s, matrix }) {
  if (matrix) {
    const e = matrix;
    return [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]];
  }
  const v = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y + t[0], iy * w + iw * -y + iz * -x - ix * -z + t[1], iz * w + iw * -z + ix * -y - iy * -x + t[2]];
}

export function threeAdapter(root) {
  return {
    roots: () => root.children,
    children: (n) => n.children,
    name: (n) => (n.userData && n.userData.name) || n.name || '', // GLTFLoader strips ':' from n.name
    extras: (n) => n.userData || {},
    parent: (n) => (n.parent && n.parent !== root ? n.parent : null),
    // node origin in the root's frame
    position: (n) => {
      let p = [0, 0, 0];
      for (let x = n; x && x !== root; x = x.parent) p = toParent(p, { t: x.position.toArray(), q: x.quaternion.toArray(), s: x.scale.toArray() });
      return p;
    },
  };
}

export function gltfAdapter(json) {
  const nodes = json.nodes || [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const scene = (json.scenes || [])[json.scene ?? 0] || { nodes: [] };
  return {
    roots: () => scene.nodes || [],
    children: (i) => nodes[i].children || [],
    name: (i) => nodes[i].name || '',
    extras: (i) => nodes[i].extras || {},
    parent: (i) => (parent.has(i) ? parent.get(i) : null),
    // node origin in the scene's frame
    position: (i) => {
      let p = [0, 0, 0];
      for (let x = i; x !== undefined && x !== null && nodes[x]; x = parent.get(x)) {
        const n = nodes[x];
        p = toParent(p, Array.isArray(n.matrix) && n.matrix.length === 16 ? { matrix: n.matrix }
          : { t: n.translation || [0, 0, 0], q: n.rotation || [0, 0, 0, 1], s: n.scale || [1, 1, 1] });
      }
      return p;
    },
  };
}

export function summarize(m) {
  const objects = {};
  for (const o of m.objects) objects[o.type] = (objects[o.type] || 0) + 1;
  return {
    levels: m.levels.length,
    rooms: m.rooms.filter((r) => r.kind === 'room').length,
    zones: m.rooms.filter((r) => r.kind === 'zone').length,
    objects,
  };
}
