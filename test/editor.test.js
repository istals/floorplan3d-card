import { describe, it, expect } from 'vitest';
import {
  snapPoint, floorVertices, nearestEdge, newRoomId, upsertRoom, deleteRoom, moveVertex, insertVertex,
  removeVertex, addDoor, removeDoor, cleanPolygon, setPin, clearPin, hide, unhide, upsertFloor, deleteFloor,
  newFloorId, parseImport, fitImport, setObject, setObjectUi, setGroup, attachPin, realignPins, sliderValue,
} from '../src/editor.js';

const square = { id: 'r1', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] };

describe('snapPoint', () => {
  it('snaps to the 5 cm grid', () => {
    expect(snapPoint([1.234, 2.071])).toEqual({ point: [1.25, 2.05], kind: 'grid' });
  });

  it('snaps to an existing vertex within 25 cm', () => {
    expect(snapPoint([3.85, 0.1], { vertices: square.polygon })).toEqual({ point: [4, 0], kind: 'vertex' });
    expect(snapPoint([3.7, 1.5], { vertices: square.polygon }).kind).not.toBe('vertex');
  });

  it('picks the closest vertex', () => {
    expect(snapPoint([0.1, 0.1], { vertices: [[0.2, 0.2], [0, 0]] }).point).toEqual([0, 0]);
  });

  it('aligns with a vertex on one axis for straight walls', () => {
    expect(snapPoint([3.9, 1.52], { vertices: square.polygon })).toEqual({ point: [4, 1.5], kind: 'align' });
  });

  it('honours a custom radius', () => {
    expect(snapPoint([3.5, 0.4], { vertices: square.polygon, radius: 0.8 }).point).toEqual([4, 0]);
  });
});

describe('floorVertices', () => {
  it('collects vertices of one floor and can skip one', () => {
    const rooms = [square, { id: 'r2', floor_id: 'up', polygon: [[9, 9], [10, 9], [10, 10]] }];
    const fid = (r) => r.floor_id || 'ground';
    expect(floorVertices(rooms, fid, 'ground')).toHaveLength(4);
    expect(floorVertices(rooms, fid, 'ground', { roomId: 'r1', index: 1 })).not.toContainEqual([4, 0]);
    expect(floorVertices(rooms, fid, 'up')).toHaveLength(3);
  });
});

describe('room edits', () => {
  it('finds the nearest edge and the projection on it', () => {
    expect(nearestEdge(square.polygon, [2, -0.3])).toMatchObject({ index: 0, point: [2, 0] });
    expect(nearestEdge(square.polygon, [4.2, 1]).index).toBe(1);
  });

  it('adds, updates and deletes rooms without mutating', () => {
    const l0 = { rooms: [] };
    const l1 = upsertRoom(l0, square);
    expect(l0.rooms).toEqual([]);
    const l2 = upsertRoom(l1, { ...square, outdoor: true });
    expect(l2.rooms).toEqual([{ ...square, outdoor: true }]);
    expect(deleteRoom(l2, 'r1').rooms).toEqual([]);
  });

  it('generates unused room ids', () => {
    expect(newRoomId({ rooms: [{ id: 'r1' }, { id: 'r2' }] })).toBe('r3');
    expect(newRoomId({ rooms: [{ id: 'r2' }] })).toBe('r1');
    expect(newRoomId({})).toBe('r1');
  });

  it('moves, inserts and removes vertices', () => {
    expect(moveVertex(square, 2, [5, 3]).polygon[2]).toEqual([5, 3]);
    expect(square.polygon[2]).toEqual([4, 3]);
    expect(insertVertex(square, 0, [2, -1]).polygon).toEqual([[0, 0], [2, -1], [4, 0], [4, 3], [0, 3]]);
    expect(removeVertex(square, 1).polygon).toEqual([[0, 0], [4, 3], [0, 3]]);
    const tri = { polygon: [[0, 0], [1, 0], [0, 1]] };
    expect(removeVertex(tri, 0)).toBe(tri);
  });

  it('puts doors on the nearest wall', () => {
    const r = addDoor(square, [1.93, 0.3]);
    expect(r.doors).toEqual([[1.95, 0]]);
    expect(addDoor(square, [2, 1.5])).toBe(square); // too far from any wall
    expect(removeDoor(r, 0).doors).toEqual([]);
  });

  it('keeps doors on diagonal walls', () => {
    const tri = { polygon: [[0, 0], [3, 3], [0, 3]] };
    const [d] = addDoor(tri, [1.33, 1.2]).doors;
    expect(nearestEdge(tri.polygon, d).dist).toBeLessThan(0.01);
  });

  it('cleans duplicate points and a repeated closing point', () => {
    expect(cleanPolygon([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});

describe('device edits', () => {
  it('pins snap to the grid and can be cleared', () => {
    const l = setPin({ pins: {} }, 'device:a', { x: 1.234, y: 2.0, z: 1.5, floor_id: 'ground' });
    expect(l.pins['device:a']).toEqual({ x: 1.25, y: 2, z: 1.5, floor_id: 'ground' });
    expect(clearPin(l, 'device:a').pins).toEqual({});
    expect(l.pins['device:a']).toBeDefined();
  });

  it('hides and unhides once', () => {
    const l = hide(hide({ hidden: [] }, 'x'), 'x');
    expect(l.hidden).toEqual(['x']);
    expect(unhide(l, 'x').hidden).toEqual([]);
  });
});

describe('floors', () => {
  it('stores overrides and standalone floors', () => {
    let l = upsertFloor({ floors: [] }, { id: 'ground', height: 2.5 });
    l = upsertFloor(l, { id: 'ground', elevation: 0.2 });
    expect(l.floors).toEqual([{ id: 'ground', height: 2.5, elevation: 0.2 }]);
    expect(deleteFloor(l, 'ground').floors).toEqual([]);
    expect(newFloorId(l, [{ id: 'floor_1' }])).toBe('floor_2');
  });
});

describe('parseImport', () => {
  it('accepts a valid layout and fills defaults', () => {
    const l = parseImport(JSON.stringify({ version: 1, rooms: [square] }));
    expect(l).toMatchObject({ version: 1, rooms: [square], pins: {}, hidden: [], floors: [] });
  });

  it('dedupes room ids', () => {
    const l = parseImport(JSON.stringify({ rooms: [square, square] }));
    expect(l.rooms.map((r) => r.id)).toEqual(['r1', 'r1_']);
  });

  it('rejects junk with a readable message', () => {
    expect(() => parseImport('{nope')).toThrow(/Not valid JSON/);
    expect(() => parseImport('[]')).toThrow(/layout object/);
    expect(() => parseImport('{"version":2}')).toThrow(/version 2/);
    expect(() => parseImport(JSON.stringify({ rooms: [{ id: 'a', polygon: [[0, 0], [1, 1]] }] }))).toThrow(/Room a/);
    expect(() => parseImport(JSON.stringify({ rooms: [{ ...square, doors: [[1, 'x']] }] }))).toThrow(/doors/);
    expect(() => parseImport(JSON.stringify({ floors: [{ name: 'x' }] }))).toThrow(/floor needs an id/);
  });
});

describe('fitImport', () => {
  const layout = {
    floors: [{ id: 'ground', name: 'Ground floor', elevation: 0, height: 2.89 }, { id: 'attic', name: 'Attic', elevation: 3.25, height: 2.5 }],
    rooms: [
      { id: 'a', area_id: 'kitchen', floor_id: 'ground', polygon: [[0, 0], [1, 0], [1, 1]] },
      { id: 'b', area_id: 'attic', floor_id: 'attic', polygon: [[0, 0], [1, 0], [1, 1]] },
    ],
    pins: { 'device:x': { x: 1, y: 1, z: 1, floor_id: 'ground' } },
  };

  it('maps unknown floors bottom-up onto HA floors and keeps the rest', () => {
    const { layout: l, floorMap, unknownAreas } = fitImport(layout, [{ id: 'floor1', elevation: 0 }], ['kitchen']);
    expect(floorMap).toEqual({ ground: 'floor1' });
    expect(l.rooms.map((r) => r.floor_id)).toEqual(['floor1', 'attic']);
    expect(l.pins['device:x'].floor_id).toBe('floor1');
    expect(l.floors).toEqual([{ id: 'floor1', elevation: 0, height: 2.89 }, layout.floors[1]]);
    expect(unknownAreas).toEqual(['attic']);
  });

  it('leaves matching floors alone', () => {
    const { floorMap, layout: l } = fitImport(layout, [{ id: 'ground', elevation: 0 }, { id: 'up', elevation: 3 }], ['kitchen', 'attic']);
    expect(floorMap).toEqual({ attic: 'up' });
    expect(l.rooms.map((r) => r.floor_id)).toEqual(['ground', 'up']);
  });

  it('does nothing without HA floors', () => {
    const { floorMap, layout: l } = fitImport(layout, [], []);
    expect(floorMap).toEqual({});
    expect(l.rooms).toEqual(layout.rooms);
  });
});

describe('setObject / setGroup', () => {
  it('merges into layout.objects without mutating', () => {
    const l = { objects: { a: { entity: 'light.x' } } };
    const n = setObject(l, 'a', { hidden: true });
    expect(n.objects.a).toEqual({ entity: 'light.x', hidden: true });
    expect(l.objects.a).toEqual({ entity: 'light.x' });
    expect(setObject({}, 'b', { entity: 'light.y' }).objects.b).toEqual({ entity: 'light.y' });
  });
  it('entity undefined returns to auto, null stays explicit', () => {
    const l = { objects: { a: { entity: 'light.x', hidden: true } } };
    expect(setObject(l, 'a', { entity: undefined }).objects.a).toEqual({ hidden: true });
    expect(setObject(l, 'a', { entity: null }).objects.a).toEqual({ entity: null, hidden: true });
  });
  it('un-hiding the last flag removes the entry', () => {
    const l = { objects: { a: { hidden: true }, b: { entity: 'light.b' } } };
    const n = setObject(l, 'a', { hidden: false });
    expect(n.objects).toEqual({ b: { entity: 'light.b' } });
  });
  it('setGroup sets and clears a controller', () => {
    const l = { groups: { g: { entity: 'light.g' } } };
    expect(setGroup({}, 'g', { entity: 'switch.s' }).tags.g).toEqual({ entity: 'switch.s' });
    expect(setGroup(l, 'g', { entity: '' }).tags).toEqual({});
    expect(l.groups.g.entity).toBe('light.g');
  });
  it('setObject label: trimmed, empty clears it (back to the model label), other fields kept', () => {
    const l = { objects: { a: { entity: 'light.a' } } };
    expect(setObject(l, 'a', { label: '  Sofa lamp ' }).objects.a).toEqual({ entity: 'light.a', label: 'Sofa lamp' });
    const named = setObject(l, 'a', { label: 'Sofa lamp' });
    expect(setObject(named, 'a', { label: '' }).objects.a).toEqual({ entity: 'light.a' });
    expect(setObject(named, 'a', { label: '   ' }).objects.a).toEqual({ entity: 'light.a' });
    expect(setObject({ objects: { b: { label: 'X' } } }, 'b', { label: '' }).objects).toEqual({});
  });
  it('setGroup label: stored with or without a controller, empty clears it', () => {
    const l = { groups: { g: { entity: 'switch.g' } } };
    expect(setGroup(l, 'g', { label: ' Facade ' }).tags.g).toEqual({ entity: 'switch.g', label: 'Facade' });
    expect(setGroup({}, 'g', { label: 'Facade' }).tags.g).toEqual({ label: 'Facade' });
    expect(setGroup({ groups: { g: { label: 'Facade' } } }, 'g', { label: '' }).tags).toEqual({});
    expect(setGroup({ groups: { g: { label: 'Facade' } } }, 'g', { entity: 'none' }).tags.g).toEqual({ label: 'Facade' });
  });
  it('setGroup: "none" (any case, padded) removes the controller, never stored literally', () => {
    const l = { groups: { g: { entity: 'light.g' } } };
    expect(setGroup(l, 'g', { entity: 'none' }).tags).toEqual({});
    expect(setGroup(l, 'g', { entity: ' None ' }).tags).toEqual({});
    expect(setGroup(l, 'g', { entity: '  switch.s ' }).tags.g).toEqual({ entity: 'switch.s' });
  });
});

describe('attachPin', () => {
  const base = { pins: { 'device:a': { x: 1, y: 2, z: 1.5, floor_id: 'g', on_model: true } } };
  it('stores attach + offset, keeps on_model and the drop position as a fallback', () => {
    const l = attachPin(base, 'device:a', 'lamp1', [0.1234, -0.2, 0.05], { x: 1.23, y: 2.01, z: 1.4567, floor_id: 'g' });
    expect(l.pins['device:a']).toEqual({ x: 1.23, y: 2.01, z: 1.457, floor_id: 'g', on_model: true, attach: 'lamp1', offset: [0.123, -0.2, 0.05] });
    expect(base.pins['device:a'].attach).toBeUndefined();
  });
  it('works without a previous pin', () => {
    const l = attachPin({}, 'device:b', 'lamp1', [0, 0, 0], { x: 0, y: 0, z: 1, floor_id: 'g' });
    expect(l.pins['device:b'].attach).toBe('lamp1');
    expect(l.pins['device:b'].on_model).toBe(true);
  });
  it('setPin detaches (normal pin, no attach / offset)', () => {
    const l = attachPin(base, 'device:a', 'lamp1', [0, 0, 0], { x: 1, y: 2, z: 1, floor_id: 'g' });
    const d = setPin(l, 'device:a', { x: 1.234, y: 2, z: 1, floor_id: 'g', on_model: true }, { grid: false });
    expect(d.pins['device:a']).toEqual({ x: 1.234, y: 2, z: 1, floor_id: 'g', on_model: true });
  });
  it('realignPins keeps attach + offset of attached pins, moves only their fallback position', () => {
    const l = attachPin(base, 'device:a', 'lamp1', [0, 0.1, 0], { x: 1, y: 2, z: 1, floor_id: 'g' });
    const withFree = { ...l, pins: { ...l.pins, 'device:c': { x: 1, y: 0, z: 1, floor_id: 'g', on_model: true } } };
    const out = realignPins(withFree, { position: [0, 0, 0], rotation: 0, scale: 1 }, { position: [2, 0, 0], rotation: 0, scale: 2 });
    expect(out.pins['device:a']).toEqual({ ...withFree.pins['device:a'], x: 4, y: 4, z: 2 }); // scale 2 about the origin, then +2 east
    expect(out.pins['device:a'].offset).toEqual([0, 0.1, 0]);
    expect(out.pins['device:c'].x).toBe(4);
  });
});

describe('setObjectUi', () => {
  it('sets and removes one action; empty ui and entry are dropped', () => {
    let l = setObjectUi({}, 'lamp', 'tap', { action: 'navigate', navigation_path: '/x' });
    expect(l.objects.lamp).toEqual({ ui: { tap_action: { action: 'navigate', navigation_path: '/x' } } });
    l = setObject(l, 'lamp', { entity: 'light.a' });
    l = setObjectUi(l, 'lamp', 'hold', { action: 'none' });
    expect(l.objects.lamp.ui).toEqual({ tap_action: { action: 'navigate', navigation_path: '/x' }, hold_action: { action: 'none' } });
    l = setObjectUi(setObjectUi(l, 'lamp', 'tap', null), 'lamp', 'hold', null);
    expect(l.objects.lamp).toEqual({ entity: 'light.a' });
    expect(setObjectUi(setObjectUi({}, 'a', 'tap', { action: 'none' }), 'a', 'tap', null).objects.a).toBeUndefined();
  });
});

describe('setObjectUi popup', () => {
  it('stores the popup list as ui.popup and removes it again', () => {
    let l = setObjectUi({}, 'lamp', 'popup', ['toggle']);
    expect(l.objects.lamp).toEqual({ ui: { popup: ['toggle'] } });
    l = setObjectUi(l, 'lamp', 'tap', { action: 'none' });
    l = setObjectUi(l, 'lamp', 'popup', null);
    expect(l.objects.lamp.ui).toEqual({ tap_action: { action: 'none' } });
  });
});

describe('sliderValue', () => {
  it('clamps to min / max and rounds to the step grid from min', () => {
    expect(sliderValue('12.37', 1, 200, 0.1)).toBe(12.4);
    expect(sliderValue('500', 1, 200, 0.1)).toBe(200);
    expect(sliderValue('-3', 1, 200, 0.1)).toBe(1);
    expect(sliderValue('0.333', 0, 1, 0.05)).toBe(0.35);
    expect(sliderValue('7', -180, 180, 0.5)).toBe(7);
    expect(sliderValue('7.3', -180, 180, 0.5)).toBe(7.5);
    expect(sliderValue('0.07', -0.5, 0.5, 0.01)).toBe(0.07);
    expect(sliderValue('2,5', 0, 10, 0.5)).toBe(2.5); // decimal comma
    expect(sliderValue('3', 0.15, 4.1, 0.05)).toBe(3);
  });
  it('never rounds past max (a range not on the grid)', () => {
    expect(sliderValue('10', 0, 9.97, 0.05)).toBeLessThanOrEqual(9.97);
  });
  it('invalid -> null', () => {
    expect(sliderValue('', 0, 1, 0.1)).toBe(null);
    expect(sliderValue('abc', 0, 1, 0.1)).toBe(null);
    expect(sliderValue(null, 0, 1, 0.1)).toBe(null);
  });
});
