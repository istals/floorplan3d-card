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

// The exact (layout, view, mode) snapshot, else the newest of that layout and mode (the first view is
// only known once the model has loaded). -> record | null
export function pickSnapshot(list, layoutKey, viewId, mode) {
  const key = snapshotKey(layoutKey, viewId, mode);
  const exact = list.find((r) => r.key === key);
  if (exact) return exact;
  const same = list.filter((r) => r.layout === layoutKey && r.mode === mode).sort((a, b) => b.at - a.at);
  return same[0] || null;
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
