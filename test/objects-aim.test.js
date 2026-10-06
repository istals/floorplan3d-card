import { describe, it, expect } from 'vitest';
import { badTargets, aimPoint, aimsUp, aimWarning, TARGET_MAX_M } from '../src/objects/aim.js';

describe('badTargets', () => {
  it('keeps a near, unshared target', () => {
    expect(badTargets([{ id: 'a', pos: [0, 0, 0], target: [2, 0, 1], distance: 7 }]).size).toBe(0);
  });
  it('ignores a target farther than distance, or 8 m without one', () => {
    const b = badTargets([
      { id: 'a', pos: [0, 0, 0], target: [0, 0, 7.5], distance: 7 },
      { id: 'b', pos: [0, 0, 0], target: [0, 0, 7.5], distance: 0 },
      { id: 'c', pos: [0, 0, 0], target: [0, 9, 0] },
      { id: 'd', pos: [1, 1, 1], target: [1, 1, 1 + TARGET_MAX_M] },
    ]);
    expect([...b]).toEqual([['a', 'far'], ['c', 'far']]);
  });
  it('ignores a target shared by 2+ spots of one group', () => {
    const b = badTargets([
      { id: 'u1', group: 'up', pos: [0, 0, 0], target: [1, 1, 1] },
      { id: 'u2', group: 'up', pos: [1, 0, 0], target: [1, 1, 1.0000000001] },
      { id: 'u3', group: 'up', pos: [2, 0, 0], target: [2, 2, 0] },
      { id: 'x', group: 'other', pos: [0, 0, 0], target: [1, 1, 1] },
      { id: 'y', pos: [0, 0, 0], target: [1, 1, 1] },
    ]);
    expect(Object.fromEntries(b)).toEqual({ u1: 'shared', u2: 'shared' });
  });
  it('no target, nothing to check', () => {
    expect(badTargets([{ id: 'a', pos: [0, 0, 0], target: null }, null]).size).toBe(0);
    expect(badTargets(undefined).size).toBe(0);
  });
});

describe('aimPoint / aimsUp', () => {
  it('trusted target wins; else up 2 m for uplights, down otherwise', () => {
    expect(aimPoint([1, 2, 3], [4, 0, 0])).toEqual([4, 0, 0]);
    expect(aimPoint([1, 2, 3], [4, 0, 0], { bad: true, up: true })).toEqual([1, 4, 3]);
    expect(aimPoint([1, 2, 3], null, { up: false })).toEqual([1, 1, 3]);
  });
  it('uplight by beam, id or label', () => {
    expect(aimsUp({ id: 'a', hints: { beam: 'up' } })).toBe(true);
    expect(aimsUp({ id: 'facade_uplight_2', hints: {} })).toBe(true);
    expect(aimsUp({ id: 'x', label: 'Garden Up_Light' })).toBe(true);
    expect(aimsUp({ id: 'tree-uplighter' })).toBe(true);
    expect(aimsUp({ id: 'terrace_spot', label: 'Terrace spot', hints: { beam: 'spot' } })).toBe(false);
    expect(aimsUp(null)).toBe(false);
  });
  it('warning lists the ids', () => {
    expect(aimWarning(new Map())).toBe(null);
    expect(aimWarning(new Map([['b', 'far'], ['a', 'shared']]))).toBe('spot target looks wrong (shared / too far): a, b');
  });
});
