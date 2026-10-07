// Model loading UI of the card: the slim progress bar at the bottom of the stage and the snapshot
// placeholder (last render of this layout / view / mode, shown behind the canvas until the model is
// ready, then cross-faded), plus the snapshot capture after the camera settles.
import { SnapshotScheduler, snapshotSize, loadSnapshot, saveSnapshot, SNAPSHOT_QUALITY } from './snapshot.js';
import { progressText } from './model-cache.js';

export const LOAD_STYLE = `
  .stage { isolation: isolate; }
  .fp-snap { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: -1;
    pointer-events: none; opacity: 1; transition: opacity .3s ease; }
  .fp-snap.fading { z-index: 1; opacity: 0; }
  .fp-snap[hidden], .fp-progress[hidden] { display: none; }
  .fp-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; pointer-events: none; }
  .fp-progress .bar { height: 3px; background: var(--primary-color, #03a9f4); width: 0; transition: width .2s linear; }
  .fp-progress.busy .bar { width: 100%; opacity: .45; }
  .fp-progress span { position: absolute; right: 8px; bottom: 6px; font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: var(--card-background-color, #fff); color: var(--secondary-text-color, #727272);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  .fp-progress.error span { color: var(--error-color, #db4437); }
`;

export class ModelLoadUI {
  // host: { stage, view, key(): { layout, view, mode } | null, canCapture(): boolean }
  constructor(host, { debounce, minInterval } = {}) {
    this.host = host;
    this.img = document.createElement('img');
    this.img.className = 'fp-snap';
    this.img.alt = '';
    this.img.hidden = true;
    this.bar = document.createElement('div');
    this.bar.className = 'fp-progress';
    this.bar.hidden = true;
    this.bar.innerHTML = '<div class="bar"></div><span></span>';
    host.stage.prepend(this.img);
    host.stage.append(this.bar);
    this.log = []; // the texts shown (headless checks)
    this.snapShownAt = null;
    this.readyAt = null;
    this._url = null;
    this._gen = 0;
    this.scheduler = new SnapshotScheduler(() => this.capture(), { debounce, minInterval });
  }

  // progress: text, frac (0..1, null: busy without a known share), error
  progress(text, frac = null, error = false) {
    clearTimeout(this._errTimer);
    if (!text) { this.bar.hidden = true; return; }
    this.bar.hidden = false;
    this.bar.classList.toggle('busy', frac === null && !error);
    this.bar.classList.toggle('error', !!error);
    this.bar.firstChild.style.width = frac === null ? '' : `${Math.round(frac * 100)}%`;
    if (this.bar.lastChild.textContent !== text) {
      this.bar.lastChild.textContent = text;
      this.log.push(text);
      if (this.log.length > 20) this.log.shift();
    }
    if (error) this._errTimer = setTimeout(() => { this.bar.hidden = true; }, 8000);
  }

  download(loaded, total) {
    this.progress(progressText(loaded, total), total ? Math.min(1, loaded / total) : null);
  }

  // A model starts loading: the last snapshot of this view behind the canvas, controls held still.
  async loading() {
    const gen = ++this._gen;
    this.readyAt = null;
    const k = this.host.key();
    if (!k) return;
    const rec = await loadSnapshot(k.layout, k.view, k.mode).catch(() => null);
    if (gen !== this._gen || !rec || !rec.blob) return;
    this._showSnap(URL.createObjectURL(rec.blob));
  }

  _showSnap(url) {
    this._dropUrl();
    this._url = url;
    this.img.src = url;
    this.img.classList.remove('fading');
    this.img.hidden = false;
    this.snapShownAt = performance.now();
    const c = this.host.view.controls;
    if (c && this._controlsWere === undefined) { this._controlsWere = c.enabled; c.enabled = false; }
  }

  _dropUrl() {
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = null;
  }

  _restoreControls() {
    const c = this.host.view.controls;
    if (this._controlsWere !== undefined && c) c.enabled = this._controlsWere;
    this._controlsWere = undefined;
  }

  // The model is ready (ok) or failed: cross-fade the snapshot away, hide the bar (or show the error).
  done(ok, error = '') {
    this._gen++;
    if (ok) {
      this.readyAt = performance.now();
      this.progress(null);
      this.scheduler.notify();
    } else if (error) this.progress(error, null, true);
    else this.progress(null);
    this._restoreControls();
    if (this.img.hidden) return;
    const img = this.img;
    img.classList.add('fading'); // over the canvas, then transparent
    clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => { img.hidden = true; img.classList.remove('fading'); this._dropUrl(); }, 320);
  }

  // Camera / view / mode changed: capture once things settle.
  changed() {
    if (this.readyAt !== null) this.scheduler.notify();
  }

  // JPEG of the current render -> IndexedDB. -> Promise<boolean>
  async capture() {
    const host = this.host, v = host.view, k = host.key();
    if (!k || !v.model || !host.canCapture() || !this.img.hidden) return false;
    if (v._tween) { this.scheduler.notify(); return false; } // still moving
    const src = v.renderer.domElement;
    if (!src.width || !src.height) return false;
    const { w, h } = snapshotSize(src.width, src.height);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return false;
    g.fillStyle = getComputedStyle(host.stage).getPropertyValue('--card-background-color').trim() || '#ffffff';
    g.fillRect(0, 0, w, h);
    try {
      v.renderer.render(v.scene, v.camera); // a fresh drawing buffer (it is not preserved between frames)
      g.drawImage(src, 0, 0, w, h);
    } catch (e) {
      return false;
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', SNAPSHOT_QUALITY));
    return saveSnapshot(k.layout, k.view, k.mode, blob).catch(() => false);
  }

  dispose() {
    this.scheduler.cancel();
    clearTimeout(this._fadeTimer);
    clearTimeout(this._errTimer);
    this._dropUrl();
  }
}
