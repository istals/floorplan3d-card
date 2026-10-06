// Final review fixes for lights-and-objects (v0.4.0): lights: off sub-group, idle redraws, per-light
// shadow updates, tap order, charger power input, import keeping object bindings.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { ObjectLayer } from '../src/objects/layer.js';
import { chargerInputs, TYPES } from '../src/objects/types.js';
import { screenByDistance } from '../src/objects/logic.js';
import { mergeImport } from '../src/editor.js';
import { normalise } from '../src/storage.js';

const st = (state, attributes = {}) => ({ state, attributes });
const ctx = { visibleLevel: () => true, lightsOn: true };

function fakeView() {
  return {
    objectsGroup: new THREE.Group(),
    dirty: 0, shadow: 0, flagged: [],
    markDirty() { this.dirty++; },
    floorElevation: () => 0,
    requestShadowUpdate(lights) { this.shadow++; this.dirty++; this.flagged.push(...lights); },
  };
}

function model(objs) {
  const root = new THREE.Group();
  const level = new THREE.Group();
  root.add(level);
  const objects = objs.map((l) => {
    const node = new THREE.Group();
    node.position.set(l.x, 2, 0);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial());
    glow.name = l.glowName || 'glow';
    node.add(glow);
    level.add(node);
    return { id: l.id, type: l.type || 'light', level: 'ground', group: l.group || null, glow: null, hints: l.hints || {}, node, suggest: {} };
  });
  return { id: 'm', root, manifest: { levels: [{ id: 'ground', node: level }], objects } };
}
const bind = (ids) => new Map(ids.map(([id, entity]) => [id, { entity, auto: true, missing: false, hidden: false }]));

describe('lights: off hides the pool sub-group', () => {
  let view, layer;
  beforeEach(() => { view = fakeView(); layer = new ObjectLayer(view); });

  it('pool visible only with a model and lights on; labels stay in objectsGroup', () => {
    expect(layer.lights.visible).toBe(false);
    const m = model([{ id: 'a', x: 1 }, { id: 'c', x: 2, type: 'climate' }]);
    layer.setModel(m);
    expect(layer.lights.visible).toBe(true);
    layer.setBindings(bind([['a', 'light.a'], ['c', 'climate.c']]), {});
    layer.update({ 'light.a': st('on'), 'climate.c': st('heat', { current_temperature: 21 }) }, { ...ctx, lightsOn: false });
    expect(layer.lights.visible).toBe(false);
    expect(view.objectsGroup.visible).toBe(true);
    const label = layer.objectAt('c').part.label;
    if (label) expect(label.parent).toBe(view.objectsGroup);
    const d = view.dirty;
    layer.update({ 'light.a': st('on'), 'climate.c': st('heat', { current_temperature: 21 }) }, ctx);
    expect(layer.lights.visible).toBe(true);
    expect(view.dirty).toBeGreaterThan(d);
    layer.setModel(null);
    expect(layer.lights.visible).toBe(false);
  });
});

describe('idle: no redraw for unchanged mower poses', () => {
  it('the same pose (or null twice) marks nothing dirty', () => {
    const view = fakeView(), layer = new ObjectLayer(view);
    layer.setModel(model([{ id: 'mw', x: 1, type: 'mower' }]));
    layer.setBindings(bind([['mw', 'lawn_mower.m']]), {});
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    layer.setMowerPose(null);
    let d = view.dirty;
    layer.setMowerPose(null);
    expect(view.dirty).toBe(d);
    layer.setMowerPose({ x: 1, y: 2, floorId: 'ground', heading: 0.5 });
    d = view.dirty;
    layer.setMowerPose({ x: 1, y: 2, floorId: 'ground', heading: 0.5 });
    expect(view.dirty).toBe(d);
    layer.setMowerPose({ x: 1.1, y: 2, floorId: 'ground', heading: 0.5 });
    expect(view.dirty).toBe(d + 1);
  });
});

describe('per-light shadow updates', () => {
  let view, layer;
  beforeEach(() => { view = fakeView(); layer = new ObjectLayer(view); });

  it('a non-shadow lamp toggling while a shadow lamp is lit redraws no shadow map', () => {
    layer.setModel(model([{ id: 'a', x: 1 }, { id: 'g', x: 3, group: 'row' }]));
    layer.setBindings(bind([['a', 'light.a'], ['g', 'light.g']]), {});
    layer.update({ 'light.a': st('on'), 'light.g': st('off') }, ctx);
    expect(view.flagged).toHaveLength(1);
    layer.update({ 'light.a': st('on'), 'light.g': st('on') }, ctx);
    layer.update({ 'light.a': st('on'), 'light.g': st('off') }, ctx);
    expect(view.flagged).toHaveLength(1);
  });

  it('a new shadow pick ranked higher keeps the lit one in its slot (only the new map redraws)', () => {
    layer.setModel(model([{ id: 'a', x: 1, hints: { max: 2 } }, { id: 'b', x: 2, hints: { max: 20 } }]));
    layer.setBindings(bind([['a', 'light.a'], ['b', 'light.b']]), {});
    layer.update({ 'light.a': st('on'), 'light.b': st('off') }, ctx);
    const first = view.flagged.slice();
    expect(first).toHaveLength(1);
    layer.update({ 'light.a': st('on'), 'light.b': st('on') }, ctx);
    expect(view.flagged).toHaveLength(2);
    expect(view.flagged[1]).not.toBe(first[0]);
    expect(layer._slots.get('a').light).toBe(first[0]);
  });

  it('shadowsStale: lit shadow slots only; dark ones redraw when they light up', () => {
    layer.setModel(model([{ id: 'a', x: 1 }, { id: 'b', x: 2 }]));
    layer.setBindings(bind([['a', 'light.a'], ['b', 'light.b']]), {});
    layer.update({ 'light.a': st('on'), 'light.b': st('off') }, ctx);
    const stale = layer.shadowsStale();
    expect(stale).toEqual([layer._slots.get('a').light]);
    layer.update({ 'light.a': st('on'), 'light.b': st('on') }, ctx);
    expect(view.flagged.at(-1)).toBe(layer._slots.get('b').light);
  });

  it('the model moving redraws the lit shadow maps', () => {
    const m = model([{ id: 'a', x: 1 }]);
    layer.setModel(m);
    layer.setBindings(bind([['a', 'light.a']]), {});
    const s = { 'light.a': st('on') };
    layer.update(s, ctx);
    m.root.position.set(0, 0, 4);
    layer.update(s, ctx);
    expect(view.flagged).toHaveLength(2);
  });
});

describe('EV charger power from a separate sensor', () => {
  it('chargerInputs lists the power sensors', () => {
    expect(chargerInputs('switch.wallbox')).toEqual(['sensor.wallbox_power', 'sensor.wallbox_charging_power']);
    expect(chargerInputs(null)).toEqual([]);
    expect(TYPES.ev_charger.inputs).toBe(chargerInputs);
  });

  it('the label follows the power sensor live', () => {
    const view = fakeView(), layer = new ObjectLayer(view);
    layer.setModel(model([{ id: 'ev', x: 1, type: 'ev_charger', glowName: 'led' }]));
    layer.setBindings(bind([['ev', 'switch.wallbox']]), {});
    const charger = st('charging');
    layer.update({ 'switch.wallbox': charger, 'sensor.wallbox_power': st('7.2', { unit_of_measurement: 'kW' }) }, ctx);
    expect(layer.objectAt('ev').part.text).toBe('7.2 kW');
    layer.update({ 'switch.wallbox': charger, 'sensor.wallbox_power': st('3.1', { unit_of_measurement: 'kW' }) }, ctx);
    expect(layer.objectAt('ev').part.text).toBe('3.1 kW');
  });
});

describe('tap candidates nearest first', () => {
  it('screenByDistance sorts within the radius', () => {
    const pts = [{ id: 'far', x: 40, y: 0 }, { id: 'out', x: 100, y: 0 }, { id: 'near', x: 5, y: 0 }, { id: 'tie', x: 0, y: 5 }];
    expect(screenByDistance(pts, 0, 0, 52)).toEqual(['near', 'tie', 'far']);
    expect(screenByDistance([], 0, 0, 52)).toEqual([]);
  });
});

describe('import keeps object bindings and group controllers', () => {
  const cur = { objects: { lamp: { entity: 'light.x' } }, tags: { facade: { entity: 'switch.f' } } };
  it('a file without objects / groups keeps the current ones', () => {
    const l = mergeImport({ rooms: [], pins: {} }, { rooms: [] }, cur);
    expect(l.objects).toBe(cur.objects);
    expect(l.tags).toBe(cur.tags);
  });
  it('a file with its own wins; invalid ones keep ours', () => {
    const own = mergeImport({ rooms: [], objects: { a: { hidden: true } }, tags: {} }, { objects: { a: { hidden: true } }, groups: {} }, cur);
    expect(own.objects).toEqual({ a: { hidden: true } });
    expect(own.tags).toEqual({});
    const bad = mergeImport({ rooms: [] }, { objects: [1], groups: 'x' }, cur);
    expect(bad.objects).toBe(cur.objects);
    expect(bad.tags).toBe(cur.tags);
    expect('objects' in mergeImport({ rooms: [] }, {}, {})).toBe(false);
  });
  it('normalise drops non-object objects / groups', () => {
    const l = normalise({ objects: [1, 2], groups: 'x' });
    expect('objects' in l).toBe(false);
    expect('groups' in l).toBe(false);
    expect(normalise({ objects: { a: {} } }).objects).toEqual({ a: {} });
  });
});
