import { describe, it, expect } from 'vitest';
import { washKind, washSize, chooseWall, placeWash, washOpacity, washTexels, WALL_REACH, fitPool, bestCandidate, POOL_MIN, placeWashes, BOUNCE, wallWide, SPILL } from '../src/objects/wash.js';

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
    expect(top).toBeCloseTo(2.33); // 3 cm above the lamp: the up beam barely overlaps it
    expect(bottom).toBeCloseTo(0);
    expect(p.height).toBeCloseTo(2.33);
    expect(p.width).toBeCloseTo(1.9);
  });
  it('up beam: above the lamp; point: centred on it', () => {
    const up = placeWash('up', [0, 0.1, -0.2], size, { wall: { point: [0, 0.1, 0], normal: [0, 0, -1] } });
    expect(up.variant).toBe('up');
    expect(up.center[1] - up.height / 2).toBeCloseTo(0.07);
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

describe('fitPool / bestCandidate', () => {
  const at = (normal, shift) => ({ point: [0, 2.4, 0], normal, shift });
  it('keeps the full pool when it fits', () => {
    expect(fitPool(2.5, () => at([0, -1, 0], 0))).toMatchObject({ pool: 2.5, shift: 0 });
  });
  it('shrinks to the largest size that fits a narrow surface', () => {
    const fit = fitPool(2.5, (d) => (d <= 1 ? at([0, -1, 0], 0) : null));
    expect(fit.pool).toBeCloseTo(0.875);
    expect(fitPool(2.5, (d) => (d <= POOL_MIN ? at([0, -1, 0], 0) : null)).pool).toBe(POOL_MIN);
  });
  it('gives up on a beam narrower than the smallest pool, and never makes a pool below POOL_MIN', () => {
    const sizes = [];
    expect(fitPool(2.5, (d) => { sizes.push(d); return null; })).toBe(null);
    expect(Math.min(...sizes)).toBe(POOL_MIN);
    expect(fitPool(0.3, () => at([0, -1, 0], 0))).toBe(null);
  });
  it('prefers a flat surface over a slope, then the least shifted placement', () => {
    expect(bestCandidate([at([0.5, -0.87, 0], 0), at([0, -1, 0], 0.5)]).normal).toEqual([0, -1, 0]);
    expect(bestCandidate([at([0, -1, 0], 1), null, at([0, -1, 0], 0.5)]).shift).toBe(0.5);
    expect(bestCandidate([null])).toBe(null);
  });
});

describe('uplight bounce', () => {
  const size = { width: 1.9, height: 2.6, pool: 2.5 };
  const floor = { point: [0, 0, 0], normal: [0, 1, 0], pool: 1.5 };
  it('an uplight lights what it aims at and, faintly, the floor around it', () => {
    const aim = { point: [0, 2.4, 0], normal: [0, -1, 0], pool: 1.5 };
    const [main, bounce] = placeWashes('spot', [0, 0.06, 0], size, { aim, floor });
    expect(main).toMatchObject({ surface: 'aim', width: 1.5 });
    expect(bounce).toMatchObject({ surface: 'bounce', variant: 'pool', k: BOUNCE, width: 1.5 });
    expect(bounce.center[1]).toBeCloseTo(0.01);
  });
  it('a spot aimed down, or with no floor, gets one pool', () => {
    const aim = { point: [0, 0, 1], normal: [0, 1, 0] };
    expect(placeWashes('spot', [0, 2.4, 0], size, { aim, floor })).toHaveLength(1);
    expect(placeWashes('spot', [0, 0.06, 0], size, { aim: { point: [0, 2.4, 0], normal: [0, -1, 0] } })).toHaveLength(1);
  });
});

describe('wallWide', () => {
  it('a wall, also with a window on one side, takes a wash', () => {
    expect(wallWide({ left: true, right: true, up: true, down: true })).toBe(true);
    expect(wallWide({ left: false, right: true, up: true, down: true })).toBe(true);
  });
  it('a post (nothing left or right) or a beam (nothing above or below) does not', () => {
    expect(wallWide({ left: false, right: false, up: true, down: true })).toBe(false);
    expect(wallWide({ left: true, right: true, up: false, down: false })).toBe(false);
  });
});

describe('wall lamp spill', () => {
  const size = { width: 1.9, height: 2.6, pool: 2 };
  const wall = { point: [0, 1.5, 0], normal: [0, 0, -1] };
  const ground = { point: [0, 0, -0.6], normal: [0, 1, 0], pool: 1.2 };
  const soffit = { point: [0, 2.6, -0.6], normal: [0, -1, 0], pool: 1.2 };
  it('a wall lamp also lights the ground in front (down / both) and an overhang above (up / both)', () => {
    const both = placeWashes('both', [0, 1.5, -0.05], size, { wall, ground, soffit });
    expect(both.map((p) => p.surface)).toEqual(['wall', 'wall', 'ground', 'soffit']);
    expect(both[2]).toMatchObject({ variant: 'pool', k: SPILL, width: 1.2 });
    expect(placeWashes('down', [0, 1.5, -0.05], size, { wall, ground, soffit }).map((p) => p.surface)).toEqual(['wall', 'ground']);
    expect(placeWashes('up', [0, 1.5, -0.05], size, { wall, ground, soffit }).map((p) => p.surface)).toEqual(['wall', 'soffit']);
  });
  it('no spill without a wall, and none for "none"', () => {
    expect(placeWashes('down', [0, 1.5, -0.05], size, { ground }).some((p) => p.surface === 'ground')).toBe(false);
    expect(placeWashes('none', [0, 1.5, -0.05], size, { wall, ground, soffit })).toEqual([]);
  });
});
