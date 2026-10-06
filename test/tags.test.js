import { describe, it, expect } from 'vitest';
import { objectTags, controllersOf, budgetGroup, bindObjects, chainState, effectiveGroups, layoutTags, lightBudget } from '../src/objects/logic.js';
import { actionTarget, popupRows } from '../src/objects/popup.js';
import { resolveActions } from '../src/actions.js';
import { parseSelector, matches } from '../src/views.js';
import { normalise, } from '../src/storage.js';
import { mergeImport, setTag, setObjectTags, addTagToObjects, removeTagFromObjects } from '../src/editor.js';

const st = (state, attributes = {}) => ({ state, attributes });

describe('objectTags', () => {
  const hass = {
    entities: { 'light.a': { labels: ['outdoor', 'lbl_x'] }, 'light.b': {} },
    labels: { outdoor: { label_id: 'outdoor', name: 'Outdoor' } },
  };
  it('defaults: fp.group, then the bound entity\'s HA labels (names, else ids), no duplicates', () => {
    expect(objectTags({ group: 'facade' }, {}, 'light.a', hass)).toEqual(['facade', 'Outdoor', 'lbl_x']);
    expect(objectTags({ group: 'Outdoor' }, {}, 'light.a', hass)).toEqual(['Outdoor', 'lbl_x']);
    expect(objectTags({}, {}, 'light.b', hass)).toEqual([]);
    expect(objectTags({}, null, null, null)).toEqual([]);
    expect(objectTags({ group: 'g' }, {}, 'light.a', { entities: hass.entities })).toEqual(['g', 'outdoor', 'lbl_x']);
  });
  it('saved tags win (trimmed, unique, strings only)', () => {
    expect(objectTags({ group: 'facade' }, { tags: [' a ', 'b', 'a', 3, ''] }, 'light.a', hass)).toEqual(['a', 'b']);
    expect(objectTags({ group: 'facade' }, { tags: [] }, 'light.a', hass)).toEqual([]);
  });
});

describe('layoutTags (migration of layout.groups)', () => {
  it('merges old groups under tags, tags win', () => {
    expect(layoutTags({ groups: { a: { entity: 'switch.a' }, b: { entity: 'switch.b' } }, tags: { b: { entity: 'switch.c' } } }))
      .toEqual({ a: { entity: 'switch.a' }, b: { entity: 'switch.c' } });
    expect(layoutTags({})).toEqual({});
    expect(layoutTags(null)).toEqual({});
  });
  it('normalise moves groups into tags on load', () => {
    const l = normalise({ groups: { facade: { entity: 'switch.f', label: 'F' } } });
    expect(l.tags).toEqual({ facade: { entity: 'switch.f', label: 'F' } });
    expect('groups' in l).toBe(false);
    expect(normalise({ tags: 'x' }).tags).toBeUndefined();
  });
  it('import keeps the current tags when the file has none, takes old groups from the file', () => {
    const cur = { tags: { t: { entity: 'switch.t' } } };
    expect(mergeImport({ rooms: [] }, {}, cur).tags).toBe(cur.tags);
    expect(mergeImport({ rooms: [], tags: { g: { entity: 'switch.g' } } }, { groups: { g: { entity: 'switch.g' } } }, cur).tags).toEqual({ g: { entity: 'switch.g' } });
  });
});

describe('controllers through tags', () => {
  const tags = { facade: { entity: 'switch.f' }, outdoor: { entity: 'switch.o' }, plain: { label: 'x' } };
  const obj = { id: 'l', group: 'facade' };
  it('every tag with a controller, own entity excluded, unique', () => {
    expect(controllersOf(obj, { entity: 'light.l', tags: ['facade', 'outdoor', 'plain'] }, tags)).toEqual([{ entity: 'switch.f', tag: 'facade' }, { entity: 'switch.o', tag: 'outdoor' }]);
    expect(controllersOf(obj, { entity: 'switch.f', tags: ['facade'] }, tags)).toEqual([]);
    expect(controllersOf(obj, { entity: 'light.l' }, tags)).toEqual([{ entity: 'switch.f', tag: 'facade' }]); // no tags: fp.group
    expect(controllersOf(obj, { entity: 'light.l', tags: [] }, tags)).toEqual([]);
  });
  it('chain: own entity and every controller must be on; reason names the first one off', () => {
    const b = { entity: 'light.l', tags: ['facade', 'outdoor'] };
    const s = { 'light.l': st('on'), 'switch.f': st('on'), 'switch.o': st('off') };
    let c = chainState(obj, b, tags, s);
    expect(c.lit).toBe(false);
    expect(c.entities).toEqual(['light.l', 'switch.f', 'switch.o']);
    expect(c.reason).toBe('switch.o is off');
    c = chainState(obj, b, tags, { ...s, 'switch.o': st('on') });
    expect(c.lit).toBe(true);
    expect(c.controllers.map((x) => x.entity)).toEqual(['switch.f', 'switch.o']);
  });
  it('budget group: the first tag with a controller, else fp.group', () => {
    expect(budgetGroup(obj, { tags: ['plain', 'outdoor', 'facade'] }, tags)).toBe('outdoor');
    expect(budgetGroup(obj, { tags: ['plain'] }, tags)).toBe('facade');
    expect(budgetGroup({ id: 'x' }, { tags: ['plain'] }, tags)).toBe(null);
  });
  it('objects sharing a controller tag count as one budget group', () => {
    const f = (id, group) => ({ id, lit: true, visible: true, max: 5, beam: 'point', group });
    const fixtures = [f('a', 'outdoor'), f('b', 'outdoor'), f('c', 'outdoor'), f('d', 'outdoor'), f('e', 'outdoor'), f('f', 'outdoor'), f('g', 'outdoor')];
    const { real } = lightBudget(fixtures, { points: 8, spots: 4, shadows: 4 });
    expect(real.size).toBe(1); // 7 > SMALL_GROUP: the middle lamp only
  });
  it('actionTarget: own, else the first usable controller', () => {
    const s = { 'light.l': st('unavailable'), 'switch.f': st('unavailable'), 'switch.o': st('on') };
    expect(actionTarget(obj, { entity: 'light.l', tags: ['facade', 'outdoor'] }, tags, s)).toBe('switch.o');
    expect(actionTarget(obj, { entity: null, tags: ['outdoor'] }, tags)).toBe('switch.o');
    expect(actionTarget(obj, { entity: 'light.l', tags: ['outdoor'] }, tags)).toBe('light.l');
  });
  it('popup: a chain row per controller with the tag label; the reason names the off one', () => {
    const t2 = { facade: { entity: 'switch.f', label: 'Facade circuit' }, outdoor: { entity: 'switch.o' } };
    const s = { 'light.l': st('on', { friendly_name: 'Lamp' }), 'switch.f': st('on'), 'switch.o': st('off', { friendly_name: 'Outdoor power' }) };
    const b = { entity: 'light.l', tags: ['facade', 'outdoor'] };
    const rows = popupRows({ id: 'l', type: 'light' }, chainState(obj, b, t2, s), s, t2);
    const chain = rows.filter((r) => r.kind === 'chain');
    expect(chain.map((r) => [r.entity, r.label, r.value])).toEqual([['switch.f', 'Facade circuit', true], ['switch.o', 'Outdoor power', false]]);
    expect(rows.find((r) => r.kind === 'reason').label).toBe('Outdoor power is off');
  });
  it('bindObjects with hass adds tags; effectiveGroups ignores unknown controllers', () => {
    const b = bindObjects([{ id: 'l', group: 'facade', suggest: { entity: 'light.l' } }], { }, { 'light.l': st('on') },
      { hass: { entities: { 'light.l': { labels: ['outdoor'] } } } });
    expect(b.get('l').tags).toEqual(['facade', 'outdoor']);
    expect(effectiveGroups({ a: { entity: 'switch.x' } }, {})).toEqual({});
  });
});

describe('tag: selectors and actions', () => {
  it('views: tag:<name> matches objects carrying the tag (fp.group as a fallback)', () => {
    const sel = parseSelector('tag:facade');
    expect(sel).toEqual({ kind: 'tag', value: 'facade' });
    expect(matches(sel, { tag: { kind: 'object', id: 'a', tags: ['facade'] }, layers: [] })).toBe(true);
    expect(matches(sel, { tag: { kind: 'object', id: 'a', tags: ['x'], group: 'facade' }, layers: [] })).toBe(false);
    expect(matches(sel, { tag: { kind: 'object', id: 'a', group: 'facade' }, layers: [] })).toBe(true);
    expect(matches(sel, { tag: { kind: 'room', id: 'a' }, layers: [] })).toBe(false);
  });
  it('actions: tag:<name> keys below the entity and object keys, above device', () => {
    const yaml = {
      'device:d1': { tap_action: { action: 'none' }, hold_action: { action: 'none' } },
      'tag:facade': { tap_action: { action: 'more-info' }, hold_action: { action: 'more-info' } },
      'light.l': { hold_action: { action: 'toggle' } },
    };
    const a = resolveActions({ yaml, kind: 'object', id: 'l', entityId: 'light.l', deviceId: 'd1', tags: ['facade'] });
    expect(a.tap.action).toBe('more-info');
    expect(a.hold.action).toBe('toggle');
    const b = resolveActions({ yaml: { ...yaml, 'object:l': { tap_action: { action: 'popup' } } }, kind: 'object', id: 'l', entityId: 'light.l', tags: ['facade'] });
    expect(b.tap.action).toBe('popup');
  });
});

describe('editor: tags', () => {
  it('setTag writes layout.tags (controller, label; none / empty dropped)', () => {
    expect(setTag({}, 'facade', { entity: ' switch.f ' }).tags).toEqual({ facade: { entity: 'switch.f' } });
    expect(setTag({ tags: { facade: { entity: 'switch.f' } } }, 'facade', { entity: 'none' }).tags).toEqual({});
    expect(setTag({ groups: { old: { entity: 'switch.o' } } }, 'facade', { label: 'F' }).tags).toEqual({ old: { entity: 'switch.o' }, facade: { label: 'F' } });
  });
  it('setObjectTags stores a list, or nothing when it equals the defaults', () => {
    expect(setObjectTags({}, 'a', ['x', 'y'], ['x']).objects.a).toEqual({ tags: ['x', 'y'] });
    expect(setObjectTags({ objects: { a: { tags: ['x', 'y'] } } }, 'a', ['x'], ['x']).objects).toEqual({});
    expect(setObjectTags({}, 'a', [], ['x']).objects.a).toEqual({ tags: [] });
  });
  it('add / remove a tag on several objects', () => {
    const tagsOf = (id) => ({ a: ['facade'], b: [] })[id] || [];
    let l = addTagToObjects({}, ['a', 'b'], 'outdoor', tagsOf, tagsOf);
    expect(l.objects).toEqual({ a: { tags: ['facade', 'outdoor'] }, b: { tags: ['outdoor'] } });
    const cur = (id) => l.objects[id].tags;
    l = removeTagFromObjects(l, ['a', 'b'], 'outdoor', cur, tagsOf);
    expect(l.objects).toEqual({});
  });
});
