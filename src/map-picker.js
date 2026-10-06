// 2D picker on the ORIGINAL map image, over the stage: zoom (wheel, pinch, + / -), pan (drag),
// crosshair, a magnifier loupe with the exact pixel and its colour. A click picks that pixel:
//   mode 'color': adds its colour (median 3x3) through onColor and stays open (Done / Esc closes);
//   mode 'point': reports the pixel through onPoint and closes.
// "Show matches" tints pixels within tolerance of the category's colours (what will be keyed).
import { medianColor } from './mower-image.js';

const CLICK_PX = 5;
const LOUPE = 112, LOUPE_ZOOM = 8;
const MAX_SIDE = 4096; // read the picture at full size up to this

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Pure: view transform helpers (tested).
export function fitView(imgW, imgH, boxW, boxH, pad = 8) {
  const s = Math.max(1e-6, Math.min((boxW - 2 * pad) / imgW, (boxH - 2 * pad) / imgH));
  return { s, ox: (boxW - imgW * s) / 2, oy: (boxH - imgH * s) / 2 };
}

// Zoom by factor k about the box point (bx, by), keeping the image point under it fixed.
export function zoomAt(v, k, bx, by, min = 0.05, max = 64) {
  const s = Math.max(min, Math.min(max, v.s * k));
  const r = s / v.s;
  return { s, ox: bx - (bx - v.ox) * r, oy: by - (by - v.oy) * r };
}

export function toImage(v, bx, by) {
  return { x: (bx - v.ox) / v.s, y: (by - v.oy) / v.s };
}

// Pixels of rgba (w x h) within tol (max channel difference) of any of the colours -> Uint8Array.
export function matchMask(rgba, w, h, colors, tol) {
  const m = new Uint8Array(w * h);
  if (!colors || !colors.length) return m;
  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    if (rgba[k + 3] < 128) continue;
    for (const c of colors) {
      if (Math.abs(rgba[k] - c[0]) <= tol && Math.abs(rgba[k + 1] - c[1]) <= tol && Math.abs(rgba[k + 2] - c[2]) <= tol) { m[i] = 1; break; }
    }
  }
  return m;
}

export class MapPicker {
  /**
   * root: the stage element. opts: { image (CanvasImageSource), title, mode: 'color' | 'point',
   *   colors() -> [[r,g,b]] (chips), tolerance() -> number, onColor(rgb, { px, py }), onPoint({ px, py }),
   *   onRemove(index), onClose(reason) }
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    const img = opts.image;
    const W0 = img.naturalWidth || img.videoWidth || img.width, H0 = img.naturalHeight || img.videoHeight || img.height;
    if (!W0 || !H0) throw new Error('empty image');
    const k = Math.min(1, MAX_SIDE / Math.max(W0, H0));
    this.imgW = W0;
    this.imgH = H0;
    this.k = k; // picture pixels -> sampled pixels
    const w = Math.max(1, Math.round(W0 * k)), h = Math.max(1, Math.round(H0 * k));
    this.src = document.createElement('canvas');
    this.src.width = w;
    this.src.height = h;
    const g = this.src.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    this.data = g.getImageData(0, 0, w, h).data;
    this.w = w;
    this.h = h;
    this.showMatches = false;
    this._maskKey = null;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'fp-picker';
    const color = this.opts.mode !== 'point';
    el.innerHTML = `<div class="fp-pk-bar"><span class="fp-pk-title">${esc(this.opts.title || 'Pick on the map image')}</span>
      <span class="fp-pk-chips"></span>
      ${color ? '<label class="fp-pk-match"><input type="checkbox" data-pk="matches"> Show matches</label>' : ''}
      <button data-pk="out" title="Zoom out">−</button><button data-pk="in" title="Zoom in">+</button><button data-pk="fit" title="Fit">Fit</button>
      <button data-pk="done" class="primary">${color ? 'Done' : 'Cancel'}</button></div>
      <div class="fp-pk-view"><canvas class="fp-pk-canvas"></canvas><canvas class="fp-pk-loupe" width="${LOUPE}" height="${LOUPE}"></canvas>
      <div class="fp-pk-info"></div></div>`;
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart', 'touchmove', 'keydown']) {
      el.addEventListener(t, (e) => e.stopPropagation());
    }
    this.el = el;
    this.view = el.querySelector('.fp-pk-view');
    this.canvas = el.querySelector('.fp-pk-canvas');
    this.loupe = el.querySelector('.fp-pk-loupe');
    this.info = el.querySelector('.fp-pk-info');
    el.querySelector('.fp-pk-bar').addEventListener('click', (e) => this._bar(e));
    el.querySelector('.fp-pk-bar').addEventListener('change', (e) => {
      if (e.target.dataset.pk === 'matches') { this.showMatches = e.target.checked; this.draw(); }
    });
    const c = this.canvas;
    this._ptrs = new Map();
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => { this._ptrs.delete(e.pointerId); this._drag = null; });
    c.addEventListener('pointerleave', () => { this.loupe.style.display = 'none'; this.info.textContent = ''; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const b = this._box(e);
      this.v = zoomAt(this.v, Math.exp(-e.deltaY * 0.0015), b.x, b.y);
      this.draw();
      this._hover(e);
    }, { passive: false });
    this._onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close('esc'); }
    };
    window.addEventListener('keydown', this._onKey, true);
    this.root.append(el);
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
    if (this._ro) this._ro.observe(this.view);
    this._resize(true);
    this.refresh();
  }

  _resize(fit = false) {
    const r = this.view.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; fit = fit || !this.v; }
    if (fit || !this.v) this.v = fitView(this.imgW, this.imgH, W, H);
    this.draw();
  }

  _box(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Client position of a picture pixel (headless checks).
  clientOf(px, py) {
    const r = this.canvas.getBoundingClientRect();
    return [r.left + this.v.ox + px * this.v.s, r.top + this.v.oy + py * this.v.s];
  }

  _bar(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const W = this.canvas.width, H = this.canvas.height;
    switch (b.dataset.pk) {
      case 'in': this.v = zoomAt(this.v, 1.5, W / 2, H / 2); break;
      case 'out': this.v = zoomAt(this.v, 1 / 1.5, W / 2, H / 2); break;
      case 'fit': this.v = fitView(this.imgW, this.imgH, W, H); break;
      case 'done': this.close('done'); return;
      case 'del': if (this.opts.onRemove) this.opts.onRemove(Number(b.dataset.i)); this.refresh(); return;
      default: return;
    }
    this.draw();
  }

  _down(e) {
    this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), v: this.v };
      this._drag = null;
      return;
    }
    this._drag = { x: e.clientX, y: e.clientY, v: this.v, moved: false };
  }

  _move(e) {
    if (this._ptrs.has(e.pointerId)) this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch && this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      const r = this.canvas.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.v = zoomAt(this._pinch.v, d / (this._pinch.d || 1), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      this.draw();
      return;
    }
    const d = this._drag;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) >= CLICK_PX) d.moved = true;
      if (d.moved) { this.v = { ...d.v, ox: d.v.ox + dx, oy: d.v.oy + dy }; this.draw(); }
    }
    this._hover(e);
  }

  _up(e) {
    this._ptrs.delete(e.pointerId);
    if (this._pinch) { if (this._ptrs.size < 2) this._pinch = null; this._drag = null; return; }
    const d = this._drag;
    this._drag = null;
    if (!d || d.moved) return;
    const p = this._pixelAt(e);
    if (!p) return;
    if (this.opts.mode === 'point') {
      const cb = this.opts.onPoint;
      this.close('point');
      if (cb) cb({ px: (p.i + 0.5) / this.k, py: (p.j + 0.5) / this.k });
      return;
    }
    const rgb = medianColor(this.data, this.w, this.h, p.i, p.j, 1);
    if (this.opts.onColor) this.opts.onColor(rgb, { px: (p.i + 0.5) / this.k, py: (p.j + 0.5) / this.k, imgW: this.imgW, imgH: this.imgH });
    this.refresh();
  }

  // sampled pixel under the pointer, or null outside the picture
  _pixelAt(e) {
    const b = this._box(e), q = toImage(this.v, b.x, b.y);
    const i = Math.floor(q.x * this.k), j = Math.floor(q.y * this.k);
    return i >= 0 && j >= 0 && i < this.w && j < this.h ? { i, j, b } : null;
  }

  _hover(e) {
    const p = this._pixelAt(e);
    if (!p) { this.loupe.style.display = 'none'; this.info.textContent = ''; return; }
    const L = this.loupe, g = L.getContext('2d');
    const n = LOUPE / LOUPE_ZOOM; // pixels shown across
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000';
    g.fillRect(0, 0, LOUPE, LOUPE);
    g.drawImage(this.src, p.i - n / 2 + 0.5, p.j - n / 2 + 0.5, n, n, 0, 0, LOUPE, LOUPE);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.strokeRect(LOUPE / 2 - LOUPE_ZOOM / 2, LOUPE / 2 - LOUPE_ZOOM / 2, LOUPE_ZOOM, LOUPE_ZOOM);
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.strokeRect(LOUPE / 2 - LOUPE_ZOOM / 2 - 1.5, LOUPE / 2 - LOUPE_ZOOM / 2 - 1.5, LOUPE_ZOOM + 3, LOUPE_ZOOM + 3);
    const W = this.canvas.width;
    L.style.display = 'block';
    const lx = p.b.x + 18 + LOUPE > W ? p.b.x - 18 - LOUPE : p.b.x + 18;
    L.style.left = `${lx}px`;
    L.style.top = `${Math.max(0, p.b.y - LOUPE - 18)}px`;
    const k = (p.j * this.w + p.i) * 4, d = this.data;
    const rgb = [d[k], d[k + 1], d[k + 2]];
    this.info.innerHTML = `<span class="swatch" style="background:rgb(${rgb.join(',')})"></span> ${Math.floor((p.i + 0.5) / this.k)}, ${Math.floor((p.j + 0.5) / this.k)} · rgb(${rgb.join(', ')})`;
  }

  // chips and the match tint follow the category's colours
  refresh() {
    if (!this.el) return;
    const box = this.el.querySelector('.fp-pk-chips');
    if (box && this.opts.mode !== 'point') {
      const cols = this.opts.colors ? this.opts.colors() : [];
      box.innerHTML = cols.map((c, i) => `<span class="cchip"><span class="swatch" style="background:rgb(${c.join(',')})"></span>
        <button data-pk="del" data-i="${i}" class="link" title="Remove this colour" aria-label="Remove">×</button></span>`).join('');
    }
    this.draw();
  }

  _mask() {
    const cols = this.opts.colors ? this.opts.colors() : [];
    const tol = this.opts.tolerance ? this.opts.tolerance() : 30;
    const key = JSON.stringify([cols, tol]);
    if (key === this._maskKey) return this._maskCanvas;
    this._maskKey = key;
    const m = matchMask(this.data, this.w, this.h, cols, tol);
    const cv = (this._maskCanvas = this._maskCanvas || document.createElement('canvas'));
    cv.width = this.w;
    cv.height = this.h;
    const g = cv.getContext('2d');
    const id = g.createImageData(this.w, this.h);
    let count = 0;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      count++;
      id.data.set([255, 0, 255, 200], i * 4);
    }
    g.putImageData(id, 0, 0);
    this.matchCount = count;
    return cv;
  }

  draw() {
    if (!this.el || !this.v) return;
    const g = this.canvas.getContext('2d');
    const { s, ox, oy } = this.v;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.imageSmoothingEnabled = s < 2;
    g.drawImage(this.src, ox, oy, this.imgW * s, this.imgH * s);
    if (this.showMatches && this.opts.mode !== 'point') g.drawImage(this._mask(), ox, oy, this.imgW * s, this.imgH * s);
  }

  close(reason = 'done') {
    if (!this.el) return;
    window.removeEventListener('keydown', this._onKey, true);
    if (this._ro) this._ro.disconnect();
    this.el.remove();
    this.el = null;
    if (this.opts.onClose) this.opts.onClose(reason);
  }
}
