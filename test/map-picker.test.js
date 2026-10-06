import { describe, it, expect } from 'vitest';
import { fitView, zoomAt, toImage, matchMask } from '../src/map-picker.js';
import { medianColor } from '../src/mower-image.js';

describe('map picker view', () => {
  it('fits the picture centred in the box', () => {
    const v = fitView(450, 850, 600, 400, 0);
    expect(v.s).toBeCloseTo(400 / 850, 9);
    expect(v.oy).toBeCloseTo(0, 9);
    expect(v.ox).toBeCloseTo((600 - 450 * v.s) / 2, 9);
  });
  it('zooms about a point (the picture pixel under it stays)', () => {
    const v = { s: 0.5, ox: 10, oy: 20 };
    const before = toImage(v, 200, 150);
    const z = zoomAt(v, 3, 200, 150);
    expect(z.s).toBe(1.5);
    const after = toImage(z, 200, 150);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(zoomAt(v, 1e6, 0, 0).s).toBe(64);
  });
  it('matches any colour within tolerance (opaque pixels only)', () => {
    const d = new Uint8ClampedArray([255, 0, 0, 255, 250, 5, 0, 255, 0, 255, 0, 255, 255, 0, 0, 0]);
    expect([...matchMask(d, 4, 1, [[255, 0, 0]], 10)]).toEqual([1, 1, 0, 0]);
    expect([...matchMask(d, 4, 1, [[255, 0, 0], [0, 255, 0]], 10)]).toEqual([1, 1, 1, 0]);
    expect([...matchMask(d, 4, 1, [], 10)]).toEqual([0, 0, 0, 0]);
  });
  it('3x3 median colour', () => {
    const w = 5, h = 5, d = new Uint8ClampedArray(w * h * 4).fill(0);
    for (let i = 0; i < w * h; i++) d[i * 4 + 3] = 255;
    for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2]]) d[(y * w + x) * 4] = 200;
    expect(medianColor(d, w, h, 2, 2, 1)).toEqual([200, 0, 0]);
    expect(medianColor(d, w, h, 2, 2)).toEqual([0, 0, 0]); // 5x5: mostly black
  });
});
