// Demo page wiring: a stand-in <ha-icon>, a mock hass shared by all cards on the page.
import * as mdi from '@mdi/js';
import { createMockHass, resetMockHass } from './mock-hass.js';

class DemoIcon extends HTMLElement {
  static get observedAttributes() { return ['icon']; }
  attributeChangedCallback() {
    const name = (this.getAttribute('icon') || '').replace(/^mdi:/, '');
    const key = 'mdi' + name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
    const path = mdi[key] || mdi.mdiHelpCircleOutline;
    this.innerHTML = `<svg viewBox="0 0 24 24" style="width:var(--mdc-icon-size,24px);height:var(--mdc-icon-size,24px);display:block;fill:currentColor"><path d="${path}"/></svg>`;
  }
}
if (!customElements.get('ha-icon')) customElements.define('ha-icon', DemoIcon);

const MAIN = document.querySelector('main').innerHTML;
let cards = [];

// Builds the cards and a fresh mock hass for the query (URLSearchParams).
function boot(params) {
  // ?test=1 (headless checks): cheaper rendering, see testMode() in src/view.js
  window.__floorplan3dTest = params.get('test') === '1';
  document.querySelector('main').innerHTML = MAIN;
  // ?cards=1: the light-theme card only (benchmarks)
  if (params.get('cards') === '1') document.querySelectorAll('.theme.dark').forEach((s) => s.remove());
  cards = [...document.querySelectorAll('floorplan3d-card')];
  const themes = new Map(cards.map((c) => [c, { darkMode: !!c.closest('.dark') }]));
  const push = (hass) => { for (const c of cards) c.hass = { ...hass, themes: themes.get(c) }; };
  for (const c of cards) {
    const model = params.get('model');
    c.setConfig({
      height: params.get('height') || '460px', view: params.get('view') || c.dataset.view || '3d', floor: params.get('floor') || undefined,
      // ?model=1 loads the generated demo house, any other value is used as the model url
      ...(model ? { model: model === '1' ? '/demo/house.glb' : model, model_opacity: 0.95 } : {}),
      // example actions (see README): double tap the mower marker to open the garden camera
      actions: { 'lawn_mower.demo': { double_tap_action: { action: 'more-info', entity: 'camera.garden' } } },
      ...(params.get('merge') === '0' ? { merge: false } : {}), // ?merge=0: every model part its own mesh
      ...(params.get('logos') === '1' ? { badges: { integration: true } } : {}), // ?logos=1: integration logos on
      ...(params.get('debug') === '1' ? { debug: true } : {}), // ?debug=1: the performance overlay
      ...(params.get('render') ? { render: params.get('render') } : {}), // ?render=default: ignore the model's render recipe
    });
  }
  push(createMockHass({ onChange: push }));
}

// The card's local caches (snapshots and model blobs in IndexedDB, Cache Storage models).
async function clearCardCaches() {
  try { if (typeof caches !== 'undefined') await caches.delete('floorplan3d-models'); } catch (e) { /* insecure context */ }
  await new Promise((resolve) => {
    try {
      const req = indexedDB.open('floorplan3d');
      req.onupgradeneeded = () => req.transaction.abort(); // not created yet: leave that to the card
      req.onsuccess = () => {
        const db = req.result, names = [...db.objectStoreNames];
        if (!names.length) { db.close(); resolve(); return; }
        const tx = db.transaction(names, 'readwrite');
        for (const n of names) tx.objectStore(n).clear();
        tx.oncomplete = tx.onerror = () => { db.close(); resolve(); };
      };
      req.onerror = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}

// Headless checks: a fresh demo without a page load. Drops the cards (their WebGL contexts too), the
// mock, test globals, local storage and (unless opts.keepCaches) the card's caches, then boots again
// for the query ({ key: value }).
window.__demoReset = async (query = {}, opts = {}) => {
  if (!opts.keepCaches) await clearCardCaches();
  for (const c of cards) {
    const v = c._view;
    c.remove();
    if (v) { v.renderer.dispose(); v.renderer.forceContextLoss(); }
  }
  resetMockHass();
  for (const k of Object.keys(window)) if (k.startsWith('__') && k !== '__demoReset') delete window[k];
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* blocked */ }
  document.querySelector('#log').textContent = '';
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null));
  history.replaceState(null, '', `${location.pathname}?${q}`);
  boot(q);
};

boot(new URLSearchParams(location.search));

// log what the card asks for, so the page works without a real HA frontend
window.addEventListener('hass-more-info', (e) => {
  document.querySelector('#log').textContent = 'more-info: ' + e.detail.entityId;
});

