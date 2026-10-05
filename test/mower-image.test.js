import { describe, it, expect, vi } from 'vitest';
import { findBlob, pickBlob, stepTrack, headingMinStep, TRACK_MAX_MISSES, pixelToPlan, planToPixel, medianColor, imageScale, fitOverlay } from '../src/mower-image.js';

// synthetic RGBA image filled with one colour
function image(w, h, bg = [30, 80, 30]) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([...bg, 255], i * 4);
  return a;
}
function rect(a, w, x0, y0, rw, rh, c) {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) a.set([...c, 255], (y * w + x) * 4);
}
const RED = [255, 40, 30];

describe('pixelToPlan / planToPixel', () => {
  const ov = { x: 3, y: -2, rotation: 30, width: 9 };

  it('maps the image centre to the overlay centre', () => {
    const p = pixelToPlan(225, 425, 450, 850, ov);
    expect(p.x).toBeCloseTo(3, 9);
    expect(p.y).toBeCloseTo(-2, 9);
  });

  it('puts the top of the image north before rotation', () => {
    const p = pixelToPlan(225, 0, 450, 850, { x: 0, y: 0, rotation: 0, width: 9 });
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(8.5, 9); // height = 9 * 850 / 450 = 17
    const q = pixelToPlan(450, 425, 450, 850, { x: 0, y: 0, rotation: 0, width: 9 });
    expect(q.x).toBeCloseTo(4.5, 9); // right edge east
  });

  it('rotates counter-clockwise like the overlay plane (rotation.y)', () => {
    // right edge centre, rotated 90°: east becomes north
    const p = pixelToPlan(450, 425, 450, 850, { x: 0, y: 0, rotation: 90, width: 9 });
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(4.5, 9);
  });

  it('round-trips with rotation 30° and offsets', () => {
    for (const [px, py] of [[0, 0], [450, 850], [12.5, 700], [300, 40]]) {
      const p = pixelToPlan(px, py, 450, 850, ov);
      const q = planToPixel(p.x, p.y, 450, 850, ov);
      expect(q.px).toBeCloseTo(px, 9);
      expect(q.py).toBeCloseTo(py, 9);
    }
  });

  it('defaults a missing width to 20 m and missing offsets to 0', () => {
    const p = pixelToPlan(100, 50, 100, 100, {});
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });
});

describe('findBlob', () => {
  it('finds a single dot (centroid in pixel-centre coordinates)', () => {
    const a = image(40, 30);
    rect(a, 40, 10, 5, 4, 4, RED);
    const b = findBlob(a, 40, 30, RED, 40);
    expect(b).toEqual({ px: 12, py: 7, count: 16, matched: true });
  });

  it('returns null when nothing matches', () => {
    expect(findBlob(image(20, 20), 20, 20, RED, 40)).toBeNull();
  });

  it('respects the colour tolerance (max channel difference)', () => {
    const a = image(20, 20);
    rect(a, 20, 2, 2, 3, 3, [225, 40, 30]); // 30 off in red
    expect(findBlob(a, 20, 20, RED, 40)).toMatchObject({ count: 9 });
    expect(findBlob(a, 20, 20, RED, 20)).toBeNull();
  });

  it('ignores noise smaller than minPixels', () => {
    const a = image(30, 30);
    rect(a, 30, 1, 1, 1, 1, RED);
    rect(a, 30, 5, 5, 1, 3, RED);
    expect(findBlob(a, 30, 30, RED, 40, { minPixels: 4 })).toBeNull();
    rect(a, 30, 20, 20, 2, 2, RED);
    expect(findBlob(a, 30, 30, RED, 40, { minPixels: 4 })).toMatchObject({ px: 21, py: 21, count: 4 });
  });

  it('picks the largest blob without prev, the nearest size-matched one with prev', () => {
    const a = image(60, 40);
    rect(a, 60, 2, 2, 5, 5, RED); // 25 px
    rect(a, 60, 50, 30, 5, 5, RED); // 25 px
    rect(a, 60, 30, 2, 2, 2, RED); // 4 px, too small to match 25
    expect(findBlob(a, 60, 40, RED, 40)).toMatchObject({ count: 25, matched: true });
    const near = findBlob(a, 60, 40, RED, 40, { prev: { px: 50, py: 30, count: 25 } });
    expect(near).toEqual({ px: 52.5, py: 32.5, count: 25, matched: true });
    const other = findBlob(a, 60, 40, RED, 40, { prev: { px: 0, py: 0, count: 25 } });
    expect(other).toEqual({ px: 4.5, py: 4.5, count: 25, matched: true });
    // unknown count (right after the colour pick): the nearest of any size
    expect(findBlob(a, 60, 40, RED, 40, { prev: { px: 31, py: 3 } })).toMatchObject({ count: 4, matched: true });
  });

  it('a big static blob never wins over the small tracked one', () => {
    let track = { px: 10.5, py: 30.5, count: 9, misses: 0 };
    for (let step = 0; step < 6; step++) {
      const a = image(80, 50);
      rect(a, 80, 40, 2, 20, 20, RED); // 400 px legend swatch, static
      const x = 9 + step * 4;
      rect(a, 80, x, 29, 3, 3, RED); // 9 px mower, moving east
      const b = findBlob(a, 80, 50, RED, 40, { prev: track });
      const r = stepTrack(track, b);
      expect(r.found).toBe(true);
      expect(r.track.px).toBeCloseTo(x + 1.5, 9);
      expect(r.track.count).toBe(9);
      track = r.track;
    }
  });

  it('falls back to the largest blob when none matches the tracked size', () => {
    expect(pickBlob([{ px: 1, py: 1, count: 400 }, { px: 9, py: 9, count: 2 }], { px: 9, py: 9, count: 30 }))
      .toEqual({ px: 1, py: 1, count: 400, matched: false });
    expect(pickBlob([], { px: 0, py: 0, count: 5 })).toBeNull();
  });
});

describe('stepTrack', () => {
  it('a brief miss keeps the last position; the next frame prefers the size-matched blob near it', () => {
    let track = { px: 10, py: 10, count: 20, misses: 0 };
    // miss: only a big look-alike far away
    let r = stepTrack(track, pickBlob([{ px: 70, py: 40, count: 300 }], track));
    expect(r.found).toBe(false);
    expect(r.track).toMatchObject({ px: 10, py: 10, count: 20, misses: 1 });
    track = r.track;
    // icon back, plus a same-size look-alike further away: the one near the last known position
    r = stepTrack(track, pickBlob([{ px: 70, py: 40, count: 300 }, { px: 50, py: 5, count: 20 }, { px: 12, py: 11, count: 22 }], track));
    expect(r.found).toBe(true);
    expect(r.track).toEqual({ px: 12, py: 11, count: 22, misses: 0 });
  });

  it('nothing found counts as a miss and keeps the track', () => {
    expect(stepTrack({ px: 1, py: 2, count: 9, misses: 0 }, null)).toEqual({ track: { px: 1, py: 2, count: 9, misses: 1 }, found: false });
    expect(stepTrack(null, null)).toEqual({ track: null, found: false });
  });

  it(`re-anchors on the largest blob after ${TRACK_MAX_MISSES} unmatched frames in a row`, () => {
    let track = { px: 10, py: 10, count: 20, misses: 0 };
    const big = { px: 70, py: 40, count: 300 };
    for (let i = 1; i < TRACK_MAX_MISSES; i++) {
      const r = stepTrack(track, pickBlob([big], track));
      expect(r.found).toBe(false);
      track = r.track;
    }
    const r = stepTrack(track, pickBlob([big], track));
    expect(r).toEqual({ track: { px: 70, py: 40, count: 300, misses: 0 }, found: true });
  });

  it('starts a track from the first blob', () => {
    expect(stepTrack(null, { px: 3, py: 4, count: 7, matched: true })).toEqual({ track: { px: 3, py: 4, count: 7, misses: 0 }, found: true });
  });
});

describe('headingMinStep', () => {
  it('is 5 cm for gps / xy', () => {
    expect(headingMinStep('gps', 30, 600)).toBe(0.05);
    expect(headingMinStep('xy')).toBe(0.05);
  });
  it('is max(0.25 m, 3 metres-per-pixel) for the image source', () => {
    expect(headingMinStep('image', 30, 600)).toBeCloseTo(0.25); // 5 cm/px -> 0.15
    expect(headingMinStep('image', 40, 400)).toBeCloseTo(0.3); // 10 cm/px
    expect(headingMinStep('image', 30, 0)).toBe(0.25);
  });
});

describe('findBlob (cont.)', () => {
  it('uses 4-neighbour connectivity', () => {
    const a = image(10, 10);
    rect(a, 10, 1, 1, 2, 2, RED);
    rect(a, 10, 3, 3, 2, 2, RED); // touches only diagonally
    expect(findBlob(a, 10, 10, RED, 40, { minPixels: 1 })).toMatchObject({ count: 4 });
  });

  it('skips transparent pixels', () => {
    const a = image(10, 10);
    rect(a, 10, 1, 1, 3, 3, RED);
    for (let i = 0; i < 100; i++) a[i * 4 + 3] = 0;
    expect(findBlob(a, 10, 10, RED, 40)).toBeNull();
  });
});

describe('medianColor', () => {
  it('takes the per-channel median of a 5x5 neighbourhood, clamped at the edges', () => {
    const a = image(10, 10, [0, 0, 0]);
    rect(a, 10, 0, 0, 3, 3, RED); // 9 of the 9..25 neighbours
    a.set([255, 255, 255, 255], 0); // one outlier
    expect(medianColor(a, 10, 10, 1, 1)).toEqual(RED);
    expect(medianColor(a, 10, 10, 8, 8)).toEqual([0, 0, 0]);
  });
});

describe('imageScale', () => {
  it('samples images wider than 1600 px on a smaller canvas', () => {
    expect(imageScale(800)).toBe(1);
    expect(imageScale(3200)).toBe(0.5);
  });
});

describe('fitOverlay', () => {
  const W = 800, H = 600;
  const truth = { x: 4.5, y: -7.25, rotation: 23, width: 31 };
  const pair = (px, py, o = truth) => { const p = pixelToPlan(px, py, W, H, o); return { px, py, plan: [p.x, p.y] }; };

  it('2 points reproduce the overlay exactly', () => {
    const r = fitOverlay([pair(100, 80), pair(650, 520)], W, H);
    expect(r.x).toBeCloseTo(truth.x, 6);
    expect(r.y).toBeCloseTo(truth.y, 6);
    expect(r.rotation).toBeCloseTo(truth.rotation, 6);
    expect(r.width).toBeCloseTo(truth.width, 6);
  });

  it('maps each pixel onto its plan point', () => {
    const pairs = [pair(10, 590), pair(790, 30)];
    const r = fitOverlay(pairs, W, H);
    for (const p of pairs) {
      const q = pixelToPlan(p.px, p.py, W, H, r);
      expect(q.x).toBeCloseTo(p.plan[0], 6);
      expect(q.y).toBeCloseTo(p.plan[1], 6);
    }
  });

  it('negative and wrapped rotations come back in -180..180', () => {
    const o = { x: 0, y: 0, rotation: -170, width: 12 };
    const r = fitOverlay([pair(0, 0, o), pair(W, H, o)], W, H);
    expect(r.rotation).toBeCloseTo(-170, 6);
  });

  it('3+ points: least-squares similarity', () => {
    const pts = [pair(50, 50), pair(700, 80), pair(400, 550), pair(120, 400)];
    // noise that cancels out in the mean
    const noisy = pts.map((p, i) => ({ ...p, plan: [p.plan[0] + (i % 2 ? 0.05 : -0.05), p.plan[1] + (i < 2 ? 0.05 : -0.05)] }));
    const r = fitOverlay(noisy, W, H);
    expect(Math.abs(r.x - truth.x)).toBeLessThan(0.05);
    expect(Math.abs(r.y - truth.y)).toBeLessThan(0.05);
    expect(Math.abs(r.rotation - truth.rotation)).toBeLessThan(0.5);
    expect(Math.abs(r.width - truth.width)).toBeLessThan(0.2);
    const exact = fitOverlay(pts, W, H);
    expect(exact.width).toBeCloseTo(truth.width, 6);
  });

  it('null for fewer than 2 points or coincident pixels', () => {
    expect(fitOverlay([pair(1, 1)], W, H)).toBeNull();
    expect(fitOverlay([pair(5, 5), { px: 5, py: 5, plan: [9, 9] }], W, H)).toBeNull();
    expect(fitOverlay(null, W, H)).toBeNull();
    expect(fitOverlay([pair(1, 1), pair(2, 2)], 0, H)).toBeNull();
  });
});

describe('MapProcessor.dispose', () => {
  it('settles a pending worker run (timeout cleared) without marking the worker dead', async () => {
    const { MapProcessor } = await import('../src/mower-image.js');
    vi.useFakeTimers();
    try {
      const mp = new MapProcessor();
      mp._out = { data: new Uint8ClampedArray(4) };
      const wk = { postMessage: vi.fn(), terminate: vi.fn() };
      mp._worker = wk;
      const run = mp._viaWorker(wk, new Uint8ClampedArray(4), 1, 1, {}, null, null, false);
      mp.dispose();
      await expect(run).rejects.toMatchObject({ disposed: true });
      expect(vi.getTimerCount()).toBe(0);
      expect(wk.terminate).toHaveBeenCalled();
      expect(mp._workerDead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
