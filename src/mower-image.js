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
