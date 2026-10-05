// Mower position from a live map image: find the mower icon by its colour, then map the pixel
// onto the plan through the map overlay alignment (the overlay IS the calibration).
//
// Pixel coordinates are continuous: pixel (i, j) covers [i, i+1) x [j, j+1), so its centre is
// (i + 0.5, j + 0.5) and the image spans [0, w] x [0, h].

export const MAX_SAMPLE_WIDTH = 1600;

// Overlay geometry, exactly as view.setMapOverlay draws it: a plane centred on (x, y), `width`
// metres wide, height = width * imgH / imgW, top of the image north, then rotated
// counter-clockwise by `rotation` degrees (plane.rotation.y) about its centre.
function frame(imgW, imgH, o) {
  const w = (o && o.width) || 20;
  const r = (((o && o.rotation) || 0) * Math.PI) / 180;
  return { w, h: (w * imgH) / imgW, cos: Math.cos(r), sin: Math.sin(r), ox: (o && o.x) || 0, oy: (o && o.y) || 0 };
}

export function pixelToPlan(px, py, imgW, imgH, overlay) {
  const f = frame(imgW, imgH, overlay);
  const lx = (px / imgW - 0.5) * f.w;
  const ly = (0.5 - py / imgH) * f.h;
  return { x: f.ox + lx * f.cos - ly * f.sin, y: f.oy + lx * f.sin + ly * f.cos };
}

export function planToPixel(x, y, imgW, imgH, overlay) {
  const f = frame(imgW, imgH, overlay);
  const dx = x - f.ox, dy = y - f.oy;
  const lx = dx * f.cos + dy * f.sin;
  const ly = -dx * f.sin + dy * f.cos;
  return { px: (lx / f.w + 0.5) * imgW, py: (0.5 - ly / f.h) * imgH };
}

// Overlay from point pairs: [{ px, py, plan: [x, y] }] (image pixels -> where they lie on the plan).
// In the overlay frame plan = centre + (width / imgW) * e^(i*rotation) * u with
// u = (px - imgW/2) + i*(imgH/2 - py), a similarity: 2 points fit exactly, 3+ by least squares.
// -> { x, y, rotation (degrees, -180..180), width } or null (fewer than 2 distinct pixels).
export function fitOverlay(pairs, imgW, imgH) {
  if (!Array.isArray(pairs) || pairs.length < 2 || !(imgW > 0) || !(imgH > 0)) return null;
  const n = pairs.length;
  const us = pairs.map((p) => [p.px - imgW / 2, imgH / 2 - p.py]);
  let ur = 0, ui = 0, zr = 0, zi = 0;
  for (let k = 0; k < n; k++) { ur += us[k][0]; ui += us[k][1]; zr += pairs[k].plan[0]; zi += pairs[k].plan[1]; }
  ur /= n; ui /= n; zr /= n; zi /= n;
  // a = sum((z - zm) * conj(u - um)) / sum(|u - um|^2)
  let nr = 0, ni = 0, den = 0;
  for (let k = 0; k < n; k++) {
    const dur = us[k][0] - ur, dui = us[k][1] - ui;
    const dzr = pairs[k].plan[0] - zr, dzi = pairs[k].plan[1] - zi;
    nr += dzr * dur + dzi * dui;
    ni += dzi * dur - dzr * dui;
    den += dur * dur + dui * dui;
  }
  if (den < 1e-9) return null;
  const ar = nr / den, ai = ni / den;
  const scale = Math.hypot(ar, ai);
  if (!(scale > 0)) return null;
  // centre = zm - a * um
  const x = zr - (ar * ur - ai * ui), y = zi - (ar * ui + ai * ur);
  return { x, y, rotation: (Math.atan2(ai, ar) * 180) / Math.PI, width: scale * imgW };
}

// Mask and flood-fill stack reused between detections (grown as needed): a 1600 px map would
// otherwise allocate about 9 MB per run.
let maskBuf = new Uint8Array(0), stackBuf = new Int32Array(0);

// Blobs (4-connected) of pixels within `tolerance` (max channel difference) of `color`;
// components smaller than minPixels are noise. -> [{ px, py, count }] (centroids)
export function findBlobs(rgba, w, h, color, tolerance, minPixels = 4) {
  const n = w * h;
  const [cr, cg, cb] = color;
  const tol = tolerance ?? 40;
  if (maskBuf.length < n) { maskBuf = new Uint8Array(n); stackBuf = new Int32Array(n); }
  const mask = maskBuf, stack = stackBuf;
  mask.fill(0, 0, n);
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    if (rgba[k + 3] < 128) continue;
    if (Math.abs(rgba[k] - cr) <= tol && Math.abs(rgba[k + 1] - cg) <= tol && Math.abs(rgba[k + 2] - cb) <= tol) mask[i] = 1;
  }
  const blobs = [];
  for (let s = 0; s < n; s++) {
    if (mask[s] !== 1) continue;
    let top = 0, count = 0, sx = 0, sy = 0;
    stack[top++] = s;
    mask[s] = 2;
    while (top) {
      const i = stack[--top];
      const x = i % w, y = (i - x) / w;
      count++;
      sx += x;
      sy += y;
      if (x > 0 && mask[i - 1] === 1) { mask[i - 1] = 2; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] === 1) { mask[i + 1] = 2; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] === 1) { mask[i - w] = 2; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] === 1) { mask[i + w] = 2; stack[top++] = i + w; }
    }
    if (count >= minPixels) blobs.push({ px: sx / count + 0.5, py: sy / count + 0.5, count });
  }
  return blobs;
}

// Choose the mower among the blobs. With `prev` ({ px, py, count? }, the tracked blob): the nearest
// blob whose size is within 0.5..2x prev.count (any size when count is unknown, e.g. right after the
// colour pick) -> matched: true. None qualifies (or no prev): the largest blob, matched only without prev.
// -> { px, py, count, matched } or null
export function pickBlob(blobs, prev = null) {
  if (!blobs || !blobs.length) return null;
  let largest = blobs[0];
  for (const b of blobs) if (b.count > largest.count) largest = b;
  if (!prev) return { ...largest, matched: true };
  const c = Number(prev.count) || 0;
  const ok = c > 0 ? blobs.filter((b) => b.count >= c * 0.5 && b.count <= c * 2) : blobs;
  if (!ok.length) return { ...largest, matched: false };
  const d = (b) => Math.hypot(b.px - prev.px, b.py - prev.py);
  return { ...ok.reduce((a, b) => (d(b) < d(a) ? b : a)), matched: true };
}

// The mower blob: see findBlobs / pickBlob. -> { px, py, count, matched } or null
export function findBlob(rgba, w, h, color, tolerance, { minPixels = 4, prev = null } = {}) {
  return pickBlob(findBlobs(rgba, w, h, color, tolerance, minPixels), prev);
}

// Unmatched frames (the icon hidden, only other blobs of its colour) before the largest blob is
// accepted as the new track.
export const TRACK_MAX_MISSES = 3;

// Next tracked blob from the last one and this frame's pick. -> { track, found }:
// found = the position moved to this frame's blob. An unmatched pick keeps the old track (and the
// last known position) until TRACK_MAX_MISSES frames in a row, so a brief miss never hands the
// track to a look-alike.
export function stepTrack(track, blob) {
  if (!blob) return { track: track ? { ...track, misses: (track.misses || 0) + 1 } : null, found: false };
  if (!track || blob.matched || (track.misses || 0) + 1 >= TRACK_MAX_MISSES) {
    return { track: { px: blob.px, py: blob.py, count: blob.count, misses: 0 }, found: true };
  }
  return { track: { ...track, misses: (track.misses || 0) + 1 }, found: false };
}

// Smallest move (m) that turns the mower object: image positions jitter by a pixel or so.
export function headingMinStep(source, overlayWidth, sampleWidth) {
  if (source !== 'image') return 0.05;
  const mpp = sampleWidth > 0 ? (Number(overlayWidth) || 20) / sampleWidth : 0;
  return Math.max(0.25, 3 * mpp);
}

// Per-channel median of the 5x5 neighbourhood around pixel (px, py) (integer pixel indices),
// clamped to the image.
export function medianColor(rgba, w, h, px, py) {
  const ch = [[], [], []];
  for (let y = py - 2; y <= py + 2; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = px - 2; x <= px + 2; x++) {
      if (x < 0 || x >= w) continue;
      const k = (y * w + x) * 4;
      ch[0].push(rgba[k]);
      ch[1].push(rgba[k + 1]);
      ch[2].push(rgba[k + 2]);
    }
  }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1] ?? 0);
}

// Scale used to sample an image of this width (large images are read on a smaller canvas).
export function imageScale(width) {
  return width > MAX_SAMPLE_WIDTH ? MAX_SAMPLE_WIDTH / width : 1;
}

// ---------- map image processing (one pass per refresh) ----------
// Working size of the processed map: masks, statistics and the visible texture (<= 1024 px wide).
export const MAP_WORK_WIDTH = 1024;
const MAP_WORK_HEIGHT = 2048;

export function mapWorkSize(width, height) {
  const s = Math.min(1, MAP_WORK_WIDTH / width, MAP_WORK_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

// Look of the processed map (before the overlay opacity): mowed stripes = their own colour lightened
// halfway to white at ~60 % alpha; no-mow = dark, hatched (diagonal lines every 8 px).
const MOWED_ALPHA = 150, NOMOW_RGB = 24, NOMOW_LINE_ALPHA = 200, NOMOW_GAP_ALPHA = 90;

function grow(bufs, key, Type, n) {
  if (!bufs[key] || bufs[key].length < n) bufs[key] = new Type(n);
  return bufs[key];
}

// Colour distance (max channel difference) when within tol, else -1.
function within(rgba, k, c, tol) {
  const d = Math.max(Math.abs(rgba[k] - c[0]), Math.abs(rgba[k + 1] - c[1]), Math.abs(rgba[k + 2] - c[2]));
  return d <= tol ? d : -1;
}

// Pixels of the mower icon: pixels of its colour near the blob centroid, their 4-connected
// neighbours of the same colour, then dilated by `dilate` px (the icon's outline / anti-aliasing).
function iconMask(rgba, w, h, blob, dilate, bufs) {
  const n = w * h;
  const mask = grow(bufs, 'icon', Uint8Array, n).subarray(0, n);
  const stack = grow(bufs, 'stack', Int32Array, n);
  mask.fill(0);
  const tol = blob.tolerance ?? 40;
  const ok = (i) => rgba[i * 4 + 3] >= 128 && within(rgba, i * 4, blob.color, tol) >= 0;
  const r = Number(blob.count) > 0 ? Math.sqrt(blob.count / Math.PI) * 1.5 + 2 : 8;
  const cx = blob.px, cy = blob.py;
  let top = 0, found = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
      const i = y * w + x;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r && ok(i)) { mask[i] = 1; stack[top++] = i; }
    }
  }
  while (top) {
    const i = stack[--top];
    const x = i % w, y = (i - x) / w;
    found++;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x > 0 && !mask[i - 1] && ok(i - 1)) { mask[i - 1] = 1; stack[top++] = i - 1; }
    if (x < w - 1 && !mask[i + 1] && ok(i + 1)) { mask[i + 1] = 1; stack[top++] = i + 1; }
    if (y > 0 && !mask[i - w] && ok(i - w)) { mask[i - w] = 1; stack[top++] = i - w; }
    if (y < h - 1 && !mask[i + w] && ok(i + w)) { mask[i + w] = 1; stack[top++] = i + w; }
  }
  if (!found) return null;
  const d = Math.max(0, Math.round(dilate || 0));
  if (d) {
    // square dilation, separable: rows into tmp, then columns back into the mask (bounding box only)
    const tmp = grow(bufs, 'tmp', Uint8Array, n);
    const bx0 = Math.max(0, x0 - d), bx1 = Math.min(w - 1, x1 + d), by0 = Math.max(0, y0 - d), by1 = Math.min(h - 1, y1 + d);
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        let v = 0;
        for (let t = Math.max(0, x - d); t <= Math.min(w - 1, x + d) && !v; t++) v = mask[y * w + t];
        tmp[y * w + x] = v;
      }
    }
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        let v = 0;
        for (let t = Math.max(by0, y - d); t <= Math.min(by1, y + d) && !v; t++) v = tmp[t * w + x];
        mask[y * w + x] = v;
      }
    }
  }
  return mask;
}

// The map picture as it is drawn on the lawn. rgba: w x h pixels; opts:
//   bg / mowed / nomow: { color: [r, g, b], tolerance } (each optional; a pixel matching several
//     goes to the nearest), iconBlob: { px, py, count, color, tolerance } (working pixels) to hide,
//   dilate: px around the icon, zoneMask: Uint8Array (1 = inside) or null.
// Background -> transparent, mowed -> light translucent, no-mow -> dark hatched, icon and outside the
// zone -> transparent, the rest unchanged. No options: a plain copy (no keying).
// bufs: an object whose typed arrays are reused between calls (grown as needed).
// -> { data (w*h*4), mowedMask (w*h, 1 = mowed), mowed, background, zone (pixel counts) }
export function processMap(rgba, w, h, opts = {}, bufs = {}) {
  const n = w * h;
  const out = grow(bufs, 'out', Uint8ClampedArray, n * 4).subarray(0, n * 4);
  const mowedMask = grow(bufs, 'mowed', Uint8Array, n).subarray(0, n);
  mowedMask.fill(0);
  const cls = [];
  for (const [kind, c] of [['bg', opts.bg], ['mowed', opts.mowed], ['nomow', opts.nomow]]) {
    if (c && Array.isArray(c.color)) cls.push({ kind, color: c.color, tol: c.tolerance ?? 30 });
  }
  const icon = opts.iconBlob && Array.isArray(opts.iconBlob.color) ? iconMask(rgba, w, h, opts.iconBlob, opts.dilate ?? 3, bufs) : null;
  const zone = opts.zoneMask || null;
  let mowed = 0, background = 0, zoneCount = 0;
  for (let i = 0, k = 0, y = 0, x = 0; i < n; i++, k += 4) {
    if (zone && !zone[i]) {
      out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0;
    } else {
      if (zone) zoneCount++;
      let kind = null, best = 256;
      for (const c of cls) {
        const d = within(rgba, k, c.color, c.tol);
        if (d >= 0 && d < best) { best = d; kind = c.kind; }
      }
      if (rgba[k + 3] < 128) kind = null;
      if (kind === 'mowed') { mowed++; mowedMask[i] = 1; }
      else if (kind === 'bg') background++;
      if (icon && icon[i]) {
        out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0;
      } else if (kind === 'bg') {
        out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0;
      } else if (kind === 'mowed') {
        out[k] = (rgba[k] + 255) >> 1;
        out[k + 1] = (rgba[k + 1] + 255) >> 1;
        out[k + 2] = (rgba[k + 2] + 255) >> 1;
        out[k + 3] = Math.min(rgba[k + 3], MOWED_ALPHA);
      } else if (kind === 'nomow') {
        out[k] = out[k + 1] = out[k + 2] = NOMOW_RGB;
        out[k + 3] = (x + y) % 8 < 3 ? NOMOW_LINE_ALPHA : NOMOW_GAP_ALPHA;
      } else {
        out[k] = rgba[k];
        out[k + 1] = rgba[k + 1];
        out[k + 2] = rgba[k + 2];
        out[k + 3] = rgba[k + 3];
      }
    }
    if (++x === w) { x = 0; y++; }
  }
  return { data: out, mowedMask, mowed, background, zone: zoneCount };
}

// Polygon [[px, py], ...] (pixel coordinates, continuous) -> mask of the pixels whose centres lie
// inside (even-odd). out: optional reused Uint8Array. -> { mask, count }
export function zoneMask(points, w, h, out = null) {
  const n = w * h;
  const mask = out && out.length >= n ? out.subarray(0, n) : new Uint8Array(n);
  mask.fill(0);
  let count = 0;
  const xs = [];
  const m = points.length;
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let a = 0, b = m - 1; a < m; b = a++) {
      const [xa, ya] = points[a], [xb, yb] = points[b];
      if ((ya <= yc) !== (yb <= yc)) xs.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5)), to = Math.min(w, Math.ceil(xs[k + 1] - 0.5));
      for (let x = from; x < to; x++) { mask[y * w + x] = 1; count++; }
    }
  }
  return { mask, count };
}

// Plan polygon -> working pixel polygon of an imgW x imgH map drawn at w x h through the overlay.
export function zonePixels(polygon, overlay, imgW, imgH, w, h) {
  const sx = w / imgW, sy = h / imgH;
  return polygon.map(([x, y]) => {
    const q = planToPixel(x, y, imgW, imgH, overlay);
    return [q.px * sx, q.py * sy];
  });
}

// Dominant direction of the mowed stripes: structure tensor of Sobel gradients on the mask
// downscaled to <= 256 px (block means). Gradients run across the stripes, so the stripes lie 90°
// from the dominant gradient. -> { angle (degrees 0..180, counter-clockwise from image right, image
// up), coherence (0..1) } or null (no mowed pixels, or no clear direction).
export function stripeAngle(mask, w, h, minCoherence = 0.3) {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 256));
  const gw = Math.floor(w / f), gh = Math.floor(h / f);
  if (gw < 3 || gh < 3) return null;
  const g = new Float32Array(gw * gh);
  for (let y = 0; y < gh * f; y++) {
    const row = y * w, gy = ((y / f) | 0) * gw;
    for (let x = 0; x < gw * f; x++) if (mask[row + x]) g[gy + ((x / f) | 0)] += 1;
  }
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      const tl = g[i - gw - 1], tc = g[i - gw], tr = g[i - gw + 1];
      const ml = g[i - 1], mr = g[i + 1];
      const bl = g[i + gw - 1], bc = g[i + gw], br = g[i + gw + 1];
      const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
      const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
      sxx += gx * gx;
      syy += gy * gy;
      sxy += gx * gy;
    }
  }
  const energy = sxx + syy;
  if (!(energy > 0)) return null;
  const coherence = Math.hypot(sxx - syy, 2 * sxy) / energy;
  if (coherence < minCoherence) return null;
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy); // gradient direction, image y down
  const deg = (-(phi + Math.PI / 2) * 180) / Math.PI; // stripes, image y up
  return { angle: ((deg % 180) + 180) % 180, coherence };
}

const AXES = ['N–S', 'NE–SW', 'E–W', 'SE–NW'];

// Stripe angle on the image (stripeAngle) -> compass axis on the plan through the overlay rotation
// (degrees counter-clockwise). -> { bearing: 0..179 (clockwise from north), label }
export function stripeBearing(angle, rotation = 0) {
  const plan = angle + (Number(rotation) || 0);
  const b = ((Math.round(90 - plan) % 180) + 180) % 180;
  return { bearing: b, label: AXES[Math.round(b / 45) % 4] };
}

// Share of the lawn mowed: mowed / zone pixels when clipped to a zone, else mowed / (mowed +
// background). -> 0..1 or null (nothing to compare with)
export function mowedShare({ mowed, background, zone, zoned }) {
  const total = zoned ? zone : mowed + background;
  return total > 0 ? Math.min(1, mowed / total) : null;
}

// ---------- browser: load an image URL into pixels (one reused canvas) ----------
let canvas = null;

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob); // decoded off the main thread
      return { src: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch { /* e.g. SVG: fall back to an <img> */ }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { src: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

export const FETCH_TIMEOUT_MS = 8000;

// Pixels of a decoded image (ImageBitmap / <img> / canvas) on the reused, downscaled canvas.
// -> { data, width, height, imgW, imgH }
export function imagePixels(src, width, height) {
  if (!width || !height) throw new Error('empty image');
  const s = imageScale(width);
  const cw = Math.max(1, Math.round(width * s)), chh = Math.max(1, Math.round(height * s));
  if (!canvas) canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(cw, chh) : document.createElement('canvas');
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== chh) canvas.height = chh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, cw, chh);
  ctx.drawImage(src, 0, 0, cw, chh);
  const data = ctx.getImageData(0, 0, cw, chh).data;
  return { data, width: cw, height: chh, imgW: width, imgH: height };
}

// { data, width, height } of the sampled canvas plus the real image size (imgW, imgH).
// Throws when the image cannot be fetched (8 s timeout) or read (e.g. another origin).
export async function readImagePixels(url) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  let blob;
  try {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } finally {
    clearTimeout(timer);
  }
  const img = await decode(blob);
  try {
    return imagePixels(img.src, img.width, img.height);
  } finally {
    img.done();
  }
}

// ---------- browser: the processed map (reused canvases, buffers and zone mask) ----------
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}

export class MapProcessor {
  constructor() {
    this.bufs = {};
    this.work = null; // the decoded image at working size (read back)
    this.canvas = null; // the processed picture (texture source)
    this._out = null; // ImageData of this.canvas
    this._zone = { key: null, mask: null, count: 0 };
  }

  // src: decoded image (imgW x imgH). opts: { bg, mowed, nomow ({ color, tolerance }), iconBlob
  // ({ px, py, count } in image pixels + color, tolerance), dilate, zone (plan polygon) and overlay
  // (alignment, for the zone) }. -> { canvas, width, height, mowed, background, zone, zoned, angle }
  run(src, imgW, imgH, opts = {}) {
    const { width: w, height: h } = mapWorkSize(imgW, imgH);
    if (!this.work) this.work = makeCanvas(w, h);
    if (this.work.width !== w) this.work.width = w;
    if (this.work.height !== h) this.work.height = h;
    const wctx = this.work.getContext('2d', { willReadFrequently: true });
    wctx.clearRect(0, 0, w, h);
    wctx.drawImage(src, 0, 0, w, h);
    const rgba = wctx.getImageData(0, 0, w, h).data;
    let zoneMaskArr = null;
    if (opts.zone && opts.overlay) {
      const o = opts.overlay;
      const key = [JSON.stringify(opts.zone), o.x, o.y, o.rotation, o.width, w, h, imgW, imgH].join('|');
      if (key !== this._zone.key) {
        const z = zoneMask(zonePixels(opts.zone, o, imgW, imgH, w, h), w, h, this._zone.mask);
        this._zone = { key, mask: z.mask, count: z.count };
      }
      zoneMaskArr = this._zone.mask;
    }
    const sx = w / imgW;
    const b = opts.iconBlob;
    const iconBlob = b ? { ...b, px: b.px * sx, py: b.py * sx, count: b.count == null ? null : b.count * sx * sx } : null;
    const r = processMap(rgba, w, h, { bg: opts.bg, mowed: opts.mowed, nomow: opts.nomow, iconBlob, dilate: opts.dilate ?? 3, zoneMask: zoneMaskArr }, this.bufs);
    if (!this.canvas) this.canvas = makeCanvas(w, h);
    if (this.canvas.width !== w || this.canvas.height !== h || !this._out || this._out.width !== w || this._out.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._out = new ImageData(w, h);
    }
    this._out.data.set(r.data);
    this.canvas.getContext('2d', { willReadFrequently: true }).putImageData(this._out, 0, 0); // CPU-side: it is uploaded, not drawn
    const s = opts.mowed ? stripeAngle(r.mowedMask, w, h) : null;
    return { canvas: this.canvas, width: w, height: h, mowed: r.mowed, background: r.background, zone: r.zone, zoned: !!zoneMaskArr, angle: s ? s.angle : null };
  }
}
