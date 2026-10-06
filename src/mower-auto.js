// Auto mode: compare the live map with the static map of the same lawn (pure, no DOM).
// The static map has the lawn (green), no-mow areas (grey), the boundary and a dark background; the
// live map adds mowed stripes (lighter green), the mower icon and the dock icon. Pixels that did not
// change are drawn transparent; mowed stripes light; no-mow shaded; icons hidden.
import { headingKernel } from './mower-heading.js';
import { mapKernel, registerAuto } from './mower-image.js';
import { tileKernel } from './mower-track.js';

export const CLS = { SAME: 0, MOWED: 1, NOMOW: 2, ICON: 3 };

// Self-contained apart from its arguments (the heading, map and tile kernels), so the map worker runs
// the very same code: H = headingKernel(), M = mapKernel(), T = tileKernel().
export function autoKernel(H, M, T) {
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

  // Classify the pixels of rect (all of the picture when null) into cls / mowedMask and the RGBA to
  // draw (data; null: classes only). Arrays are full-size (w x h); only rect is written.
  // -> { mowed, lawn (incl. no-mow), nomow, icon } counts of rect
  function classify(stat, live, w, h, shift, rect, cls, mowedMask, data, opts = {}) {
    const same = opts.same ?? 26, gain = opts.gain ?? 14;
    const x0 = rect ? rect.x0 : 0, y0 = rect ? rect.y0 : 0, x1 = rect ? rect.x1 : w, y1 = rect ? rect.y1 : h;
    const dx = shift ? shift.dx : 0, dy = shift ? shift.dy : 0;
    let mowed = 0, lawn = 0, nomow = 0, icon = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * w + x0; x < x1; x++, i++) {
        const k = i * 4;
        const sx = x - dx, sy = y - dy;
        const inS = sx >= 0 && sy >= 0 && sx < w && sy < h;
        const ks = inS ? (sy * w + sx) * 4 : k;
        const sr = inS ? stat[ks] : live[k], sg = inS ? stat[ks + 1] : live[k + 1], sb = inS ? stat[ks + 2] : live[k + 2];
        const lr = live[k], lg = live[k + 1], lb = live[k + 2];
        const lawnPx = isLawn(sr, sg, sb), greyPx = !lawnPx && isGrey(sr, sg, sb);
        if (lawnPx) lawn++;
        const d = Math.max(Math.abs(lr - sr), Math.abs(lg - sg), Math.abs(lb - sb));
        mowedMask[i] = 0;
        if (greyPx && d <= same * 2) { // no-mow: shaded
          cls[i] = CL.NOMOW;
          nomow++;
          if (data) {
            data[k] = data[k + 1] = data[k + 2] = NOMOW_RGB;
            data[k + 3] = (x + y) % 8 < 3 ? NOMOW_LINE_ALPHA : NOMOW_GAP_ALPHA;
          }
        } else if (d <= same) {
          cls[i] = CL.SAME; // transparent
          if (data) data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 0;
        } else if (lawnPx && isLawn(lr, lg, lb) && lum(lr, lg, lb) >= lum(sr, sg, sb) + gain) {
          cls[i] = CL.MOWED;
          mowedMask[i] = 1;
          mowed++;
          if (data) {
            data[k] = (lr + 255) >> 1;
            data[k + 1] = (lg + 255) >> 1;
            data[k + 2] = (lb + 255) >> 1;
            data[k + 3] = MOWED_ALPHA;
          }
        } else {
          cls[i] = CL.ICON; // icons: hidden (the 3D mower stands there)
          icon++;
          if (data) data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 0;
        }
      }
    }
    return { mowed, lawn, nomow, icon };
  }

  // stat, live: RGBA of the same size (w x h); shift: { dx, dy } of the live map against the static
  // one. opts: { same, gain, minBlob, maxBlob (px; larger changed areas are no icon) }.
  // -> { cls, mowedMask, data (RGBA to draw), mowed, lawn, nomow, icon, changed (icon share of the
  //      picture), mismatch (changed > 30 %: the maps do not match; no blobs then), label (Int32Array,
  //      blob index + 1 per pixel), blobs: [{ id, px, py, count, grey, idx, x0, y0, x1, y1 }] }
  function compareMaps(stat, live, w, h, shift = { dx: 0, dy: 0 }, opts = {}) {
    const minBlob = opts.minBlob ?? 6;
    const n = w * h;
    const cls = new Uint8Array(n), mowedMask = new Uint8Array(n), data = new Uint8ClampedArray(n * 4);
    const { mowed, lawn, nomow, icon } = classify(stat, live, w, h, shift, null, cls, mowedMask, data, opts);
    const changed = n ? icon / n : 0;
    const mismatch = changed > MISMATCH_SHARE;
    const label = new Int32Array(n);
    const blobs = mismatch ? [] : iconBlobs(cls, live, w, h, minBlob, opts.maxBlob ?? Math.max(400, n * 0.02), label);
    return { cls, mowedMask, data, mowed, lawn: Math.max(0, lawn - nomow), nomow, icon, changed, mismatch, label, blobs };
  }

  // Connected icon pixels (8-connected, so thin outlines hold together); thin slivers (anti-aliased
  // edges) and areas larger than maxBlob are no icons. label: filled with blob id (index + 1).
  // rect: only these pixels (a search window; label cleared there), else the whole picture.
  function iconBlobs(cls, live, w, h, minBlob = 6, maxBlob = Infinity, label = null, rect = null) {
    const rx0 = rect ? rect.x0 : 0, ry0 = rect ? rect.y0 : 0, rx1 = rect ? rect.x1 : w, ry1 = rect ? rect.y1 : h;
    const rw = rx1 - rx0, rh = ry1 - ry0;
    const seen = new Uint8Array(rw * rh), out = [];
    const at = (x, y) => (y - ry0) * rw + (x - rx0);
    if (label) for (let y = ry0; y < ry1; y++) label.fill(0, y * w + rx0, y * w + rx1);
    const stack = [];
    for (let yy = ry0; yy < ry1; yy++) for (let xx = rx0; xx < rx1; xx++) {
      const s = yy * w + xx;
      if (cls[s] !== CL.ICON || seen[at(xx, yy)]) continue;
      const idx = [];
      stack.push(s);
      seen[at(xx, yy)] = 1;
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
          if (nx < rx0 || ny < ry0 || nx >= rx1 || ny >= ry1) continue;
          const j = ny * w + nx;
          if (cls[j] === CL.ICON && !seen[at(nx, ny)]) { seen[at(nx, ny)] = 1; stack.push(j); }
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
  // prevGrey, dockAt, cache, leaving }. leaving (just undocked, still over the dock icon): the dock blob
  // stays a candidate, matched around the last position at the expected size (the merged blob is
  // larger than the mower). -> { b, m } | null (m: matchTemplate result, m.score >= 0.5)
  function pickMower(blobs, gray, w, h, t, label, ctx = {}) {
    if (!t || !blobs.length) return null;
    const prev = ctx.prev || null, exp = ctx.expected || null;
    const dockOf = (b) => isDock(b, ctx.prevGrey, ctx.dockAt);
    let cand = ctx.leaving ? blobs.slice() : blobs.filter((b) => !dockOf(b));
    if (exp) cand = cand.filter((b) => b.count >= exp / 4 && (b.count <= exp * 4 || (ctx.leaving && dockOf(b))));
    const dist = (b) => (prev ? Math.hypot(b.px - prev[0], b.py - prev[1]) : 0);
    const plaus = (b) => (exp ? Math.abs(Math.log(b.count / exp)) : 0) + (prev ? dist(b) / Math.max(10, Math.sqrt(b.count) * 4) : 0);
    cand = cand.slice().sort((a, b) => plaus(a) - plaus(b) || b.count - a.count).slice(0, 3);
    let best = null;
    for (const b of cand) {
      // the mower over the dock icon: one blob larger than the mower, the last position inside it
      const merged = ctx.leaving && prev && (dockOf(b) || (exp && b.count > exp * 1.5)) && prev[0] >= b.x0 - 2 && prev[0] <= b.x1 + 3 && prev[1] >= b.y0 - 2 && prev[1] <= b.y1 + 3;
      const cx = merged ? prev[0] : b.px, cy = merged ? prev[1] : b.py;
      const count = merged && exp ? Math.min(exp, b.count) : b.count;
      const m = H.matchTemplate(gray, w, h, t, cx, cy, { scale: Math.sqrt(count / t.count), radius: merged ? 6 : 3, cache: ctx.cache, label, id: b.id, count });
      if (!m || m.score < MATCH_MIN) continue;
      if (!best || m.score > best.m.score + TIE || (Math.abs(m.score - best.m.score) <= TIE && dist(b) < dist(best.b))) best = { b, m };
    }
    return best;
  }

  // Grey values of rect (grown by pad) into g (full size, w x h). -> g
  function grayInto(live, w, h, rect, pad, g) {
    const x0 = Math.max(0, rect.x0 - pad), y0 = Math.max(0, rect.y0 - pad), x1 = Math.min(w, rect.x1 + pad), y1 = Math.min(h, rect.y1 + pad);
    for (let y = y0; y < y1; y++) for (let x = x0, i = y * w + x0, k = i * 4; x < x1; x++, i++, k += 4) g[i] = 0.299 * live[k] + 0.587 * live[k + 1] + 0.114 * live[k + 2];
    return g;
  }

  // The mower among the icon blobs of cls (rect: the search window, else the whole picture): its
  // picture match, else (no picture) the blob nearest the last position / the largest that is not the
  // dock; with a picture that matched nothing, only a blob near the last position (never some other
  // changed area). -> { pose: { px, py, count, angle | null, source, score } | null, b, blobs }
  function findMower(live, w, h, cls, label, gray, rect, ctx) {
    const blobs = iconBlobs(cls, live, w, h, ctx.minBlob ?? 6, ctx.maxBlob ?? Math.max(400, w * h * 0.02), label, rect);
    const t = ctx.template || null;
    const pick = t ? pickMower(blobs, gray, w, h, t, label, ctx) : null;
    let b = pick && pick.b, pose = null;
    if (pick) pose = { px: pick.m.x, py: pick.m.y, count: ctx.leaving && ctx.expected && b.count > ctx.expected * 1.5 ? ctx.expected : b.count, angle: pick.m.angle, source: 'picture', score: pick.m.score };
    else if (!ctx.leaving) {
      const prev = ctx.prev;
      const rest = blobs.filter((x) => !isDock(x, ctx.prevGrey, ctx.dockAt) && (!ctx.expected || x.count <= ctx.expected * 4));
      const near = prev && rest.length ? rest.reduce((a, c) => (Math.hypot(c.px - prev[0], c.py - prev[1]) < Math.hypot(a.px - prev[0], a.py - prev[1]) ? c : a)) : null;
      const nearOk = near && Math.hypot(near.px - prev[0], near.py - prev[1]) < 40 ? near : null;
      b = t ? nearOk : nearOk || rest.find((x) => !x.grey) || rest.find((x) => x !== blobs.find((y) => y.grey)) || null;
      if (b) {
        const pts = [];
        for (const i of b.idx) pts.push([(i % w) + 0.5, Math.floor(i / w) + 0.5]);
        const mo = H.momentsOf(pts), hd = H.momentHeading(mo);
        pose = { px: mo.cx, py: mo.cy, count: b.count, angle: hd ? hd.angle : null, source: hd ? 'icon' : null, score: null };
      }
    }
    return { pose, b: pose ? b : null, blobs };
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
    const gray = ctx.template ? H.grayOf(live, w, h) : null;
    const f = findMower(live, w, h, r.cls, r.label, gray, null, ctx);
    out.pose = f.pose;
    // grey blobs other than the mower: next time a still one is the dock (a parked mower is not)
    out.grey = f.blobs.filter((x) => x !== f.b && x.grey).map((x) => [x.px, x.py]);
    const dock = f.blobs.find((x) => x !== f.b && x.grey);
    out.dock = dock ? [dock.px, dock.py] : null;
    return out;
  }

  // ---------- per refresh, with state kept between refreshes (the map worker's) ----------
  function frameState() {
    return { w: 0, h: 0, cls: null, mowedMask: null, data: null, tc: null, hashes: null, detHashes: null, mismatch: false, share: null, angle: null,
      dcls: null, dmask: null, label: null, gray: null, lastDet: null };
  }

  // One refresh of the live map. S: frameState() (kept). ctx: findMower's ctx + { shift, detect, layer
  // (recompute the drawn layer's changed tiles), window ({ x0, y0, x1, y1 } search window) | null, full
  // (search the whole picture) }.
  // -> { same (nothing changed since the last detection: its result again), full (searched all), pose,
  //      grey, dock (undefined: not looked at), mismatch, share, angle, changed (share of tiles redrawn),
  //      patches: { rects: [[x0, y0, x1, y1]], data (their RGBA, one after the other) } | null }
  function framePass(stat, live, w, h, ctx, S) {
    const n = w * h;
    if (S.w !== w || S.h !== h || S.shiftKey !== `${ctx.shift ? ctx.shift.dx : 0},${ctx.shift ? ctx.shift.dy : 0}` || S.statKey !== ctx.statKey) {
      Object.assign(S, frameState(), { w, h, cls: new Uint8Array(n), mowedMask: new Uint8Array(n), data: new Uint8ClampedArray(n * 4),
        dcls: new Uint8Array(n), dmask: new Uint8Array(n), label: new Int32Array(n), gray: new Float32Array(n),
        shiftKey: `${ctx.shift ? ctx.shift.dx : 0},${ctx.shift ? ctx.shift.dy : 0}`, statKey: ctx.statKey });
      S.tc = new Int32Array(T.tilesOf(w, h).cols * T.tilesOf(w, h).rows * 4);
    }
    const hs = T.tileHashes(live, w, h);
    const out = { same: false, full: false, pose: null, grey: undefined, dock: undefined, mismatch: S.mismatch, share: S.share, angle: S.angle, changed: 0, patches: null };
    if (ctx.layer || !S.hashes) {
      const changed = T.changedTiles(S.hashes, hs);
      for (const i of changed) {
        const c = classify(stat, live, w, h, ctx.shift, T.tileRect(i, w, h), S.cls, S.mowedMask, S.data);
        S.tc.set([c.mowed, c.lawn, c.nomow, c.icon], i * 4);
      }
      S.hashes = hs;
      let mowed = 0, lawn = 0, nomow = 0, icon = 0;
      for (let i = 0; i < S.tc.length; i += 4) { mowed += S.tc[i]; lawn += S.tc[i + 1]; nomow += S.tc[i + 2]; icon += S.tc[i + 3]; }
      S.mismatch = n ? icon / n > MISMATCH_SHARE : false;
      const l = Math.max(0, lawn - nomow);
      S.share = l > 0 ? Math.min(1, mowed / l) : null;
      if (changed.length) {
        const sa = mowed ? M.stripeAngle(S.mowedMask, w, h) : null;
        S.angle = sa ? sa.angle : null;
        const tiles = changed.length > hs.length / 2 ? [{ x0: 0, y0: 0, x1: w, y1: h }] : changed.map((i) => T.tileRect(i, w, h));
        let size = 0;
        for (const r of tiles) size += (r.x1 - r.x0) * (r.y1 - r.y0) * 4;
        const data = new Uint8ClampedArray(size);
        let o = 0;
        for (const r of tiles) for (let y = r.y0; y < r.y1; y++) {
          data.set(S.data.subarray((y * w + r.x0) * 4, (y * w + r.x1) * 4), o);
          o += (r.x1 - r.x0) * 4;
        }
        out.patches = { rects: tiles.map((r) => [r.x0, r.y0, r.x1, r.y1]), data };
      }
      out.changed = hs.length ? changed.length / hs.length : 0;
      out.mismatch = S.mismatch;
      out.share = S.share;
      out.angle = S.angle;
    }
    if (out.mismatch || !ctx.detect) return out;
    // the same picture as at the last detection: the same answer (unless a full search is asked for)
    if (!ctx.full && S.lastDet && S.detHashes && T.changedTiles(S.detHashes, hs).length === 0) {
      return Object.assign(out, { same: true, pose: S.lastDet.pose, full: false });
    }
    const t = ctx.template || null;
    const run = (rect) => {
      const r = rect || { x0: 0, y0: 0, x1: w, y1: h };
      const c = classify(stat, live, w, h, ctx.shift, r, S.dcls, S.dmask, null);
      if (!rect && n && c.icon / n > MISMATCH_SHARE) return { mismatch: true };
      if (t) grayInto(live, w, h, r, Math.ceil(Math.sqrt(ctx.expected || t.count) * 2), S.gray);
      return findMower(live, w, h, S.dcls, S.label, t ? S.gray : null, rect, ctx);
    };
    let f = !ctx.full && ctx.window ? run(ctx.window) : null;
    // a window only answers with a picture match (a cut-off icon at its edge is no answer): else all of it
    const cut = (b, r) => !!b && ((b.x0 <= r.x0 && r.x0 > 0) || (b.y0 <= r.y0 && r.y0 > 0) || (b.x1 >= r.x1 - 1 && r.x1 < w) || (b.y1 >= r.y1 - 1 && r.y1 < h));
    if (!f || !f.pose || (t && f.pose.source !== 'picture') || cut(f.b, ctx.window)) { f = run(null); out.full = true; }
    if (f.mismatch) { S.mismatch = true; out.mismatch = true; return out; }
    out.pose = f.pose;
    if (out.full) {
      out.grey = f.blobs.filter((x) => x !== f.b && x.grey).map((x) => [x.px, x.py]);
      const dock = f.blobs.find((x) => x !== f.b && x.grey);
      out.dock = dock ? [dock.px, dock.py] : null;
    }
    S.detHashes = hs;
    S.lastDet = { pose: out.pose };
    return out;
  }

  return { lum, isLawn, isGrey, downGray, bestShift, classify, compareMaps, iconBlobs, autoShare, isDock, pickMower, findMower, autoProcess, frameState, framePass };
}

const AK = autoKernel(headingKernel(), mapKernel(), tileKernel());
registerAuto({
  source: `const H = (${headingKernel.toString()})();\nconst T = (${tileKernel.toString()})();\nconst A = (${autoKernel.toString()})(H, K, T);`,
  run: AK.autoProcess, frame: AK.framePass, frameState: AK.frameState, bestShift: AK.bestShift, downGray: AK.downGray,
});
export const { lum, isLawn, isGrey, downGray, bestShift, classify, compareMaps, iconBlobs, autoShare, isDock, pickMower, findMower, autoProcess, frameState, framePass } = AK;

// The dock: the largest mostly-grey blob that is not the mower. blobs: compareMaps().blobs
export function dockBlob(blobs, exclude = null) {
  return (blobs || []).find((b) => b !== exclude && b.grey) || null;
}
