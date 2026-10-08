import { describe, it, expect } from 'vitest';
import {
  simplifyPolygon, pickOutline, serializeOutline, parseOutline, saveOutline, loadOutline, outlineKey,
  fitOutline, polygonLength, HOUSE_OUTLINE, OUTLINE_CAP,
} from '../src/load-outline.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m };
};

describe('simplifyPolygon', () => {
  it('rounds to 5 cm and drops repeated and closing points', () => {
    expect(simplifyPolygon([[0.01, 0], [4.02, 0.01], [4, 3], [0, 3], [0, 0]])).toEqual([[0, 0], [4, 0], [4, 3], [0, 3]]);
  });
  it('drops near-collinear points', () => {
    expect(simplifyPolygon([[0, 0], [2, 0.01], [4, 0], [4, 3], [0, 3]])).toEqual([[0, 0], [4, 0], [4, 3], [0, 3]]);
  });
  it('keeps real corners and rejects degenerate input', () => {
    expect(simplifyPolygon([[0, 0], [4, 0], [2, 3]])).toHaveLength(3);
    expect(simplifyPolygon([[0, 0], [1, 1]])).toBe(null);
    expect(simplifyPolygon(null)).toBe(null);
    expect(simplifyPolygon([[0, 0], ['x', 1], [4, 0], [2, 3]])).toHaveLength(3);
  });
});

describe('pickOutline', () => {
  const sq = (x) => [[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]];
  it('takes the level with the most rooms', () => {
    const out = pickOutline([{ polygon: sq(0), floor_id: 'a' }, { polygon: sq(2), floor_id: 'b' }, { polygon: sq(4), floor_id: 'b' }, { polygon: [[0, 0]], floor_id: 'b' }]);
    expect(out).toEqual([sq(2), sq(4)]);
  });
  it('is empty without rooms', () => {
    expect(pickOutline([])).toEqual([]);
    expect(pickOutline(undefined)).toEqual([]);
  });
});

describe('storage', () => {
  const polys = [[[0, 0], [4, 0], [4, 3], [0, 3]]];
  it('uses a key per layout', () => {
    expect(outlineKey('default')).toBe('fp3d-outline:default');
  });
  it('round-trips and ignores junk', () => {
    const st = memory();
    expect(saveOutline('k', polys, st)).toBe(true);
    expect(loadOutline('k', st)).toEqual(polys);
    expect(loadOutline('other', st)).toBe(null);
    st.setItem(outlineKey('bad'), '{nope');
    expect(loadOutline('bad', st)).toBe(null);
    st.setItem(outlineKey('bad'), '[[[0,0],[1,1]]]');
    expect(parseOutline('[[[0,0],[1,1]]]')).toBe(null);
  });
  it('survives a throwing storage', () => {
    const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
    expect(saveOutline('k', polys, boom)).toBe(false);
    expect(loadOutline('k', boom)).toBe(null);
  });
  it('caps the stored size by dropping rooms', () => {
    const big = Array.from({ length: 2000 }, (_, i) => [[i, 0], [i + 0.5, 0], [i + 0.5, 0.5], [i, 0.5]]);
    const s = serializeOutline(big);
    expect(s.length).toBeLessThanOrEqual(OUTLINE_CAP);
    expect(JSON.parse(s).length).toBeGreaterThan(100);
    expect(serializeOutline([])).toBe(null);
  });
});

describe('fitOutline', () => {
  it('fits into the box with y flipped (north up)', () => {
    const f = fitOutline([[[0, 0], [4, 0], [4, 2], [0, 2]]], 100, 2);
    expect(f.viewBox).toBe('0 0 104 54');
    expect(f.d).toBe('M2 52L102 52L102 2L2 2Z');
    expect(f.length).toBe(300);
  });
  it('scales every room by the same factor', () => {
    const f = fitOutline(HOUSE_OUTLINE, 100, 0);
    expect(f.w).toBe(100);
    expect(f.h).toBe(100);
    expect(f.d.startsWith('M0 100')).toBe(true);
  });
  it('polygonLength closes the ring', () => {
    expect(polygonLength([[0, 0], [3, 0], [3, 4]])).toBe(12);
  });
});
