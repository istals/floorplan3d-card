// Snapshot placeholder: a JPEG of the rendered model per (layout key, view, mode) in IndexedDB, shown
// at the next load until the model is ready.
import { idbAll, idbPut, idbDelete } from './idb.js';
import { lruEvict } from './model-cache.js';

export const SNAPSHOT_CAP = 2 * 1024 * 1024;
export const SNAPSHOT_MAX_PX = 1280;
export const SNAPSHOT_QUALITY = 0.7;

export const snapshotKey = (layoutKey, viewId, mode) => `${layoutKey}|${viewId || ''}|${mode}`;

export function snapshotSize(w, h, max = SNAPSHOT_MAX_PX) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

// The view a layout's card starts in with its model (known only once the model has loaded), remembered
// as { key: startKey(layout), start: viewId } in the same store.
export const startKey = (layoutKey) => `start|${layoutKey}`;

// The exact (layout, view, mode) snapshot only: another view's picture would show the wrong scene.
// viewId null (not known yet): the remembered start view's. -> record | null
export function pickSnapshot(list, layoutKey, viewId, mode) {
  let view = viewId;
  if (view === null || view === undefined) {
    const s = list.find((r) => r.key === startKey(layoutKey));
    if (!s || typeof s.start !== 'string') return null;
    view = s.start;
  }
  const key = snapshotKey(layoutKey, view, mode);
  return list.find((r) => r.key === key) || null;
}

export async function rememberStartView(layoutKey, viewId) {
  return idbPut('snapshots', { key: startKey(layoutKey), layout: layoutKey, start: viewId || '', size: 0, at: Date.now() });
}

// Capture after changes settle: debounce ms after the last notify, at most once per minInterval ms.
export class SnapshotScheduler {
  constructor(capture, { debounce = 3000, minInterval = 30000, now = () => Date.now() } = {}) {
    Object.assign(this, { capture, debounce, minInterval, now });
    this.last = -Infinity;
    this.timer = null;
  }

  notify() {
    this._arm(this.debounce);
  }

  _arm(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._fire(), ms);
  }

  _fire() {
    this.timer = null;
    const wait = this.last + this.minInterval - this.now();
    if (wait > 0) { this._arm(wait); return; }
    this.last = this.now();
    this.capture();
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

// -> record { key, layout, view, mode, blob, size, at } | null
export async function loadSnapshot(layoutKey, viewId, mode) {
  const rec = pickSnapshot(await idbAll('snapshots'), layoutKey, viewId, mode);
  if (rec) idbPut('snapshots', { ...rec, at: Date.now() }); // LRU touch
  return rec;
}

export async function saveSnapshot(layoutKey, viewId, mode, blob) {
  if (!blob || blob.size > SNAPSHOT_CAP) return false;
  const key = snapshotKey(layoutKey, viewId, mode);
  const ok = await idbPut('snapshots', { key, layout: layoutKey, view: viewId || '', mode, blob, size: blob.size, at: Date.now() });
  if (!ok) return false;
  const all = await idbAll('snapshots');
  const drop = lruEvict(all.map((r) => ({ key: r.key, size: r.size, at: r.at })), SNAPSHOT_CAP, key);
  if (drop.length) await idbDelete('snapshots', drop);
  return true;
}
