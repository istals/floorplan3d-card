import { describe, it, expect, vi } from 'vitest';
import { parseSelector, nodeIndex, matches, resolveVisibility, unmatchedSelectors,
  modelViewRules, generatedViews, migrateShowModes, resolveViews, primaryLevel, defaultFloors, markerState } from '../src/views.js';
import { buildManifest } from '../src/manifest.js';

const tree = (roots) => {
  const parent = new Map();
  const walk = (n) => (n.children || []).forEach((c) => { parent.set(c, n); walk(c); });
  roots.forEach(walk);
  return { roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '', extras: (n) => n.extras || {}, parent: (n) => parent.get(n) || null };
};
const fp = (o) => ({ fp: o });
const sq = [[0, 0], [4, 0], [4, 3]];
const lamp = { name: 'lamp', extras: fp({ kind: 'object', id: 'l1', type: 'light', group: 'facade' }) };
const sofa = { name: 'Sofa', extras: fp({ layer: 'furniture' }) };
const kitchen = { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq }), children: [sofa, { name: 'slab' }] };
const ceiling = { name: 'Ceiling', extras: fp({ layer: ['ceiling'] }) };
const ground = { name: 'ground', extras: fp({ kind: 'level', id: 'ground', order: 0 }), children: [kitchen, lamp] };
const attic = { name: 'attic', extras: fp({ kind: 'level', id: 'attic', order: 1 }), children: [ceiling] };
const ext = { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [{ name: 'lawn', extras: fp({ kind: 'zone', id: 'lawn', outline: sq }) }] };
const roof = { name: 'roof' };
const adapter = tree([ground, attic, ext, roof]);
const idx = nodeIndex(adapter, buildManifest(adapter));
const at = (name) => idx.nodes.findIndex((n) => n.name === name);

describe('parseSelector', () => {
  it('parses known kinds', () => {
    expect(parseSelector('all')).toEqual({ kind: 'all', value: null });
    expect(parseSelector('level:ground')).toEqual({ kind: 'level', value: 'ground' });
    expect(parseSelector('node:ground/**/Sofa')).toEqual({ kind: 'node', value: 'ground/**/Sofa' });
    expect(parseSelector('nope:x')).toBeNull();
    expect(parseSelector('')).toBeNull();
  });
});

describe('nodeIndex / matches', () => {
  it('indexes tags, layers, paths and levels', () => {
    const k = idx.nodes[at('kitchen')];
    expect(k).toMatchObject({ path: 'ground/kitchen', levelId: 'ground', tag: { kind: 'room', id: 'kitchen' } });
    expect(idx.nodes[at('Sofa')].layers).toEqual(['furniture']);
    expect(idx.nodes[at('Ceiling')].layers).toEqual(['ceiling']);
    expect(idx.nodes[at('roof')].tag).toMatchObject({ kind: 'level', id: 'roof', role: 'roof' });
  });
  it('matches every selector kind', () => {
    const m = (s, name) => matches(parseSelector(s), idx.nodes[at(name)]);
    expect(m('level:ground', 'ground')).toBe(true);
    expect(m('role:exterior', 'exterior')).toBe(true);
    expect(m('room:kitchen', 'kitchen')).toBe(true);
    expect(m('zone:lawn', 'lawn')).toBe(true);
    expect(m('object:l1', 'lamp')).toBe(true);
    expect(m('type:light', 'lamp')).toBe(true);
    expect(m('group:facade', 'lamp')).toBe(true);
    expect(m('layer:furniture', 'Sofa')).toBe(true);
    expect(m('node:ground/kitchen/Sofa', 'Sofa')).toBe(true);
    expect(m('node:ground/*/Sofa', 'Sofa')).toBe(true);
    expect(m('node:**/Sofa', 'Sofa')).toBe(true);
    expect(m('node:ground/*', 'Sofa')).toBe(false);
    expect(m('all', 'roof')).toBe(true);
    expect(m('room:kitchen', 'Sofa')).toBe(false); // selectors match the node itself, not descendants
  });
});

describe('resolveVisibility', () => {
  const vis = (rules) => { const v = resolveVisibility(idx, rules); return (name) => v[at(name)]; };
  it('defaults to visible and inherits', () => {
    const v = vis([]);
    expect(v('Sofa')).toBe(true);
  });
  it('last matching rule wins; children inherit', () => {
    const v = vis([{ hide: 'level:attic' }, { hide: 'role:roof' }]);
    expect([v('ground'), v('attic'), v('Ceiling'), v('roof')]).toEqual([true, false, false, false]);
    expect(vis([{ hide: 'level:attic' }, { show: 'level:attic' }])('attic')).toBe(true);
  });
  it('a shown descendant keeps its ancestors visible but not its siblings', () => {
    const v = vis([{ hide: 'level:ground' }, { show: 'room:kitchen' }]);
    expect([v('ground'), v('kitchen'), v('slab'), v('lamp')]).toEqual([true, true, true, false]);
  });
  it('hide all + show list (model views)', () => {
    const v = vis([{ hide: 'all' }, { show: 'level:ground' }, { show: 'role:exterior' }]);
    expect([v('ground'), v('kitchen'), v('attic'), v('lawn'), v('roof')]).toEqual([true, true, false, true, false]);
  });
  it('layer rules reach nested nodes', () => {
    expect(vis([{ hide: 'layer:furniture' }])('Sofa')).toBe(false);
  });
  it('reports selectors that match nothing', () => {
    expect(unmatchedSelectors(idx, [{ hide: 'node:old/path' }, { hide: 'level:ground' }, { hide: 'bad' }])).toEqual(['node:old/path', 'bad']);
  });
});

describe('resolveVisibility: keep_objects', () => {
  // a driveway zone (itself a mesh) holding its paving and two facade lamps (each with a glow child)
  const glow1 = { name: 'glow1' }, glow2 = { name: 'glow2' };
  const lamp3 = { name: 'lamp3', extras: fp({ kind: 'object', id: 'facade_3', type: 'light', group: 'facade' }), children: [glow1] };
  const lamp4 = { name: 'lamp4', extras: fp({ kind: 'object', id: 'facade_4', type: 'light' }), children: [glow2] };
  const paving = { name: 'paving' };
  const drive = { name: 'drive', extras: fp({ kind: 'zone', id: 'drive', outline: sq }), children: [paving, lamp3, lamp4] };
  const lawn2 = { name: 'lawn2', extras: fp({ kind: 'zone', id: 'lawn2', outline: sq }) };
  const ext2 = { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [drive, lawn2] };
  const ad = tree([ext2]);
  const ix = nodeIndex(ad, buildManifest(ad));
  const i = (name) => ix.nodes.findIndex((n) => n.name === name);
  const v = (rules) => { const e = resolveVisibility(ix, rules); return { e, at: (n) => e[i(n)] }; };

  it('hidden zone with keep_objects: lamps (and their subtree) visible, paving hidden, zone own mesh hidden', () => {
    const { e, at } = v([{ hide: 'zone:drive', keep_objects: true }]);
    expect([at('lamp3'), at('glow1'), at('lamp4'), at('glow2')]).toEqual([true, true, true, true]);
    expect(at('paving')).toBe(false);
    expect(at('drive')).toBe(true); // kept on for its lamps (pickable through it) ...
    expect(e.selfHidden[i('drive')]).toBe(true); // ... but its own geometry is hidden
    expect(e.keptOnly[i('drive')]).toBe(true); // counts as hidden for the zone's devices
    expect(e.selfHidden[i('lamp3')]).toBe(false);
    expect(at('lawn2')).toBe(true);
  });
  it('without keep_objects the lamps go with the zone', () => {
    const { e, at } = v([{ hide: 'zone:drive' }]);
    expect([at('drive'), at('lamp3'), at('glow1'), at('paving')]).toEqual([false, false, false, false]);
    expect(e.selfHidden.some(Boolean)).toBe(false);
  });
  it('an object-level hide still hides a kept object, in any order', () => {
    let { at } = v([{ hide: 'zone:drive', keep_objects: true }, { hide: 'object:facade_4' }]);
    expect([at('lamp3'), at('lamp4'), at('glow2')]).toEqual([true, false, false]);
    ({ at } = v([{ hide: 'object:facade_4' }, { hide: 'zone:drive', keep_objects: true }]));
    expect([at('lamp4'), at('lamp3')]).toEqual([false, true]);
    ({ at } = v([{ hide: 'group:facade', keep_objects: true }]));
    expect(at('lamp3')).toBe(false); // an object-level hide is a hide, keep_objects or not
  });
  it('level hidden with keep_objects keeps objects in its zones; hide all + keep too', () => {
    let { at } = v([{ hide: 'level:exterior', keep_objects: true }]);
    expect([at('exterior'), at('lamp3'), at('paving'), at('lawn2')]).toEqual([true, true, false, false]);
    ({ at } = v([{ hide: 'all', keep_objects: true }]));
    expect([at('lamp4'), at('glow2'), at('paving')]).toEqual([true, true, false]);
  });
  it('a plain visible sibling is not marked self-hidden', () => {
    const { e } = v([{ hide: 'zone:drive', keep_objects: true }]);
    expect(e.selfHidden[i('exterior')]).toBe(false);
    expect(e.keptOnly[i('exterior')]).toBe(false);
  });
});

describe('views edge cases', () => {
  it('rule order matters', () => {
    const v = resolveVisibility(idx, [{ show: 'room:kitchen' }, { hide: 'level:ground' }]);
    expect(v[at('kitchen')]).toBe(false);
  });
  it('malformed rules are ignored', () => {
    const rules = [{}, null, { show: 5 }, { hide: 'node:' }];
    expect(() => unmatchedSelectors(idx, rules)).not.toThrow();
    expect(resolveVisibility(idx, rules).every(Boolean)).toBe(true);
    expect(unmatchedSelectors(idx, rules)).toEqual(['node:']);
  });
  it('node names with regex characters match literally', () => {
    const odd = { name: 'a.b[1]' };
    const a2 = tree([{ name: 'root', children: [odd, { name: 'aXb1' }] }]);
    const i2 = nodeIndex(a2, buildManifest(a2));
    const hit = i2.nodes.filter((n) => matches(parseSelector('node:root/a.b[1]'), n)).map((n) => n.name);
    expect(hit).toEqual(['a.b[1]']);
  });
});


describe('view sources', () => {
  const levels = [
    { id: 'attic', label: 'Attic', role: 'storey', order: 1 },
    { id: 'ground', label: 'Ground floor', role: 'storey', order: 0 },
    { id: 'exterior', label: 'Exterior', role: 'exterior', order: null },
    { id: 'roof', label: 'roof', role: 'roof', order: null },
  ];
  it('model view {show, hide} → rules', () => {
    expect(modelViewRules({ show: ['level:ground'], hide: ['role:roof'] })).toEqual([{ hide: 'all' }, { show: 'level:ground' }, { hide: 'role:roof' }]);
    expect(modelViewRules({ show: [], hide: ['role:roof'] })).toEqual([{ hide: 'role:roof' }]);
  });
  it('generated views stack storeys and keep the exterior (legacy generated views)', () => {
    expect(generatedViews(levels)).toEqual([
      { id: 'ground', label: 'Ground floor', rules: [{ hide: 'all' }, { show: 'level:ground' }, { show: 'role:exterior' }] },
      { id: 'attic', label: 'Attic', rules: [{ hide: 'all' }, { show: 'level:ground' }, { show: 'level:attic' }, { show: 'role:exterior' }] },
      { id: 'all', label: 'All', rules: [] },
    ]);
  });
  it('migrates legacy level show modes', () => {
    expect(migrateShowModes({ roof: { show: 'hidden' }, attic: { show: 'all-only' }, site: { show: 'always' }, ground: { floor: 'f' } }))
      .toEqual({ all: [{ hide: 'level:roof' }, { show: 'level:site' }], floorViews: [{ hide: 'level:attic' }] });
  });
  it('merges model → layout → yaml, with added and hidden views', () => {
    const manifest = { levels, views: [{ id: 'ground', label: 'Ground', show: ['level:ground'], hide: [], camera: null }, { id: 'all', label: 'Everything', show: [], hide: [], camera: null }] };
    const v = resolveViews({
      manifest, haFloors: [{ id: 'floor1', name: 'Floor1' }],
      layoutViews: { ground: { rules: [{ hide: 'layer:ceiling' }], camera: { position: [1, 1, 1], target: [0, 0, 0] }, floors: ['floor1'] }, all: { hidden: true }, night: { added: true, label: 'Night', rules: [{ show: 'role:exterior' }] } },
      yamlViews: { ground: { label: 'GF', rules: [{ hide: 'type:light' }] } },
      savedLevels: {},
    });
    expect(v.map((x) => [x.id, x.label, x.source, x.hidden])).toEqual([['ground', 'GF', 'model', false], ['all', 'Everything', 'model', true], ['night', 'Night', 'added', false]]);
    expect(v[0].rules).toEqual([{ hide: 'all' }, { show: 'level:ground' }, { hide: 'layer:ceiling' }, { hide: 'type:light' }]);
    expect(v[0].floors).toEqual(['floor1']);
    expect(v[0].camera).toEqual({ position: [1, 1, 1], target: [0, 0, 0] });
  });
  it('without a model: one view per HA floor plus all', () => {
    const v = resolveViews({ manifest: null, haFloors: [{ id: 'f1', name: 'F1' }, { id: 'f2', name: 'F2' }], layoutViews: {}, yamlViews: {}, savedLevels: {} });
    expect(v.map((x) => [x.id, x.label, x.source, x.floors])).toEqual([['f1', 'F1', 'floors', ['f1']], ['f2', 'F2', 'floors', ['f2']], ['all', 'All', 'floors', null]]);
  });
  it('generated views get migrated show-mode rules', () => {
    const v = resolveViews({ manifest: { levels, views: [] }, haFloors: [], layoutViews: {}, yamlViews: {}, savedLevels: { attic: { show: 'all-only' } } });
    expect(v.find((x) => x.id === 'ground').rules.at(-1)).toEqual({ hide: 'level:attic' });
    expect(v.find((x) => x.id === 'all').rules).toEqual([]);
  });
});

describe('primary level, floors, devices', () => {
  const lv = [{ id: 'ground', role: 'storey', order: 0 }, { id: 'attic', role: 'storey', order: 1 }, { id: 'exterior', role: 'exterior', order: null }];
  it('primary = highest visible storey; default floors follow it', () => {
    const v = resolveVisibility(idx, [{ hide: 'all' }, { show: 'level:ground' }, { show: 'level:attic' }]);
    expect(primaryLevel(idx, v, lv)).toBe('attic');
    expect(defaultFloors('attic', { attic: 'mansard', ground: 'floor1' })).toEqual(['mansard']);
    expect(defaultFloors(null, {})).toEqual([]);
  });
  it('device follows its visible room, fades below the primary level, falls back to linked floors', () => {
    const ctx = { visibleRooms: new Set(['kitchen', 'lawn']), primaryOrder: 1, levelOrder: { ground: 0, attic: 1 }, viewFloors: new Set(['mansard']), isAll: false };
    expect(markerState({ roomId: 'kitchen', roomLevelId: 'ground', markerFloorId: 'floor1' }, ctx)).toEqual({ shown: true, faded: true });
    expect(markerState({ roomId: 'lawn', roomLevelId: 'exterior', markerFloorId: 'floor1' }, ctx)).toEqual({ shown: true, faded: false });
    expect(markerState({ roomId: 'bath', roomLevelId: 'ground', markerFloorId: 'floor1' }, ctx)).toEqual({ shown: false, faded: false });
    expect(markerState({ roomId: null, roomLevelId: null, markerFloorId: 'mansard' }, ctx)).toEqual({ shown: true, faded: false });
    expect(markerState({ roomId: null, roomLevelId: null, markerFloorId: 'floor1' }, ctx)).toEqual({ shown: false, faded: false });
    expect(markerState({ roomId: null, roomLevelId: null, markerFloorId: 'floor1' }, { ...ctx, isAll: true })).toEqual({ shown: true, faded: false });
  });
});

describe('review fixes', () => {
  const levels = [
    { id: 'ground', label: 'Ground', role: 'storey', order: 0 },
    { id: 'attic', label: 'Attic', role: 'storey', order: 1 },
  ];
  it('all-only keeps the level in its own view; only hides it in lower views', () => {
    const v = resolveViews({ manifest: { levels, views: [] }, haFloors: [], layoutViews: {}, yamlViews: {}, savedLevels: { attic: { show: 'all-only' } } });
    expect(v.find((x) => x.id === 'attic').rules.at(-1)).toEqual({ show: 'role:exterior' });
    const w = resolveViews({ manifest: { levels, views: [] }, haFloors: [], layoutViews: {}, yamlViews: {}, savedLevels: { attic: { show: 'only' } } });
    expect(w.find((x) => x.id === 'ground').rules.at(-1)).toEqual({ hide: 'level:attic' });
    expect(w.find((x) => x.id === 'attic').rules.some((r) => r.hide === 'level:attic')).toBe(false);
  });
  it('room hidden by a rule falls back to the linked floor, with fading', () => {
    const ctx = { visibleRooms: new Set(), primaryOrder: 1, levelOrder: { ground: 0 }, viewFloors: new Set(['f1']), isAll: false };
    expect(markerState({ roomId: 'kitchen', roomLevelId: 'ground', markerFloorId: 'f1' }, ctx)).toEqual({ shown: true, faded: true });
  });
  it('tolerates missing levels/floors, unlabelled and duplicate model views, and copies inputs', () => {
    const v = resolveViews({ manifest: { views: [{ id: 'a', show: [], hide: [] }, { id: 'a', label: 'dup', show: [], hide: [] }] }, haFloors: undefined, layoutViews: {}, yamlViews: {}, savedLevels: {} });
    expect(v.map((x) => [x.id, x.label])).toEqual([['a', 'a']]);
    const floors = ['f'], camera = { position: [1, 2, 3], target: [0, 0, 0] }, rules = [{ hide: 'all' }];
    const r = resolveViews({ manifest: null, haFloors: [], layoutViews: { n: { added: true, floors, camera, rules } }, yamlViews: {}, savedLevels: {} });
    const n = r.find((x) => x.id === 'n');
    expect(n.floors).not.toBe(floors); expect(n.camera.position).not.toBe(camera.position); expect(n.rules[0]).not.toBe(rules[0]);
  });
  it('warns once about unknown yaml view ids', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const args = { manifest: null, haFloors: [], layoutViews: {}, yamlViews: { zzz: { label: 'x' } }, savedLevels: {} };
    resolveViews(args); resolveViews(args);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
