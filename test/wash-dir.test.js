import { describe, it, expect } from 'vitest';
import { washKind, washSetting, resolveWash, placeWashes, clearOfWall, WASH_DIRS } from '../src/objects/wash.js';
import { glowEmissiveScale, hintDefaults } from '../src/objects/types.js';
import { setObject, setTag } from '../src/editor.js';

describe('wash direction', () => {
  it('model beam: updown / both -> both, the others unchanged', () => {
    expect(washKind({ beam: 'updown' })).toBe('both');
    expect(washKind({ beam: 'both' })).toBe('both');
    expect(washKind({ beam: 'down' })).toBe('down');
    expect(washKind({ beam: 'up' })).toBe('up');
    expect(washKind({ beam: 'spot' })).toBe('spot');
    expect(hintDefaults({ beam: 'updown' }).beam).toBe('point'); // the real light stays a point light
  });
  it('settings: down | up | both | none, anything else is no setting', () => {
    expect(WASH_DIRS).toEqual(['down', 'up', 'both', 'none']);
    for (const v of WASH_DIRS) expect(washSetting(v)).toBe(v);
    expect(washSetting('spot')).toBe(null);
    expect(washSetting(undefined)).toBe(null);
    expect(washSetting('')).toBe(null);
  });
  it('object > tag > model', () => {
    const hints = { beam: 'down' };
    const tags = { facade: { wash: 'both' }, night: { entity: 'switch.x' }, garden: { wash: 'up' } };
    expect(resolveWash(hints, undefined, [], tags)).toBe('down');
    expect(resolveWash(hints, undefined, ['night', 'facade'], tags)).toBe('both');
    expect(resolveWash(hints, undefined, ['garden', 'facade'], tags)).toBe('up'); // first tag with a setting
    expect(resolveWash(hints, 'none', ['facade'], tags)).toBe('none');
    expect(resolveWash(hints, 'bogus', ['facade'], tags)).toBe('both');
    expect(resolveWash({ beam: 'spot' }, undefined, ['night'], tags)).toBe('spot');
    expect(resolveWash({ beam: 'spot' }, 'up', [], tags)).toBe('up');
    expect(resolveWash({ beam: 'updown' }, undefined, null, null)).toBe('both');
  });
  it('both: two quads (down below, up above) on a wall; none: nothing', () => {
    const size = { width: 1.9, height: 2.6, pool: 2 };
    const wall = { point: [0, 2.3, 0], normal: [0, 0, -1] }, floor = { point: [0, 0, -0.1], normal: [0, 1, 0] };
    const ps = placeWashes('both', [0, 2.3, -0.1], size, { wall, floor });
    expect(ps.map((p) => p.variant)).toEqual(['down', 'up']);
    expect(ps[0].center[1]).toBeLessThan(2.3);
    expect(ps[1].center[1]).toBeGreaterThan(2.3);
    expect(placeWashes('none', [0, 2.3, -0.1], size, { wall, floor })).toEqual([]);
    expect(placeWashes('down', [0, 2.3, -0.1], size, { wall, floor }).length).toBe(1);
    // no wall: a floor pool and a ceiling pool
    const ceiling = { point: [0, 2.7, -0.1], normal: [0, -1, 0] };
    expect(placeWashes('both', [0, 2.3, -0.1], size, { floor, ceiling }).map((p) => p.surface)).toEqual(['floor', 'ceiling']);
    expect(placeWashes('both', [0, 2.3, -0.1], size, {})).toEqual([]);
  });
});

describe('clearOfWall', () => {
  const wall = { point: [0, 2, 0], normal: [0, 0, -1] }; // wall at z = 0, the lamp side is -z
  it('pushes a point closer than 0.15 m away from the wall along its normal', () => {
    const p = clearOfWall([1, 2, -0.05], wall);
    expect(p[0]).toBeCloseTo(1);
    expect(p[1]).toBeCloseTo(2);
    expect(p[2]).toBeCloseTo(-0.15);
    expect(clearOfWall([1, 2, 0.02], wall)[2]).toBeCloseTo(-0.15); // inside the wall too
  });
  it('far enough or no wall: unchanged', () => {
    expect(clearOfWall([1, 2, -0.3], wall)).toEqual([1, 2, -0.3]);
    expect(clearOfWall([1, 2, -0.05], null)).toEqual([1, 2, -0.05]);
    expect(clearOfWall([1, 2, -0.05], wall, 0.05)[2]).toBeCloseTo(-0.05);
  });
});

describe('glowEmissiveScale', () => {
  it('small bulbs keep full strength, large shades are dimmed (min 0.25)', () => {
    expect(glowEmissiveScale(0.08)).toBe(1);
    expect(glowEmissiveScale(0.12)).toBe(1);
    expect(glowEmissiveScale(0.24)).toBeCloseTo(Math.pow(0.5, 0.7));
    expect(glowEmissiveScale(0.5)).toBeCloseTo(Math.pow(0.12 / 0.5, 0.7));
    expect(glowEmissiveScale(3)).toBe(0.25);
    expect(glowEmissiveScale(0)).toBe(1);
    expect(glowEmissiveScale(NaN)).toBe(1);
  });
});

describe('editor: wash settings', () => {
  it('layout.objects[id].wash and layout.tags[name].wash; default removes the key', () => {
    let l = setObject({}, 'f1', { wash: 'both' });
    expect(l.objects.f1).toEqual({ wash: 'both' });
    l = setObject(l, 'f1', { wash: undefined });
    expect(l.objects.f1).toBeUndefined();
    l = setTag({ tags: { facade: { entity: 'switch.f' } } }, 'facade', { wash: 'up' });
    expect(l.tags.facade).toEqual({ entity: 'switch.f', wash: 'up' });
    l = setTag(l, 'facade', { wash: '' });
    expect(l.tags.facade).toEqual({ entity: 'switch.f' });
    expect(setTag({}, 'x', { wash: 'bogus' }).tags.x).toBeUndefined();
  });
});
