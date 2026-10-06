// Auto mode: compare the live map with the static map of the same lawn (pure, no DOM).
// The static map has the lawn (green), no-mow areas (grey), the boundary and a dark background; the
// live map adds mowed stripes (lighter green), the mower icon and the dock icon. Pixels that did not
// change are drawn transparent; mowed stripes light; no-mow shaded; icons hidden.

export const CLS = { SAME: 0, MOWED: 1, NOMOW: 2, ICON: 3 };
const MOWED_ALPHA = 64, NOMOW_RGB = 24, NOMOW_LINE_ALPHA = 200, NOMOW_GAP_ALPHA = 90;

export const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
export const isLawn = (r, g, b) => g > r + 12 && g > b + 12 && g > 45;
export function isGrey(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx - mn <= 22 && mx >= 85 && mx <= 225;
}

// Grey copy downscaled by f (block means).
export function downGray(rgba, w, h, f) {
  const gw = Math.max(1, Math.floor(w / f)), gh = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(gw * gh);
  for (let y = 0; y < gh * f; y++) for (let x = 0; x < gw * f; x++) {
    const k = (y * w + x) * 4;
    out[Math.floor(y / f) * gw + Math.floor(x / f)] += lum(rgba[k], rgba[k + 1], rgba[k + 2]);
  }
  for (let i = 0; i < out.length; i++) out[i] /= f * f;
  return { g: out, w: gw, h: gh };
}

// Translation of b against a (grey, same size) within ±max px by the smallest mean absolute difference.
// -> { dx, dy } (b(x + dx, y + dy) matches a(x, y))
export function bestShift(a, b, w, h, max = 4) {
  let best = { dx: 0, dy: 0, sad: Infinity };
  for (let dy = -max; dy <= max; dy++) for (let dx = -max; dx <= max; dx++) {
    let s = 0, n = 0;
    for (let y = max; y < h - max; y++) for (let x = max; x < w - max; x++) {
      s += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx]);
      n++;
    }
    const sad = n ? s / n : Infinity;
    if (sad < best.sad - 1e-9 || (Math.abs(sad - best.sad) <= 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) best = { dx, dy, sad };
  }
  return { dx: best.dx, dy: best.dy };
}

// stat, live: RGBA of the same size (w x h); shift: { dx, dy } of the live map against the static one
// (live(x + dx, y + dy) ~ stat(x, y)). opts: { same (max channel difference counted as unchanged),
// gain (lighter by at least this on the lawn = mowed), minBlob (px) }.
// -> { cls (Uint8Array, CLS per live pixel), mowedMask, data (RGBA to draw), mowed, lawn, nomow, icon,
//      blobs: [{ px, py, count, grey, idx: Int32Array of pixel indices, x0, y0, x1, y1 }] (largest first) }
export function compareMaps(stat, live, w, h, shift = { dx: 0, dy: 0 }, opts = {}) {
  const same = opts.same ?? 26, gain = opts.gain ?? 14, minBlob = opts.minBlob ?? 6;
  const n = w * h;
  const cls = new Uint8Array(n), mowedMask = new Uint8Array(n), data = new Uint8ClampedArray(n * 4);
  let mowed = 0, lawn = 0, nomow = 0, icon = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const k = i * 4;
      const sx = x - shift.dx, sy = y - shift.dy;
      const inS = sx >= 0 && sy >= 0 && sx < w && sy < h;
      const ks = inS ? (sy * w + sx) * 4 : k;
      const sr = inS ? stat[ks] : live[k], sg = inS ? stat[ks + 1] : live[k + 1], sb = inS ? stat[ks + 2] : live[k + 2];
      const lr = live[k], lg = live[k + 1], lb = live[k + 2];
      const lawnPx = isLawn(sr, sg, sb), greyPx = !lawnPx && isGrey(sr, sg, sb);
      if (lawnPx) lawn++;
      const d = Math.max(Math.abs(lr - sr), Math.abs(lg - sg), Math.abs(lb - sb));
      if (greyPx && d <= same * 2) { // no-mow: shaded
        cls[i] = CLS.NOMOW;
        nomow++;
        data[k] = data[k + 1] = data[k + 2] = NOMOW_RGB;
        data[k + 3] = (x + y) % 8 < 3 ? NOMOW_LINE_ALPHA : NOMOW_GAP_ALPHA;
      } else if (d <= same) {
        cls[i] = CLS.SAME; // transparent
      } else if (lawnPx && isLawn(lr, lg, lb) && lum(lr, lg, lb) >= lum(sr, sg, sb) + gain) {
        cls[i] = CLS.MOWED;
        mowedMask[i] = 1;
        mowed++;
        data[k] = (lr + 255) >> 1;
        data[k + 1] = (lg + 255) >> 1;
        data[k + 2] = (lb + 255) >> 1;
        data[k + 3] = MOWED_ALPHA;
      } else {
        cls[i] = CLS.ICON; // icons: hidden (the 3D mower stands there)
        icon++;
      }
    }
  }
  return { cls, mowedMask, data, mowed, lawn: Math.max(0, lawn - nomow), nomow, icon, blobs: iconBlobs(cls, live, w, h, minBlob) };
}

// Connected icon pixels (8-connected, so thin outlines hold together).
export function iconBlobs(cls, live, w, h, minBlob = 6) {
  const seen = new Uint8Array(w * h), out = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (cls[s] !== CLS.ICON || seen[s]) continue;
    const idx = [];
    stack.push(s);
    seen[s] = 1;
    let sx = 0, sy = 0, grey = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (stack.length) {
      const i = stack.pop();
      idx.push(i);
      const x = i % w, y = (i - x) / w;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (isGrey(live[i * 4], live[i * 4 + 1], live[i * 4 + 2])) grey++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (cls[j] === CLS.ICON && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    // thin slivers (anti-aliased edges of lines and stripes) are not icons
    if (idx.length < minBlob || x1 - x0 < 3 || y1 - y0 < 3) continue;
    out.push({ px: sx / idx.length + 0.5, py: sy / idx.length + 0.5, count: idx.length, grey: grey / idx.length > 0.6, idx: Int32Array.from(idx), x0, y0, x1, y1 });
  }
  return out.sort((a, b) => b.count - a.count);
}

// Mowed share of the lawn (0..1) or null.
export const autoShare = (r) => (r && r.lawn > 0 ? Math.min(1, r.mowed / r.lawn) : null);

// The dock: the largest mostly-grey blob (the mower is matched by its picture). blobs: compareMaps().blobs
export function dockBlob(blobs, exclude = null) {
  return (blobs || []).find((b) => b !== exclude && b.grey) || null;
}
