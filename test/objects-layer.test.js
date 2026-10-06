import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { ObjectLayer } from '../src/objects/layer.js';

const st = (state, attributes = {}) => ({ state, attributes });

function fakeView() {
  return {
    objectsGroup: new THREE.Group(),
    dirty: 0, shadow: 0,
    markDirty() { this.dirty++; },
    floorElevation: (f) => (f === 'up' ? 3 : 0),
    flagged: [],
    requestShadowUpdate(lights) { this.shadow++; this.dirty++; this.flagged.push(...lights); },
  };
}

// a level node with lamps: { id, x, group?, hints?, type? }
function model(lamps) {
  const root = new THREE.Group();
  const level = new THREE.Group();
  root.add(level);
  const objects = lamps.map((l) => {
    const node = new THREE.Group();
    node.position.set(l.x, 2, 0);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial());
    glow.name = 'glow';
    node.add(glow);
    level.add(node);
    return { id: l.id, type: l.type || 'light', level: 'ground', group: l.group || null, glow: null, hints: l.hints || {}, node, suggest: {} };
  });
  return { id: 'm', root, manifest: { levels: [{ id: 'ground', node: level }], objects } };
}

const bind = (ids) => new Map(ids.map(([id, entity]) => [id, { entity, auto: true, missing: false, hidden: false }]));
const ctx = { visibleLevel: () => true, lightsOn: true };
const points = (layer) => layer.pool.points;
const lit = (arr) => arr.filter((l) => l.intensity > 0);

describe('ObjectLayer', () => {
  let view, layer;
  beforeEach(() => {
    view = fakeView();
    layer = new ObjectLayer(view);
  });

  it('creates a fixed pool: 8 points (first 4 cast shadows) and 4 spots, all dark, hidden without a model', () => {
    expect(points(layer)).toHaveLength(8);
    expect(layer.pool.spots).toHaveLength(4);
    expect(points(layer).map((l) => l.castShadow)).toEqual([true, true, true, true, false, false, false, false]);
    expect(layer.pool.spots.every((l) => !l.castShadow)).toBe(true);
    expect(points(layer)[0].shadow.mapSize.x).toBe(512);
    expect(points(layer)[0].shadow.bias).toBeCloseTo(-0.004);
    expect(points(layer)[0].shadow.camera.near).toBeCloseTo(0.15);
    expect([...points(layer), ...layer.pool.spots].every((l) => l.intensity === 0)).toBe(true);
    expect(layer.lights.children.filter((o) => o.isLight)).toHaveLength(12);
    expect(layer.lights.parent).toBe(view.objectsGroup);
    expect(view.objectsGroup.visible).toBe(false);
    expect(points(layer).slice(0, 4).every((l) => l.shadow.autoUpdate === false)).toBe(true);
  });

  it('a lit lamp gets a shadow-casting pool light at its glow centre', () => {
    const m = model([{ id: 'a', x: 3, hints: { max: 10, distance: 9 } }]);
    layer.setModel(m);
    expect(view.objectsGroup.visible).toBe(true);
    layer.setBindings(bind([['a', 'light.a']]), {});
    layer.update({ 'light.a': st('on', { brightness: 128 }) }, ctx);
    const on = lit(points(layer));
    expect(on).toHaveLength(1);
    expect(points(layer).indexOf(on[0])).toBeLessThan(4);
    expect(on[0].position.toArray()).toEqual([3, 2, 0]);
    expect(on[0].intensity).toBeCloseTo((128 / 255) * 10);
    expect(on[0].distance).toBe(9);
    expect(view.shadow).toBe(1);
    expect(m.root.children[0].children[0].children[0].material.emissiveIntensity).toBeCloseTo((128 / 255) * 3);
  });

  it('the same states again change nothing', () => {
    layer.setModel(model([{ id: 'a', x: 1 }]));
    layer.setBindings(bind([['a', 'light.a']]), {});
    const states = { 'light.a': st('on') };
    layer.update(states, ctx);
    const d = view.dirty, s = view.shadow;
    layer.update({ ...states }, ctx);
    expect(view.dirty).toBe(d);
    expect(view.shadow).toBe(s);
  });

  it('a brightness change updates the pooled light without a new assignment', () => {
    layer.setModel(model([{ id: 'a', x: 1 }]));
    layer.setBindings(bind([['a', 'light.a']]), {});
    layer.update({ 'light.a': st('on', { brightness: 255 }) }, ctx);
    const s = view.shadow, d = view.dirty;
    layer.update({ 'light.a': st('on', { brightness: 51, rgb_color: [255, 0, 0] }) }, ctx);
    const l = lit(points(layer))[0];
    expect(points(layer).indexOf(l)).toBeLessThan(4); // a shadow light
    expect(l.intensity).toBeCloseTo(1);
    expect(l.color.g).toBeCloseTo(0);
    expect(view.shadow).toBe(s); // shadow maps depend on position only
    expect(view.dirty).toBeGreaterThan(d);
  });

  it('a group of 20 gets one real light (middle fixture, x1.5), the rest stay emissive', () => {
    const lamps = Array.from({ length: 20 }, (_, i) => ({ id: `g${i + 1}`, x: i, group: 'row', hints: { max: 2 } }));
    layer.setModel(model(lamps));
    layer.setBindings(bind(lamps.map((l) => [l.id, 'light.row'])), {});
    layer.update({ 'light.row': st('on') }, ctx);
    const on = lit(points(layer));
    expect(on).toHaveLength(1);
    expect(on[0].intensity).toBeCloseTo(3);
    expect(on[0].position.x).toBe(9); // g10 of g1..g20
    expect(points(layer).indexOf(on[0])).toBeGreaterThanOrEqual(4); // groups never cast shadows
  });

  it('non-shadow picks fill slots 4..7 first; more lit fixtures than the pool stay emissive only', () => {
    const lamps = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, x: i, hints: { max: 12 - i, castShadow: i >= 2 ? false : true } }));
    layer.setModel(model(lamps));
    layer.setBindings(bind(lamps.map((l) => [l.id, 'light.x'])), {});
    layer.update({ 'light.x': st('on') }, ctx);
    const p = points(layer);
    expect(p.every((l) => l.intensity > 0)).toBe(true);
    expect(p[0].position.x).toBe(0);
    expect(p[1].position.x).toBe(1);
    expect(p.slice(4).map((l) => l.position.x)).toEqual([2, 3, 4, 5]);
  });

  it('group lamps take the non-shadow slots 4..7, singles spill into shadow slots instead (I2)', () => {
    const singles = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, x: 10 + i, hints: { max: 20, castShadow: i === 0 } }));
    const facade = Array.from({ length: 4 }, (_, i) => ({ id: `f${i + 1}`, x: i, group: 'facade', hints: { max: 5 } }));
    layer.setModel(model([...singles, ...facade]));
    layer.setBindings(bind([...singles.map((l) => [l.id, 'light.s']), ...facade.map((l) => [l.id, 'light.f'])]), {});
    layer.update({ 'light.s': st('on'), 'light.f': st('on') }, ctx);
    const p = points(layer);
    expect(p.every((l) => l.intensity > 0)).toBe(true);
    expect(p.slice(4).map((l) => l.position.x).sort()).toEqual([0, 1, 2, 3]);
    expect(p.slice(0, 4).map((l) => l.position.x).sort()).toEqual([10, 11, 12, 13]);
  });
  it('spot fixtures use a spot slot aimed at hints.target (model frame -> card world)', () => {
    const m = model([{ id: 's', x: 1, hints: { beam: 'spot', target: [1, 0, 0], angle: 30, max: 8 } }]);
    m.root.position.set(10, 0, 0);
    layer.setModel(m);
    layer.setBindings(bind([['s', 'light.s']]), {});
    layer.update({ 'light.s': st('on') }, ctx);
    const on = lit(layer.pool.spots);
    expect(on).toHaveLength(1);
    expect(on[0].position.toArray()).toEqual([11, 2, 0]);
    expect(on[0].target.position.toArray()).toEqual([11, 0, 0]);
    expect(on[0].angle).toBeCloseTo((30 * Math.PI) / 180);
    expect(lit(points(layer))).toHaveLength(0);
  });

  it('uplights sharing one target in a group aim straight up from their own lamp; a far target is ignored', () => {
    const ups = [0, 1, 2].map((i) => ({ id: `up${i}`, x: i * 2, group: 'uplights', hints: { beam: 'up', target: [3, 0, 3], max: 8 } }));
    const far = { id: 'spot_far', x: 9, hints: { beam: 'spot', target: [9, 0, 30], distance: 6, max: 8 } };
    const m = model([...ups, far]);
    m.root.position.set(10, 0, 0);
    layer.setModel(m);
    expect(Object.fromEntries(layer.badTargets)).toEqual({ up0: 'shared', up1: 'shared', up2: 'shared', spot_far: 'far' });
    layer.setBindings(bind([...ups.map((u) => [u.id, 'light.u']), ['spot_far', 'light.f']]), {});
    layer.update({ 'light.u': st('on'), 'light.f': st('on') }, ctx);
    const on = lit(layer.pool.spots);
    expect(on).toHaveLength(4);
    for (const l of on) {
      expect(l.target.position.x).toBeCloseTo(l.position.x);
      expect(l.target.position.z).toBeCloseTo(l.position.z);
      const up = l.position.x < 19; // the uplights at x 10..14, the far spot at 19 points down
      expect(l.target.position.y - l.position.y).toBeCloseTo(up ? 2 : -1);
    }
  });

  it('hidden levels and lights: off give no real light, emissive stays', () => {
    const m = model([{ id: 'a', x: 1 }]);
    layer.setModel(m);
    layer.setBindings(bind([['a', 'light.a']]), {});
    layer.update({ 'light.a': st('on') }, { visibleLevel: () => false, lightsOn: true });
    expect(lit(points(layer))).toHaveLength(0);
    layer.update({ 'light.a': st('on') }, { visibleLevel: () => true, lightsOn: false });
    expect(lit(points(layer))).toHaveLength(0);
    expect(layer.objectAt('a').result.lit).toBe(true);
    layer.update({ 'light.a': st('on') }, ctx);
    expect(lit(points(layer))).toHaveLength(1);
    // a hidden node (e.g. a view hides it) is not visible either
    m.manifest.objects[0].node.visible = false;
    layer.update({ 'light.a': st('on') }, ctx);
    expect(lit(points(layer))).toHaveLength(0);
  });

  it('turning a light off frees its slot; unavailable / missing entities stay dark', () => {
    layer.setModel(model([{ id: 'a', x: 1 }, { id: 'b', x: 2 }]));
    layer.setBindings(bind([['a', 'light.a'], ['b', 'light.gone']]), {});
    layer.update({ 'light.a': st('on') }, ctx);
    expect(lit(points(layer))).toHaveLength(1);
    layer.update({ 'light.a': st('unavailable') }, ctx);
    expect(lit(points(layer))).toHaveLength(0);
    expect(layer.objectAt('a').chain.unavailable).toBe(true);
  });

  it('a hidden object is ignored: no glow, no pool light, even when its group controller is on', () => {
    const m = model([{ id: 'a', x: 1, group: 'g' }, { id: 'b', x: 2 }]);
    layer.setModel(m);
    const b = bind([['a', 'light.a'], ['b', 'light.a']]);
    b.get('a').hidden = true;
    layer.setBindings(b, { g: { entity: 'switch.g' } });
    layer.update({ 'light.a': st('on'), 'switch.g': st('on') }, ctx);
    const on = lit(points(layer));
    expect(on).toHaveLength(1);
    expect(on[0].position.x).toBe(2);
    expect(m.manifest.objects[0].node.children[0].material.emissiveIntensity).toBe(0);
    expect(layer.objectAt('a').result.lit).toBe(false);
    // un-hiding lights it
    layer.setBindings(bind([['a', 'light.a'], ['b', 'light.a']]), {});
    layer.update({ 'light.a': st('on'), 'switch.g': st('on') }, ctx);
    expect(lit(points(layer))).toHaveLength(2);
  });

  it('a group controller gates the fixture (chain rule)', () => {
    const m = model([{ id: 'a', x: 1, group: 'g' }]);
    layer.setModel(m);
    layer.setBindings(bind([['a', 'light.a']]), { g: { entity: 'switch.g' } });
    layer.update({ 'light.a': st('on'), 'switch.g': st('off') }, ctx);
    expect(lit(points(layer))).toHaveLength(0);
    layer.update({ 'light.a': st('on'), 'switch.g': st('on') }, ctx);
    expect(lit(points(layer))).toHaveLength(1);
  });

  it('moving the model moves the pool lights on the next update', () => {
    const m = model([{ id: 'a', x: 1 }]);
    layer.setModel(m);
    layer.setBindings(bind([['a', 'light.a']]), {});
    const states = { 'light.a': st('on') };
    layer.update(states, ctx);
    m.root.position.set(0, 0, 5);
    layer.update(states, ctx);
    expect(lit(points(layer))[0].position.toArray()).toEqual([1, 2, 5]);
    expect(layer.anchors().find((a) => a.id === 'a').world.toArray()).toEqual([1, 2, 5]);
  });

  it('setModel(null) restores the materials, darkens the pool and forgets the parts', () => {
    const m = model([{ id: 'a', x: 1 }]);
    const glow = m.manifest.objects[0].node.children[0];
    const orig = glow.material;
    layer.setModel(m);
    expect(glow.material).not.toBe(orig);
    layer.setBindings(bind([['a', 'light.a']]), {});
    layer.update({ 'light.a': st('on') }, ctx);
    layer.setModel(null);
    expect(glow.material).toBe(orig);
    expect(lit(points(layer))).toHaveLength(0);
    expect(layer.objectAt('a')).toBeNull();
    expect(layer.anchors()).toEqual([]);
    expect(view.objectsGroup.visible).toBe(false);
    layer.update({ 'light.a': st('on') }, ctx); // no errors without a model
  });

  it('no shadow redraw without shadow lights (no lamps, groups, castShadow false)', () => {
    layer.setModel(model([]));
    layer.update({}, ctx);
    expect(view.shadow).toBe(0);
    layer.setModel(model([{ id: 'a', x: 1, hints: { castShadow: false } }, { id: 'b', x: 2, group: 'g' }]));
    layer.setBindings(bind([['a', 'light.a'], ['b', 'light.a']]), {});
    layer.update({ 'light.a': st('on') }, ctx);
    layer.update({ 'light.a': st('off') }, ctx);
    expect(view.shadow).toBe(0);
    expect(lit(points(layer))).toHaveLength(0);
  });

  it('a shadow light: its map is redrawn when it lights up, not when it goes dark', () => {
    layer.setModel(model([{ id: 'a', x: 1 }]));
    layer.setBindings(bind([['a', 'light.a']]), {});
    layer.update({ 'light.a': st('on') }, ctx);
    expect(view.flagged).toEqual([points(layer)[0]]);
    layer.update({ 'light.a': st('off') }, ctx);
    expect(view.shadow).toBe(1);
  });

  it('dispose removes the pool from the view', () => {
    layer.dispose();
    expect(view.objectsGroup.children).toHaveLength(0);
  });

  it('mower node follows the pose in world space and is restored afterwards', () => {
    const m = model([{ id: 'mw', x: 1, type: 'mower' }]);
    m.root.position.set(10, 0, 5);
    m.root.rotation.y = 0.7;
    layer.setModel(m);
    layer.setBindings(bind([['mw', 'lawn_mower.m']]), {});
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    expect(layer.mowerBound()).toBe(true);
    const node = m.manifest.objects[0].node;
    const p0 = node.position.clone(), q0 = node.quaternion.clone();
    layer.setMowerPose({ x: 2, y: 4, floorId: 'up', heading: Math.PI / 2 });
    const w = node.getWorldPosition(new THREE.Vector3());
    expect(w.x).toBeCloseTo(2); expect(w.z).toBeCloseTo(-4); expect(w.y).toBeCloseTo(3 + 2);
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
    expect(fwd.z).toBeCloseTo(-1); // heading north (plan +y = world -z)
    expect(layer.anchorOf('mw').x).toBeCloseTo(2, 1);
    layer.setMowerPose(null);
    expect(node.position.distanceTo(p0)).toBeCloseTo(0);
    expect(node.quaternion.angleTo(q0)).toBeCloseTo(0);
    layer.setMowerPose({ x: 1, y: 1, floorId: 'up', heading: 0 });
    layer.setModel(null);
    expect(node.position.distanceTo(p0)).toBeCloseTo(0);
  });

  it('mower stands on the ground when it is known (pose.ground), keeping its own height over its level', () => {
    const m = model([{ id: 'mw', x: 1, type: 'mower' }]);
    const node = m.manifest.objects[0].node;
    layer.setModel(m);
    layer.setBindings(bind([['mw', 'lawn_mower.m']]), {});
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    const localY = node.getWorldPosition(new THREE.Vector3()).y - (m.manifest.levels[0].elevation || 0);
    layer.setMowerPose({ x: 2, y: 4, floorId: 'up', heading: 0, ground: 0.25 }); // floor 'up' is at 3 m
    expect(node.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0.25 + localY);
    layer.setMowerPose({ x: 2, y: 4, floorId: 'up', heading: 0, ground: null });
    expect(node.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(3 + localY);
    layer.setModel(null);
  });

  it('mower height is relative to its own floor: upper-floor node stays put on the same floor', () => {
    const m = model([{ id: 'mw', x: 1, type: 'mower' }]);
    m.manifest.levels[0].elevation = 3;
    const node = m.manifest.objects[0].node;
    node.position.y = 3.1;
    layer.setModel(m);
    layer.setBindings(bind([['mw', 'lawn_mower.m']]), {});
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    layer.setMowerPose({ x: 2, y: 2, floorId: 'up', heading: 0 }); // elevation(up) = 3
    expect(node.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(3.1);
    layer.setMowerPose({ x: 2, y: 2, floorId: 'ground', heading: 0 }); // elevation 0
    expect(node.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0.1);
  });

  it('realigning the model re-captures the node origin', () => {
    const m = model([{ id: 'mw', x: 1, type: 'mower' }]);
    layer.setModel(m);
    layer.setBindings(bind([['mw', 'lawn_mower.m']]), {});
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    layer.setMowerPose({ x: 2, y: 4, floorId: 'ground', heading: 0 });
    m.root.position.set(7, 1, -3);
    m.root.rotation.y = 1;
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    const w = m.manifest.objects[0].node.getWorldPosition(new THREE.Vector3());
    expect(w.x).toBeCloseTo(2); expect(w.z).toBeCloseTo(-4); expect(w.y).toBeCloseTo(3); // 2 + root offset 1
    layer.setMowerPose(null);
    const back = m.manifest.objects[0].node.position;
    expect(back.x).toBeCloseTo(1); expect(back.y).toBeCloseTo(2);
  });

  it.each([['+x', 0], ['-x', 1], ['+z', 2], ['-z', 3]])('hints.front %s faces the direction of travel', (front, k) => {
    const m = model([{ id: 'mw', x: 1, type: 'mower', hints: { front } }]);
    m.root.rotation.y = 0.4;
    layer.setModel(m);
    layer.setBindings(bind([['mw', 'lawn_mower.m']]), {});
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    const axis = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)][k];
    for (const h of [0, 1, 2.5, -2]) {
      layer.setMowerPose({ x: 0, y: 0, floorId: 'ground', heading: h });
      const f = axis.clone().applyQuaternion(m.manifest.objects[0].node.getWorldQuaternion(new THREE.Quaternion()));
      expect(f.x).toBeCloseTo(Math.cos(h)); expect(f.z).toBeCloseTo(-Math.sin(h));
    }
  });

  it('mower glow takes the status colour', () => {
    const m = model([{ id: 'mw', x: 1, type: 'mower' }]);
    layer.setModel(m);
    layer.setBindings(bind([['mw', 'lawn_mower.m']]), {});
    layer.update({ 'lawn_mower.m': st('error') }, ctx);
    const mat = m.manifest.objects[0].node.children[0].material;
    expect(mat.emissive.r).toBeGreaterThan(0.5);
    layer.update({ 'lawn_mower.m': st('docked') }, ctx);
    expect(mat.emissiveIntensity).toBe(0);
  });

  it('dock LED follows the bound mower state', () => {
    const m = model([{ id: 'mw', x: 1, type: 'mower' }, { id: 'dk', x: 2, type: 'dock', hints: { led: 'glow' } }]);
    layer.setModel(m);
    layer.setBindings(bind([['mw', 'lawn_mower.m'], ['dk', null]]), {});
    const mat = m.manifest.objects[1].node.children[0].material;
    expect(mat.emissiveIntensity).toBe(0);
    layer.update({ 'lawn_mower.m': st('docked') }, ctx);
    const led = m.manifest.objects[1].node.children[0].material;
    expect(led.emissiveIntensity).toBe(3);
    expect(led.emissive.g).toBeGreaterThan(led.emissive.r);
    layer.update({ 'lawn_mower.m': st('mowing') }, ctx);
    expect(led.emissiveIntensity).toBe(0);
  });
});
