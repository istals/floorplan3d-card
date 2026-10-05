import { describe, it, expect } from 'vitest';
import {
  surfaceKind, chooseSurface, needsStick, nearestDistance, rayGroups, nearPolygon, worldOf, planOf,
  HORIZONTAL_DIRS, SURFACE_OFFSET, WALL_RANGE, CEILING_RANGE, FLOOR_RANGE, STICK_DISTANCE, surfaceKey, stickSurface,
} from '../src/surface.js';

const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const h = (point, normal, distance, dir) => ({ point, normal, distance, dir });

describe('surfaceKind', () => {
  it('wall, corner and door anchors stick to walls', () => {
    expect(surfaceKind('sensor', 'temperature')).toBe('wall'); // wall
    expect(surfaceKind('camera')).toBe('wall'); // corner
    expect(surfaceKind('lock')).toBe('wall'); // door
    expect(surfaceKind('binary_sensor', 'motion')).toBe('wall'); // corner, ceiling height
    expect(surfaceKind('something_new')).toBe('wall'); // default rule: wall
  });
  it('ceiling-grid devices go to the ceiling, floor-standing ones to the floor', () => {
    expect(surfaceKind('light')).toBe('ceiling');
    expect(surfaceKind('fan')).toBe('ceiling');
    expect(surfaceKind('binary_sensor', 'smoke')).toBe('ceiling');
    expect(surfaceKind('vacuum')).toBe('floor');
    expect(surfaceKind('lawn_mower')).toBe('floor');
  });
});

describe('rayGroups', () => {
  it('8 unit horizontal directions', () => {
    expect(HORIZONTAL_DIRS).toHaveLength(8);
    for (const d of HORIZONTAL_DIRS) {
      expect(d[1]).toBe(0);
      expect(Math.hypot(...d)).toBeCloseTo(1);
    }
  });
  it('per kind: walls horizontal 2.5 m, ceiling up 4 m, floor down 3 m; all = every ray', () => {
    expect(rayGroups('wall')).toEqual([{ dirs: HORIZONTAL_DIRS, max: WALL_RANGE }]);
    expect(rayGroups('ceiling')).toEqual([{ dirs: [[0, 1, 0]], max: CEILING_RANGE }]);
    expect(rayGroups('floor')).toEqual([{ dirs: [[0, -1, 0]], max: FLOOR_RANGE }]);
    expect(rayGroups('all')).toHaveLength(3);
    expect(rayGroups(null)).toEqual([]);
    expect([WALL_RANGE, CEILING_RANGE, FLOOR_RANGE]).toEqual([2.5, 4, 3]);
  });
});

describe('chooseSurface', () => {
  const wallNear = h([1, 1.5, 0], [-1, 0, 0], 1, [1, 0, 0]);
  const wallFar = h([0, 1.5, -2], [0, 0, 1], 2, [0, 0, -1]);
  const ceiling = h([0, 2.6, 0], [0, -1, 0], 1.1, [0, 1, 0]);
  const floor = h([0, 0, 0], [0, 1, 0], 1.5, [0, -1, 0]);
  const slope = h([0.5, 1.5, 0], [-0.7, 0.7, 0], 0.5, [1, 0, 0]); // |n.y| 0.7: not a wall

  it('wall: nearest roughly vertical face, 5 cm off along the normal', () => {
    const s = chooseSurface('wall', [wallFar, slope, wallNear, ceiling]);
    expect(close(s.point, [1 - SURFACE_OFFSET, 1.5, 0])).toBe(true);
    expect(s.normal).toEqual([-1, 0, 0]);
    expect(s.distance).toBe(1);
  });
  it('normals are turned to face the ray origin (back faces, flipped meshes)', () => {
    const s = chooseSurface('wall', [h([1, 1.5, 0], [1, 0, 0], 1, [1, 0, 0])]);
    expect(close(s.point, [0.95, 1.5, 0])).toBe(true);
    expect(s.normal).toEqual([-1, 0, 0]);
  });
  it('ceiling: face looking down, 5 cm below; floor: face looking up, 5 cm above', () => {
    expect(close(chooseSurface('ceiling', [wallNear, ceiling, floor]).point, [0, 2.55, 0])).toBe(true);
    expect(close(chooseSurface('floor', [wallNear, ceiling, floor]).point, [0, 0.05, 0])).toBe(true);
  });
  it('a ceiling must be hit by an upward ray, a floor by a downward one', () => {
    expect(chooseSurface('ceiling', [h([0, 2.6, 0], [0, -1, 0], 1, [1, 0, 0])])).toBe(null);
    expect(chooseSurface('floor', [h([0, 0, 0], [0, 1, 0], 1, [1, 0, 0])])).toBe(null);
  });
  it('out of range or no hit -> null (keep the computed point)', () => {
    expect(chooseSurface('wall', [h([3, 1.5, 0], [-1, 0, 0], 3, [1, 0, 0])])).toBe(null);
    expect(chooseSurface('ceiling', [h([0, 6, 0], [0, -1, 0], 4.5, [0, 1, 0])])).toBe(null);
    expect(chooseSurface('floor', [h([0, -4, 0], [0, 1, 0], 3.5, [0, -1, 0])])).toBe(null);
    expect(chooseSurface('wall', [])).toBe(null);
    expect(chooseSurface('wall', null)).toBe(null);
    expect(chooseSurface(null, [wallNear])).toBe(null);
  });
  it('accept() filters candidates (e.g. stay near the room)', () => {
    const s = chooseSurface('wall', [wallNear, wallFar], { accept: (p) => p[0] < 0.5 });
    expect(close(s.point, [0, 1.5, -2 + SURFACE_OFFSET])).toBe(true);
    expect(chooseSurface('wall', [wallNear], { accept: () => false })).toBe(null);
  });
  it('any: the nearest hit of every kind', () => {
    expect(chooseSurface('any', [wallFar, ceiling, wallNear]).normal).toEqual([-1, 0, 0]);
    expect(chooseSurface('any', [floor, ceiling]).normal).toEqual([0, -1, 0]);
  });
  it('accepts {x,y,z} vectors too', () => {
    const s = chooseSurface('floor', [{ point: { x: 1, y: 0, z: 2 }, normal: { x: 0, y: 1, z: 0 }, distance: 1, dir: { x: 0, y: -1, z: 0 } }]);
    expect(close(s.point, [1, 0.05, 2])).toBe(true);
  });
});

describe('needsStick / nearestDistance', () => {
  it('nearest distance over all hits, Infinity without', () => {
    expect(nearestDistance([{ distance: 2 }, { distance: 0.4 }])).toBe(0.4);
    expect(nearestDistance([])).toBe(Infinity);
    expect(nearestDistance(null)).toBe(Infinity);
  });
  it('only free pins farther than 15 cm from a surface found nearby', () => {
    const pin = { x: 1, y: 1, z: 1.2, floor_id: 'g' };
    expect(STICK_DISTANCE).toBe(0.15);
    expect(needsStick(pin, 0.5)).toBe(true);
    expect(needsStick(pin, 0.15)).toBe(false);
    expect(needsStick(pin, 0.05)).toBe(false);
    expect(needsStick(pin, Infinity)).toBe(false); // nothing to stick to
    expect(needsStick({ ...pin, attach: 'lamp' }, 0.5)).toBe(false); // follows its object
    expect(needsStick(null, 0.5)).toBe(false);
  });
});

describe('stickSurface', () => {
  const wall = (dist) => h([dist, 1.5, 0], [-1, 0, 0], dist, [1, 0, 0]);
  const ceiling = (dist) => h([0, 1.5 + dist, 0], [0, -1, 0], dist, [0, 1, 0]);
  const floor = (dist) => h([0, 1.5 - dist, 0], [0, 1, 0], dist, [0, -1, 0]);
  it('the type\'s surface when it is not much farther than the nearest one', () => {
    expect(stickSurface('ceiling', [wall(2), ceiling(0.3), floor(2)]).normal).toEqual([0, -1, 0]);
    expect(stickSurface('wall', [wall(2), ceiling(1.2), floor(1.5)]).normal).toEqual([-1, 0, 0]); // 2 <= 2 x 1.2
  });
  it('else the nearest surface (a floor lamp pinned in a corner sticks to the wall, not the ceiling)', () => {
    expect(stickSurface('ceiling', [wall(0.5), ceiling(1.1), floor(1.5)]).normal).toEqual([-1, 0, 0]);
    expect(stickSurface(null, [wall(0.5), floor(0.3)]).normal).toEqual([0, 1, 0]);
    expect(stickSurface('wall', [floor(0.3)]).normal).toEqual([0, 1, 0]);
    expect(stickSurface('wall', [])).toBe(null);
  });
});

describe('plan <-> world, nearPolygon, surfaceKey', () => {
  it('world = (x, elevation + z, -y) and back', () => {
    expect(worldOf({ x: 1, y: 2, z: 1.5 }, 3)).toEqual([1, 4.5, -2]);
    expect(planOf([1, 4.5, -2], 3)).toEqual({ x: 1, y: 2, z: 1.5 });
  });
  it('nearPolygon: inside or within margin of an edge', () => {
    const sq = [[0, 0], [4, 0], [4, 3], [0, 3]];
    expect(nearPolygon([2, 1], sq, 0.5)).toBe(true);
    expect(nearPolygon([4.4, 1], sq, 0.5)).toBe(true);
    expect(nearPolygon([4.6, 1], sq, 0.5)).toBe(false);
    expect(nearPolygon([2, 1], null, 0.5)).toBe(true); // no room: no constraint
  });
  it('surfaceKey changes with the point, floor and kind', () => {
    const a = surfaceKey('wall', 'g', { x: 1, y: 2, z: 1.5 });
    expect(a).toBe(surfaceKey('wall', 'g', { x: 1.0000001, y: 2, z: 1.5 }));
    expect(a).not.toBe(surfaceKey('wall', 'g', { x: 1.01, y: 2, z: 1.5 }));
    expect(a).not.toBe(surfaceKey('ceiling', 'g', { x: 1, y: 2, z: 1.5 }));
    expect(a).not.toBe(surfaceKey('wall', 'f', { x: 1, y: 2, z: 1.5 }));
  });
});
