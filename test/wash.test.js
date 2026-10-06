import { describe, it, expect } from 'vitest';
import { washKind, washSize, chooseWall, placeWash, washOpacity, washTexels, WALL_REACH } from '../src/objects/wash.js';

const close = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

describe('washKind / washSize', () => {
  it('kind from the raw beam hint (default down)', () => {
    expect(washKind({ beam: 'up' })).toBe('up');
    expect(washKind({ beam: 'point' })).toBe('point');
    expect(washKind({ beam: 'spot' })).toBe('spot');
    expect(washKind({ beam: 'down' })).toBe('down');
    expect(washKind(null)).toBe('down');
  });
  it('size grows with max, clamped (width 0.8-2.5, height 1-3), distance limits it', () => {
    expect(washSize({ max: 0 })).toEqual({ width: 0.8, height: 1, pool: 0.8 });
    expect(washSize({ max: 100 })).toEqual({ width: 2.5, height: 3, pool: 2.5 });
    const s = washSize({ max: 5 });
    expect(s.width).toBeCloseTo(1.9);
    expect(s.height).toBeCloseTo(2.6);
    const d = washSize({ max: 5, distance: 2 });
    expect(d.height).toBeCloseTo(1.2);
    expect(d.width).toBeCloseTo(1);
  });
  it('opacity follows the level (x 0.6), half next to a real light', () => {
    expect(washOpacity(1, false)).toBeCloseTo(0.6);
    expect(washOpacity(0.5, true)).toBeCloseTo(0.15);
    expect(washOpacity(0, false)).toBe(0);
  });
});

describe('chooseWall', () => {
  it('nearest wall hit (|n.y| < 0.3) within reach, normal turned to the lamp', () => {
    const hits = [
      { point: [0, 2, -0.5], normal: [0, 0, -1], distance: 0.5, dir: [0, 0, -1] }, // raw normal points away
      { point: [0.3, 2, 0], normal: [-1, 0, 0], distance: 0.3, dir: [1, 0, 0] },
      { point: [0, 1.9, 0.1], normal: [0, 1, 0], distance: 0.1, dir: [0, 0, 1] }, // floor-ish: not a wall
      { point: [0, 2, 2], normal: [0, 0, -1], distance: 2, dir: [0, 0, 1] }, // too far
    ];
    const w = chooseWall(hits);
    expect(w.point).toEqual([0.3, 2, 0]);
    expect(w.normal).toEqual([-1, 0, 0]);
    expect(chooseWall([hits[0]]).normal).toEqual([0, 0, 1]);
    expect(chooseWall([hits[2], hits[3]])).toBe(null);
    expect(WALL_REACH).toBe(0.6);
  });
});

describe('placeWash', () => {
  const anchor = [0, 2.3, -0.1];
  const wall = { point: [0, 2.3, 0], normal: [0, 0, -1] };
  const floor = { point: [0, 0, -0.1], normal: [0, 1, 0] };
  const size = { width: 1.9, height: 2.6, pool: 2 };
  it('down beam: on the wall, 1 cm off, extending below the lamp, cut at the floor', () => {
    const p = placeWash('down', anchor, size, { wall, floor });
    expect(p.surface).toBe('wall');
    expect(p.variant).toBe('down');
    expect(close(p.normal, [0, 0, -1])).toBe(true);
    expect(p.center[2]).toBeCloseTo(-0.01);
    const top = p.center[1] + p.height / 2, bottom = p.center[1] - p.height / 2;
    expect(top).toBeCloseTo(2.45);
    expect(bottom).toBeCloseTo(0);
    expect(p.height).toBeCloseTo(2.45);
    expect(p.width).toBeCloseTo(1.9);
  });
  it('up beam: above the lamp; point: centred on it', () => {
    const up = placeWash('up', [0, 0.1, -0.2], size, { wall: { point: [0, 0.1, 0], normal: [0, 0, -1] } });
    expect(up.variant).toBe('up');
    expect(up.center[1] - up.height / 2).toBeCloseTo(-0.05);
    const pt = placeWash('point', anchor, size, { wall });
    expect(pt.variant).toBe('oval');
    expect(pt.center[1]).toBeCloseTo(2.3);
  });
  it('no wall: a pool on the floor (down / point) or the ceiling (up); nothing to hit: null', () => {
    const p = placeWash('down', anchor, size, { floor });
    expect(p.surface).toBe('floor');
    expect(p.variant).toBe('pool');
    expect(close(p.center, [0, 0.01, -0.1])).toBe(true);
    expect(p.width).toBe(2);
    const c = placeWash('up', anchor, size, { ceiling: { point: [0, 2.7, -0.1], normal: [0, -1, 0] } });
    expect(c.surface).toBe('ceiling');
    expect(close(c.normal, [0, -1, 0])).toBe(true);
    expect(c.center[1]).toBeCloseTo(2.69);
    expect(placeWash('up', anchor, size, { floor })).toBe(null);
    expect(placeWash('down', anchor, size, {})).toBe(null);
  });
  it('spot: a pool where the aim ray hits, facing the lamp', () => {
    const p = placeWash('spot', [0, 2, 0], size, { aim: { point: [1, 0, 0], normal: [0, -1, 0], dir: [0.4, -0.9, 0] }, wall });
    expect(p.surface).toBe('aim');
    expect(close(p.normal, [0, 1, 0])).toBe(true);
    expect(close(p.center, [1, 0.01, 0])).toBe(true);
  });
});

describe('washTexels', () => {
  it('cone: bright near the top centre, dark at the bottom and the sides', () => {
    const w = 32, h = 64, t = washTexels('down', w, h);
    expect(t.length).toBe(w * h * 4);
    const a = (x, y) => t[(y * w + x) * 4 + 3];
    // row 0 of the data is the bottom of the texture (flipY false: v = 0 at the bottom)
    expect(a(16, h - 4)).toBeGreaterThan(150);
    expect(a(16, 1)).toBeLessThan(30);
    expect(a(0, h - 4)).toBeLessThan(20);
    const u = washTexels('up', w, h), au = (x, y) => u[(y * w + x) * 4 + 3];
    expect(au(16, 3)).toBeGreaterThan(150);
    const pool = washTexels('pool', 32, 32), ap = (x, y) => pool[(y * 32 + x) * 4 + 3];
    expect(ap(16, 16)).toBeGreaterThan(200);
    expect(ap(0, 0)).toBe(0);
  });
});
