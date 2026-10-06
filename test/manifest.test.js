import { describe, it, expect } from 'vitest';
import { readTag, buildManifest, gltfAdapter, threeAdapter, summarize } from '../src/manifest.js';

// tiny tree helper: { name, extras, children }
const tree = (roots) => {
  const parent = new Map();
  const walk = (n) => (n.children || []).forEach((c) => { parent.set(c, n); walk(c); });
  roots.forEach(walk);
  return {
    roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '',
    extras: (n) => n.extras || {}, parent: (n) => parent.get(n) || null,
  };
};
const fp = (o) => ({ fp: o });
const sq = [[0, 0], [4, 0], [4, 3], [0, 3]];

describe('readTag', () => {
  it('prefers extras over the name', () => {
    expect(readTag('fp:light:x', fp({ kind: 'room', id: 'k' }))).toMatchObject({ kind: 'room', id: 'k', source: 'extras' });
  });
  it('reads name fallbacks', () => {
    expect(readTag('fp:level:ground', {})).toMatchObject({ kind: 'level', id: 'ground', source: 'name' });
    expect(readTag('fp:light:terrace_1', {})).toMatchObject({ kind: 'object', type: 'light', id: 'terrace_1' });
  });
  it('reads legacy names only at the top level', () => {
    expect(readTag('floor:floor1', {}, { topLevel: true })).toMatchObject({ kind: 'level', id: 'floor1', role: 'storey', source: 'legacy' });
    expect(readTag('roof', {}, { topLevel: true })).toMatchObject({ kind: 'level', role: 'roof' });
    expect(readTag('site', {}, { topLevel: true })).toMatchObject({ kind: 'level', id: 'site', role: 'exterior' });
    expect(readTag('floor:x', {})).toBeNull();
    expect(readTag('Mesh_12', {})).toBeNull();
  });
});

describe('buildManifest', () => {
  const lamp = { name: 'lamp', extras: fp({ kind: 'object', id: 'kitchen_1', type: 'light', hints: { beam: 'down' } }) };
  const kitchen = { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq, doors: [[2, 0]], suggest: { area: 'kitchen' } }), children: [lamp, { name: 'slab' }] };
  const ground = { name: 'ground', extras: fp({ kind: 'level', id: 'ground', order: 0, elevation: 0, height: 2.7 }), children: [kitchen] };
  const garden = { name: 'garden', extras: fp({ kind: 'zone', id: 'garden', outline: [[-5, -5], [10, -5], [10, 10]] }) };
  const exterior = { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [garden] };
  const roof = { name: 'roof' };

  it('collects levels, rooms, zones and objects with their parents', () => {
    const m = buildManifest(tree([ground, exterior, roof]));
    expect(m.levels.map((l) => [l.id, l.role, l.order])).toEqual([['ground', 'storey', 0], ['exterior', 'exterior', null], ['roof', 'roof', null]]);
    expect(m.rooms.map((r) => [r.kind, r.id, r.level])).toEqual([['room', 'kitchen', 'ground'], ['zone', 'garden', 'exterior']]);
    expect(m.objects[0]).toMatchObject({ id: 'kitchen_1', type: 'light', level: 'ground', room: 'kitchen', hints: { beam: 'down' } });
    expect(m.rooms[0]).toMatchObject({ outline: sq, doors: [[2, 0]], suggest: { area: 'kitchen' }, path: 'ground/kitchen' });
    expect(m.errors).toEqual([]);
  });

  it('finds the owner of a nested node', () => {
    const m = buildManifest(tree([ground]));
    expect(m.ownerOf(kitchen.children[1]).id).toBe('kitchen');
    expect(m.ownerOf(lamp).id).toBe('kitchen_1');
    expect(m.ownerOf({ name: 'stray' })).toBeNull();
  });

  it('looks through a single untagged wrapper', () => {
    const m = buildManifest(tree([{ name: 'Scene', children: [ground, roof] }]));
    expect(m.levels.map((l) => l.id)).toEqual(['ground', 'roof']);
  });

  it('keeps the first of duplicate ids and reports the rest', () => {
    const a = { name: 'a', extras: fp({ kind: 'level', id: 'ground' }) };
    const b = { name: 'b', extras: fp({ kind: 'level', id: 'ground' }) };
    const m = buildManifest(tree([a, b]));
    expect(m.levels).toHaveLength(1);
    expect(m.levels[0].node).toBe(a);
    expect(m.errors[0]).toMatch(/duplicate level id "ground"/);
  });

  it('rooms and zones share one id namespace', () => {
    const lvl = { name: 'l', extras: fp({ kind: 'level', id: 'l' }), children: [
      { name: 'a', extras: fp({ kind: 'room', id: 'x', outline: sq }) },
      { name: 'b', extras: fp({ kind: 'zone', id: 'x', outline: sq }) },
    ] };
    const m = buildManifest(tree([lvl]));
    expect(m.rooms).toHaveLength(1);
    expect(m.errors.join('\n')).toMatch(/duplicate room\/zone id "x"/);
  });

  it('reports invalid ids, unknown kinds and roles, rooms outside levels', () => {
    const m = buildManifest(tree([
      { name: 'x', extras: fp({ kind: 'level', id: 'Bad Id' }) },
      { name: 'y', extras: fp({ kind: 'thing', id: 'y' }) },
      { name: 'z', extras: fp({ kind: 'level', id: 'z', role: 'cellar' }) },
      { name: 'r', extras: fp({ kind: 'room', id: 'loose', outline: sq }) },
    ]));
    expect(m.errors.join('\n')).toMatch(/invalid id "Bad Id"/);
    expect(m.errors.join('\n')).toMatch(/unknown kind "thing"/);
    expect(m.errors.join('\n')).toMatch(/room "loose" is not inside a level/);
    expect(m.warnings.join('\n')).toMatch(/unknown role "cellar"/);
    expect(m.levels.find((l) => l.id === 'z').role).toBe('storey');
  });

  it('drops a malformed outline with a warning', () => {
    const lvl = { name: 'l', extras: fp({ kind: 'level', id: 'l' }), children: [
      { name: 'r', extras: fp({ kind: 'room', id: 'r', outline: [[0, 0], ['a', 1]] }) },
    ] };
    const m = buildManifest(tree([lvl]));
    expect(m.rooms[0].outline).toBeNull();
    expect(m.warnings.join('\n')).toMatch(/room "r": outline needs at least 3 \[x, y\] points/);
  });

  it('treats an untagged legacy model as before', () => {
    const m = buildManifest(tree([{ name: 'floor:ground' }, { name: 'roof' }, { name: 'site' }, { name: 'Lamp' }]));
    expect(m.levels.map((l) => [l.id, l.role])).toEqual([['ground', 'storey'], ['roof', 'roof'], ['site', 'exterior']]);
    expect(m.errors).toEqual([]);
  });

  it('summarizes', () => {
    expect(summarize(buildManifest(tree([ground, exterior])))).toEqual({ levels: 2, rooms: 1, zones: 1, objects: { light: 1 } });
  });
});

describe('gltfAdapter', () => {
  it('walks glTF JSON nodes by index', () => {
    const json = {
      scene: 0, scenes: [{ nodes: [0] }],
      nodes: [
        { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), children: [1] },
        { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq }) },
      ],
    };
    const m = buildManifest(gltfAdapter(json));
    expect(m.rooms[0]).toMatchObject({ id: 'kitchen', level: 'ground', node: 1 });
    expect(m.ownerOf(1).id).toBe('kitchen');
  });
});

describe('manifest views', () => {
  it('reads valid root views and drops invalid ones', () => {
    const root = { name: 'Scene', extras: { fp: { views: [
      { id: 'ground', label: 'Ground floor', show: ['level:ground'], hide: ['role:roof'], camera: { position: [1, 2, 3], target: [0, 0, 0] } },
      { id: 'Bad Id', label: 'x' },
      { id: 'all', show: 'oops' },
    ] } }, children: [{ name: 'ground', extras: fp({ kind: 'level', id: 'ground' }) }] };
    const m = buildManifest(tree([root]));
    expect(m.views).toEqual([
      { id: 'ground', label: 'Ground floor', show: ['level:ground'], hide: ['role:roof'], camera: { position: [1, 2, 3], target: [0, 0, 0] } },
      { id: 'all', label: 'all', show: [], hide: [], camera: null },
    ]);
    expect(m.warnings.join('\n')).toMatch(/view "Bad Id": invalid id/);
  });
  it('has no views by default', () => {
    expect(buildManifest(tree([{ name: 'floor:ground' }])).views).toEqual([]);
  });
});

describe('layer-only tags', () => {
  it('a node with fp but no kind is not an error', () => {
    const m = buildManifest(tree([{ name: 'Sofa', extras: fp({ layer: 'furniture' }) }, { name: 'floor:ground' }]));
    expect(m.errors).toEqual([]);
  });
});

describe('kindless fp keeps name tags', () => {
  it('layer-only fp on a legacy-named top-level node', () => {
    const m = buildManifest(tree([{ name: 'floor:ground', extras: fp({ layer: 'x' }) }, { name: 'roof' }]));
    expect(m.errors).toEqual([]);
    expect(m.levels.map((l) => l.id)).toEqual(['ground', 'roof']);
  });
  it('views-only fp on a single legacy-named root', () => {
    const m = buildManifest(tree([{ name: 'floor:ground', extras: { fp: { views: [{ id: 'v1' }] } } }]));
    expect(m.levels.map((l) => l.id)).toEqual(['ground']);
    expect(m.views.map((v) => v.id)).toEqual(['v1']);
  });
  it('layer-only fp on an fp:<type>:<id> named node', () => {
    const lamp = { name: 'fp:light:lamp_1', extras: fp({ layer: 'decoration' }) };
    const m = buildManifest(tree([{ name: 'floor:ground', children: [lamp] }]));
    expect(m.errors).toEqual([]);
    expect(m.objects).toMatchObject([{ id: 'lamp_1', type: 'light' }]);
  });
});

describe('spot target warning', () => {
  const lvl = (children) => ({ name: 'g', extras: { fp: { kind: 'level', id: 'g' } }, children });
  const json = (objs) => ({ scene: 0, scenes: [{ nodes: [0] }], nodes: [lvl(objs.map((_, i) => i + 1)), ...objs] });
  const up = (id, x, target, extra = {}) => ({ name: id, translation: [x, 1, 0], extras: { fp: { kind: 'object', id, type: 'light', group: 'ups', hints: { beam: 'up', target } } }, ...extra });

  it('warns for targets shared in a group or too far (node origin from translation / rotation / matrix)', () => {
    const m = buildManifest(gltfAdapter(json([
      up('u1', 0, [5, 5, 5]), up('u2', 2, [5, 5, 5]),
      { name: 'far', rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], extras: { fp: { kind: 'object', id: 'far', type: 'light', hints: { beam: 'spot', target: [0, 0, 9] } } } },
      { name: 'ok', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 0, 0, 1], extras: { fp: { kind: 'object', id: 'ok', type: 'light', hints: { beam: 'spot', target: [21, 0, 1] } } } },
    ])));
    expect(m.warnings).toEqual(['spot target looks wrong (shared / too far): far, u1, u2']);
  });

  it('no warning for distinct, near targets', () => {
    const m = buildManifest(gltfAdapter(json([up('u1', 0, [0, 3, 0]), up('u2', 2, [2, 3, 0])])));
    expect(m.warnings).toEqual([]);
  });

  it('three adapter: positions in the root frame', () => {
    const a = threeAdapter({ children: [] });
    const node = { position: { toArray: () => [1, 2, 3] }, quaternion: { toArray: () => [0, 0, 0, 1] }, scale: { toArray: () => [2, 2, 2] }, parent: null };
    const child = { position: { toArray: () => [1, 0, 0] }, quaternion: { toArray: () => [0, 0, 0, 1] }, scale: { toArray: () => [1, 1, 1] }, parent: node };
    expect(a.position(child)).toEqual([3, 2, 3]);
  });
});
