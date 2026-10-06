import { describe, it, expect } from 'vitest';
import { iconMoments, momentHeading, smoothHeading, angleDiff, makeTemplate, matchTemplate, grayOf } from '../src/mower-heading.js';

const BG = [40, 90, 40], RED = [230, 40, 40];
function image(w, h, c = BG) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([...c, 255], i * 4);
  return a;
}
// fill pixels whose centre is inside(lx, ly) in the icon frame (front = +lx), turned to heading `deg`
function draw(a, w, h, cx, cy, deg, inside, color = RED) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ex = x + 0.5 - cx, ey = cy - (y + 0.5);
    const lx = ex * c + ey * s, ly = -ex * s + ey * c;
    if (inside(lx, ly)) a.set([...color, 255], (y * w + x) * 4);
  }
}
const teardrop = (lx, ly) => Math.hypot(lx + 4, ly) <= 6 || (lx >= -4 && lx <= 14 && Math.abs(ly) <= 6 * (14 - lx) / 18);
const arrow = (lx, ly) => lx >= -8 && lx <= 12 && Math.abs(ly) <= 7 * (12 - lx) / 20;
const round = (lx, ly) => Math.hypot(lx, ly) <= 7;

describe('heading from icon moments', () => {
  for (const [name, shape] of [['teardrop', teardrop], ['arrow', arrow]]) {
    for (const deg of [0, 37, 90, 155, 210, 300]) {
      it(`${name} at ${deg}°`, () => {
        const w = 80, h = 80, a = image(w, h);
        draw(a, w, h, 40.3, 39.6, deg, shape);
        const m = iconMoments(a, w, h, [RED], 30, 41, 40, 25);
        const hd = momentHeading(m);
        expect(hd).not.toBeNull();
        expect(Math.abs(angleDiff(hd.angle, deg))).toBeLessThanOrEqual(5);
      });
    }
  }
  it('round icon: no heading', () => {
    const w = 60, h = 60, a = image(w, h);
    draw(a, w, h, 30, 30, 0, round);
    expect(momentHeading(iconMoments(a, w, h, [RED], 30, 30, 30, 20))).toBeNull();
  });
  it('refined centroid of the connected icon only', () => {
    const w = 60, h = 60, a = image(w, h);
    draw(a, w, h, 20, 20, 0, round);
    draw(a, w, h, 50, 50, 0, round); // another blob outside the window
    const m = iconMoments(a, w, h, [RED], 30, 21, 19, 15);
    expect(m.cx).toBeCloseTo(20, 1);
    expect(m.cy).toBeCloseTo(20, 1);
  });
});

describe('heading smoothing', () => {
  it('low-pass for jitter (wraps around 0), a turn is taken as it is', () => {
    expect(smoothHeading(null, 10).angle).toBe(10);
    expect(smoothHeading({ angle: 354, pending: null }, 4, { alpha: 0.5 }).angle).toBeCloseTo(359, 6);
    expect(smoothHeading({ angle: 10, pending: null }, 60).angle).toBe(60);
  });
  it('a jump > 120° needs two agreeing frames', () => {
    let st = { angle: 0, pending: null };
    st = smoothHeading(st, 170);
    expect(st.angle).toBe(0);
    st = smoothHeading(st, 172);
    expect(st.angle).toBe(172);
    expect(smoothHeading({ angle: 0, pending: null }, null)).toEqual({ angle: 0, pending: null });
  });
});

// a mower-like picture: body, darker front bumper, a light disc at the back (front = top)
function mowerPicture() {
  const w = 24, h = 32, a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4;
    const inBody = Math.abs(x + 0.5 - 12) <= 10 && y >= 2 && y <= 30;
    if (!inBody) continue; // transparent
    let c = [90, 90, 95];
    if (y < 8) c = [30, 30, 30];
    if (Math.hypot(x + 0.5 - 12, y + 0.5 - 22) < 5) c = [235, 235, 235];
    if (x < 5 && y > 12 && y < 20) c = [200, 60, 40];
    a.set([...c, 255], k);
  }
  return { a, w, h };
}
// paste the picture turned to heading `deg` (top = front), scaled, centred on (cx, cy)
function paste(dst, w, h, pic, t, cx, cy, deg, s, noise = 0) {
  const r = ((deg - 90) * Math.PI) / 180, c = Math.cos(r), si = Math.sin(r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ex = x + 0.5 - cx, ey = cy - (y + 0.5);
    const tx = (ex * c + ey * si) / s, ty = (-ex * si + ey * c) / s;
    const px = Math.floor(t.ox + tx), py = Math.floor(t.oy - ty);
    if (px < 0 || py < 0 || px >= pic.w || py >= pic.h) continue;
    const k = (py * pic.w + px) * 4;
    if (pic.a[k + 3] < 128) continue;
    dst.set([pic.a[k], pic.a[k + 1], pic.a[k + 2], 255], (y * w + x) * 4);
  }
  if (noise) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
    for (let i = 0; i < w * h * 4; i += 4) for (let j = 0; j < 3; j++) dst[i + j] = Math.max(0, Math.min(255, dst[i + j] + rnd()));
  }
}

describe('template match with the mower picture', () => {
  const pic = mowerPicture();
  const t = makeTemplate(pic.a, pic.w, pic.h);
  it('template: background trimmed, centroid', () => {
    expect(t.w).toBe(20);
    expect(t.h).toBe(29);
    expect(t.count).toBe(20 * 29);
  });
  it('front = top: heading 0 points the bumper to the right', () => {
    const w = 60, h = 60, a = image(w, h);
    // the template's centroid in picture pixels (template + crop offset 2, 2)
    paste(a, w, h, pic, { ox: t.cx + 2, oy: t.cy + 2 }, 30, 30, 0, 1);
    const k = (30 * w + 30 + 12) * 4; // right of the centre: the dark bumper
    expect(a[k]).toBe(30);
  });
  for (const [deg, s] of [[0, 1], [33, 1], [90, 0.8], [147, 0.7], [222, 1], [318, 0.9]]) {
    it(`finds heading ${deg}° at scale ${s} within 5° and 1 px`, () => {
      const w = 90, h = 90, a = image(w, h);
      const cx = 44.3, cy = 46.7;
      paste(a, w, h, pic, { ox: t.cx + 2, oy: t.cy + 2 }, cx, cy, deg, s, 12);
      const g = grayOf(a, w, h);
      const r = matchTemplate(g, w, h, t, cx + 1.2, cy - 0.8, { scale: s, radius: 2 });
      expect(r.score).toBeGreaterThan(0.6);
      expect(Math.abs(angleDiff(r.angle, deg))).toBeLessThanOrEqual(5);
      expect(Math.hypot(r.x - cx, r.y - cy)).toBeLessThanOrEqual(1);
    });
  }
});
