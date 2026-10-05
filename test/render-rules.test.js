import { describe, it, expect } from 'vitest';
import { castsShadow, shadowInfo, isCoplanarOverlay, depthRange, depthChanged, isOccluded, sunDirection, ghostMaterial, pickable } from '../src/render-rules.js';

describe('castsShadow', () => {
  const solid = { names: ['wall_1', 'plaster'], layers: [], transparent: false, opacity: 1, transmission: 0, size: [4, 2.7, 0.15], bottom: 0, floors: [0, 3] };
  it('opaque solid meshes cast', () => {
    expect(castsShadow(solid)).toBe(true);
    expect(castsShadow({ ...solid, layers: ['furniture'] })).toBe(true);
  });
  it('glass: transparent, opacity < 1, transmission, glass layer', () => {
    expect(castsShadow({ ...solid, transparent: true })).toBe(false);
    expect(castsShadow({ ...solid, opacity: 0.98 })).toBe(false);
    expect(castsShadow({ ...solid, transmission: 0.9 })).toBe(false);
    expect(castsShadow({ ...solid, layers: ['glass'] })).toBe(false);
    expect(castsShadow({ ...solid, layers: ['facade_glass'] })).toBe(false);
  });
  it('glass names: whole words, window but not its frame or sill', () => {
    for (const n of ['glass', 'window_pane', 'Window', 'pane_3', 'GLAZING', 'livingroom window', 'Panes']) expect(castsShadow({ ...solid, names: [n] }), n).toBe(false);
    for (const n of ['fence_panel', 'solar_panel', 'wall_panels', 'window_frame', 'windowsill', 'Window sill', 'fiberglass_tub']) expect(castsShadow({ ...solid, names: [n] }), n).toBe(true);
  });
  it('floor overlays and ground: terrain / floor / decal / label layers', () => {
    for (const l of ['terrain', 'floor', 'decal', 'label']) expect(castsShadow({ ...solid, layers: [l] })).toBe(false);
  });
  it('flat meshes cast no shadow only when lying on a floor or the terrain', () => {
    const flat = { ...solid, size: [3, 0.01, 2] };
    expect(castsShadow({ ...flat, bottom: 0.02 })).toBe(false); // rug / decal on the ground floor
    expect(castsShadow({ ...flat, bottom: 3.04 })).toBe(false); // on the upper floor
    expect(castsShadow({ ...flat, bottom: 2.4 })).toBe(true); // awning / flat roof membrane
    expect(castsShadow({ ...flat, bottom: 6, floors: [] })).toBe(true);
    expect(castsShadow({ ...solid, size: [3, 0.04, 2] })).toBe(true); // a ceiling slab still casts
    expect(castsShadow({ ...solid, size: [0.01, 0.01, 0.01] })).toBe(true); // tiny, not flat
  });
});

describe('shadowInfo', () => {
  const mat = (name, extra = {}) => ({ name, transparent: false, opacity: 1, ...extra });
  const node = (name, material, parent = null, fp) => ({ name, material, parent, userData: fp ? { fp } : {} });
  it('names: the node itself and its materials, not its ancestors', () => {
    const windows = node('Windows', null);
    expect(castsShadow(shadowInfo(node('mesh_12', mat('white_paint'), windows), { size: [1, 1, 0.1], bottom: 1, floors: [0] }))).toBe(true);
    expect(castsShadow(shadowInfo(node('mesh_13', mat('Glass_clear'), windows), { size: [1, 1, 0.1], bottom: 1, floors: [0] }))).toBe(false);
    expect(shadowInfo(node('a', [mat('m1'), mat('m2')], windows), {}).names).toEqual(['a', 'm1', 'm2']);
  });
  it('layers: the node and its ancestors (fp tags are intentional)', () => {
    const g = node('facade', null, null, { layer: 'glass' });
    const info = shadowInfo(node('mesh_1', mat('x'), g), { size: [1, 1, 1], bottom: 0, floors: [0] });
    expect(info.layers).toEqual(['glass']);
    expect(castsShadow(info)).toBe(false);
  });
  it('material state: any transparent, the lowest opacity, the highest transmission', () => {
    const info = shadowInfo(node('m', [mat('a'), mat('b', { transparent: true, opacity: 0.4, transmission: 0.5 })]), {});
    expect([info.transparent, info.opacity, info.transmission]).toEqual([true, 0.4, 0.5]);
  });
});

describe('isCoplanarOverlay', () => {
  it('decal / edging layers and overlay-like names', () => {
    expect(isCoplanarOverlay({ names: ['lawn_edging'], layers: [] })).toBe(true);
    expect(isCoplanarOverlay({ names: ['x'], layers: ['decal'] })).toBe(true);
    expect(isCoplanarOverlay({ names: ['x'], layers: ['edging'] })).toBe(true);
    expect(isCoplanarOverlay({ names: ['Paving Overlay'], layers: [] })).toBe(true);
    expect(isCoplanarOverlay({ names: ['wall'], layers: ['furniture'] })).toBe(false);
  });
});

describe('depthRange', () => {
  it('far reaches the far side of the whole model (terrain included) + 5 %', () => {
    expect(depthRange({ target: 20, house: 15, centre: 20, radius: 10 })).toEqual({ near: 0.2, far: 52.5 });
    expect(depthRange({ target: 130, house: 120, centre: 130, radius: 141 })).toEqual({ near: 0.6, far: 284.55 });
  });
  it('radius capped at 300 m', () => {
    expect(depthRange({ target: 100, house: 100, centre: 100, radius: 5000 }).far).toBeCloseTo(420);
  });
  it('near follows the nearer of the pivot and the house (0 inside it)', () => {
    expect(depthRange({ target: 200, house: 10, centre: 50, radius: 100 }).near).toBe(0.2);
    expect(depthRange({ target: 100, house: 80, centre: 100, radius: 20 }).near).toBe(0.4);
    expect(depthRange({ target: 100, house: 0, centre: 100, radius: 20 }).near).toBe(0.2);
  });
  it('ortho keeps near 0.1', () => {
    expect(depthRange({ target: 60, house: 55, centre: 60, radius: 20, ortho: true })).toEqual({ near: 0.1, far: 84 });
  });
  it('changes over 1 % only', () => {
    expect(depthChanged({ near: 0.2, far: 100 }, { near: 0.2, far: 100.5 })).toBe(false);
    expect(depthChanged({ near: 0.2, far: 100 }, { near: 0.2, far: 102 })).toBe(true);
    expect(depthChanged({ near: 0.2, far: 100 }, { near: 0.21, far: 100 })).toBe(true);
  });
});

describe('isOccluded', () => {
  it('a hit closer than the marker minus 0.3 m hides it', () => {
    expect(isOccluded(null, 10)).toBe(false);
    expect(isOccluded(5, 10)).toBe(true);
    expect(isOccluded(9.8, 10)).toBe(false); // the surface the marker sits on
    expect(isOccluded(9.69, 10)).toBe(true);
  });
});

describe('sunDirection', () => {
  const len = (v) => Math.hypot(...v);
  // compass bearing (deg, clockwise from TRUE north) of the horizontal sun direction. Card world: plan
  // north = -Z, east = +X; the model turned rot (rad, CCW from above) turns its plan north by -rot in
  // bearing; fp.north = clockwise angle from the model's plan north to true north (the prototype export
  // writes environment.north = -26.4 for "true north 26.4° west of model north").
  const trueBearing = (d, north, rot = 0) => {
    const card = (Math.atan2(d[0], -d[2]) * 180) / Math.PI;
    return (((card + (rot * 180) / Math.PI - north) % 360) + 360) % 360;
  };
  it('default direction without north', () => {
    const d = sunDirection(null);
    expect(len(d)).toBeCloseTo(1);
    const e = [-0.4, 1, 0.35], l = len(e);
    d.forEach((x, i) => expect(x).toBeCloseTo(e[i] / l));
  });
  it('about 42° up', () => {
    const d = sunDirection(0);
    expect(len(d)).toBeCloseTo(1);
    expect(d[1]).toBeCloseTo(34 / Math.hypot(38, 34));
  });
  it('the sun stays at the same true bearing (SSW, 180° + 0.35 rad) whatever north and the model rotation', () => {
    const expected = 180 + (0.35 * 180) / Math.PI;
    for (const [north, rot] of [[0, 0], [90, 0], [-26.4, 0], [63.6, 0], [90, Math.PI / 2], [-26.4, 1]]) {
      expect(trueBearing(sunDirection(north, rot), north, rot), `${north} ${rot}`).toBeCloseTo(expected);
    }
  });
  it('north = 90 (true north = plan east, +X): the sun comes from plan west (-X), a bit plan north', () => {
    const d = sunDirection(90);
    expect(d[0]).toBeLessThan(-0.6);
    expect(d[2]).toBeLessThan(0);
  });
});

describe('ghostMaterial', () => {
  const base = { wasTransparent: false, baseOpacity: 1, baseDepthWrite: true };
  it('ghosted: blended with depth writes kept', () => {
    expect(ghostMaterial(base, 0.6)).toEqual({ transparent: true, alphaHash: false, depthWrite: true, opacity: 0.6, alphaToCoverage: false });
    expect(ghostMaterial({ ...base, baseDepthWrite: false }, 0.6).depthWrite).toBe(true);
  });
  it('opaque again restores', () => {
    expect(ghostMaterial(base, 1)).toEqual({ transparent: false, alphaHash: false, depthWrite: true, opacity: 1, alphaToCoverage: false });
  });
  it('originally transparent materials are untouched', () => {
    expect(ghostMaterial({ wasTransparent: true, baseOpacity: 0.3, baseDepthWrite: false }, 0.6)).toBe(null);
  });
});

describe('pickable', () => {
  it('skips helpers, lines, see-through meshes', () => {
    expect(pickable({ isMesh: true, helper: false, transparent: false, opacity: 1 })).toBe(true);
    expect(pickable({ isMesh: true, helper: true, transparent: false, opacity: 1 })).toBe(false);
    expect(pickable({ isMesh: false, helper: false, transparent: false, opacity: 1 })).toBe(false);
    expect(pickable({ isMesh: true, helper: false, transparent: true, opacity: 0.4 })).toBe(false);
    expect(pickable({ isMesh: true, helper: false, transparent: true, opacity: 0.8 })).toBe(true);
  });
});

import { coplanarWinners } from '../src/render-rules.js';
describe('coplanarWinners', () => {
  const sheet = (id, textured, o = {}) => ({ id, textured, min: [0, 0, 0], max: [4, 0.002, 3], ...o });
  it('the textured one of a coplanar pair wins', () => {
    expect([...coplanarWinners([sheet('plain', false), sheet('brick', true)])]).toEqual(['brick']);
  });
  it('tolerates small box and height differences, finds pairs in any order', () => {
    const w = coplanarWinners([sheet('x', false, { min: [9, 0, 9], max: [10, 0.001, 10] }), sheet('plain', false, { min: [0.01, 0.003, 0], max: [4.01, 0.004, 3] }), sheet('brick', true)]);
    expect([...w]).toEqual(['brick']);
  });
  it('both or neither textured: nothing', () => {
    expect(coplanarWinners([sheet('a', true), sheet('b', true)]).size).toBe(0);
    expect(coplanarWinners([sheet('a', false), sheet('b', false)]).size).toBe(0);
  });
  it('not flat, different size or too far apart: nothing', () => {
    expect(coplanarWinners([sheet('a', false), sheet('b', true, { max: [4, 0.2, 3] })]).size).toBe(0);
    expect(coplanarWinners([sheet('a', false), sheet('b', true, { max: [5, 0.002, 3] })]).size).toBe(0);
    expect(coplanarWinners([sheet('a', false), sheet('b', true, { min: [0, 0.02, 0], max: [4, 0.022, 3] })]).size).toBe(0);
  });
});
