import { describe, it, expect } from 'vitest';
import { mergeFloors, roomFloorId, wallSegments, markerPositions, lightGlow, roomLabel, roomLabelMode } from '../src/layout.js';
import { pointInPolygon } from '../src/placement.js';

const hass = {
  floors: { up: { floor_id: 'up', name: 'Upstairs', level: 1 }, ground: { floor_id: 'ground', name: 'Ground', level: 0 } },
  areas: { kitchen: { area_id: 'kitchen', floor_id: 'ground' }, bed: { area_id: 'bed', floor_id: 'up' }, nofloor: { area_id: 'nofloor' } },
};

describe('mergeFloors', () => {
  it('merges repeated entries per id (a partial entry keeps the model elevation)', () => {
    const h = { floors: { f: { floor_id: 'f', name: 'F', level: 1 } }, areas: {} };
    for (const hh of [h, { floors: {}, areas: {} }]) {
      const f = mergeFloors(hh, { floors: [{ id: 'f', elevation: 3.25, height: 2.5 }, { id: 'f', height: 2.4 }] }).find((x) => x.id === 'f');
      expect(f.elevation).toBe(3.25);
      expect(f.height).toBe(2.4);
    }
  });
  it('syncs HA floors with elevation = level * 3', () => {
    expect(mergeFloors(hass, {})).toEqual([
      { id: 'ground', name: 'Ground', elevation: 0, height: 2.7 },
      { id: 'up', name: 'Upstairs', elevation: 3, height: 2.7 },
    ]);
  });

  it('lets stored floors override elevation and height and keeps layout-only floors', () => {
    const f = mergeFloors(hass, { floors: [{ id: 'up', elevation: 2.9, height: 2.4 }, { id: 'attic', name: 'Attic', elevation: 5.5 }] });
    expect(f.map((x) => [x.id, x.elevation, x.height])).toEqual([['ground', 0, 2.7], ['up', 2.9, 2.4], ['attic', 5.5, 2.7]]);
  });

  it('always has at least one floor', () => {
    expect(mergeFloors({}, {})).toHaveLength(1);
  });
});

describe('roomFloorId', () => {
  const floors = mergeFloors(hass, {});
  it('uses the room floor, then the area floor, then the lowest floor', () => {
    expect(roomFloorId({ floor_id: 'up', area_id: 'kitchen' }, hass, floors)).toBe('up');
    expect(roomFloorId({ area_id: 'bed' }, hass, floors)).toBe('up');
    expect(roomFloorId({ area_id: 'nofloor' }, hass, floors)).toBe('ground');
    expect(roomFloorId({ floor_id: 'gone', area_id: 'x' }, hass, floors)).toBe('ground');
  });
});

describe('wallSegments', () => {
  const a = { polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] };
  const b = { polygon: [[4, 0], [8, 0], [8, 3], [4, 3]] };
  const total = (segs) => segs.reduce((s, w) => s + Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), 0);

  it('emits shared walls once', () => {
    const segs = wallSegments([a, b]);
    expect(segs).toHaveLength(7);
    expect(total(segs)).toBeCloseTo(14 + 14 - 3);
  });

  it('cuts a door gap', () => {
    const segs = wallSegments([{ ...a, doors: [[2, 0.1]] }]);
    expect(segs).toHaveLength(5);
    expect(total(segs)).toBeCloseTo(14 - 0.9);
  });

  it('a door in a shared wall opens it for both rooms', () => {
    const segs = wallSegments([{ ...a, doors: [[4, 1.5]] }, b]);
    expect(total(segs)).toBeCloseTo(25 - 0.9);
  });

  it('clips a door at the end of a wall', () => {
    const segs = wallSegments([{ ...a, doors: [[0.2, 0]] }], { doorWidth: 1 });
    expect(total(segs)).toBeCloseTo(14 - 0.7 - 0.5);
  });

  it('outdoor rooms have no walls but their doors cut indoor walls', () => {
    expect(wallSegments([{ ...b, outdoor: true }])).toEqual([]);
    expect(total(wallSegments([a, { ...b, outdoor: true, doors: [[4, 1.5]] }]))).toBeCloseTo(14 - 0.9);
  });
});

describe('markerPositions', () => {
  const floors = mergeFloors(hass, {});
  const kitchen = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const layout = {
    rooms: [{ id: 'r1', area_id: 'kitchen', polygon: kitchen }, { id: 'r2', area_id: 'bed', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] }],
    pins: { 'device:p': { x: 9, y: 9, z: 0.5, floor_id: 'up' } },
  };
  const markers = [
    { id: 'device:l', areaId: 'kitchen', domain: 'light' },
    { id: 'device:s', areaId: 'kitchen', domain: 'sensor' },
    { id: 'device:b', areaId: 'bed', domain: 'light' },
    { id: 'device:p', areaId: 'kitchen', domain: 'sensor' },
    { id: 'device:x', areaId: 'garage', domain: 'sensor' },
  ];
  const pos = markerPositions(markers, layout, hass, floors);

  it('auto places markers in the room of their area', () => {
    expect(pos.get('device:l')).toMatchObject({ floorId: 'ground', auto: true });
    expect(pointInPolygon([pos.get('device:s').x, pos.get('device:s').y], kitchen)).toBe(true);
    expect(pos.get('device:b').floorId).toBe('up');
  });

  it('pins override auto placement', () => {
    expect(pos.get('device:p')).toEqual({ x: 9, y: 9, z: 0.5, floorId: 'up', auto: false });
  });

  it('skips markers whose area has no room', () => {
    expect(pos.has('device:x')).toBe(false);
  });
});

describe('lightGlow', () => {
  it('is null for lights that are off', () => {
    expect(lightGlow({ state: 'off', attributes: {} })).toBeNull();
    expect(lightGlow(undefined)).toBeNull();
  });
  it('uses rgb_color and brightness', () => {
    expect(lightGlow({ state: 'on', attributes: { rgb_color: [255, 0, 0], brightness: 255 } })).toEqual({ rgb: [255, 0, 0], strength: 1 });
    expect(lightGlow({ state: 'on', attributes: { brightness: 0 } })).toEqual({ rgb: [255, 196, 120], strength: 0.25 });
  });
});

describe('roomLabel', () => {
  it('rectangles show width × depth, others the area', () => {
    expect(roomLabel('Kitchen', [[0, 0], [2.65, 0], [2.65, 3.75], [0, 3.75]], 'size')).toBe('Kitchen · 2.7 × 3.8 m');
    expect(roomLabel('Hall', [[0, 0], [4, 0], [4, 2], [2, 2], [2, 5], [0, 5]], 'size')).toBe('Hall · 14.0 m²');
    expect(roomLabel('Hall', [[0, 0], [4, 0], [4, 2]], 'name')).toBe('Hall');
    expect(roomLabel('Hall', [[0, 0], [4, 0], [4, 2]], 'none')).toBe('');
    expect(roomLabel('', [[0, 0], [1, 0], [1, 1], [0, 1]], 'size')).toBe('1.0 × 1.0 m');
  });
  it('rotated rectangle with right angles shows edge lengths', () => {
    // 45° rotated 2×3 rectangle: v0=(1,0), v1=(1+√2,√2), v2=(1-1/√2,5/√2), v3=(1-3/√2,3/√2)
    const s2 = Math.sqrt(2);
    const poly = [[1, 0], [1 + s2, s2], [1 - 1/s2, 5/s2], [1 - 3/s2, 3/s2]];
    expect(roomLabel('Bedroom', poly, 'size')).toBe('Bedroom · 2.0 × 3.0 m');
  });
});

describe('markerPositions: attached pins', () => {
  const floors = [{ id: 'g', elevation: 0, height: 2.7 }];
  const markers = [{ id: 'device:a', domain: 'light', areaId: null }];
  const layout = { rooms: [], pins: { 'device:a': { x: 1, y: 1, z: 1, floor_id: 'g', on_model: true, attach: 'lamp', offset: [0, 0.1, 0] } } };
  it('resolve to the object anchor + offset', () => {
    const pos = markerPositions(markers, layout, {}, floors, (pin, fid) => (pin.attach === 'lamp' && fid === 'g' ? { x: 3, y: 4, z: 2 } : null));
    expect(pos.get('device:a')).toEqual({ x: 3, y: 4, z: 2, floorId: 'g', auto: false, attached: 'lamp' });
  });
  it('fall back to the stored position when the object is not there', () => {
    const pos = markerPositions(markers, layout, {}, floors, () => null);
    expect(pos.get('device:a')).toEqual({ x: 1, y: 1, z: 1, floorId: 'g', auto: false });
  });
});

describe('roomLabelMode', () => {
  it('card YAML wins over the layout, default name and size', () => {
    expect(roomLabelMode({}, {})).toBe('size');
    expect(roomLabelMode({}, { room_labels: 'name' })).toBe('name');
    expect(roomLabelMode({ room_labels: 'none' }, { room_labels: 'name' })).toBe('none');
    expect(roomLabelMode({}, { room_labels: 'bogus' })).toBe('size');
  });
});
