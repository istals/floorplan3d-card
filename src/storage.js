// Layout persistence.
// 1. floorplan3d companion integration (shared across all users and devices)
// 2. frontend user data (stored in HA, but per user)
// 3. browser localStorage (last resort)

import { migrateModel } from './bindings.js';

export const EMPTY_LAYOUT = () => ({
  version: 1,
  floors: [],
  rooms: [],
  pins: {},
  hidden: [],
  mower: null,
});

export class LayoutStore {
  constructor(key) {
    this.key = key || 'default';
    this.backend = null;
    this._timer = null;
    this._pending = null;
  }

  async load(hass) {
    let shared;
    try {
      const r = await hass.callWS({ type: 'floorplan3d/layout/get', key: this.key });
      shared = r && r.layout;
      this.backend = 'shared';
    } catch (e) { /* integration not installed */ }
    // nothing shared yet: pick up a layout made before the integration was installed,
    // the next save moves it to shared storage
    if (this.backend === 'shared' && shared) return normalise(shared);
    const user = await this._userData(hass);
    if (!this.backend) this.backend = user.ok ? 'user' : 'browser';
    if (user.value) return normalise(user.value);
    return normalise(this._browser());
  }

  async _userData(hass) {
    try {
      const r = await hass.callWS({ type: 'frontend/get_user_data', key: 'floorplan3d_' + this.key });
      return { ok: true, value: r && r.value };
    } catch (e) {
      return { ok: false, value: null };
    }
  }

  _browser() {
    try {
      return JSON.parse(localStorage.getItem('floorplan3d_' + this.key) || 'null');
    } catch (e) {
      return null;
    }
  }

  save(hass, layout, delay = 600) {
    clearTimeout(this._timer);
    // a newer save replaces this one; settle the old promise so callers don't hang
    if (this._pending) this._pending(false);
    return new Promise((resolve) => {
      this._pending = resolve;
      this._timer = setTimeout(async () => {
        this._pending = null;
        try {
          if (this.backend === 'shared') {
            await hass.callWS({ type: 'floorplan3d/layout/set', key: this.key, layout });
          } else if (this.backend === 'user') {
            await hass.callWS({ type: 'frontend/set_user_data', key: 'floorplan3d_' + this.key, value: layout });
          } else {
            localStorage.setItem('floorplan3d_' + this.key, JSON.stringify(layout));
          }
          resolve(true);
        } catch (e) {
          console.error('floorplan3d: save failed', e);
          resolve(false);
        }
      }, delay);
    });
  }
}

export function normalise(l) {
  const base = EMPTY_LAYOUT();
  if (!l || typeof l !== 'object') return base;
  const out = {
    ...base,
    ...l,
    floors: Array.isArray(l.floors) ? l.floors : [],
    rooms: Array.isArray(l.rooms) ? l.rooms : [],
    pins: l.pins && typeof l.pins === 'object' ? l.pins : {},
    hidden: Array.isArray(l.hidden) ? l.hidden : [],
    model: migrateModel(l.model || null),
  };
  // object bindings / tag settings: plain objects or absent (readers default to none)
  for (const k of ['objects', 'groups', 'tags']) {
    if (k in out && !(out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]))) delete out[k];
  }
  // pre-0.4.5 group controllers are tags now (layout.tags wins over a leftover groups entry)
  if (out.groups) { out.tags = { ...out.groups, ...(out.tags || {}) }; delete out.groups; }
  return out;
}
