// Mower position and heading from the icon on the live map (pure, no DOM).
//
// Angles here are degrees counter-clockwise from the image's right with image UP positive (the
// plan convention); image pixel rows grow downwards, so dy = -(y - cy).
//
// 1. Moments: the icon's pixels (its colours, connected to the coarse blob) -> refined centroid,
//    principal axis (second moments), front end by the skewness along it (arrow / teardrop icons
//    are heavier at the back). Round icons -> no heading.
// 2. Template: the product picture of the mower (front = top) matched by normalized cross-correlation
//    over rotations (coarse 10°, then 1°) and a few scales around the icon -> angle and centre.

// Self-contained (no references outside), so the map worker runs the very same code from its source.
export function headingKernel() {
  const D = Math.PI / 180;
    const MIN_COVER = 0.7;
  const norm360 = (a) => ((a % 360) + 360) % 360;

  // ---------- 1. moments ----------
  // Pixels of `colors` (within tol) connected to the matching pixel nearest (cx, cy) inside a window of
  // radius r. -> { n, cx, cy, mu20, mu02, mu11, pts: Float32Array [dx, dy, ...] (dy up) } or null.
  function iconMoments(rgba, w, h, colors, tol, cx, cy, r) {
    const cols = Array.isArray(colors && colors[0]) ? colors : [colors];
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    const ww = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (ww <= 0 || hh <= 0) return null;
    const ok = new Uint8Array(ww * hh);
    let seed = -1, best = Infinity;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = (y * w + x) * 4;
        if (rgba[k + 3] < 128) continue;
        let m = false;
        for (const c of cols) if (Math.abs(rgba[k] - c[0]) <= tol && Math.abs(rgba[k + 1] - c[1]) <= tol && Math.abs(rgba[k + 2] - c[2]) <= tol) { m = true; break; }
        if (!m) continue;
        const i = (y - y0) * ww + (x - x0);
        ok[i] = 1;
        const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        if (d < best) { best = d; seed = i; }
      }
    }
    if (seed < 0) return null;
    const stack = [seed], list = [];
    ok[seed] = 2;
    while (stack.length) {
      const i = stack.pop();
      list.push(i);
      const x = i % ww, y = (i - x) / ww;
      if (x > 0 && ok[i - 1] === 1) { ok[i - 1] = 2; stack.push(i - 1); }
      if (x < ww - 1 && ok[i + 1] === 1) { ok[i + 1] = 2; stack.push(i + 1); }
      if (y > 0 && ok[i - ww] === 1) { ok[i - ww] = 2; stack.push(i - ww); }
      if (y < hh - 1 && ok[i + ww] === 1) { ok[i + ww] = 2; stack.push(i + ww); }
    }
    return momentsOf(list.map((i) => [x0 + (i % ww) + 0.5, y0 + Math.floor(i / ww) + 0.5]));
  }

  // [[x, y], ...] (pixel centres, y down) -> moments (see iconMoments)
  function momentsOf(points) {
    const n = points.length;
    if (!n) return null;
    let sx = 0, sy = 0;
    for (const [x, y] of points) { sx += x; sy += y; }
    const cx = sx / n, cy = sy / n;
    let mu20 = 0, mu02 = 0, mu11 = 0;
    const pts = new Float32Array(n * 2);
    points.forEach(([x, y], i) => {
      const dx = x - cx, dy = cy - y; // dy up
      pts[i * 2] = dx;
      pts[i * 2 + 1] = dy;
      mu20 += dx * dx;
      mu02 += dy * dy;
      mu11 += dx * dy;
    });
    return { n, cx, cy, mu20: mu20 / n, mu02: mu02 / n, mu11: mu11 / n, pts };
  }

  // Heading from moments -> { angle, elong, skew, confidence } or null (round / symmetric icon).
  // Elongated: principal axis, front = the side the skewness points to. Not elongated: the third-order
  // moment vector (where the far-out mass lies) when it is strong enough.
  function momentHeading(m, { minElong = 1.25, minSkew = 0.25, minPixels = 12 } = {}) {
    if (!m || m.n < minPixels) return null;
    const { mu20, mu02, mu11, pts } = m;
    const tr = mu20 + mu02, det = mu20 * mu02 - mu11 * mu11;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
    const elong = Math.sqrt(l1 / l2);
    const sigma = Math.sqrt(Math.max(1e-9, tr / 2));
    // third-order vector: sum r^2 * (dx, dy)
    let vx = 0, vy = 0;
    for (let i = 0; i < pts.length; i += 2) { const dx = pts[i], dy = pts[i + 1], r2 = dx * dx + dy * dy; vx += r2 * dx; vy += r2 * dy; }
    vx /= m.n * sigma ** 3;
    vy /= m.n * sigma ** 3;
    if (elong >= minElong) {
      const th = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
      const ux = Math.cos(th), uy = Math.sin(th);
      let s3 = 0, s2 = 0;
      for (let i = 0; i < pts.length; i += 2) { const p = pts[i] * ux + pts[i + 1] * uy; s2 += p * p; s3 += p * p * p; }
      const sd = Math.sqrt(s2 / m.n) || 1;
      const skew = s3 / m.n / sd ** 3;
      if (Math.abs(skew) < minSkew * 0.4) return null; // an axis but no front (e.g. an ellipse)
      const angle = norm360(th / D + (skew < 0 ? 180 : 0));
      return { angle, elong, skew, confidence: Math.min(1, (elong - 1) * Math.abs(skew)) };
    }
    const mag = Math.hypot(vx, vy);
    if (mag < minSkew) return null;
    return { angle: norm360(Math.atan2(vy, vx) / D), elong, skew: mag, confidence: Math.min(1, mag) };
  }

  // ---------- 2. template ----------
  // The mower picture -> template: background removed (alpha, else the corner colour), cropped, grey.
  // rgba: w x h. -> { w, h, gray: Float32Array, alpha: Uint8Array, cx, cy (alpha centroid), count } or null
  function makeTemplate(rgba, w, h, { bgTol = 12 } = {}) {
    const n = w * h;
    let hasAlpha = false;
    for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 250) { hasAlpha = true; break; }
    // no alpha: the background is what connects to the border in the corner colours (a flood fill,
    // so a light part of the mower inside its outline stays)
    const bgMask = new Uint8Array(n);
    if (!hasAlpha) {
      const corner = [0, w - 1, (h - 1) * w, n - 1].map((i) => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
      const near = (i) => corner.some((c) => Math.abs(rgba[i * 4] - c[0]) <= bgTol && Math.abs(rgba[i * 4 + 1] - c[1]) <= bgTol && Math.abs(rgba[i * 4 + 2] - c[2]) <= bgTol);
      const st = [];
      for (let x = 0; x < w; x++) st.push(x, (h - 1) * w + x);
      for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
      while (st.length) {
        const i = st.pop();
        if (bgMask[i] || !near(i)) continue;
        bgMask[i] = 1;
        const x = i % w, y = (i - x) / w;
        if (x > 0) st.push(i - 1);
        if (x < w - 1) st.push(i + 1);
        if (y > 0) st.push(i - w);
        if (y < h - 1) st.push(i + w);
      }
    }
    const isBg = (k) => (hasAlpha ? rgba[k + 3] < 128 : bgMask[k >> 2] === 1);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (isBg((y * w + x) * 4)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const tw = x1 - x0 + 1, th = y1 - y0 + 1;
    const gray = new Float32Array(tw * th), alpha = new Uint8Array(tw * th);
    let count = 0, sx = 0, sy = 0;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const k = ((y + y0) * w + (x + x0)) * 4, i = y * tw + x;
      if (isBg(k)) continue;
      alpha[i] = 1;
      gray[i] = 0.299 * rgba[k] + 0.587 * rgba[k + 1] + 0.114 * rgba[k + 2];
      count++;
      sx += x + 0.5;
      sy += y + 0.5;
    }
    return { w: tw, h: th, gray, alpha, cx: sx / count, cy: sy / count, count };
  }

  // The template scaled by s and turned so its top points to `angle` (image-up degrees, 90 = unturned),
  // sampled on a square patch centred on the template's centroid. -> { size, gray, mask, n }
  function turnTemplate(t, s, angle) {
    const rot = (angle - 90) * D; // counter-clockwise on screen
    const c = Math.cos(rot), si = Math.sin(rot);
    const R = Math.ceil(Math.hypot(Math.max(t.cx, t.w - t.cx), Math.max(t.cy, t.h - t.cy)) * s) + 1;
    const size = 2 * R + 1;
    const gray = new Float32Array(size * size), mask = new Uint8Array(size * size);
    let n = 0;
    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        // patch offset (y down) -> template offset: undo the screen rotation (y up), then the scale
        const ex = u - R, ey = R - v;
        const tx = (ex * c + ey * si) / s, ty = (-ex * si + ey * c) / s;
        const px = t.cx + tx - 0.5, py = t.cy - ty - 0.5; // template pixel coords (y down)
        const ix = Math.round(px), iy = Math.round(py);
        if (ix < 0 || iy < 0 || ix >= t.w || iy >= t.h) continue;
        const i = iy * t.w + ix;
        if (!t.alpha[i]) continue;
        const j = v * size + u;
        mask[j] = 1;
        gray[j] = t.gray[i];
        n++;
      }
    }
    return { size, R, gray, mask, n };
  }

  // NCC of a turned template centred on image pixel (ix, iy) of a grey image (gw x gh). -> -1..1
  // own (Int32Array label per pixel) + id + count: the blob being matched; at least 70 % of the
  // template must lie on its pixels, and the score is scaled by how much of the template and of the
  // blob overlap (a uniform dock next to the lawn no longer looks like the mower).
  function nccAt(img, gw, gh, p, ix, iy, own = null, id = 0, count = 0) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0, on = 0;
    for (let v = 0; v < p.size; v++) {
      const y = iy + v - p.R;
      if (y < 0 || y >= gh) continue;
      for (let u = 0; u < p.size; u++) {
        const j = v * p.size + u;
        if (!p.mask[j]) continue;
        const x = ix + u - p.R;
        if (x < 0 || x >= gw) continue;
        if (own) { // correlation over the blob's own pixels only: a uniform dock has no pattern
          if (own[y * gw + x] !== id) continue;
          on++;
        }
        const a = p.gray[j], b = img[y * gw + x];
        sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
      }
    }
    if ((!own && n < p.n * 0.6) || n < 8) return -1;
    const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    if (va <= 1e-6 || vb <= 1e-6) return -1;
    const ncc = (sab - (sa * sb) / n) / Math.sqrt(va * vb);
    if (!own) return ncc;
    const tplOn = on / p.n;
    if (tplOn < MIN_COVER) return -1;
    return ncc * tplOn * Math.min(1, on / Math.max(1, count));
  }

  // Area-averaged halvings of the template (pixels opaque when at least half of their 2x2 source is),
  // so a big product picture shrinks to the icon's few pixels without aliasing. -> [t, t/2, t/4, ...]
  function pyramid(t) {
    if (t.pyr) return t.pyr;
    const out = [t];
    let cur = t;
    while (cur.w >= 8 && cur.h >= 8 && out.length < 8) {
      const w = cur.w >> 1, h = cur.h >> 1;
      const gray = new Float32Array(w * h), alpha = new Uint8Array(w * h);
      let count = 0, sx = 0, sy = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let g = 0, a = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const i = (2 * y + dy) * cur.w + 2 * x + dx;
          if (cur.alpha[i]) { a++; g += cur.gray[i]; }
        }
        if (a < 2) continue;
        const i = y * w + x;
        alpha[i] = 1;
        gray[i] = g / a;
        count++;
        sx += x + 0.5;
        sy += y + 0.5;
      }
      if (!count) break;
      cur = { w, h, gray, alpha, cx: sx / count, cy: sy / count, count, f: (cur.f || 1) * 2 };
      out.push(cur);
    }
    t.pyr = out;
    return out;
  }

  // The pyramid level for scale s (template -> image) and the scale left to apply to it.
  function levelFor(t, s) {
    const pyr = pyramid(t);
    let lv = pyr[0];
    for (const l of pyr) if (s * (l.f || 1) <= 1.0001) lv = l; // the smallest level still shrunk (never upsampled)
    return { t: lv, s: s * (lv.f || 1) };
  }

  function grayOf(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, k = 0; i < w * h; i++, k += 4) g[i] = 0.299 * rgba[k] + 0.587 * rgba[k + 1] + 0.114 * rgba[k + 2];
    return g;
  }

  // Rotation (and scale) search of the template around (cx, cy) in a grey image.
  // opts: scale (template -> image), scales (factors tried, default 0.8..1.25), radius (px searched,
  // default 2), cache (Map reused between calls for turned patches).
  // -> { angle, x, y (pixel-centre coordinates of the template centroid), score, scale } or null
  function matchTemplate(gray, gw, gh, t, cx, cy, opts = {}) {
    if (!t) return null;
    const cache = opts.cache || new Map();
    const turned = (s, a) => {
      const key = `${s.toFixed(4)}|${Math.round(norm360(a) * 10)}`;
      let p = cache.get(key);
      if (!p) {
        const l = levelFor(t, s);
        p = turnTemplate(l.t, l.s, norm360(a));
        cache.set(key, p);
        if (cache.size > 2000) cache.clear();
      }
      return p;
    };
    const own = opts.label || null, id = opts.id || 0, count = opts.count || 0;
    const scales = (opts.scales || [0.8, 0.9, 1, 1.12, 1.25]).map((f) => f * (opts.scale || 1));
    const r = opts.radius ?? 2;
    const icx = Math.floor(cx), icy = Math.floor(cy);
    const search = (s, angles, rad, x0, y0) => {
      let best = null;
      for (const a of angles) {
        const p = turned(s, a);
        for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
          const sc = nccAt(gray, gw, gh, p, x0 + dx, y0 + dy, own, id, count);
          if (!best || sc > best.score) best = { angle: a, ix: x0 + dx, iy: y0 + dy, score: sc, scale: s };
        }
      }
      return best;
    };
    const coarse = [];
    for (let a = 0; a < 360; a += 10) coarse.push(a);
    // the middle scale first over all angles, then every scale at the best few angles
    let best = search(scales[Math.floor(scales.length / 2)], coarse, r, icx, icy);
    if (!best) return null;
    for (const s of scales) {
      const b = search(s, [best.angle - 10, best.angle, best.angle + 10], r, best.ix, best.iy);
      if (b && b.score > best.score) best = b;
    }
    const fine = [];
    for (let a = -6; a <= 6; a++) fine.push(best.angle + a);
    const f = search(best.scale, fine, 1, best.ix, best.iy);
    if (f && f.score >= best.score) best = f;
    // the patch centre sits on the template's centroid: pixel centre of (ix, iy)
    return { angle: norm360(best.angle), x: best.ix + 0.5, y: best.iy + 0.5, score: best.score, scale: best.scale };
  }

  return { norm360, iconMoments, momentsOf, momentHeading, makeTemplate, turnTemplate, nccAt, grayOf, matchTemplate, pyramid };
}

const HK = headingKernel();
export const { norm360, iconMoments, momentsOf, momentHeading, makeTemplate, turnTemplate, nccAt, grayOf, matchTemplate } = HK;
export const angleDiff = (a, b) => { const d = norm360(a - b); return d > 180 ? d - 360 : d; };

// Heading filter: small changes (<= jitter°, detection noise) are low-passed, larger ones (a turn) are
// taken as they are, a jump > maxJump° only when the next reading agrees with it (two frames).
// st: { angle, pending } | null. -> new state.
export function smoothHeading(st, angle, { alpha = 0.5, jitter = 15, maxJump = 120 } = {}) {
  if (angle === null || angle === undefined || !Number.isFinite(angle)) return st;
  if (!st || st.angle === null || st.angle === undefined) return { angle: norm360(angle), pending: null };
  const d = angleDiff(angle, st.angle);
  if (Math.abs(d) > maxJump) {
    if (st.pending !== null && st.pending !== undefined && Math.abs(angleDiff(angle, st.pending)) <= 30) return { angle: norm360(angle), pending: null };
    return { angle: st.angle, pending: norm360(angle) };
  }
  return { angle: norm360(Math.abs(d) <= jitter ? st.angle + alpha * d : angle), pending: null };
}

