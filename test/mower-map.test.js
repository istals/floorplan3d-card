import { describe, it, expect } from 'vitest';
import { processMap, zoneMask, zonePixels, stripeAngle, stripeBearing, mowedShare, mapWorkSize, planToPixel } from '../src/mower-image.js';

const BG = [30, 70, 35], MOWED = [120, 190, 110], NOMOW = [140, 140, 140], RED = [255, 40, 30];
function image(w, h, c = BG) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([...c, 255], i * 4);
  return a;
}
function rect(a, w, x0, y0, rw, rh, c) {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) a.set([...c, 255], (y * w + x) * 4);
}
const alpha = (d, w, x, y) => d[(y * w + x) * 4 + 3];
const px = (d, w, x, y) => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

// stripes along direction `deg` (counter-clockwise from image right, image up = +y), `period` px
function stripes(w, h, deg, period = 12) {
  const a = image(w, h);
  const r = (deg * Math.PI) / 180, nx = -Math.sin(r), ny = Math.cos(r);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + 0.5) * nx + (h - y - 0.5) * ny;
      if (Math.floor(t / period) % 2 === 0) a.set([...MOWED, 255], (y * w + x) * 4);
    }
  }
  return a;
}
function maskOf(rgba, w, h, c) {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (rgba[i * 4] === c[0] && rgba[i * 4 + 1] === c[1]) m[i] = 1;
  return m;
}
const axisDiff = (a, b) => { const d = Math.abs((((a - b) % 180) + 180) % 180); return Math.min(d, 180 - d); };

describe('processMap', () => {
  it('without colours copies the image (no keying)', () => {
    const w = 8, h = 6, src = image(w, h);
    rect(src, w, 2, 2, 2, 2, MOWED);
    const r = processMap(src, w, h, {});
    expect(Array.from(r.data)).toEqual(Array.from(src));
    expect(r.data).not.toBe(src);
  });

  it('makes the background transparent, keeps others, counts pixels', () => {
    const w = 10, h = 10, src = image(w, h);
    rect(src, w, 0, 0, 10, 3, MOWED);
    rect(src, w, 6, 6, 2, 2, [240, 240, 240]); // dock: untouched
    const r = processMap(src, w, h, { bg: { color: BG, tolerance: 20 }, mowed: { color: MOWED, tolerance: 20 } });
    expect(alpha(r.data, w, 5, 5)).toBe(0);
    expect(px(r.data, w, 6, 6)).toEqual([240, 240, 240, 255]);
    const m = px(r.data, w, 1, 1);
    expect(m[3]).toBeGreaterThan(0);
    expect(m[3]).toBeLessThan(255); // subtle
    expect(m[0]).toBeGreaterThanOrEqual(MOWED[0]); // lightened
    expect(r.mowed).toBe(30);
    expect(r.background).toBe(66);
    expect(r.mowedMask[1 * w + 1]).toBe(1);
    expect(r.mowedMask[5 * w + 5]).toBe(0);
  });

  it('a pixel matching two colours goes to the nearer one', () => {
    const w = 2, h = 1, src = image(w, h, [60, 110, 60]);
    const r = processMap(src, w, h, { bg: { color: BG, tolerance: 200 }, mowed: { color: [70, 120, 70], tolerance: 200 } });
    expect(r.mowed).toBe(2);
  });

  it('shades no-mow pixels dark, translucent and hatched', () => {
    const w = 16, h = 16, src = image(w, h, NOMOW);
    const r = processMap(src, w, h, { nomow: { color: NOMOW, tolerance: 10 } });
    const as = new Set();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = px(r.data, w, x, y);
      expect(p[0]).toBeLessThan(80);
      expect(p[3]).toBeGreaterThan(0);
      expect(p[3]).toBeLessThan(255);
      as.add(p[3]);
    }
    expect(as.size).toBe(2); // hatch lines and gaps
  });

  it('hides the icon blob (dilated) and keeps it when not asked', () => {
    const w = 40, h = 40, src = image(w, h);
    rect(src, w, 18, 18, 4, 4, RED);
    rect(src, w, 2, 2, 3, 3, RED); // another blob of the icon colour far away: kept
    const blob = { px: 20, py: 20, count: 16, color: RED, tolerance: 30 };
    const r = processMap(src, w, h, { iconBlob: blob, dilate: 3 });
    expect(alpha(r.data, w, 19, 19)).toBe(0);
    expect(alpha(r.data, w, 15, 20)).toBe(0); // 3 px dilation
    expect(alpha(r.data, w, 14, 20)).toBe(255);
    expect(alpha(r.data, w, 3, 3)).toBe(255);
    const off = processMap(src, w, h, {});
    expect(px(off.data, w, 19, 19)).toEqual([...RED, 255]);
  });

  it('finds the icon when the centroid misses its pixels (ring)', () => {
    const w = 40, h = 40, src = image(w, h);
    rect(src, w, 15, 15, 10, 10, RED);
    rect(src, w, 17, 17, 6, 6, BG);
    const r = processMap(src, w, h, { iconBlob: { px: 20, py: 20, count: 64, color: RED, tolerance: 30 }, dilate: 0 });
    expect(alpha(r.data, w, 15, 15)).toBe(0);
    expect(alpha(r.data, w, 24, 24)).toBe(0);
  });

  it('clears pixels outside the zone mask and counts zone pixels', () => {
    const w = 10, h = 10, src = image(w, h, MOWED);
    const zone = new Uint8Array(w * h);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 10; x++) zone[y * w + x] = 1;
    const r = processMap(src, w, h, { mowed: { color: MOWED, tolerance: 10 }, zoneMask: zone });
    expect(alpha(r.data, w, 5, 7)).toBe(0);
    expect(alpha(r.data, w, 5, 2)).toBeGreaterThan(0);
    expect(r.zone).toBe(50);
    expect(r.mowed).toBe(50);
  });

  it('reuses the buffers it is given', () => {
    const bufs = {};
    const a = processMap(image(4, 4), 4, 4, {}, bufs);
    const b = processMap(image(4, 4), 4, 4, {}, bufs);
    expect(b.data.buffer).toBe(a.data.buffer);
    const c = processMap(image(8, 8), 8, 8, {}, bufs); // grows
    expect(c.data.length).toBe(256);
  });
});

describe('zone mask', () => {
  it('rasterises a polygon by pixel centres', () => {
    const { mask, count } = zoneMask([[2, 2], [8, 2], [8, 6], [2, 6]], 10, 10);
    expect(count).toBe(24);
    expect(mask[2 * 10 + 2]).toBe(1);
    expect(mask[5 * 10 + 7]).toBe(1);
    expect(mask[6 * 10 + 5]).toBe(0);
    expect(mask[3 * 10 + 8]).toBe(0);
  });

  it('handles a concave outline', () => {
    const { mask } = zoneMask([[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10]], 10, 10);
    expect(mask[8 * 10 + 5]).toBe(0); // the notch
    expect(mask[8 * 10 + 2]).toBe(1);
    expect(mask[2 * 10 + 5]).toBe(1);
  });

  it('maps plan outlines into working pixels through the overlay (any image size)', () => {
    const ov = { x: 10, y: 5, rotation: 30, width: 9 };
    const poly = [[9, 4], [11, 4], [11, 6], [9, 6]];
    for (const [imgW, imgH, w, h] of [[450, 850, 450, 850], [1600, 3022, 1024, 1934], [900, 900, 512, 512]]) {
      const pts = zonePixels(poly, ov, imgW, imgH, w, h);
      const q = planToPixel(9, 4, imgW, imgH, ov);
      expect(pts[0][0]).toBeCloseTo((q.px * w) / imgW, 6);
      expect(pts[0][1]).toBeCloseTo((q.py * h) / imgH, 6);
      // the centre of the image lies in a zone around the overlay centre
      const { mask } = zoneMask(pts, w, h);
      expect(mask[Math.floor(h / 2) * w + Math.floor(w / 2)]).toBe(1);
    }
  });
});

describe('stripe angle', () => {
  for (const deg of [0, 30, 45, 90, 120, 163]) {
    it(`finds stripes at ${deg}°`, () => {
      const w = 300, h = 240, a = stripes(w, h, deg);
      const s = stripeAngle(maskOf(a, w, h, MOWED), w, h);
      expect(s).not.toBeNull();
      expect(axisDiff(s.angle, deg)).toBeLessThan(3);
    });
  }

  it('works on large masks (downscaled)', () => {
    const w = 1024, h = 1500, a = stripes(w, h, 70, 40);
    const s = stripeAngle(maskOf(a, w, h, MOWED), w, h);
    expect(axisDiff(s.angle, 70)).toBeLessThan(3);
  });

  it('no stripes (empty or noise) -> null', () => {
    expect(stripeAngle(new Uint8Array(100 * 100), 100, 100)).toBeNull();
    const m = new Uint8Array(200 * 200);
    let s = 7;
    for (let i = 0; i < m.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; m[i] = (s >> 16) & 1; }
    expect(stripeAngle(m, 200, 200)).toBeNull();
  });

  it('bearing on the plan: overlay rotation, compass axis', () => {
    expect(stripeBearing(90, 0)).toEqual({ bearing: 0, label: 'N–S' });
    expect(stripeBearing(0, 0)).toEqual({ bearing: 90, label: 'E–W' });
    expect(stripeBearing(0, 45)).toEqual({ bearing: 45, label: 'NE–SW' });
    expect(stripeBearing(30, 0)).toEqual({ bearing: 60, label: 'NE–SW' });
    expect(stripeBearing(170, 0)).toEqual({ bearing: 100, label: 'E–W' });
    expect(stripeBearing(0, -45)).toEqual({ bearing: 135, label: 'SE–NW' });
  });
});

describe('mowed share', () => {
  it('mowed / zone pixels with a zone, else mowed / lawn (mowed + background)', () => {
    expect(mowedShare({ mowed: 25, zone: 100, background: 10, zoned: true })).toBeCloseTo(0.25);
    expect(mowedShare({ mowed: 30, zone: 0, background: 90, zoned: false })).toBeCloseTo(0.25);
    expect(mowedShare({ mowed: 0, zone: 0, background: 0, zoned: false })).toBeNull();
    expect(mowedShare({ mowed: 5, zone: 0, background: 0, zoned: true })).toBeNull();
  });

  it('end to end: synthetic stripes in a zone', () => {
    const w = 200, h = 200, src = image(w, h);
    rect(src, w, 0, 0, 200, 50, MOWED); // a quarter of the image mowed
    const zone = zoneMask([[0, 0], [200, 0], [200, 100], [0, 100]], w, h);
    const r = processMap(src, w, h, { bg: { color: BG, tolerance: 20 }, mowed: { color: MOWED, tolerance: 20 }, zoneMask: zone.mask });
    expect(mowedShare({ ...r, zoned: true })).toBeCloseTo(0.5);
  });
});

describe('working size', () => {
  it('keeps small images, scales large ones to <= 1024 wide keeping the aspect', () => {
    expect(mapWorkSize(450, 850)).toEqual({ width: 450, height: 850 });
    const s = mapWorkSize(1600, 1200);
    expect(s.width).toBe(1024);
    expect(s.height).toBe(768);
  });
});
