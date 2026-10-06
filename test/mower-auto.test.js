import { describe, it, expect } from 'vitest';
import { compareMaps, bestShift, downGray, autoShare, dockBlob, CLS, pickMower, isDock, autoProcess } from '../src/mower-auto.js';
import { makeTemplate, matchTemplate, grayOf, angleDiff } from '../src/mower-heading.js';

const BGC = [28, 28, 30], LAWN = [60, 125, 58], MOWED = [118, 190, 104], NOMOW = [140, 140, 140], LINE = [210, 50, 50], DOCK = [176, 176, 176];
const W = 160, H = 200;
function staticMap() {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = BGC;
    if (x >= 10 && x < 150 && y >= 10 && y < 190) c = LAWN;
    if ((x === 10 || x === 149 || y === 10 || y === 189) && c === LAWN) c = LINE;
    if (Math.hypot(x + 0.5 - 50, y + 0.5 - 150) < 12) c = NOMOW;
    a.set([...c, 255], (y * W + x) * 4);
  }
  return a;
}
const striped = (x, y) => x > 11 && x < 148 && y > 11 && y < 188 && Math.floor((x + 0.4 * y) / 10) % 2 === 0 && Math.hypot(x + 0.5 - 50, y + 0.5 - 150) >= 12;
function mowerPicture() {
  const w = 24, h = 32, a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!(Math.abs(x + 0.5 - 12) <= 10 && y >= 2 && y <= 30)) continue;
    let c = [90, 90, 95];
    if (y < 8) c = [30, 30, 30];
    if (Math.hypot(x + 0.5 - 12, y + 0.5 - 22) < 5) c = [235, 235, 235];
    if (x < 5 && y > 12 && y < 20) c = [200, 60, 40];
    a.set([...c, 255], (y * w + x) * 4);
  }
  return { a, w, h };
}
function paste(dst, pic, t, cx, cy, deg, s) {
  const r = ((deg - 90) * Math.PI) / 180, c = Math.cos(r), si = Math.sin(r);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ex = x + 0.5 - cx, ey = cy - (y + 0.5);
    const tx = (ex * c + ey * si) / s, ty = (-ex * si + ey * c) / s;
    const px = Math.floor(t.cx + 2 + tx), py = Math.floor(t.cy + 2 - ty);
    if (px < 0 || py < 0 || px >= pic.w || py >= pic.h) continue;
    const k = (py * pic.w + px) * 4;
    if (pic.a[k + 3] < 128) continue;
    dst.set([pic.a[k], pic.a[k + 1], pic.a[k + 2], 255], (y * W + x) * 4);
  }
}
function liveMap(pic, t, cx, cy, deg, s) {
  const a = staticMap();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (striped(x, y)) a.set([...MOWED, 255], (y * W + x) * 4);
  for (let y = 165; y < 180; y++) for (let x = 120; x < 140; x++) a.set([...DOCK, 255], (y * W + x) * 4);
  paste(a, pic, t, cx, cy, deg, s);
  return a;
}

describe('auto mode: live map against the static map', () => {
  const pic = mowerPicture();
  const t = makeTemplate(pic.a, pic.w, pic.h);
  for (const deg of [20, 135, 260]) {
    it(`stripes, no-mow, mower at ${deg}° and the dock`, () => {
      const cx = 81.4, cy = 70.6, s = 0.8;
      const live = liveMap(pic, t, cx, cy, deg, s);
      const r = compareMaps(staticMap(), live, W, H);
      // mowed mask against the truth (outside the icons)
      let inter = 0, uni = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (r.cls[i] === CLS.ICON) continue;
        const a = striped(x, y), b = r.mowedMask[i] === 1;
        if (a && b) inter++;
        if (a || b) uni++;
      }
      expect(inter / uni).toBeGreaterThan(0.9);
      expect(r.nomow).toBeGreaterThan(300);
      expect(r.data[((150 * W + 50) * 4) + 3]).toBeGreaterThan(0); // shaded
      expect(r.data[((100 * W + 3) * 4) + 3]).toBe(0); // background unchanged: transparent
      const share = autoShare(r);
      expect(share).toBeGreaterThan(0.4);
      expect(share).toBeLessThan(0.6);
      // the mower: the blob whose picture match is best
      const g = grayOf(live, W, H);
      let best = null;
      for (const b of r.blobs) {
        const m = matchTemplate(g, W, H, t, b.px, b.py, { scale: Math.sqrt(b.count / t.count), radius: 3 });
        if (m && (!best || m.score > best.m.score)) best = { b, m };
      }
      expect(best.m.score).toBeGreaterThan(0.6);
      expect(Math.abs(angleDiff(best.m.angle, deg))).toBeLessThanOrEqual(5);
      expect(Math.hypot(best.m.x - cx, best.m.y - cy)).toBeLessThanOrEqual(1);
      const dock = dockBlob(r.blobs, best.b);
      expect(dock && Math.hypot(dock.px - 130, dock.py - 172.5)).toBeLessThan(1);
    });
  }
  it('finds a shift between the maps', () => {
    const a = staticMap(), b = new Uint8ClampedArray(a.length);
    // b = a moved by (+3, -2)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = x - 3, sy = y + 2;
      const k = (y * W + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) { b.set([...BGC, 255], k); continue; }
      b.set(a.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), k);
    }
    const ga = downGray(a, W, H, 1), gb = downGray(b, W, H, 1);
    expect(bestShift(ga.g, gb.g, ga.w, ga.h, 4)).toEqual({ dx: 3, dy: -2 });
    const r = compareMaps(a, b, W, H, { dx: 3, dy: -2 });
    expect(r.icon).toBe(0);
    expect(r.mowed).toBe(0);
  });
});

describe('auto mode: the mower beats the dock', () => {
  // the reviewer's case: a grey product picture (bright front, dark back) and a uniform grey dock
  const tw = 300, tp = new Uint8ClampedArray(tw * tw * 4).fill(255);
  for (let y = 30; y < 270; y++) for (let x = 90; x < 210; x++) { const g = y < 90 ? 240 : y > 220 ? 40 : 130; tp.set([g, g, g, 255], (y * tw + x) * 4); }
  const t = makeTemplate(tp, tw, tw);
  const S = 512;
  for (const ang of [90, 30, 200, 300]) for (const sz of [1, 0.7]) {
    it(`icon at ${ang}° (size ${sz}) chosen over the dock, heading within 5°`, () => {
      const stat = new Uint8ClampedArray(S * S * 4), live = new Uint8ClampedArray(S * S * 4);
      for (let i = 0; i < S * S; i++) { stat.set([40, 140, 50, 255], i * 4); live.set([40, 140, 50, 255], i * 4); }
      const rr = ((ang - 90) * Math.PI) / 180, c = Math.cos(rr), s = Math.sin(rr);
      for (let y = -30; y <= 30; y++) for (let x = -30; x <= 30; x++) {
        const ex = x, ey = -y, tx = ex * c + ey * s, ty = -ex * s + ey * c, u = tx / sz, v = -ty / sz;
        if (Math.abs(u) < 6 && Math.abs(v) < 12) { const g = v < -7 ? 240 : v > 9 ? 40 : 130; live.set([g, g, g, 255], ((250 + y) * S + 250 + x) * 4); }
      }
      for (let y = 100; y < 114; y++) for (let x = 100; x < 114; x++) live.set([150, 150, 150, 255], (y * S + x) * 4);
      const r = compareMaps(stat, live, S, S);
      const pick = pickMower(r.blobs, grayOf(live, S, S), S, S, t, r.label, {});
      expect(pick).not.toBeNull();
      expect(Math.hypot(pick.b.px - 250.5, pick.b.py - 250.5)).toBeLessThan(2);
      expect(Math.abs(angleDiff(pick.m.angle, ang))).toBeLessThanOrEqual(5);
    });
  }
  it('a known dock position or a still grey blob is dropped', () => {
    const b = { px: 107, py: 107, count: 196, grey: true };
    expect(isDock(b, [[107.2, 106.9]], null)).toBe(true);
    expect(isDock(b, [], [108, 108])).toBe(true);
    expect(isDock(b, [[150, 150]], null)).toBe(false);
    expect(isDock({ ...b, grey: false }, [[107, 107]], null)).toBe(false);
  });
});

describe('auto mode: static map mismatch guard', () => {
  it('a different picture is a mismatch: no blobs (no million-pixel blob)', () => {
    const w = 200, h = 200, stat = new Uint8ClampedArray(w * h * 4), live = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { stat.set([30, 150, 40, 255], i * 4); live.set([200, 60, 180, 255], i * 4); }
    const r = compareMaps(stat, live, w, h);
    expect(r.mismatch).toBe(true);
    expect(r.blobs).toEqual([]);
    const p = autoProcess(stat, live, w, h, { detect: true });
    expect(p.mismatch).toBe(true);
    expect(p.pose).toBeNull();
  });
  it('changed areas larger than maxBlob are no icon', () => {
    const w = 100, h = 100, stat = new Uint8ClampedArray(w * h * 4), live = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { stat.set([30, 150, 40, 255], i * 4); live.set([30, 150, 40, 255], i * 4); }
    for (let y = 10; y < 60; y++) for (let x = 10; x < 60; x++) live.set([200, 60, 180, 255], (y * w + x) * 4); // 25 % of the picture
    expect(compareMaps(stat, live, w, h, { dx: 0, dy: 0 }, { maxBlob: 500 }).blobs).toEqual([]);
  });
});
