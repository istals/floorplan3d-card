import { describe, it, expect } from 'vitest';
import { bindObjects, mowerTabEntity, chainState, lightColor, lightLevel, lightBudget, nightFactor, sunVector, screenNearest, sunStrength, clampSunDir, snapPin, attachedPosition, attachOffset, floorAtHeight, effectiveGroups } from '../src/objects/logic.js';

const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes });

describe('bindObjects', () => {
  const objects = [
    { id: 'a', suggest: { entity: 'light.a' } },
    { id: 'b', suggest: { entity: 'light.missing' } },
    { id: 'c', suggest: {} },
  ];
  const states = { 'light.a': st('light.a', 'on'), 'light.x': st('light.x', 'off') };
  it('auto-binds suggest.entity when it exists', () => {
    const b = bindObjects(objects, {}, states);
    expect(b.get('a')).toEqual({ entity: 'light.a', auto: true, missing: false, hidden: false });
    expect(b.get('b')).toEqual({ entity: null, auto: true, missing: true, hidden: false });
    expect(b.get('c')).toEqual({ entity: null, auto: true, missing: false, hidden: false });
  });
  it('layout entry overrides and can hide', () => {
    const b = bindObjects(objects, { a: { entity: 'light.x' }, c: { hidden: true } }, states);
    expect(b.get('a')).toEqual({ entity: 'light.x', auto: false, missing: false, hidden: false });
    expect(b.get('c').hidden).toBe(true);
  });
  it('explicit entity that no longer exists is missing', () => {
    expect(bindObjects(objects, { a: { entity: 'light.gone' } }, states).get('a').missing).toBe(true);
  });
});

describe('bindObjects: mower / dock from the Mower tab', () => {
  const objects = [
    { id: 'm', type: 'mower', suggest: { entity: 'lawn_mower.other' } },
    { id: 'd', type: 'dock', suggest: {} },
    { id: 'l', type: 'lamp', suggest: { entity: 'light.gone' } },
    { id: 'm2', type: 'mower', suggest: { entity: 'lawn_mower.real' } },
  ];
  const states = { 'lawn_mower.mine': st('lawn_mower.mine', 'docked'), 'lawn_mower.real': st('lawn_mower.real', 'mowing') };
  it('uses the Mower tab entity when suggest is missing or not found', () => {
    const b = bindObjects(objects, {}, states, { mowerEntity: 'lawn_mower.mine' });
    expect(b.get('m')).toEqual({ entity: 'lawn_mower.mine', auto: true, missing: false, hidden: false, from: 'mower' });
    expect(b.get('d').entity).toBe('lawn_mower.mine');
    expect(b.get('l').entity).toBe(null);
    expect(b.get('m2')).toEqual({ entity: 'lawn_mower.real', auto: true, missing: false, hidden: false });
  });
  it('explicit bindings and none win; unknown mower entity is ignored', () => {
    const b = bindObjects(objects, { m: { entity: null }, d: { entity: 'lawn_mower.real' } }, states, { mowerEntity: 'lawn_mower.mine' });
    expect(b.get('m').entity).toBe(null);
    expect(b.get('d')).toEqual({ entity: 'lawn_mower.real', auto: false, missing: false, hidden: false });
    expect(bindObjects(objects, {}, states, { mowerEntity: 'lawn_mower.nope' }).get('m').missing).toBe(true);
  });
  it('mowerTabEntity resolves the lawn_mower of the same device', () => {
    const ents = { 'device_tracker.pos': { device_id: 'd1' }, 'lawn_mower.x': { device_id: 'd1' }, 'sensor.y': { device_id: 'd2' } };
    expect(mowerTabEntity('device_tracker.pos', ents)).toBe('lawn_mower.x');
    expect(mowerTabEntity('lawn_mower.z', ents)).toBe('lawn_mower.z');
    expect(mowerTabEntity('sensor.y', ents)).toBe('sensor.y');
    expect(mowerTabEntity('', ents)).toBe(null);
  });
});

describe('effectiveGroups', () => {
  const states = { 'switch.f': { state: 'on' }, 'light.g': { state: 'off' } };
  it('keeps controllers that exist in HA', () => {
    expect(effectiveGroups({ a: { entity: 'switch.f' }, b: { entity: 'light.g' } }, states)).toEqual({ a: { entity: 'switch.f' }, b: { entity: 'light.g' } });
  });
  it('drops missing, "none", empty and malformed controllers', () => {
    expect(effectiveGroups({ a: { entity: 'switch.typo' }, b: { entity: 'none' }, c: {}, d: null, e: { entity: 5 } }, states)).toEqual({});
    expect(effectiveGroups(undefined, states)).toEqual({});
  });
  it('a missing controller leaves the chain to the own entity', () => {
    const obj = { group: 'a' };
    const st = { 'light.x': { state: 'on', attributes: {} } };
    expect(chainState(obj, { entity: 'light.x' }, effectiveGroups({ a: { entity: 'switch.typo' } }, st), st).lit).toBe(true);
  });
});

describe('chainState', () => {
  const states = {
    'light.f': st('light.f', 'on', { brightness: 128 }),
    'switch.g': st('switch.g', 'off'),
    'switch.on': st('switch.on', 'on'),
    'switch.x': st('switch.x', 'home'),
    'climate.y': st('climate.y', 'heat'),
    'light.u': st('light.u', 'unavailable'),
  };
  it('own entity only', () => {
    const r = chainState({ group: null }, { entity: 'light.f' }, {}, states);
    expect(r.lit).toBe(true); expect(r.source.entity_id).toBe('light.f'); expect(r.reason).toBe(null);
  });
  it('group controller off makes it dark with reason entity name', () => {
    const r = chainState({ group: 'facade' }, { entity: 'light.f' }, { facade: { entity: 'switch.g' } }, states);
    expect(r.lit).toBe(false); expect(r.reason).toBe('switch.g is off'); expect(r.entities).toEqual(['light.f', 'switch.g']);
  });
  it('group controller only (no own entity)', () => {
    const r = chainState({ group: 'facade' }, { entity: null }, { facade: { entity: 'switch.on' } }, states);
    expect(r.lit).toBe(true); expect(r.source).toBe(null);
  });
  it('unavailable is dark and flagged', () => {
    const r = chainState({ group: null }, { entity: 'light.u' }, {}, states);
    expect(r.lit).toBe(false); expect(r.unavailable).toBe(true);
  });
  it('no entity at all is dark without reason', () => {
    expect(chainState({ group: null }, { entity: null }, {}, states)).toMatchObject({ lit: false, reason: null });
  });
  it('switch.x in home state is dark (isOn is on only)', () => {
    const r = chainState({ group: null }, { entity: 'switch.x' }, {}, states);
    expect(r.lit).toBe(false);
  });
  it('climate heat as own entity is dark', () => {
    const r = chainState({ group: null }, { entity: 'climate.y' }, {}, states);
    expect(r.lit).toBe(false);
  });
  it('no own entity + controller off gives reason with entity name', () => {
    const r = chainState({ group: 'facade' }, { entity: null }, { facade: { entity: 'switch.g' } }, states);
    expect(r.lit).toBe(false); expect(r.reason).toBe('switch.g is off');
  });
});

describe('lightColor / lightLevel', () => {
  it('rgb_color wins', () => expect(lightColor(st('light.a', 'on', { rgb_color: [255, 0, 0], hs_color: [120, 100] }))).toEqual([255, 0, 0]));
  it('hs_color converts', () => expect(lightColor(st('light.a', 'on', { hs_color: [120, 100] }))).toEqual([0, 255, 0]));
  it('kelvin converts to warm for 2700', () => { const [r, g, b] = lightColor(st('light.a', 'on', { color_temp_kelvin: 2700 })); expect(r).toBe(255); expect(b).toBeLessThan(g); });
  it('default warm white', () => expect(lightColor(st('switch.a', 'on'))).toEqual([255, 191, 128]));
  it('level from brightness, 1 when on without brightness, 0 when off', () => {
    expect(lightLevel(st('light.a', 'on', { brightness: 51 }))).toBeCloseTo(0.2);
    expect(lightLevel(st('switch.a', 'on'))).toBe(1);
    expect(lightLevel(st('light.a', 'off', { brightness: 200 }))).toBe(0);
    expect(lightLevel(null)).toBe(0);
  });
});

describe('lightBudget', () => {
  const f = (id, o = {}) => ({ id, lit: true, visible: true, group: null, max: 5, beam: 'point', castShadow: true, ...o });
  it('largest max first, pools respected, unlit and invisible skipped', () => {
    const fx = [f('a', { max: 34 }), f('b', { max: 5 }), f('c', { lit: false, max: 99 }), f('d', { visible: false, max: 99 }), f('s', { beam: 'spot', max: 10 })];
    const r = lightBudget(fx, { points: 1, spots: 1, shadows: 4 });
    expect([...r.real.keys()].sort()).toEqual(['a', 's']);
    expect(r.real.get('s').kind).toBe('spot');
  });
  it('a small group lights every lamp (factor 1) while the pool has room, never with shadows', () => {
    const fx = ['g1', 'g2', 'g3', 'g4'].map((id) => f(id, { group: 'facade', max: 5 }));
    const r = lightBudget(fx);
    expect([...r.real.keys()].sort()).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect([...r.real.values()].every((v) => v.factor === 1)).toBe(true);
    expect(r.shadows.size).toBe(0);
  });
  it('a group whose lamps all wash a wall is lit evenly or not at all', () => {
    const big = Array.from({ length: 9 }, (_, i) => f('w' + i, { group: 'facade', wash: true }));
    expect([...lightBudget(big).real.keys()]).toEqual([]); // > 6 lamps: washes only, no lamp stands out
    const small = ['g1', 'g2', 'g3', 'g4'].map((id) => f(id, { group: 'facade', max: 50, wash: true }));
    expect([...lightBudget(small).real.keys()].sort()).toEqual(['g1', 'g2', 'g3', 'g4']);
    // short pool: the middle alone would stand out, so none
    const r = lightBudget([f('s1', { max: 1 }), f('s2', { max: 1 })].concat(small), { points: 5 });
    expect([...r.real.keys()].sort()).toEqual(['s1', 's2']);
    // one lamp without a wash: the old rule (middle at 1.5)
    const mixed = small.map((x, i) => (i ? x : { ...x, wash: false }));
    expect(lightBudget([f('s1', { max: 1 }), f('s2', { max: 1 })].concat(mixed), { points: 5 }).real.get('g2').factor).toBe(1.5);
  });
  it('a short non-shadow pool gives a small group one light (middle, 1.5), never part', () => {
    const fx = [f('s1', { max: 1 }), f('s2', { max: 1 })].concat(['g1', 'g2', 'g3', 'g4'].map((id) => f(id, { group: 'facade', max: 50 })));
    const r = lightBudget(fx, { points: 5 });
    expect([...r.real.keys()].sort()).toEqual(['g2', 's1', 's2']);
    expect(r.real.get('g2').factor).toBe(1.5);
  });
  it('8 lit point singles + a 4-lamp facade: the facade middle competes and keeps one light (I1)', () => {
    const fx = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => f('p' + i, { max: 5 })).concat(['g1', 'g2', 'g3', 'g4'].map((id) => f(id, { group: 'facade', max: 5 })));
    const r = lightBudget(fx);
    const g = [...r.real.keys()].filter((id) => id.startsWith('g'));
    expect(g).toEqual(['g2']);
    expect(r.real.get('g2')).toEqual({ kind: 'point', factor: 1.5, grouped: true });
    expect(r.real.size).toBe(8);
  });
  it('a small group is lit per lamp only in non-shadow capacity (points - shadows), never in shadow slots (I2)', () => {
    // 1 shadowed single + facade(4) + a 3-lamp group: both middles take 2 of the 4 non-shadow slots,
    // the facade needs 3 more (does not fit) and keeps its middle at 1.5; the trio needs 2 more and is lit per lamp
    const fx = [f('s', { max: 9 })]
      .concat(['f1', 'f2', 'f3', 'f4'].map((id) => f(id, { group: 'facade', max: 8 })))
      .concat(['t1', 't2', 't3'].map((id) => f(id, { group: 'trio', max: 7 })));
    const r = lightBudget(fx);
    expect(r.shadows).toEqual(new Set(['s']));
    const grouped = [...r.real].filter(([, v]) => v.grouped && v.kind === 'point');
    expect(grouped.length).toBeLessThanOrEqual(4);
    expect(grouped.map(([id, v]) => [id, v.factor]).sort()).toEqual([['f2', 1.5], ['t1', 1], ['t2', 1], ['t3', 1]]);
    // without the trio the facade fits: 4 lamps in the 4 non-shadow slots, factor 1
    const r2 = lightBudget(fx.slice(0, 5));
    expect(['f1', 'f2', 'f3', 'f4'].map((id) => r2.real.get(id).factor)).toEqual([1, 1, 1, 1]);
    // two shadowed singles + spare shadow slots do not make room for group lamps
    const r3 = lightBudget(fx.slice(0, 5), { points: 8, shadows: 5 });
    expect(r3.real.get('f2').factor).toBe(1.5);
    expect(r3.real.has('f1')).toBe(false);
  });
  it('per-lamp expansion uses spot slots for spot lamps; the middle drops back to factor 1', () => {
    const fx = ['a1', 'a2', 'a3'].map((id) => f(id, { group: 'spots', beam: 'spot' }));
    const r = lightBudget(fx, { points: 4, spots: 3, shadows: 4 });
    expect([...r.real.values()].every((v) => v.kind === 'spot' && v.factor === 1)).toBe(true);
    expect(r.real.size).toBe(3);
  });
  it('a group whose middle lost the main ranking stays dark (glow only), not partial', () => {
    const fx = [f('a', { max: 9 }), f('b', { max: 9 })].concat(['g1', 'g2', 'g3'].map((id) => f(id, { group: 'x', max: 1 })));
    const r = lightBudget(fx, { points: 2, shadows: 0 });
    expect([...r.real.keys()].sort()).toEqual(['a', 'b']);
  });
  it('a group of 19 keeps one light (middle, factor 1.5)', () => {
    const fx = Array.from({ length: 19 }, (_, i) => f('lamp' + (i + 1), { group: 'string', max: 5 }));
    const r = lightBudget(fx);
    expect(r.real.size).toBe(1);
    expect(r.real.get('lamp10').factor).toBe(1.5);
  });
  it('group middle fixture with numeric collation (lamp2/lamp10/lamp3 → lamp3) when the pool is short', () => {
    const fx = ['lamp2', 'lamp10', 'lamp3'].map((id) => f(id, { group: 'facade', max: 5 }));
    const r = lightBudget(fx, { points: 2 });
    expect([...r.real.keys()]).toEqual(['lamp3']);
  });
  it('at most N shadows, only castShadow !== false singles', () => {
    const fx = [1, 2, 3, 4, 5, 6].map((i) => f('p' + i, { max: i })).concat([f('n', { max: 100, castShadow: false })]);
    const r = lightBudget(fx);
    expect(r.shadows.size).toBe(4);
    expect(r.shadows.has('n')).toBe(false);
    expect(r.shadows.has('p6')).toBe(true);
  });
  it('spot fixture never casts shadow even with castShadow true and largest max', () => {
    const fx = [f('point1', { max: 2 }), f('spot1', { beam: 'spot', max: 100, castShadow: true })];
    const r = lightBudget(fx);
    expect(r.real.has('spot1')).toBe(true);
    expect(r.shadows.has('spot1')).toBe(false);
  });
  it('tie-break equal max by id (alphabetical)', () => {
    const fx = [f('z', { max: 10 }), f('a', { max: 10 })];
    const r = lightBudget(fx, { points: 1 });
    expect([...r.real.keys()]).toEqual(['a']);
  });
});

describe('nightFactor / sunVector', () => {
  it('smoothstep between +6 and -6 degrees', () => {
    expect(nightFactor(30)).toBe(0); expect(nightFactor(-20)).toBe(1); expect(nightFactor(0)).toBeCloseTo(0.5);
  });
  it('non-finite input returns 0', () => {
    expect(nightFactor(NaN)).toBe(0);
    expect(nightFactor(Infinity)).toBe(0);
    expect(nightFactor(-Infinity)).toBe(0);
  });
  it('east sun with north 0 points to +x', () => {
    const [x, y, z] = sunVector(90, 0, 0, 0); expect(x).toBeCloseTo(1); expect(y).toBeCloseTo(0); expect(z).toBeCloseTo(0);
  });
  it('south sun at 45° elevation points to +z (south) and up', () => {
    const [x, y, z] = sunVector(180, 45, 0, 0); expect(x).toBeCloseTo(0); expect(y).toBeCloseTo(Math.SQRT1_2); expect(z).toBeCloseTo(Math.SQRT1_2);
  });
  it('north -26.4: true north lies west of model north', () => {
    const [x, , z] = sunVector(0, 0, -26.4, 0); expect(x).toBeLessThan(0); expect(z).toBeLessThan(0);
  });
  it('model alignment rotation (deg, CCW) rotates the vector', () => {
    const [x, , z] = sunVector(90, 0, 0, 90); expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(-1);
  });
});

describe('screenNearest', () => {
  const pts = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 130, y: 100 }];
  it('nearest within radius', () => { expect(screenNearest(pts, 118, 100, 30)).toBe('b'); expect(screenNearest(pts, 300, 300, 52)).toBe(null); });
  it('exact tie: first point wins', () => {
    const tied = [{ id: 'first', x: 100, y: 100 }, { id: 'second', x: 100, y: 100 }];
    expect(screenNearest(tied, 100, 100, 10)).toBe('first');
  });
});

describe('sun below the horizon', () => {
  it('sunStrength is 0 at -2 and below, 1 from +4', () => {
    expect(sunStrength(-10)).toBe(0);
    expect(sunStrength(-2)).toBe(0);
    expect(sunStrength(0)).toBeGreaterThan(0);
    expect(sunStrength(0)).toBeLessThan(1);
    expect(sunStrength(4)).toBe(1);
    expect(sunStrength(NaN)).toBe(1);
  });
  it('clampSunDir lifts y to 0.05 and keeps unit length and bearing', () => {
    const v = clampSunDir(sunVector(90, -10));
    expect(v[1]).toBeCloseTo(0.05);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(v[0]).toBeGreaterThan(0.99);
    expect(clampSunDir([0, 0.5, 0.5])).toEqual([0, 0.5, 0.5]);
    expect(clampSunDir([0, -1, 0])).toEqual([0, 1, 0]);
  });
});

describe('snapPin', () => {
  const v = (x, y, z) => ({ x, y, z });
  it('wall hit: 5 cm off the wall along the normal, height above the floor', () => {
    // wall facing east (+x) at world x = 2, plan y = 3 (world z = -3), 1.4 m up on a floor at 3 m
    const p = snapPin({ point: v(2, 4.4, -3), normal: v(1, 0, 0) }, 3, 'upper');
    expect(p.x).toBeCloseTo(2.05, 9);
    expect(p.y).toBeCloseTo(3, 9);
    expect(p.z).toBeCloseTo(1.4, 9);
    expect(p.floor_id).toBe('upper');
  });
  it('wall facing north (world -z) moves the pin north in plan', () => {
    const p = snapPin({ point: v(1, 1, -2), normal: v(0, 0, -1) }, 0, 'g');
    expect(p.y).toBeCloseTo(2.05, 9);
    expect(p.x).toBeCloseTo(1, 9);
  });
  it('ceiling hit: just below the ceiling', () => {
    const p = snapPin({ point: v(1, 2.7, -1), normal: v(0, -1, 0) }, 0, 'g');
    expect(p.z).toBeCloseTo(2.65, 9);
    expect([p.x, p.y]).toEqual([1, 1]);
  });
  it('accepts arrays', () => {
    const p = snapPin({ point: [0, 1, 0], normal: [0, 1, 0] }, 0, 'g');
    expect(p.z).toBeCloseTo(1.05, 9);
  });
});

describe('attached pins', () => {
  it('offset = marker world point - anchor (mm), round trip through attachedPosition', () => {
    const anchor = { x: 1, y: 2.5, z: -2 };
    const off = attachOffset(anchor, { x: 1.2, y: 2.1, z: 0.4, floorId: 'g' }, 0.3);
    // marker world: (1.2, 0.3 + 0.4, -2.1)
    expect(off).toEqual([0.2, -1.8, -0.1]);
    const p = attachedPosition(anchor, off, 0.3);
    expect(p.x).toBeCloseTo(1.2, 9);
    expect(p.y).toBeCloseTo(2.1, 9);
    expect(p.z).toBeCloseTo(0.4, 9);
  });
  it('follows the anchor', () => {
    const p = attachedPosition({ x: 5, y: 1, z: -5 }, [0, 0.2, 0], 0);
    expect([p.x, p.y]).toEqual([5, 5]);
    expect(p.z).toBeCloseTo(1.2, 9);
  });
  it('bad offset -> null', () => {
    expect(attachedPosition({ x: 0, y: 0, z: 0 }, null, 0)).toBeNull();
    expect(attachedPosition(null, [0, 0, 0], 0)).toBeNull();
  });
});

describe('floorAtHeight', () => {
  const floors = [{ id: 'g', elevation: 0 }, { id: 'up', elevation: 3 }, { id: 'cellar', elevation: -3 }];
  it('highest floor at or below the hit', () => {
    expect(floorAtHeight(floors, 1.2)).toBe('g');
    expect(floorAtHeight(floors, 4.5)).toBe('up');
    expect(floorAtHeight(floors, -1)).toBe('cellar');
  });
  it('5 cm tolerance: a hit just under a floor surface counts for that floor', () => {
    expect(floorAtHeight(floors, 2.96)).toBe('up');
    expect(floorAtHeight(floors, 2.9)).toBe('g');
  });
  it('none below -> null', () => {
    expect(floorAtHeight(floors, -5)).toBeNull();
    expect(floorAtHeight([], 1)).toBeNull();
  });
});
