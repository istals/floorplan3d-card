import { describe, it, expect } from 'vitest';
import { nodeIndex, ruleState, ruleKeepsObjects, setRuleState, nextEyeState, viewTree, pickSelector, orderViews, nextViewId, parseSelector, matches, legacyShowRules } from '../src/views.js';
import { buildManifest } from '../src/manifest.js';

const tree = (roots) => {
  const parent = new Map();
  const walk = (n) => (n.children || []).forEach((c) => { parent.set(c, n); walk(c); });
  roots.forEach(walk);
  return { roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '', extras: (n) => n.extras || {}, parent: (n) => parent.get(n) || null };
};
const fp = (o) => ({ fp: o });
const sq = [[0, 0], [4, 0], [4, 3]];
const lamp = { name: 'lamp', extras: fp({ kind: 'object', id: 'l1', type: 'light' }) };
const sofa = { name: 'Sofa', extras: fp({ kind: 'object', id: 'sofa', type: 'furniture', layer: 'furniture' }) };
const chairs = { name: 'Chairs', extras: fp({ layer: 'furniture' }), children: [{ name: 'chair1' }, { name: 'chair2' }] };
const kitchen = { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq }), children: [sofa, chairs, { name: 'slab' }] };
const deep = { name: 'deep', children: [{ name: 'deeper', children: [{ name: 'deepest', children: [{ name: 'm' }] }] }] };
const ceiling = { name: 'Ceiling', extras: fp({ layer: ['ceiling'] }) };
const ground = { name: 'ground', extras: fp({ kind: 'level', id: 'ground', order: 0 }), children: [kitchen, lamp, deep, { name: 'mesh_177' }] };
const attic = { name: 'attic', extras: fp({ kind: 'level', id: 'attic', order: 1 }), children: [ceiling] };
const ext = { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [{ name: 'lawn', extras: fp({ kind: 'zone', id: 'lawn', outline: sq }) }] };
const props = { name: 'Props', children: [{ name: 'Tree', children: [{ name: 'leaves' }] }] };
const adapter = tree([ground, attic, ext, props]);
const man = buildManifest(adapter);
const idx = nodeIndex(adapter, man);
const at = (name) => idx.nodes.findIndex((n) => n.name === name);

describe('rule list edits', () => {
  it('reads the state of a selector from the layout rules (last one wins)', () => {
    expect(ruleState([], 'level:ground')).toBe('default');
    expect(ruleState([{ hide: 'level:ground' }], 'level:ground')).toBe('hidden');
    expect(ruleState([{ hide: 'level:ground' }, { show: 'level:ground' }], 'level:ground')).toBe('shown');
    expect(ruleState([{ show: 'layer:x' }], 'level:ground')).toBe('default');
    expect(ruleState([{ hide: 'zone:d', keep_objects: true }], 'zone:d')).toBe('hidden');
    expect(ruleKeepsObjects([{ hide: 'zone:d', keep_objects: true }], 'zone:d')).toBe(true);
    expect(ruleKeepsObjects([{ hide: 'zone:d', keep_objects: true }, { hide: 'zone:d' }], 'zone:d')).toBe(false);
    expect(setRuleState([{ hide: 'zone:d' }], 'zone:d', 'hidden', { keepObjects: true })).toEqual([{ hide: 'zone:d', keep_objects: true }]);
    expect(setRuleState([{ hide: 'zone:d', keep_objects: true }], 'zone:d', 'shown')).toEqual([{ show: 'zone:d' }]);
    expect(ruleState(null, 'all')).toBe('default');
  });
  it('replaces earlier rules for the selector and appends the new one', () => {
    const r = [{ hide: 'level:ground' }, { show: 'layer:x' }, { show: 'level:ground' }];
    expect(setRuleState(r, 'level:ground', 'hidden')).toEqual([{ show: 'layer:x' }, { hide: 'level:ground' }]);
    expect(setRuleState(r, 'level:ground', 'shown')).toEqual([{ show: 'layer:x' }, { show: 'level:ground' }]);
    expect(setRuleState(r, 'level:ground', 'default')).toEqual([{ show: 'layer:x' }]);
    expect(setRuleState(undefined, 'all', 'hidden')).toEqual([{ hide: 'all' }]);
    expect(r).toHaveLength(3); // not mutated
  });
  it('cycles default -> shown -> hidden -> default', () => {
    expect(nextEyeState('default')).toBe('shown');
    expect(nextEyeState('shown')).toBe('hidden');
    expect(nextEyeState('hidden')).toBe('default');
  });
});

describe('viewTree', () => {
  const t = viewTree(idx, { 'level:ground': 'Ground floor' });
  it('lists levels, their rooms/zones and objects under each', () => {
    expect(t.tree.map((r) => [r.sel, r.depth])).toEqual([
      ['level:ground', 0], ['room:kitchen', 1], ['object:sofa', 2], ['object:l1', 1],
      ['level:attic', 0],
      ['level:exterior', 0], ['zone:lawn', 1],
    ]);
    expect(t.tree[0].label).toBe('Ground floor');
    expect(t.tree[1].label).toBe('kitchen');
    expect(t.tree[1].nodes).toEqual([at('kitchen')]);
  });
  it('lists distinct layers with their nodes', () => {
    expect(t.layers.map((r) => r.sel)).toEqual(['layer:furniture', 'layer:ceiling']);
    expect(t.layers[0].nodes).toEqual([at('Sofa'), at('Chairs')]);
  });
  it('lists untagged groups with children up to two levels below a level or the root', () => {
    expect(t.groups.map((r) => [r.sel, r.depth])).toEqual([
      ['node:ground/kitchen/Chairs', 1], ['node:ground/deep', 0], ['node:ground/deep/deeper', 1],
      ['node:Props', 0], ['node:Props/Tree', 1],
    ]);
  });
});

describe('pickSelector', () => {
  const owner = (name) => { const e = man.byNode.get(idx.nodes[at(name)].node); return e; };
  it('uses the tag of a tagged room/zone/object owner', () => {
    expect(pickSelector(idx, at('slab'), owner('kitchen'))).toEqual({ sel: 'room:kitchen', idx: at('kitchen') });
    expect(pickSelector(idx, at('lawn'), owner('lawn'))).toEqual({ sel: 'zone:lawn', idx: at('lawn') });
  });
  it('walks up to the nearest named group with children (not past the owning level)', () => {
    expect(pickSelector(idx, at('chair1'), owner('kitchen'))).toEqual({ sel: 'room:kitchen', idx: at('kitchen') });
    expect(pickSelector(idx, at('m'), owner('ground'))).toEqual({ sel: 'node:ground/deep/deeper/deepest', idx: at('deepest') });
    expect(pickSelector(idx, at('leaves'), null)).toEqual({ sel: 'node:Props/Tree', idx: at('Tree') });
  });
  it('a mesh directly in a level picks the mesh itself', () => {
    expect(pickSelector(idx, at('mesh_177'), owner('ground'))).toEqual({ sel: 'node:ground/mesh_177', idx: at('mesh_177') });
  });
  it('the level node itself picks the level', () => {
    expect(pickSelector(idx, at('attic'), owner('attic'))).toEqual({ sel: 'level:attic', idx: at('attic') });
  });
  it('returns null without a node', () => {
    expect(pickSelector(idx, -1, null)).toBeNull();
  });
});

describe('orderViews / nextViewId', () => {
  const vs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'all' }];
  it('sorts by the stored order; unknown ids keep their relative place after', () => {
    expect(orderViews(vs, ['c', 'a']).map((v) => v.id)).toEqual(['c', 'a', 'b', 'all']);
    expect(orderViews(vs, null).map((v) => v.id)).toEqual(['a', 'b', 'c', 'all']);
    expect(orderViews(vs, ['x', 'all', 'b']).map((v) => v.id)).toEqual(['all', 'b', 'a', 'c']);
  });
  it('picks the first free view_<n>', () => {
    expect(nextViewId(['a', 'view_1', 'view_3'])).toEqual({ id: 'view_2', n: 2 });
    expect(nextViewId([])).toEqual({ id: 'view_1', n: 1 });
  });
});

describe('unique node selectors', () => {
  const chair = () => ({ name: 'Chair' });
  const odd = { name: 'a*b/c#d', children: [{ name: 'x' }] };
  const room = { name: 'Dining', children: [chair(), chair(), chair(), { name: 'Table' }, odd] };
  const ad = tree([room, { name: 'Dining' }]);
  const ix = nodeIndex(ad, buildManifest(ad));
  const paths = ix.nodes.map((n) => n.path);
  const m = (sel, path) => matches(parseSelector(sel), ix.nodes[paths.indexOf(path)]);
  it('suffixes ambiguous sibling names with #<n>, leaves unique ones alone', () => {
    expect(paths).toEqual(['Dining#0', 'Dining#0/Chair#0', 'Dining#0/Chair#1', 'Dining#0/Chair#2', 'Dining#0/Table',
      'Dining#0/a\\*b\\/c\\#d', 'Dining#0/a\\*b\\/c\\#d/x', 'Dining#1']);
    expect(ix.nodes[2].dup).toBe(1);
    expect(ix.nodes[4].dup).toBe(null);
  });
  it('a suffixed selector matches one sibling only', () => {
    expect(m('node:Dining#0/Chair#1', 'Dining#0/Chair#1')).toBe(true);
    expect(m('node:Dining#0/Chair#1', 'Dining#0/Chair#0')).toBe(false);
    expect(m('node:**/Chair*', 'Dining#0/Chair#2')).toBe(true);
  });
  it('escaped * and / in names match literally', () => {
    expect(m('node:Dining#0/a\\*b\\/c\\#d', 'Dining#0/a\\*b\\/c\\#d')).toBe(true);
    expect(m('node:Dining#0/a\\*b\\/c\\#d/x', 'Dining#0/a\\*b\\/c\\#d/x')).toBe(true);
    expect(m('node:Dining#0/a\\*b\\/c\\#d', 'Dining#0/Table')).toBe(false);
    expect(m('node:Dining#0/*/x', 'Dining#0/a\\*b\\/c\\#d/x')).toBe(true);
  });
  it('group rows label duplicates with their number', () => {
    const t = viewTree(nodeIndex(tree([{ name: 'G', children: [{ name: 'S', children: [{ name: 'm' }] }, { name: 'S', children: [{ name: 'm' }] }] }]),
      buildManifest(tree([]))));
    expect(t.groups.map((r) => [r.sel, r.label])).toEqual([['node:G', 'G'], ['node:G/S#0', 'S #1'], ['node:G/S#1', 'S #2']]);
  });
});

describe('tree parents', () => {
  it('objects in a room name the room row as parent', () => {
    const t = viewTree(idx);
    expect(t.tree.find((r) => r.sel === 'object:sofa').parent).toBe('room:kitchen');
    expect(t.tree.find((r) => r.sel === 'object:l1').parent).toBe('level:ground');
    expect(t.tree.find((r) => r.sel === 'room:kitchen').children).toBe(1);
  });
});

describe('legacyShowRules', () => {
  const levels = [{ id: 'g', role: 'storey', order: 0 }, { id: 'f', role: 'storey', order: 1 }, { id: 'ext', role: 'exterior' }];
  const views = [{ id: 'g', source: 'generated' }, { id: 'f', source: 'generated' }, { id: 'all', source: 'generated' }, { id: 'x', source: 'added' }];
  it('moves a level\'s legacy show mode into the views\' layout rules (before existing ones)', () => {
    const saved = { ext: { show: 'hidden', floor: 'ground' }, f: { show: 'only', floor: 'first' } };
    const lv = { g: { rules: [{ show: 'layer:a' }], camera: null } };
    expect(legacyShowRules(lv, views, 'ext', saved, levels)).toEqual({
      g: { rules: [{ hide: 'level:ext' }, { show: 'layer:a' }], camera: null },
      f: { rules: [{ hide: 'level:ext' }] },
      all: { rules: [{ hide: 'level:ext' }] },
    });
    expect(legacyShowRules({}, views, 'f', saved, levels)).toEqual({ g: { rules: [{ hide: 'level:f' }] } });
    expect(legacyShowRules({}, views, 'g', { g: { show: 'all-only' } }, levels)).toEqual({ f: { rules: [{ hide: 'level:g' }] } });
    expect(legacyShowRules({}, views, 'g', { g: { show: 'always' } }, levels)).toEqual({
      g: { rules: [{ show: 'level:g' }] }, f: { rules: [{ show: 'level:g' }] }, all: { rules: [{ show: 'level:g' }] } });
  });
  it('returns the same object when there is no legacy mode', () => {
    const lv = {};
    expect(legacyShowRules(lv, views, 'g', { g: { floor: 'x' } }, levels)).toBe(lv);
    expect(legacyShowRules(lv, views, 'g', {}, levels)).toBe(lv);
  });
});
