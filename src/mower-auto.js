// Auto mode: compare the live map with the static map of the same lawn (pure, no DOM).
// The static map has the lawn (green), no-mow areas (grey), the boundary and a dark background; the
// live map adds mowed stripes (lighter green), the mower icon and the dock icon. Pixels that did not
// change are drawn transparent; mowed stripes light; no-mow shaded; icons hidden.
import { headingKernel } from './mower-heading.js';
import { mapKernel, registerAuto } from './mower-image.js';

export const CLS = { SAME: 0, MOWED: 1, NOMOW: 2, ICON: 3 };

// Self-contained apart from its two arguments (the heading and map kernels), so the map worker runs
// the very same code: H = headingKernel(), M = mapKernel().
export function autoKernel(H, M) {
  const CL = { SAME: 0, MOWED: 1, NOMOW: 2, ICON: 3 };
  const MOWED_ALPHA = 64, NOMOW_RGB = 24, NOMOW_LINE_ALPHA = 200, NOMOW_GAP_ALPHA = 90;
  const MISMATCH_SHARE = 0.3; // changed (non-lawn) share above which the static map does not match
  const MATCH_MIN = 0.5;
  const TIE = 0.05;

  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const isLawn = (r, g, b) => g > r + 12 && g > b + 12 && g > 45;
  function isGrey(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx - mn <= 22 && mx >= 85 && mx <= 225;
  }

  // Grey copy downscaled by f (block means).
  function downGray(rgba, w, h, f) {
    const gw = Math.max(1, Math.floor(w / f)), gh = Math.max(1, Math.floor(h / f));
    const out = new Float32Array(gw * gh);
    for (let y = 0; y < gh * f; y++) for (let x = 0; x < gw * f; x++) {
      const k = (y * w + x) * 4;
      out[Math.floor(y / f) * gw + Math.floor(x / f)] += lum(rgba[k], rgba[k + 1], rgba[k + 2]);
    }
    for (let i = 0; i < out.length; i++) out[i] /= f * f;
    return { g: out, w: gw, h: gh };
  }

  // Translation of b against a (grey, same size) within ±max px by the smallest mean absolute
  // difference. -> { dx, dy } (b(x + dx, y + dy) matches a(x, y))
  function bestShift(a, b, w, h, max = 4) {
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

  // stat, live: RGBA of the same size (w x h); shift: { dx, dy } of the live map against the static
  // one. opts: { same, gain, minBlob, maxBlob (px; larger changed areas are no icon) }.
  // -> { cls, mowedMask, data (RGBA to draw), mowed, lawn, nomow, icon, changed (icon share of the
  //      picture), mismatch (changed > 30 %: the maps do not match; no blobs then), label (Int32Array,
  //      blob index + 1 per pixel), blobs: [{ id, px, py, count, grey, idx, x0, y0, x1, y1 }] }
  function compareMaps(stat, live, w, h, shift = { dx: 0, dy: 0 }, opts = {}) {
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
          cls[i] = CL.NOMOW;
          nomow++;
          data[k] = data[k + 1] = data[k + 2] = NOMOW_RGB;
          data[k + 3] = (x + y) % 8 < 3 ? NOMOW_LINE_ALPHA : NOMOW_GAP_ALPHA;
        } else if (d <= same) {
          cls[i] = CL.SAME; // transparent
        } else if (lawnPx && isLawn(lr, lg, lb) && lum(lr, lg, lb) >= lum(sr, sg, sb) + gain) {
          cls[i] = CL.MOWED;
          mowedMask[i] = 1;
          mowed++;
          data[k] = (lr + 255) >> 1;
          data[k + 1] = (lg + 255) >> 1;
          data[k + 2] = (lb + 255) >> 1;
          data[k + 3] = MOWED_ALPHA;
        } else {
          cls[i] = CL.ICON; // icons: hidden (the 3D mower stands there)
          icon++;
        }
      }
    }
    const changed = n ? icon / n : 0;
    const mismatch = changed > MISMATCH_SHARE;
    const label = new Int32Array(n);
    const blobs = mismatch ? [] : iconBlobs(cls, live, w, h, minBlob, opts.maxBlob ?? Math.max(400, n * 0.02), label);
    return { cls, mowedMask, data, mowed, lawn: Math.max(0, lawn - nomow), nomow, icon, changed, mismatch, label, blobs };
  }

  // Connected icon pixels (8-connected, so thin outlines hold together); thin slivers (anti-aliased
  // edges) and areas larger than maxBlob are no icons. label: filled with blob id (index + 1).
  function iconBlobs(cls, live, w, h, minBlob = 6, maxBlob = Infinity, label = null) {
    const seen = new Uint8Array(w * h), out = [];
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (cls[s] !== CL.ICON || seen[s]) continue;
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
          if (cls[j] === CL.ICON && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      if (idx.length < minBlob || idx.length > maxBlob || x1 - x0 < 3 || y1 - y0 < 3) continue;
      out.push({ px: sx / idx.length + 0.5, py: sy / idx.length + 0.5, count: idx.length, grey: grey / idx.length > 0.6, idx: Int32Array.from(idx), x0, y0, x1, y1 });
    }
    out.sort((a, b) => b.count - a.count);
    out.forEach((b, i) => {
      b.id = i + 1;
      if (label) for (const j of b.idx) label[j] = b.id;
    });
    return out;
  }

  const autoShare = (r) => (r && r.lawn > 0 ? Math.min(1, r.mowed / r.lawn) : null);

  // The dock: grey, and where a grey blob was last time (it does not move) or at the known dock
  // position. prevGrey: [[px, py], ...] of the last picture's grey blobs; dockAt: [px, py] | null.
  function isDock(b, prevGrey, dockAt) {
    if (!b.grey) return false;
    const r = Math.max(3, Math.sqrt(b.count) * 0.15);
    if (dockAt && Math.hypot(b.px - dockAt[0], b.py - dockAt[1]) <= r * 2) return true;
    return (prevGrey || []).some((p) => Math.hypot(b.px - p[0], b.py - p[1]) <= r);
  }

  // The mower among the blobs: dock dropped, the 3 most plausible (size near the expected icon size,
  // nearest the last position) matched against the picture with the blob coverage; ties (within 0.05)
  // go to the one nearest the last position. ctx: { prev: [px, py] | null, expected (px count) | null,
  // prevGrey, dockAt, cache }. -> { b, m } | null (m: matchTemplate result, m.score >= 0.5)
  function pickMower(blobs, gray, w, h, t, label, ctx = {}) {
    if (!t || !blobs.length) return null;
    const prev = ctx.prev || null, exp = ctx.expected || null;
    let cand = blobs.filter((b) => !isDock(b, ctx.prevGrey, ctx.dockAt));
    if (exp) cand = cand.filter((b) => b.count >= exp / 4 && b.count <= exp * 4);
    const dist = (b) => (prev ? Math.hypot(b.px - prev[0], b.py - prev[1]) : 0);
    const plaus = (b) => (exp ? Math.abs(Math.log(b.count / exp)) : 0) + (prev ? dist(b) / Math.max(10, Math.sqrt(b.count) * 4) : 0);
    cand = cand.slice().sort((a, b) => plaus(a) - plaus(b) || b.count - a.count).slice(0, 3);
    let best = null;
    for (const b of cand) {
      const m = H.matchTemplate(gray, w, h, t, b.px, b.py, { scale: Math.sqrt(b.count / t.count), radius: 3, cache: ctx.cache, label, id: b.id, count: b.count });
      if (!m || m.score < MATCH_MIN) continue;
      if (!best || m.score > best.m.score + TIE || (Math.abs(m.score - best.m.score) <= TIE && dist(b) < dist(best.b))) best = { b, m };
    }
    return best;
  }

  // One auto pass (main thread or worker). ctx: pickMower's ctx + { template, shift, prevBlob }.
  // -> { data, mowed, lawn, nomow, icon, changed, mismatch, share, angle (stripes), grey ([[px, py]]),
  //      pose: { px, py, count, angle | null, source, score } | null, dock: [px, py] | null }
  function autoProcess(stat, live, w, h, ctx = {}) {
    const r = compareMaps(stat, live, w, h, ctx.shift || { dx: 0, dy: 0 }, { maxBlob: ctx.maxBlob });
    const out = { data: r.data, mowed: r.mowed, lawn: r.lawn, nomow: r.nomow, icon: r.icon, changed: r.changed, mismatch: r.mismatch,
      share: autoShare(r), angle: null, grey: [], pose: null, dock: null };
    if (r.mismatch) return out;
    const sa = r.mowed ? M.stripeAngle(r.mowedMask, w, h) : null;
    out.angle = sa ? sa.angle : null;
    if (!ctx.detect) { out.grey = r.blobs.filter((x) => x.grey).map((x) => [x.px, x.py]); return out; }
    const t = ctx.template || null;
    const gray = t ? H.grayOf(live, w, h) : null;
    const pick = t ? pickMower(r.blobs, gray, w, h, t, r.label, ctx) : null;
    let b = pick && pick.b, pose = null;
    if (pick) pose = { px: pick.m.x, py: pick.m.y, count: b.count, angle: pick.m.angle, source: 'picture', score: pick.m.score };
    else {
      // no picture match: the blob nearest the last position, else the largest that is not the dock
      const prev = ctx.prev;
      const rest = r.blobs.filter((x) => !isDock(x, ctx.prevGrey, ctx.dockAt) && (!ctx.expected || x.count <= ctx.expected * 4));
      const near = prev && rest.length ? rest.reduce((a, c) => (Math.hypot(c.px - prev[0], c.py - prev[1]) < Math.hypot(a.px - prev[0], a.py - prev[1]) ? c : a)) : null;
      b = (near && Math.hypot(near.px - prev[0], near.py - prev[1]) < 40 ? near : null) || rest.find((x) => !x.grey) || rest.find((x) => x !== r.blobs.find((y) => y.grey)) || null;
      if (b) {
        const pts = [];
        for (const i of b.idx) pts.push([(i % w) + 0.5, Math.floor(i / w) + 0.5]);
        const mo = H.momentsOf(pts), hd = H.momentHeading(mo);
        pose = { px: mo.cx, py: mo.cy, count: b.count, angle: hd ? hd.angle : null, source: hd ? 'icon' : null, score: null };
      }
    }
    out.pose = pose;
    // grey blobs other than the mower: next time a still one is the dock (a parked mower is not)
    out.grey = r.blobs.filter((x) => x !== b && x.grey).map((x) => [x.px, x.py]);
    const dock = r.blobs.find((x) => x !== b && x.grey);
    out.dock = dock ? [dock.px, dock.py] : null;
    return out;
  }

  return { lum, isLawn, isGrey, downGray, bestShift, compareMaps, iconBlobs, autoShare, isDock, pickMower, autoProcess };
}

const AK = autoKernel(headingKernel(), mapKernel());
registerAuto({ source: `const H = (${headingKernel.toString()})();\nconst A = (${autoKernel.toString()})(H, K);`, run: AK.autoProcess });
export const { lum, isLawn, isGrey, downGray, bestShift, compareMaps, iconBlobs, autoShare, isDock, pickMower, autoProcess } = AK;

// The dock: the largest mostly-grey blob that is not the mower. blobs: compareMaps().blobs
export function dockBlob(blobs, exclude = null) {
  return (blobs || []).find((b) => b !== exclude && b.grey) || null;
}
