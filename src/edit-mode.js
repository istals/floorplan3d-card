// Edit mode: side panel (Rooms / Devices / Mower / Views / Model / Data) and the pointer interactions on
// the plan (drawing rooms, dragging corners, adding doors, dragging markers to pin them, hiding model
// parts per view).

import * as E from './editor.js';
import { roomFloorId, LEVEL_SPACING } from './layout.js';
import { pointInPolygon, signedArea } from './placement.js';
import { buildMarkers, areaName } from './registry.js';
import { readSource, calibrationError, overlayUrl } from './mower.js';
import { readImagePixels, planToPixel, medianColor } from './mower-image.js';
import { ruleState, setRuleState, nextEyeState, viewTree, pickSelector, nextViewId, unmatchedSelectors, legacyShowRules,
  SECTION_DIRS, sectionDir, sectionPos, sectionAt, sectionRange, zoomToFor } from './views.js';
import { levelsFromFloorMap } from './bindings.js';
import { outlineLoops, pickLoop, rasterGrid, outlineFromGrid } from './outline.js';
import { snapPin, attachOffset, floorAtHeight } from './objects/logic.js';
import { actionTarget } from './objects/popup.js';
import { typeOf } from './objects/types.js';
import { resolveActions, validateAction } from './actions.js';
import { surfaceKind, rayGroups, stickSurface, nearestDistance, needsStick, worldOf, planOf } from './surface.js';

const DENSE_TRIS = 150000;

const CLICK_SLOP_PX = 5;
const SNAP_PX = 10; // snap radius never smaller than this many screen pixels

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Clipboard API needs a secure context (HA over plain http has none): fall back to a hidden textarea.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
const fmt = (v) => (Math.round(v * 100) / 100).toString();

export class EditMode {
  constructor(card) {
    this.card = card;
    this.tab = 'rooms';
    this.selectedRoom = null;
    this.selectedMarker = null;
    this.drawing = null; // { areaId, floorId, points, cursor }
    this.picking = null; // { areaId, busy, poly, floorId, note }
    this._outlineCache = new Map();
    this._outlineModel = null;
    this.doorMode = false;
    this.calibrating = null; // { src } waiting for a click on the plan
    this.colorPick = false; // waiting for a click on the mower icon in the map overlay
    this.overlayMove = false;
    this.drag = null;
    this.confirmDelete = false;
    this.saveState = '';
    this.message = null; // { text, error }
    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    this.panel.addEventListener('click', (e) => this._onPanelClick(e));
    this.panel.addEventListener('change', (e) => this._onPanelChange(e));
    this.panel.addEventListener('input', (e) => this._onPanelInput(e));
    // rebuilding the panel under a dragged slider would drop the drag: hold renders until release
    this.panel.addEventListener('pointerdown', (e) => { if (e.target.type === 'range') this._sliding = true; });
    const release = () => {
      if (!this._sliding) return;
      this._sliding = false;
      if (this._renderHeld) { this._renderHeld = false; this.render(); }
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    this.panel.addEventListener('change', (e) => { if (e.target.type === 'range') release(); });
    this._onKey = (e) => this._onKeyDown(e);
    this._onWinMove = (e) => this._dragMove(e);
    this._onWinUp = (e) => this._dragEnd(e);
    this._handles = new Map();
    this.vwSel = null; // a hidden view chosen in the Views tab (visible views follow the chips)
    this.vwPick = null; // { sel, idx } last part clicked in 3D on the Views tab
    this.vwExpanded = new Set(); // room/zone rows showing their objects
    this.objExpanded = new Set(); // Objects tab: room rows showing their objects (collapsed by default)
    this.objSel = null; // Objects tab: object picked in 3D / its row
    this.menu = null;
    this._onMenuAway = (e) => { if (this.menu && !e.composedPath().includes(this.menu)) this._closeMenu(); };
  }

  get layout() { return this.card._layout; }
  get hass() { return this.card._hass; }
  get view() { return this.card._view; }
  get floors() { return this.card._floors || []; }

  // The floor that "Place", drawing and the door tool work on: the floor shown on its own, the view's
  // single linked floor, else (overview, several or no linked floors) the HA floor of the view's
  // primary level, else the first floor.
  activeFloor() {
    const c = this.card, has = (id) => !!id && this.floors.some((f) => f.id === id);
    if (c._floorOnly && has(c._floor)) return c._floor;
    const st = c._viewState;
    if (st && !st.allFloors && st.floors.length === 1 && has(st.floors[0])) return st.floors[0];
    const prim = st && st.primary && c._levels ? c._levels.levelFloor[st.primary] : null;
    if (has(prim)) return prim;
    if (!st && has(c._floor)) return c._floor;
    return this.floors[0].id;
  }

  floorOf(room) {
    return roomFloorId(room, this.hass, this.floors);
  }

  room(id) {
    return (this.layout.rooms || []).find((r) => r.id === id) || null;
  }

  snapRadius() {
    return Math.max(E.SNAP_RADIUS, SNAP_PX / Math.max(this.view.pixelsPerMetre(), 1e-6));
  }

  enter() {
    window.addEventListener('keydown', this._onKey);
    this.view.setStems(true);
    this.render();
    this.refreshOverlay();
    this._syncStageClasses();
  }

  // card detached while editing / attached again: window listeners off / on (state kept)
  detach() {
    window.removeEventListener('keydown', this._onKey);
    this._endWindowDrag();
    this._closeMenu();
  }

  attach() {
    window.addEventListener('keydown', this._onKey);
  }

  exit() {
    window.removeEventListener('keydown', this._onKey);
    this._endWindowDrag();
    this.drawing = null;
    this.picking = null;
    this.doorMode = false;
    this.calibrating = null;
    this.colorPick = false;
    this.overlayMove = false;
    this.selectedRoom = null;
    this.selectedMarker = null;
    this.modelPick = null;
    this.vwPick = null;
    this.vwSel = null;
    this.pivoting = false;
    this._closeMenu();
    this.view.highlightModelNode(null);
    this.view.setStems(false);
    this.view.setOverlay({});
    this._syncStageClasses();
    this.card._applyMarkerSelection(null);
  }

  // called by the card after every rebuild
  afterUpdate() {
    if (this.selectedRoom && !this.room(this.selectedRoom)) this.selectedRoom = null;
    this.card._applyMarkerSelection(this.selectedMarker);
    this.refreshOverlay();
    if (this._sliding) this._renderHeld = true;
    else this.render();
  }

  commit(layout) {
    this.card._commit(layout);
  }

  setSaveState(s) {
    this.saveState = s;
    const el = this.panel.querySelector('.save-state');
    if (el) el.textContent = this._saveText();
    else this.render();
  }

  // ---------- plan pointer events (from the card's canvas listeners) ----------
  canvasDown(e) {
    this._down = e.button === 0 ? [e.clientX, e.clientY] : null;
  }

  canvasMove(e) {
    if (!this.drawing) return;
    const p = this._planPoint(e, this.drawing.floorId);
    if (!p) return;
    this.drawing.cursor = this._snapDraw(p);
    this.refreshOverlay();
  }

  canvasUp(e) {
    const d = this._down;
    this._down = null;
    if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) >= CLICK_SLOP_PX) return;
    this._click(e);
  }

  _planPoint(e, floorId, z = 0) {
    return this.view.planPoint(e.clientX, e.clientY, this.view.floorElevation(floorId) + z);
  }

  _click(e) {
    if (this.pivoting) {
      this._setPivot(e);
      return;
    }
    if (this.colorPick) {
      const p = this._planPoint(e, this.card._mowerFloor());
      if (!p) return;
      this.colorPick = false;
      this._syncStageClasses();
      this._pickMowerColor(p[0], p[1]);
      return;
    }
    if (this.calibrating) {
      const p = this._planPoint(e, this.card._mowerFloor());
      if (!p) return;
      const plan = E.snapPoint(p, { radius: 0 }).point;
      const { src } = this.calibrating;
      this.calibrating = null;
      this.setMower({ calibration: [...(this.mower().calibration || []), { src, plan }] });
      return;
    }
    if (this.picking && !this.drawing) {
      this._pickRoom(e);
      return;
    }
    if (this.tab === 'objects' && this.view.model && !this.drawing) return; // object taps: the card's gesture
    if (this.tab === 'views' && this.view.model && !this.drawing) {
      this._pickView(e);
      return;
    }
    if (this.tab === 'model' && this.view.model && !this.drawing) {
      const owner = this.view.pickModel(e.clientX, e.clientY);
      this.modelPick = owner ? (owner.kind === 'untagged' ? { kind: 'untagged', path: owner.path } : { kind: owner.kind, id: owner.id }) : null;
      this.view.highlightModelNode(owner ? owner.node : null);
      this.render();
      const row = this.panel.querySelector('tr.sel');
      if (row) row.scrollIntoView({ block: 'nearest' });
      return;
    }
    const fid = this.drawing ? this.drawing.floorId : this.activeFloor();
    const p = this._planPoint(e, fid);
    if (!p) return;
    if (this.drawing) {
      this._addDrawPoint(p);
      return;
    }
    const sel = this.room(this.selectedRoom);
    if (this.doorMode && sel) {
      const next = E.addDoor(sel, p, Math.max(0.6, this.snapRadius()));
      if (next !== sel) {
        this.doorMode = false;
        this.commit(E.upsertRoom(this.layout, next));
      }
      return;
    }
    // pick the smallest room under the click, so a room wins over the garden around it
    const hits = (this.layout.rooms || [])
      .filter((r) => this.floorOf(r) === fid && r.polygon && pointInPolygon(p, r.polygon))
      .sort((a, b) => Math.abs(signedArea(a.polygon)) - Math.abs(signedArea(b.polygon)));
    this.selectRoom(hits.length ? hits[0].id : null);
  }

  // ---------- pick a room's outline from the model ----------
  startPicking(areaId) {
    this.selectedRoom = null;
    this.selectedMarker = null;
    this.card._applyMarkerSelection(null);
    this.picking = { areaId, busy: false, poly: null };
    this.tab = 'rooms';
    this.message = null;
    this.refreshOverlay();
    this.render();
  }

  cancelPicking() {
    this.picking = null;
    this.refreshOverlay();
    this.render();
  }

  _pickRoom(e) {
    const pk = this.picking;
    if (pk.busy) return;
    const owner = this.view.pickModel(e.clientX, e.clientY);
    if (!owner) {
      this.message = { text: "Click on a room's floor", warn: true };
      this.render();
      return;
    }
    if (owner.kind === 'room' || owner.kind === 'zone') {
      const cur = this.layout.model || {};
      this.picking = null;
      this.message = { text: `Linked ${owner.label || owner.id} to ${areaName(this.hass, pk.areaId)}` };
      this.setModelProps({ rooms: { ...(cur.rooms || {}), [owner.id]: { ...(cur.rooms || {})[owner.id], area: pk.areaId } } });
      this.refreshOverlay();
      return;
    }
    if (owner.hit.up === false) {
      this.message = { text: "Click on a room's floor", warn: true };
      this.render();
      return;
    }
    pk.busy = true;
    pk.poly = null;
    this.message = { text: 'Tracing…' };
    this.render();
    const mesh = owner.hit.object, hit = owner.hit.point;
    setTimeout(() => {
      if (this.picking !== pk) return;
      pk.busy = false;
      try {
        const r = this._traceOutline(mesh, hit);
        pk.poly = r.poly;
        pk.floorId = this.activeFloor();
        this.message = r.note ? { text: r.note, warn: true } : null;
      } catch (err) {
        this.message = { text: `Could not trace this floor: ${err.message}`, error: true };
      }
      this.refreshOverlay();
      this.render();
    }, 0);
  }

  // all loops (or the raster grid for dense meshes) are cached per floor piece and height; each click then
  // only picks a loop. Fallback: the mesh's bounding rectangle.
  _traceOutline(mesh, hit) {
    const model = this.view.model;
    // loops are in card world: a new model or a new alignment invalidates them
    const placed = JSON.stringify(this.card._modelAlign());
    if (this._outlineModel !== model || this._outlineAlign !== placed) {
      this._outlineCache.clear();
      this._outlineModel = model;
      this._outlineAlign = placed;
    }
    const b = Math.round(hit[1] / 0.05);
    const key = (n) => mesh.uuid + ':' + n;
    let entry = null;
    for (const n of [b, b - 1, b + 1]) { entry = this._outlineCache.get(key(n)); if (entry) break; }
    if (!entry) {
      const tris = this.view.meshTriangles(mesh);
      entry = tris.length / 9 > DENSE_TRIS ? { grid: rasterGrid(tris, hit[1]) } : { loops: outlineLoops(tris, hit[1]) };
      this._outlineCache.set(key(b), entry);
    }
    const poly = entry.grid ? outlineFromGrid(entry.grid, hit) : entry.loops ? pickLoop(entry.loops, [hit[0], -hit[2]]) : null;
    return poly ? { poly } : { poly: this.view.meshPlanRect(mesh), note: "Used the floor piece's bounding rectangle — reshape it if needed" };
  }

  usePickedOutline() {
    const pk = this.picking;
    if (!pk || !pk.poly) return;
    const room = { id: E.newRoomId(this.layout), area_id: pk.areaId, polygon: pk.poly, doors: [], outdoor: false, floor_id: pk.floorId || this.activeFloor() };
    this.picking = null;
    this.selectedRoom = room.id;
    this.commit(E.upsertRoom(this.layout, room));
  }

  selectRoom(id) {
    this.selectedRoom = id;
    this.selectedMarker = null;
    this.doorMode = false;
    this.confirmDelete = false;
    if (id) this.tab = 'rooms';
    this.card._applyMarkerSelection(null);
    this.refreshOverlay();
    this.render();
  }

  selectMarker(id) {
    this.selectedMarker = id;
    this.selectedRoom = null;
    this.doorMode = false;
    if (id) this.tab = 'devices';
    this.card._applyMarkerSelection(id);
    this.refreshOverlay();
    this.render();
  }

  // ---------- drawing ----------
  startDrawing(areaId) {
    const area = this.hass.areas && this.hass.areas[areaId];
    // the floor shown on its own (or the view's only floor), else the area's floor, else the active floor
    const st = this.card._viewState;
    const single = this.card._floorOnly || (st && !st.allFloors && st.floors.length === 1 ? st.floors[0] : null);
    let floorId = single && this.floors.some((f) => f.id === single) ? single : null;
    if (!floorId) floorId = area && this.floors.some((f) => f.id === area.floor_id) ? area.floor_id : this.activeFloor();
    if (floorId !== this.card._floor) this.card._setFloor(floorId);
    if (this.card._mode !== 'top') this.card._setMode('top');
    this.selectedRoom = null;
    this.selectedMarker = null;
    this.card._applyMarkerSelection(null);
    this.drawing = { areaId, floorId, points: [], cursor: null };
    this.tab = 'rooms';
    this._syncStageClasses();
    this.refreshOverlay();
    this.render();
  }

  _snapDraw(p) {
    const vertices = [
      ...E.floorVertices(this.layout.rooms || [], (r) => this.floorOf(r), this.drawing.floorId),
      ...this.drawing.points,
    ];
    return E.snapPoint(p, { vertices, radius: this.snapRadius() });
  }

  _addDrawPoint(p) {
    const d = this.drawing;
    const s = this._snapDraw(p).point;
    const first = d.points[0];
    if (d.points.length >= 3 && Math.hypot(s[0] - first[0], s[1] - first[1]) <= this.snapRadius()) {
      this.finishDrawing();
      return;
    }
    d.points.push(s);
    this.refreshOverlay();
    this.render();
  }

  finishDrawing() {
    const d = this.drawing;
    if (!d) return;
    const polygon = E.cleanPolygon(d.points);
    if (polygon.length < 3) return;
    const area = this.hass.areas && this.hass.areas[d.areaId];
    const room = { id: E.newRoomId(this.layout), area_id: d.areaId, polygon, doors: [], outdoor: false };
    // only store the floor when it differs from the area's, so HA floor changes follow through
    if (!area || area.floor_id !== d.floorId) room.floor_id = d.floorId;
    this.drawing = null;
    this._syncStageClasses();
    this.selectedRoom = room.id;
    this.commit(E.upsertRoom(this.layout, room));
  }

  cancelDrawing() {
    this.drawing = null;
    this._syncStageClasses();
    this.refreshOverlay();
    this.render();
  }

  _onKeyDown(e) {
    const target = e.composedPath()[0];
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    if (this.menu && e.key === 'Escape') {
      this._closeMenu();
      e.preventDefault();
      return;
    }
    if (this.pivoting) {
      if (e.key !== 'Escape') return;
      this.cancelPivot();
      e.preventDefault();
    } else if (this.picking && !this.drawing) {
      if (e.key !== 'Escape') return;
      this.cancelPicking();
      e.preventDefault();
    } else if (this.drawing) {
      if (e.key === 'Enter') this.finishDrawing();
      else if (e.key === 'Escape') this.cancelDrawing();
      else if (e.key === 'Backspace') {
        this.drawing.points.pop();
        this.refreshOverlay();
        this.render();
      } else return;
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (this.colorPick) this.colorPick = false;
      else if (this.doorMode) this.doorMode = false;
      else if (this.selectedRoom) this.selectedRoom = null;
      else if (this.selectedMarker) this.selectMarker(null);
      this._syncStageClasses();
      this.refreshOverlay();
      this.render();
    }
  }

  _syncStageClasses() {
    this.card._stage.classList.toggle('drawing', !!this.drawing || !!this.picking || this.doorMode || !!this.calibrating || this.colorPick || !!this.pivoting);
    this.view.setPivotMarker(!!this.card._editing && this.tab === 'views');
    this.card._stage.classList.toggle('moving', this.overlayMove);
    const picking = !!this.card._editing && (this.tab === 'model' || this.tab === 'views') && !!this.view.model;
    this.card._stage.classList.toggle('picking', picking);
    this.card._stage.classList.toggle('picking-views', picking && this.tab === 'views');
  }

  // Overlay move tool: grab the pointer before OrbitControls sees it (capture phase on the stage).
  canvasDownCapture(e) {
    const o = this.mower().overlay;
    if (!this.overlayMove || !o || e.button !== 0) return;
    e.stopPropagation();
    const fid = this.card._mowerFloor();
    const start = this._planPoint(e, fid);
    if (!start) return;
    this._startWindowDrag({ kind: 'overlay', start: [e.clientX, e.clientY], plan: start, origin: [o.x || 0, o.y || 0], floorId: fid, moved: false });
  }

  // ---------- mower ----------
  mower() {
    return this.layout.mower || {};
  }

  setMower(patch) {
    const cur = this.layout.mower || { entity: '', source: 'gps', x_attr: 'x', y_attr: 'y', floor_id: this.floors[0].id, calibration: [], overlay: null, trail: true };
    this.commit({ ...this.layout, mower: { ...cur, ...patch } });
    this.render();
  }

  setOverlay(patch, rerender = true) {
    const m = this.mower();
    const cur = m.overlay || { entity: '', x: 0, y: 0, rotation: 0, width: 20, opacity: 0.6, refresh: 10 };
    const overlay = { ...cur, ...patch };
    this.card._commit({ ...this.layout, mower: { ...m, overlay } });
    if (rerender) this.render();
  }

  // live values in the Mower tab, without re-rendering the panel
  onStates() {
    if (this.tab !== 'mower') return;
    const el = this.panel.querySelector('.mower-live');
    if (el) el.innerHTML = this._mowerLiveHtml();
  }

  _mowerLiveHtml() {
    const m = this.mower();
    const st = m.entity && this.hass.states[m.entity];
    if (!m.entity) return m.source === 'image' ? 'Pick the mower entity: its marker follows the icon found on the map image.' : 'Pick the entity that reports the mower position.';
    if (!st) return `Entity <b>${esc(m.entity)}</b> not found.`;
    if (m.source === 'image') return this._mowerImageHtml();
    const r = readSource(st, m);
    if (!r) return m.source === 'xy'
      ? `No numeric <b>${esc(m.x_attr || 'x')}</b> / <b>${esc(m.y_attr || 'y')}</b> attributes on ${esc(m.entity)}.`
      : `No latitude/longitude on ${esc(m.entity)} (state: ${esc(st.state)}).`;
    const live = this.card._mowerLive;
    const raw = r.raw.map((v) => (m.source === 'xy' ? fmt(v) : v.toFixed(6))).join(', ');
    const plan = live && live.floorId ? `on plan (${fmt(live.x)}, ${fmt(live.y)})` : 'not on the plan yet: add a calibration point';
    return `Reading ${raw}<br>${plan}`;
  }

  _mowerImageHtml() {
    const m = this.mower();
    const ic = m.image || {};
    if (!m.overlay || !m.overlay.entity) return 'Add the map overlay below and align it with the plan: that alignment is the calibration.';
    if (!ic.color) return 'Pick the mower icon colour on the map (below).';
    const r = this.card._imageResult;
    const live = this.card._mowerLive;
    if (r && r.error) return `<span style="color: var(--error-color, #db4437)">${esc(r.error)}</span>`;
    if (r && r.missing) return 'Mower icon not found' + (live && live.floorId ? ` (last seen at ${fmt(live.x)}, ${fmt(live.y)})` : '') + '.';
    if (r && live && live.floorId) return `Found at ${fmt(live.x)}, ${fmt(live.y)} (${r.count} px)`;
    return 'Looking for the mower icon…';
  }

  // Colour under a plan point in the map image: median of the 5x5 pixels around it.
  async _pickMowerColor(x, y) {
    const m = this.mower();
    const o = m.overlay;
    const ic = m.image || {};
    const entity = ic.entity || (o && o.entity);
    const url = entity && overlayUrl(this.hass, entity, Date.now());
    if (!url || !o) { this.message = { text: 'Set the map overlay first.', error: true }; this.render(); return; }
    try {
      const img = await readImagePixels(url);
      const q = planToPixel(x, y, img.imgW, img.imgH, o);
      const k = img.width / img.imgW;
      const px = Math.floor(q.px * k), py = Math.floor(q.py * k);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
        this.message = { text: 'That point is outside the map image.', error: true };
        this.render();
        return;
      }
      const color = medianColor(img.data, img.width, img.height, px, py);
      this.message = null;
      // start tracking at the clicked icon (not the largest blob of its colour)
      this.card._imageBlob = { px: q.px, py: q.py, count: null, misses: 0, imgW: img.imgW, imgH: img.imgH, sampleW: img.width, color };
      this.setMower({ image: { tolerance: 40, min_pixels: 4, ...ic, color } });
    } catch (e) {
      console.warn('floorplan3d: could not read the mower map image', e);
      this.message = { text: "Can't read the map image.", error: true };
      this.render();
    }
  }

  // ---------- overlay ----------
  _handle(key, cls) {
    let el = this._handles.get(key);
    if (!el) {
      el = document.createElement('div');
      this._handles.set(key, el);
    }
    el.className = 'fp-handle ' + cls;
    return el;
  }

  refreshOverlay(preview) {
    if (!this.view) return;
    this._syncStageClasses();
    const color = this.card._built.theme ? this.card._built.theme.primary : 0x03a9f4;
    const lines = [], fills = [], handles = [];
    const used = new Set();
    const handle = (key, cls, x, y, floorId, setup) => {
      const el = this._handle(key, cls);
      used.add(key);
      el.onpointerdown = setup ? (e) => setup(e, el) : null;
      el.oncontextmenu = null;
      handles.push({ element: el, x, y, floorId });
      return el;
    };

    const room = preview || this.room(this.selectedRoom);
    if (room && room.polygon) {
      const fid = this.floorOf(room);
      fills.push({ points: room.polygon, floorId: fid, color, opacity: 0.16 });
      lines.push({ points: room.polygon, closed: true, floorId: fid, color });
      room.polygon.forEach(([x, y], i) => {
        const el = handle('v' + i, 'vertex', x, y, fid, (e, h) => this._vertexDown(e, room.id, i, h));
        el.title = 'Drag to move, right-click to delete';
        el.oncontextmenu = (e) => {
          e.preventDefault();
          const r = this.room(room.id);
          if (r) this.commit(E.upsertRoom(this.layout, E.removeVertex(r, i)));
        };
      });
      if (!this.drag) {
        room.polygon.forEach((a, i) => {
          const b = room.polygon[(i + 1) % room.polygon.length];
          const el = handle('m' + i, 'mid', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, fid, (e, h) => this._midDown(e, room.id, i, h));
          el.title = 'Drag to add a corner';
        });
      }
      (room.doors || []).forEach(([x, y], i) => handle('d' + i, 'door', x, y, fid));
    }

    const pk = this.picking;
    if (pk && pk.poly) {
      const fid = pk.floorId || this.activeFloor();
      fills.push({ points: pk.poly, floorId: fid, color, opacity: 0.25 });
      lines.push({ points: pk.poly, closed: true, floorId: fid, color });
    }

    const d = this.drawing;
    if (d) {
      const pts = d.cursor ? [...d.points, d.cursor.point] : d.points;
      lines.push({ points: pts, closed: false, floorId: d.floorId, color });
      d.points.forEach(([x, y], i) => handle('p' + i, i === 0 && d.points.length >= 3 ? 'draw first' : 'draw', x, y, d.floorId));
      if (d.cursor) handle('cursor', 'cursor ' + d.cursor.kind, d.cursor.point[0], d.cursor.point[1], d.floorId);
    }

    for (const k of [...this._handles.keys()]) if (!used.has(k)) this._handles.delete(k);
    this.view.setOverlay({ lines, fills, handles });
  }

  // ---------- drags (corners, midpoints, markers) ----------
  _startWindowDrag(drag) {
    this.drag = drag;
    this.view.setControlsEnabled(false);
    window.addEventListener('pointermove', this._onWinMove);
    window.addEventListener('pointerup', this._onWinUp);
    window.addEventListener('pointercancel', this._onWinUp);
  }

  _endWindowDrag() {
    const d = this.drag;
    if (d && d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
    if (d && d.kind === 'marker' && d.attach !== undefined && this.view) this.view.highlightModelNode(null);
    if (d && d.kind === 'marker' && this.view) this.view.setSurfacePreview(null);
    window.removeEventListener('pointermove', this._onWinMove);
    window.removeEventListener('pointerup', this._onWinUp);
    window.removeEventListener('pointercancel', this._onWinUp);
    if (this.view) this.view.setControlsEnabled(true);
    this.drag = null;
  }

  _vertexDown(e, roomId, index) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    this._startWindowDrag({ kind: 'vertex', roomId, index, start: [e.clientX, e.clientY], moved: false });
  }

  _midDown(e, roomId, edge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    this._startWindowDrag({ kind: 'mid', roomId, edge, start: [e.clientX, e.clientY], moved: false });
  }

  markerDown(m, e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (this.drawing || this.doorMode || this.calibrating || this.colorPick) return;
    if (m.id === this.card._mowerMarkerId) {
      this.selectMarker(m.id); // positioned live, nothing to drag
      return;
    }
    const pos = this.card._positions && this.card._positions.get(m.id);
    this.selectMarker(m.id);
    if (!pos) return;
    this._startWindowDrag({ kind: 'marker', id: m.id, pos: { ...pos }, start: [e.clientX, e.clientY], moved: false });
  }

  _dragMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < CLICK_SLOP_PX) return;
    d.moved = true;
    if (d.kind === 'overlay') {
      const p = this._planPoint(e, d.floorId);
      if (!p) return;
      const r = (v) => Math.round(v * 100) / 100;
      this.setOverlay({ x: r(d.origin[0] + p[0] - d.plan[0]), y: r(d.origin[1] + p[1] - d.plan[1]) }, false);
      return;
    }
    if (d.kind === 'marker') {
      d.last = { clientX: e.clientX, clientY: e.clientY };
      if (!e.altKey && this.view.model) {
        // magnetic: raycast at most once per frame, on the latest pointer position
        if (!d.raf) d.raf = requestAnimationFrame(() => { d.raf = 0; this._magnet(d); });
        return;
      }
      if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
      this._setDragTarget(d, null);
      this.view.setSurfacePreview(null); // Alt: free drag, no preview
      this._freeMarker(d, e);
      return;
    }
    let room = this.room(d.roomId);
    if (!room) return;
    if (d.kind === 'mid') {
      // first move of a midpoint handle inserts the corner, then it is a normal corner drag
      const a = room.polygon[d.edge], b = room.polygon[(d.edge + 1) % room.polygon.length];
      d.base = E.insertVertex(room, d.edge, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      d.kind = 'vertex';
      d.index = d.edge + 1;
    }
    room = d.base || room;
    const fid = this.floorOf(room);
    const p = this._planPoint(e, fid);
    if (!p) return;
    const otherRooms = (this.layout.rooms || []).filter((r) => r.id !== room.id);
    const others = E.floorVertices(otherRooms, (r) => this.floorOf(r), fid)
      .concat(room.polygon.filter((_, i) => i !== d.index));
    const s = E.snapPoint(p, { vertices: others, radius: this.snapRadius() }).point;
    d.preview = E.moveVertex(room, d.index, s);
    this.refreshOverlay(d.preview);
  }

  // Free drag (Alt, no model, nothing under the cursor): the plan point at the current height.
  _freeMarker(d, e) {
    d.snapped = false;
    const p = this._planPoint(e, d.pos.floorId, d.pos.z);
    if (!p) return;
    d.pos.x = p[0];
    d.pos.y = p[1];
    this.view.moveMarker(d.id, p[0], p[1], d.pos.z, d.pos.floorId);
  }

  // Magnetic drag: stick to the model surface under the pointer (5 cm off it); over a model object
  // highlight it, the drop attaches. Floor = the HA floor of the hit's level (else the current one).
  _magnet(d) {
    if (this.drag !== d || !d.last) return;
    const hit = this.view.surfaceAt(d.last.clientX, d.last.clientY);
    if (!hit) { // empty sky: keep the last snapped spot (a far plane hit would fling the marker away)
      this._setDragTarget(d, null);
      this.view.setSurfacePreview(null);
      return;
    }
    const owner = hit.owner;
    const level = owner ? (owner.kind === 'level' ? owner.id : owner.level) : null;
    const lf = (this.card._levels && this.card._levels.levelFloor) || {};
    // the HA floor bound to the hit's level, else the floor the hit stands on, else the current one
    const floorId = (level && lf[level] && this.floors.some((f) => f.id === lf[level]) ? lf[level] : null)
      || floorAtHeight(this.floors.map((f) => ({ id: f.id, elevation: this.view.floorElevation(f.id) })), hit.point.y)
      || d.pos.floorId;
    const pin = snapPin(hit, this.view.floorElevation(floorId), floorId);
    d.pos = { ...d.pos, x: pin.x, y: pin.y, z: pin.z, floorId };
    d.snapped = true;
    const layer = this.card._objects;
    const obj = owner && owner.kind === 'object' && layer && layer.objectAt(owner.id) ? owner : null;
    this._setDragTarget(d, obj);
    // preview: a ring on the surface, its face tinted, "Attach: <object>" over a model object
    const target = obj && layer.objectAt(obj.id);
    const label = obj ? 'Attach: ' + ((target && target.obj && target.obj.label) || obj.id) : null;
    this.view.setSurfacePreview({ point: hit.point, normal: hit.normal, tri: hit.tri, label });
    this.view.moveMarker(d.id, pin.x, pin.y, pin.z, floorId);
  }

  _setDragTarget(d, owner) {
    const id = owner ? owner.id : null;
    if ((d.attach || null) === id) return;
    d.attach = id;
    this.view.highlightModelNode(owner ? owner.node : null);
  }

  _dragEnd() {
    const d = this.drag;
    if (d && d.kind === 'marker' && d.raf) { // the last move is still waiting for its frame
      cancelAnimationFrame(d.raf);
      d.raf = 0;
      this._magnet(d);
    }
    this._endWindowDrag();
    if (!d || !d.moved) {
      if (d && d.kind !== 'marker') this.refreshOverlay();
      return;
    }
    if (d.kind === 'overlay') {
      this.render();
    } else if (d.kind === 'marker') {
      const at = { x: d.pos.x, y: d.pos.y, z: d.pos.z, floor_id: d.pos.floorId };
      const anchor = d.attach && this.card._objects && this.card._objects.anchorOf(d.attach);
      if (anchor) {
        const offset = attachOffset(anchor, d.pos, this.view.floorElevation(d.pos.floorId));
        this.commit(E.attachPin(this.layout, d.id, d.attach, offset, at));
      } else {
        this.commit(E.setPin(this.layout, d.id, { ...at, on_model: this._onModel(d.id) }, { grid: !d.snapped }));
      }
    } else if (d.preview) {
      this.commit(E.upsertRoom(this.layout, d.preview));
    } else {
      this.refreshOverlay();
    }
  }

  // ---------- panel ----------
  _saveText() {
    return { saving: 'Saving…', saved: 'Saved', failed: 'Save failed' }[this.saveState] || '';
  }

  render() {
    // a rebuild must not move the panel under the user: keep scroll position and the focused control
    const oldBody = this.panel.querySelector('.tab-body');
    const scroll = oldBody && this._renderedTab === this.tab ? oldBody.scrollTop : 0;
    const active = this.panel.contains(this.panel.getRootNode().activeElement) ? this.panel.getRootNode().activeElement : null;
    const focusKey = active && active.dataset && active.dataset.field ? [active.dataset.field, active.dataset.id || ''] : null;
    const report = this.panel.querySelector('details.report');
    if (report) this._reportOpen = report.open;
    const adv = this.panel.querySelector('details.advanced');
    if (adv) this._advancedOpen = adv.open;
    this._renderedTab = this.tab;
    const hasObjects = this._hasObjects();
    if (this.tab === 'objects' && !hasObjects) this.tab = 'devices';
    const tabs = [['rooms', 'Rooms'], ['devices', 'Devices'], ...(hasObjects ? [['objects', 'Objects']] : []), ['mower', 'Mower'], ['views', 'Views'], ['model', 'Model'], ['data', 'Data']];
    const body = {
      rooms: () => this._roomsTab(), devices: () => this._devicesTab(), objects: () => this._objectsTab(), mower: () => this._mowerTab(), views: () => this._viewsTab(),
      model: () => this._modelTab(), data: () => this._dataTab(),
    }[this.tab]();
    const msg = this.message ? `<div class="msg ${this.message.error ? 'error' : this.message.warn ? 'warn' : ''}">${esc(this.message.text)}</div>` : '';
    this.panel.innerHTML = `
      <div class="tabs">${tabs.map(([id, label]) => `<button data-act="tab" data-id="${id}" class="${this.tab === id ? 'on' : ''}">${label}</button>`).join('')}</div>
      <div class="tab-body">${msg}${body}</div>
      <div class="foot"><span class="save-state">${this._saveText()}</span><span>${esc(this._backendLabel())}</span></div>`;
    const newBody = this.panel.querySelector('.tab-body');
    if (newBody && scroll) newBody.scrollTop = scroll;
    if (focusKey) {
      const el = [...this.panel.querySelectorAll('[data-field]')]
        .find((x) => x.dataset.field === focusKey[0] && (x.dataset.id || '') === focusKey[1]);
      if (el) el.focus({ preventScroll: true });
    }
  }

  _backendLabel() {
    return { shared: 'Shared storage', user: 'Per-user storage', browser: 'Browser storage' }[this.card._store.backend] || '';
  }

  _areas() {
    const areas = Object.values(this.hass.areas || {});
    return areas.sort((a, b) => a.name.localeCompare(b.name));
  }

  _roomsTab() {
    const d = this.drawing;
    if (d) {
      return `<section class="box">
        <h3>Drawing: ${esc(areaName(this.hass, d.areaId))}</h3>
        <p class="hint">Click the corners on the plan. Points snap to 5 cm and to existing corners, so shared walls line up.
        Click the first point or press Enter to finish, Backspace removes the last point, Esc cancels.</p>
        <p>${d.points.length} point${d.points.length === 1 ? '' : 's'}</p>
        <div class="row"><button data-act="finish" ${d.points.length < 3 ? 'disabled' : ''} class="primary">Finish</button>
        <button data-act="undo-point" ${d.points.length ? '' : 'disabled'}>Undo point</button>
        <button data-act="cancel-draw">Cancel</button></div></section>`;
    }
    const pk = this.picking;
    if (pk) {
      return `<section class="box">
        <h3>Pick: ${esc(areaName(this.hass, pk.areaId))}</h3>
        ${pk.busy ? '<p class="hint">Tracing…</p>' : pk.poly
    ? `<p>${pk.poly.length} corners</p><div class="row"><button data-act="pick-use" class="primary">Use this outline</button>
        <button data-act="pick-draw">Draw instead</button></div>`
    : "<p class=\"hint\">Click on this room's floor in the model.</p>"}
        <div class="row"><button data-act="pick-cancel">Cancel</button></div></section>`;
    }
    const sel = this.room(this.selectedRoom);
    const rooms = this.layout.rooms || [];
    const areas = this._areas();
    let out = '';
    if (sel) {
      const areaOpts = areas.map((a) => `<option value="${esc(a.area_id)}" ${a.area_id === sel.area_id ? 'selected' : ''}>${esc(a.name)}</option>`);
      if (sel.area_id && !areas.some((a) => a.area_id === sel.area_id)) areaOpts.unshift(`<option selected value="${esc(sel.area_id)}">${esc(sel.area_id)} (missing)</option>`);
      const fid = this.floorOf(sel);
      const floorOpts = this.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === fid ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
      const doors = (sel.doors || []).map((p, i) => `<li>Door ${i + 1} <span class="dim">(${fmt(p[0])}, ${fmt(p[1])})</span> <button class="link" data-act="del-door" data-i="${i}">Remove</button></li>`).join('');
      out += `<section class="box">
        <h3>${esc(areaName(this.hass, sel.area_id))}</h3>
        <label>Area <select data-field="room-area">${areaOpts.join('')}</select></label>
        <label>Floor <select data-field="room-floor">${floorOpts}</select></label>
        <label class="check"><input type="checkbox" data-field="room-outdoor" ${sel.outdoor ? 'checked' : ''}> Outdoor (no walls)</label>
        <div class="sub">Doors</div>
        <ul class="plain">${doors || '<li class="dim">No doors</li>'}</ul>
        <button data-act="door-mode" class="${this.doorMode ? 'primary' : ''}">${this.doorMode ? 'Click a wall on the plan…' : 'Add door'}</button>
        <p class="hint">Drag corners to reshape. Drag an edge midpoint to add a corner, right-click a corner to delete it.</p>
        <div class="row">
          <button data-act="delete-room" class="danger">${this.confirmDelete ? 'Really delete?' : 'Delete room'}</button>
          <button data-act="deselect">Done</button>
        </div></section>`;
    }

    const byFloor = new Map(this.floors.map((f) => [f.id, []]));
    byFloor.set('', []);
    for (const a of areas) (byFloor.get(a.floor_id) || byFloor.get('')).push(a);
    for (const [fid, list] of byFloor) {
      if (!list.length) continue;
      const fname = fid ? this.floors.find((f) => f.id === fid).name : 'No floor';
      out += `<div class="sub">${esc(fname)}</div><ul class="list">`;
      for (const a of list) {
        const mr = (this.card._modelRooms || []).find((x) => x.area_id === a.area_id);
        if (mr) {
          out += `<li><span class="name">${esc(a.name)}</span><span class="pill ok">model</span>
            <button data-act="tab" data-id="model">Model</button></li>`;
          continue;
        }
        const r = rooms.find((x) => x.area_id === a.area_id);
        out += `<li class="${r && r.id === this.selectedRoom ? 'sel' : ''}"><span class="name">${esc(a.name)}</span>
          <span class="pill ${r ? 'ok' : 'missing'}">${r ? 'drawn' : 'missing'}</span>
          ${r ? `<button data-act="select-room" data-id="${esc(r.id)}">Select</button>` : `${this.view.model ? `<button data-act="pick" data-id="${esc(a.area_id)}">Pick</button>` : ''}<button data-act="draw" data-id="${esc(a.area_id)}">Draw</button>`}</li>`;
      }
      out += '</ul>';
    }
    const orphans = rooms.filter((r) => !(this.hass.areas || {})[r.area_id]);
    if (orphans.length) {
      out += '<div class="sub">Rooms without an HA area</div><ul class="list">';
      for (const r of orphans) out += `<li><span class="name">${esc(r.area_id || r.id)}</span><button data-act="select-room" data-id="${esc(r.id)}">Select</button></li>`;
      out += '</ul>';
    }
    if (!areas.length) out += '<p class="hint">No areas in Home Assistant yet. Create areas under Settings → Areas.</p>';

    // floor heights come from the model when there is one; the table is for model-less layouts
    if (this.view.model) return out;
    const stored = new Set((this.layout.floors || []).map((f) => f.id));
    const haFloors = new Set(Object.keys(this.hass.floors || {}));
    out += `<details class="advanced" ${this._advancedOpen ? 'open' : ''}><summary>Advanced (no model)</summary>
      <div class="sub">Floors</div><table class="floors"><tr><th></th><th>Elevation m</th><th>Height m</th><th></th></tr>`;
    for (const f of this.floors) {
      out += `<tr><td>${esc(f.name)}</td>
        <td><input type="number" step="0.05" data-field="floor-elevation" data-id="${esc(f.id)}" value="${fmt(f.elevation)}"></td>
        <td><input type="number" step="0.05" min="0.5" data-field="floor-height" data-id="${esc(f.id)}" value="${fmt(f.height)}"></td>
        <td>${!haFloors.has(f.id) && stored.has(f.id) ? `<button class="link" data-act="del-floor" data-id="${esc(f.id)}">Remove</button>` : ''}</td></tr>`;
    }
    out += `</table><p class="hint">Floors come from Home Assistant (Settings → Areas → Floors). Add one here only for a level HA doesn't have.</p>
      <button data-act="add-floor">Add floor</button></details>`;
    return out;
  }

  _allMarkers() {
    return buildMarkers(this.hass, { ...this.layout, hidden: [] }, { group_by: this.card._config.group_by });
  }

  _devicesTab() {
    const all = this._allMarkers();
    const byId = new Map(all.map((m) => [m.id, m]));
    const hidden = this.layout.hidden || [];
    let out = '';
    const m = this.selectedMarker && byId.get(this.selectedMarker);
    if (m) {
      const pos = this.card._positions && this.card._positions.get(m.id);
      const pin = (this.layout.pins || {})[m.id];
      const pinned = !!pin;
      const attached = pin && pin.attach;
      const target = attached && this.card._objects && this.card._objects.objectAt(attached);
      if (m.id === this.card._mowerMarkerId) {
        return out + `<section class="box"><h3>${esc(m.name)}</h3><p class="dim">${esc(m.entityId)}</p>
          <p>Follows the live mower position. Set it up in the Mower tab.</p>
          <div class="row"><button data-act="deselect-marker">Done</button></div></section>`;
      }
      out += `<section class="box"><h3>${esc(m.name)}</h3>
        <p class="dim">${esc(m.entityId)}${m.areaId ? ' · ' + esc(areaName(this.hass, m.areaId)) : ''}</p>
        <p>${attached ? `Attached to ${esc((target && target.obj.label) || attached)}${target ? '' : ' (not in the model)'}` : pinned ? 'Pinned' : 'Auto placed'}</p>
        ${pos ? `<label>Height above floor (m) <input type="number" step="0.05" min="0" data-field="marker-z" value="${fmt(pos.z)}"></label>` : ''}
        <div class="row">
          ${attached ? '<button data-act="detach">Detach</button>' : ''}
          ${pinned ? '<button data-act="unpin">Return to auto placement</button>' : ''}
          <button data-act="hide">Hide</button>
          <button data-act="deselect-marker">Done</button>
        </div></section>`;
    }
    out += `<p class="hint">Drag any marker on the plan to pin it there${this.view.model ? ' (it sticks to the model surface; drop on a model object to attach it, hold Alt for a free drag)' : ''}. Click a marker to select it.</p>`;
    if (this.view.model) {
      const st = this.stick;
      if (st) {
        const n = st.moves.length;
        out += `<section class="box stick"><p>${n ? `${n} marker${n === 1 ? '' : 's'} will move onto the nearest surface.` : 'Every pinned marker already sits on a surface.'}</p>
          <div class="row">${n ? '<button data-act="stick-apply" class="primary">Apply</button>' : ''}<button data-act="stick-cancel">${n ? 'Cancel' : 'OK'}</button></div></section>`;
      } else {
        out += '<div class="row"><button data-act="stick-all" title="Pinned markers floating more than 15 cm from the model move onto the nearest wall, ceiling or floor">Stick all to surfaces</button></div>';
      }
    }

    const unplaced = all.filter((x) => !hidden.includes(x.id) && !hidden.includes(x.entityId) && !(this.card._positions || new Map()).has(x.id));
    out += `<div class="sub">Devices without a room (${unplaced.length})</div>`;
    if (unplaced.length) {
      out += '<ul class="list">';
      for (const x of unplaced) {
        out += `<li><span class="name">${esc(x.name)}<span class="dim"> · ${x.areaId ? esc(areaName(this.hass, x.areaId)) : 'no area'}</span></span>
          <button data-act="place" data-id="${esc(x.id)}">Place</button></li>`;
      }
      out += '</ul>';
    } else out += '<p class="dim">Every device is on the plan.</p>';

    out += `<div class="sub">Hidden (${hidden.length})</div>`;
    if (hidden.length) {
      out += '<ul class="list">';
      for (const id of hidden) {
        const x = byId.get(id) || all.find((y) => y.entityId === id);
        out += `<li><span class="name">${esc(x ? x.name : id)}</span><button data-act="unhide" data-id="${esc(id)}">Unhide</button></li>`;
      }
      out += '</ul>';
    } else out += '<p class="dim">Nothing hidden.</p>';
    return out;
  }

  _hasObjects() {
    const mb = this.view.model && this.card.modelBindings();
    return !!(mb && mb.manifest.objects && mb.manifest.objects.length);
  }

  // Objects tab: model objects by level -> room (rooms collapsed), each with its entity binding.
  _objectsTab() {
    const mb = this.card.modelBindings();
    const objs = (mb && mb.manifest.objects) || [];
    const states = this.hass.states;
    const bindings = this.card._bindings || new Map();
    const ids = Object.keys(states).sort();
    const DOMAINS = {
      light: ['light', 'switch'], light_strip: ['light', 'switch'], mower: ['lawn_mower'], dock: ['lawn_mower', 'binary_sensor'],
      ev_charger: ['sensor', 'switch', 'binary_sensor'], climate: ['climate'],
    };
    const ICONS = {
      light: 'mdi:lightbulb', light_strip: 'mdi:led-strip-variant', mower: 'mdi:robot-mower', dock: 'mdi:home-lightning-bolt',
      ev_charger: 'mdi:ev-station', climate: 'mdi:thermostat',
    };
    const listFor = (type) => {
      const d = DOMAINS[type];
      return d ? ids.filter((id) => d.includes(id.split('.')[0])) : ids;
    };
    const types = [...new Set(objs.map((o) => (DOMAINS[o.type] ? o.type : 'other')))];
    const datalists = types.map((t) => `<datalist id="fp-obj-${t}">${listFor(t).map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`).join('');
    const lo = this.layout.objects || {};
    const rowHtml = (o) => {
      const b = bindings.get(o.id) || {};
      const t = DOMAINS[o.type] ? o.type : 'other';
      const saved = lo[o.id] || {};
      const explicit = saved.entity !== undefined;
      const sug = (o.suggest || {}).entity;
      let badge = '', value = '', ph = 'auto: none';
      if (explicit) {
        value = saved.entity === null ? 'none' : saved.entity;
        if (b.missing) badge = '<span class="badge warn">entity not found</span>';
      } else if (b.entity) { badge = '<span class="badge">auto</span>'; ph = b.entity; } else if (sug) {
        badge = '<span class="badge warn">entity not found</span>';
        ph = `auto: ${sug}`;
      }
      const sel = this.objSel === o.id;
      // Test only where a tap could toggle something (not hidden, own entity or a known group controller)
      const testable = !b.hidden && !!actionTarget(o, b, this.card._groups || {});
      return `<li class="obj${sel ? ' sel' : ''}${b.hidden ? ' hid' : ''}" data-obj="${esc(o.id)}">
        <div class="orow"><ha-icon icon="${ICONS[t] || 'mdi:cube-outline'}"></ha-icon><span class="name">${esc(o.label || o.id)}</span>${badge}
          ${testable ? `<button data-act="obj-test" data-id="${esc(o.id)}" title="Toggle it like a tap in the view">Test</button>` : ''}
          <label class="check"><input type="checkbox" data-field="obj-hidden" data-id="${esc(o.id)}" ${b.hidden ? 'checked' : ''}> Hide</label></div>
        <input list="fp-obj-${t}" data-field="obj-entity" data-id="${esc(o.id)}" value="${esc(value)}" placeholder="${esc(ph)}" title="Empty: automatic; type none to leave it unbound">
        ${o.group ? `<div class="dim">Group ${esc(o.group)}</div>` : ''}${this._objActionsHtml(o, saved.ui)}</li>`;
    };
    const levelOf = new Map(mb.manifest.levels.map((l) => [l.id, l]));
    const roomOf = new Map(mb.manifest.rooms.map((r) => [r.id, r]));
    const order = [...new Set([...mb.manifest.levels.map((l) => l.id), ...objs.map((o) => o.level)])];
    let out = datalists + '<p class="hint">Bind each model object to a Home Assistant entity. Empty means automatic; "none" leaves it unbound. Click an object in the plan to find its row. Tap / Hold / Double tap pick its actions (card YAML <code>actions:</code> overrides these).</p>';
    out += '<ul class="otree">';
    for (const lid of order) {
      const inLevel = objs.filter((o) => o.level === lid);
      if (!inLevel.length) continue;
      const lv = levelOf.get(lid);
      out += `<li class="room lvl"><span class="name">${esc(lv ? lv.label : lid || 'No level')}</span></li>`;
      const roomIds = [...new Set(inLevel.map((o) => o.room || ''))];
      for (const rid of roomIds) {
        const list = inLevel.filter((o) => (o.room || '') === rid);
        const key = `${lid}/${rid}`;
        const open = this.objExpanded.has(key) || list.some((o) => o.id === this.objSel);
        const r = roomOf.get(rid);
        out += `<li class="room" style="--d:1"><button class="link expand" data-act="obj-expand" data-key="${esc(key)}">${open ? '\u25be' : '\u25b8'}</button>
          <span class="name">${esc(r ? r.label : rid ? rid : 'No room')}</span><span class="dim">${list.length}</span></li>`;
        if (open) out += list.map(rowHtml).join('');
      }
    }
    out += '</ul>';
    const groups = [...new Set(objs.map((o) => o.group).filter(Boolean))].sort();
    if (groups.length) {
      const lg = this.layout.groups || {};
      const gl = ids.filter((id) => /^(light|switch)\./.test(id));
      out += `<div class="sub">Groups</div><p class="hint">A group controller must be on too: a fixture is lit only while its own entity and the controller are both on.</p>
        <datalist id="fp-grp-ents">${gl.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
      out += groups.map((g) => {
        const e = (lg[g] && lg[g].entity) || '';
        const missing = e && !states[e] ? ' <span class="badge warn">entity not found</span>' : '';
        return `<label class="grp" data-grp="${esc(g)}">${esc(g)}${missing} <input list="fp-grp-ents" data-field="grp-entity" data-id="${esc(g)}"
        value="${esc(e)}" placeholder="no controller" title="Empty or none: no controller"></label>`;
      }).join('');
    }
    return out;
  }

  // Objects tab: Tap / Hold / Double tap selects (Default = the model / type action) with the fields each needs.
  _objActionsHtml(o, ui = {}) {
    const def = resolveActions({ modelUi: o.ui, kind: 'object', id: o.id, typeDefaults: typeOf(o.type).defaults });
    const KINDS = ['toggle', 'more-info', 'popup', 'navigate', 'url', 'perform-action', 'none'];
    const FIELDS = {
      navigate: [['navigation_path', '/lovelace/0']], url: [['url_path', 'https://… or /local/…']],
      'perform-action': [['perform_action', 'light.turn_on'], ['target', 'target entity_id']],
    };
    const id = esc(o.id);
    let sels = '', fields = '', warn = '';
    for (const [w, label] of [['tap', 'Tap'], ['hold', 'Hold'], ['double_tap', 'Double tap']]) {
      const cur = (ui || {})[`${w}_action`] || null;
      const d = def[w] ? def[w].action : 'none';
      sels += `<label class="act">${label}<select data-field="obj-act" data-id="${id}" data-which="${w}">
        <option value="">Default (${esc(d)})</option>${KINDS.map((k) => `<option value="${k}"${cur && cur.action === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`;
      for (const [key, ph] of (cur && FIELDS[cur.action]) || []) {
        const v = key === 'target' ? (cur.target && cur.target.entity_id) || '' : cur[key] || '';
        fields += `<input data-field="obj-act-field" data-id="${id}" data-which="${w}" data-key="${key}" value="${esc(v)}" placeholder="${esc(`${label}: ${ph}`)}">`;
      }
      const msg = cur && validateAction(cur);
      if (msg) warn += `<div class="badge warn">${esc(label)}: ${esc(msg)}</div>`;
    }
    return `<div class="oacts">${sels}</div>${fields}${warn}`;
  }

  _setObjAction(el) {
    const id = el.dataset.id, which = el.dataset.which;
    const cur = (((this.layout.objects || {})[id] || {}).ui || {})[`${which}_action`] || null;
    if (el.dataset.field === 'obj-act') {
      const v = el.value;
      this.commit(E.setObjectUi(this.layout, id, which, v ? (cur && cur.action === v ? cur : { action: v }) : null));
      return;
    }
    if (!cur) return;
    const key = el.dataset.key, v = el.value.trim();
    const next = { ...cur };
    if (key === 'target') {
      if (v) next.target = { entity_id: v };
      else delete next.target;
    } else if (v) next[key] = v;
    else delete next[key];
    this.commit(E.setObjectUi(this.layout, id, which, next));
  }

  // A click on an object in 3D (Objects tab): open its room, select and show its row.
  selectObject(id) {
    const mb = this.card.modelBindings();
    const o = mb && mb.manifest.objects.find((x) => x.id === id);
    if (!o) return;
    this.objSel = id;
    this.objExpanded.add(`${o.level}/${o.room || ''}`);
    this.render();
    const row = [...this.panel.querySelectorAll('li.obj')].find((x) => x.dataset.obj === id);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      row.classList.add('flash');
    }
  }

  _mowerTab() {
    const m = this.mower();
    const states = this.hass.states;
    const ids = Object.keys(states).sort();
    const posIds = ids.filter((id) => /^(device_tracker|sensor|lawn_mower|vacuum)\./.test(id));
    const picIds = ids.filter((id) => /^(image|camera)\./.test(id));
    const datalist = (id, list) => `<datalist id="${id}">${list.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
    const floorOpts = this.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === this.card._mowerFloor() ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    const cal = m.calibration || [];
    const err = calibrationError(cal, m.source === 'xy' ? 'xy' : 'gps');
    const fitName = ['', 'shift only', 'shift, rotate, scale', 'affine (least squares)'][Math.min(cal.length, 3)];
    let out = `<div class="sub">Position</div>
      <label>Entity <input list="fp-pos-ents" data-field="mower-entity" value="${esc(m.entity || '')}" placeholder="device_tracker.mower_position"></label>
      ${datalist('fp-pos-ents', posIds)}
      <label>Source <select data-field="mower-source">
        <option value="gps" ${m.source !== 'xy' && m.source !== 'image' ? 'selected' : ''}>GPS (latitude / longitude)</option>
        <option value="xy" ${m.source === 'xy' ? 'selected' : ''}>Map x / y attributes</option>
        <option value="image" ${m.source === 'image' ? 'selected' : ''}>Live map image (mower icon colour)</option></select></label>
      ${m.source === 'xy' ? `<div class="row"><label>x attribute <input data-field="mower-xattr" value="${esc(m.x_attr || 'x')}"></label>
        <label>y attribute <input data-field="mower-yattr" value="${esc(m.y_attr || 'y')}"></label></div>` : ''}
      <label>Floor <select data-field="mower-floor">${floorOpts}</select></label>
      <label class="check"><input type="checkbox" data-field="mower-trail" ${m.trail !== false ? 'checked' : ''}> Show trail (this session)</label>
      <p class="hint mower-live">${this._mowerLiveHtml()}</p>`;
    if (!m.entity) return out;

    if (m.source !== 'image') out += this._calibrationHtml(m, cal, err, fitName);
    else if (this.card._trail && this.card._trail.length) out += '<div class="row"><button data-act="trail-clear">Clear trail</button></div>';
    out += this._overlayHtml(m, picIds, datalist);
    if (m.source === 'image') out += this._mowerImageSection(m);
    out += '<div class="row"><button data-act="mower-remove" class="danger">Remove mower</button></div>';
    return out;
  }

  _mowerImageSection(m) {
    const ic = m.image || {};
    const o = m.overlay;
    let out = '<div class="sub">Mower icon on the map</div>';
    out += `<label>Image entity <input list="fp-pic-ents" data-field="mower-img-entity" value="${esc(ic.entity || '')}" placeholder="${esc((o && o.entity) || 'same as the overlay')}"></label>`;
    if (this.colorPick) {
      out += `<section class="box"><p>Click the mower icon on the map overlay. Esc cancels.</p>
        <div class="row"><button data-act="img-pick-cancel">Cancel</button></div></section>`;
    }
    const sw = ic.color ? `<span class="swatch" style="display:inline-block;width:18px;height:18px;border-radius:4px;vertical-align:middle;border:1px solid var(--divider-color);background:rgb(${ic.color.map(Number).join(',')})"></span> rgb(${ic.color.join(', ')})` : '';
    out += `<div class="row"><button data-act="img-pick" class="${ic.color || this.colorPick ? '' : 'primary'}" ${this.colorPick || !(o && o.entity) ? 'disabled' : ''}>Pick mower colour</button> ${sw}</div>`;
    if (ic.color) {
      const tol = ic.tolerance ?? 40;
      out += `<label><span class="lab">Colour tolerance<span class="val" data-val="img-tolerance">${tol}</span></span>
        <input type="range" data-field="mower-img-tolerance" min="0" max="255" step="1" value="${tol}"></label>`;
    }
    out += `<p class="hint">Align the map overlay with the plan first: the alignment maps image pixels to the plan, so no
      calibration points are needed. Then pick the colour of the mower icon on the map.</p>`;
    return out;
  }

  _calibrationHtml(m, cal, err, fitName) {
    let out = `<div class="sub">Calibration (${cal.length} point${cal.length === 1 ? '' : 's'}${cal.length ? ': ' + fitName : ''})</div>`;
    if (this.calibrating) {
      out += `<section class="box"><p>Click on the plan where the mower is right now.</p>
        <div class="row"><button data-act="cal-cancel">Cancel</button></div></section>`;
    }
    out += '<ul class="plain">' + cal.map((c, i) => `<li>${i + 1}. (${c.src.map((v) => (m.source === 'xy' ? fmt(v) : v.toFixed(6))).join(', ')}) → (${fmt(c.plan[0])}, ${fmt(c.plan[1])})
      <button class="link" data-act="cal-del" data-i="${i}">Remove</button></li>`).join('') + '</ul>';
    if (cal.length >= 3) out += `<p class="dim">Fit error ${fmt(err)} m</p>`;
    out += `<div class="row"><button data-act="cal-add" class="${this.calibrating ? '' : 'primary'}" ${this.calibrating ? 'disabled' : ''}>Add point</button>
      ${this.card._trail && this.card._trail.length ? '<button data-act="trail-clear">Clear trail</button>' : ''}</div>
      <p class="hint">"Add point" takes the current reading, then you click where the mower really is. One point aligns
      a GPS track north-up, two fix rotation and scale, three or more also correct skew. Spread points far apart.</p>`;
    return out;
  }

  _overlayHtml(m, picIds, datalist) {
    let out = '';
    const o = m.overlay;
    out += `<div class="sub">Map overlay</div>
      <label>Image or camera entity <input list="fp-pic-ents" data-field="ov-entity" value="${esc((o && o.entity) || '')}" placeholder="image.mower_map"></label>
      ${datalist('fp-pic-ents', picIds)}`;
    if (o && o.entity) {
      const slider = (f, label, min, max, step, v) => `<label><span class="lab">${label}<span class="val" data-val="${f}">${fmt(v)}</span></span>
        <input type="range" data-field="ov-${f}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
      out += slider('x', 'x (m)', -100, 100, 0.05, o.x ?? 0)
        + slider('y', 'y (m)', -100, 100, 0.05, o.y ?? 0)
        + slider('rotation', 'Rotation (°)', -180, 180, 0.5, o.rotation ?? 0)
        + slider('width', 'Width (m)', 1, 200, 0.1, o.width ?? 20)
        + slider('opacity', 'Opacity', 0, 1, 0.05, o.opacity ?? 0.6)
        + (o.entity.startsWith('camera.') ? slider('refresh', 'Refresh every (s)', 1, 120, 1, o.refresh ?? 10) : '');
      out += `<div class="row"><button data-act="ov-move" class="${this.overlayMove ? 'primary' : ''}">${this.overlayMove ? 'Drag the map on the plan…' : 'Move with mouse'}</button>
        <button data-act="ov-remove">Remove overlay</button></div>`;
    }
    return out;
  }

  // ---------- views ----------
  // The view the Views tab edits: a hidden view picked in its select, else the active chip.
  _vwView() {
    const vs = this.card._views || [];
    // (kept while the view is visible: a hide is committed before the view list catches up)
    const v = this.vwSel && vs.find((x) => x.id === this.vwSel);
    if (v && v.hidden) return v;
    return this.card.currentView();
  }

  // the card switched views (chip or select)
  onViewChanged() {
    this.vwSel = null;
    this._closeMenu();
    if (this.tab === 'views') this.render();
  }

  _layoutRules(id) {
    const v = (this.layout.views || {})[id];
    return v && Array.isArray(v.rules) ? v.rules : [];
  }

  _setRule(id, sel, state) {
    this.card.saveViewPatch(id, { rules: setRuleState(this._layoutRules(id), sel, state) });
  }

  // Tree rows for the loaded model, with the manifest's labels (cached per node index).
  _tree() {
    const idx = this.card.viewIndex();
    const mb = this.card._mb;
    if (!idx || !mb) return null;
    if (this._treeCache && this._treeCache.idx === idx) return this._treeCache.tree;
    const labels = {};
    for (const l of mb.manifest.levels) labels['level:' + l.id] = l.label;
    for (const r of mb.manifest.rooms) labels[r.kind + ':' + r.id] = r.label;
    for (const o of mb.manifest.objects || []) if (o.label) labels['object:' + o.id] = o.label;
    const tree = viewTree(idx, labels);
    const rowOf = new Map(); // node position -> selector of the row listing it
    for (const r of [...tree.tree, ...tree.groups]) for (const i of r.nodes) if (!rowOf.has(i)) rowOf.set(i, r.sel);
    tree.rowOf = rowOf;
    this._treeCache = { idx, tree };
    return tree;
  }

  _viewsTab() {
    const card = this.card;
    const views = card._views || [];
    const v = this._vwView();
    if (!v) return '<p class="hint">No views yet.</p>';
    const st = card._stateFor(v);
    const lv = (this.layout.views || {})[v.id] || {};
    const i = views.indexOf(v);
    const visible = views.filter((x) => !x.hidden).length;
    const opts = views.map((x) => `<option value="${esc(x.id)}" ${x.id === v.id ? 'selected' : ''}>${esc(x.label)}${x.hidden ? ' (hidden)' : ''}</option>`).join('');
    const hideLabel = v.source === 'added' ? 'Delete view' : v.hidden ? 'Unhide' : 'Hide';
    const top = card._mode === 'top';
    let out = `<p class="hint">Each view is a button on the card. Choose what it shows: click a part of the model, or use the eyes below.</p>
      <label>View <select data-field="vw-view">${opts}</select></label>
      <label>Label <input data-field="vw-label" value="${esc(v.label)}"></label>
      <div class="row"><button data-act="vw-add">Add view</button>
        <button data-act="vw-hide" ${!v.hidden && v.source !== 'added' && visible <= 1 ? 'disabled' : ''} class="${v.source === 'added' ? 'danger' : ''}">${hideLabel}</button>
        <button data-act="vw-up" ${i <= 0 ? 'disabled' : ''} title="Move left">Up</button>
        <button data-act="vw-down" ${i < 0 || i >= views.length - 1 ? 'disabled' : ''} title="Move right">Down</button></div>
      <div class="sub">Linked HA floors</div>
      <div class="floor-links">${this.floors.map((f) => `<label class="check"><input type="checkbox" data-field="vw-floor" data-id="${esc(f.id)}" ${st.floors.includes(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')}</div>
      <p class="hint">Devices on linked floors show in this view. None checked: the view belongs to no floor (e.g. a garden view).</p>
      <div class="sub">Camera${top ? ' (top view)' : ''}</div>
      <p class="hint">${top ? (v.camera_top ? 'Top view opens with a saved centre and zoom.' : 'Top view keeps the current position.')
    : v.camera ? 'Opens with a saved camera.' : 'Opens framing the house.'}</p>
      <div class="row"><button data-act="vw-save-cam" ${v.hidden ? 'disabled' : ''}>Save current view as start</button>
        <button data-act="vw-reset-cam" ${(top ? lv.camera_top : lv.camera) ? '' : 'disabled'}>Reset camera</button></div>
      <div class="row">${this.pivoting ? '<button data-act="vw-pivot-cancel">Cancel</button>'
    : `<button data-act="vw-pivot" ${v.hidden || v.id !== card._viewId ? 'disabled' : ''} title="Click a point: the camera rotates and zooms around it">Set rotation centre</button>`}</div>
      ${this.pivoting ? '<p class="hint">Click where the rotation centre should be (Esc cancels).</p>' : ''}
      <label>Zoom towards <select data-field="vw-zoom-to">${[['', `Card default (${zoomToFor(null, card._config)})`], ['center', 'Centre'], ['cursor', 'Cursor']]
    .map(([val, label]) => `<option value="${val}" ${(lv.zoom_to || '') === val ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
    out += this._sectionHtml(v, lv);
    if (this.view.model && !this.view.isTagged()) {
      out += `<label class="check"><input type="checkbox" data-field="vw-cut" ${(v.cut ?? v.id !== 'all') ? 'checked' : ''}> Cut at storey height</label>`;
    }
    const idx = card.viewIndex();
    const tree = this._tree();
    const rules = this._layoutRules(v.id);
    if (idx && tree && this.view.model) {
      const eff = st.effective;
      // fully shown = the node and everything below it visible (nodes are in pre-order)
      const full = new Array(idx.nodes.length);
      for (let k = idx.nodes.length - 1; k >= 0; k--) full[k] = !eff || (!!eff[k] && idx.nodes[k].children.every((c) => full[c]));
      const yamlRules = ((card._config.views || {})[v.id] || {}).rules;
      const yamlSels = new Set((Array.isArray(yamlRules) ? yamlRules : []).map((r) => r && (r.show ?? r.hide)));
      const eyeTitle = { default: 'Default (from the model); click: show', shown: 'Shown here; click: hide', hidden: 'Hidden here; click: back to default' };
      const eyeIcon = { default: 'mdi:eye-outline', shown: 'mdi:eye', hidden: 'mdi:eye-off' };
      const row = (r, cls = '') => {
        const on = eff ? r.nodes.some((n) => eff[n]) : true;
        const part = on && !r.nodes.every((n) => full[n]);
        const state = ruleState(rules, r.sel);
        const picked = this.vwPick && this.vwPick.sel === r.sel ? ' picked' : '';
        const vis = part ? ['Partly shown', 'mdi:circle-half-full'] : on ? ['Visible', 'mdi:cube-outline'] : ['Hidden', 'mdi:cube-off-outline'];
        const open = this.vwExpanded.has(r.sel);
        const toggle = r.children && !r.sel.startsWith('level:')
          ? `<button class="link expand" data-act="vw-expand" data-sel="${esc(r.sel)}" title="${open ? 'Hide' : 'Show'} its ${r.children} object(s)">${open ? '\u25be' : '\u25b8'}</button>` : '';
        return `<li data-sel="${esc(r.sel)}" class="${cls}${on ? '' : ' off'}${part ? ' part' : ''}${picked}" style="--d:${r.depth}" title="${esc(r.path || r.sel)}">
          <span class="state" title="${vis[0]} in this view"><ha-icon icon="${vis[1]}"></ha-icon></span>
          <span class="name">${esc(r.label)}${part ? ' <span class="dim">partly</span>' : ''}</span>${toggle}
          ${yamlSels.has(r.sel) ? '<span class="yaml" title="The card YAML has a rule for this part; it wins over this setting">YAML</span>' : ''}
          <button class="eye ${state}" data-act="vw-eye" data-sel="${esc(r.sel)}" title="${eyeTitle[state]}"><ha-icon icon="${eyeIcon[state]}"></ha-icon></button></li>`;
      };
      const shownRows = tree.tree.filter((r) => !r.parent || r.parent.startsWith('level:') || this.vwExpanded.has(r.parent));
      out += '<div class="sub">Model</div>';
      out += tree.tree.length ? '<ul class="vtree">' + shownRows.map((r) => row(r, r.sel.startsWith('level:') ? 'lvl' : '')).join('') + '</ul>'
        : '<p class="dim">No tagged levels or rooms.</p>';
      if (tree.layers.length) out += '<div class="sub">Layers</div><ul class="vtree">' + tree.layers.map((r) => row(r)).join('') + '</ul>';
      if (tree.groups.length) out += '<div class="sub">Model groups</div><ul class="vtree">' + tree.groups.map((r) => row(r)).join('') + '</ul>';
      const gone = unmatchedSelectors(idx, rules);
      if (gone.length) {
        out += '<div class="sub">Not in this model</div><ul class="vtree">' + gone.map((s) => `<li class="gone" data-sel="${esc(s)}"><span class="name">${esc(s)}</span>
          <button class="link" data-act="vw-rm" data-sel="${esc(s)}">Remove</button></li>`).join('') + '</ul>';
      }
    } else if (!this.view.model) {
      out += '<p class="hint">Upload a model (Model tab) to choose which parts each view shows.</p>';
    }
    out += `<div class="row"><button data-act="vw-reset" class="danger" ${rules.length || lv.camera || lv.camera_top ? '' : 'disabled'}>Reset this view</button></div>`;
    return out;
  }

  // "Side section" block: direction + position of the cut (layout.views[id].section, card world).
  _sectionHtml(v, lv) {
    const box = this.view.model && this.view.sectionBox();
    if (!box) return '';
    const plane = this.card.sectionPlaneNow(v);
    if (!plane) return '';
    const dir = sectionDir(plane.normal);
    const [lo, hi] = this._sectionRange(dir.normal, box);
    const pos = Math.min(hi, Math.max(lo, sectionPos(plane)));
    const opts = SECTION_DIRS.map((d) => `<option value="${d.id}" ${d.id === dir.id ? 'selected' : ''}>${d.label}</option>`).join('');
    const src = lv.section ? 'Saved for this view.' : v.modelSection ? 'From the model.' : 'Default: through the middle of the house.';
    return `<div class="sub">Side section</div>
      <p class="hint">The Section button (box cutter) cuts the house here and looks at the cut face. ${src}</p>
      <label>Direction <select data-field="vw-sec-dir">${opts}</select></label>
      <label><span class="lab">Position (m ${dir.normal[0] ? 'east' : 'north'})<span class="val" data-val="vw-sec-pos">${fmt(pos)}</span></span>
        <input type="range" data-field="vw-sec-pos" min="${lo}" max="${hi}" step="0.05" value="${pos}"></label>
      <div class="row"><button data-act="vw-sec-reset" ${lv.section ? '' : 'disabled'}>Reset section</button></div>`;
  }

  // slider range: the model box along the axis, on the 0.05 m grid
  _sectionRange(normal, box) {
    const [a, b] = sectionRange(normal, box);
    return [Math.floor(a / 0.05) * 0.05, Math.ceil(b / 0.05) * 0.05].map((x) => Math.round(x * 100) / 100);
  }

  _sectionFromPanel(v, pos) {
    const sel = this.panel.querySelector('[data-field="vw-sec-dir"]');
    const dir = SECTION_DIRS.find((d) => d.id === (sel && sel.value)) || SECTION_DIRS[0];
    return sectionAt(dir.normal, Math.round(pos * 100) / 100);
  }

  _nodePos(idx, node) {
    if (!this._posCache || this._posCache.idx !== idx) this._posCache = { idx, map: new Map(idx.nodes.map((n, i) => [n.node, i])) };
    const p = this._posCache.map.get(node);
    return p === undefined ? -1 : p;
  }

  cancelPivot() {
    this.pivoting = false;
    this._syncStageClasses();
    this.render();
  }

  // "Set rotation centre": the clicked model point (else the view's floor plane) becomes the
  // controls target; saved with the camera (3D) or as the top-view centre (top).
  _setPivot(e) {
    const card = this.card, v = card.currentView();
    card.leaveSection();
    const point = this.view.pivotPoint(e.clientX, e.clientY, this.view.floorElevation(card._floor));
    if (!point || !v) {
      this.message = { text: 'Click on the model or the floor', warn: true };
      this.render();
      return;
    }
    this.pivoting = false;
    this._syncStageClasses();
    if (card._mode === 'top') {
      const cur = this.view.getTopCamera();
      const camera_top = { center: [Math.round(point[0] * 100) / 100 + 0, Math.round(-point[2] * 100) / 100 + 0], zoom: cur.zoom };
      this.view.setTopCamera(camera_top);
      this.message = { text: `Top view of "${v.label}" now centres here.` };
      card.saveViewPatch(v.id, { camera_top });
    } else {
      const camera = this.view.setPivot(point);
      this.message = { text: `Rotation centre of "${v.label}" set.` };
      card.saveViewPatch(v.id, { camera });
    }
    this.render();
  }

  // Click on the model (Views tab): highlight the part and offer hide/show.
  _pickView(e) {
    const idx = this.card.viewIndex();
    const owner = idx ? this.view.pickModel(e.clientX, e.clientY) : null;
    const p = owner && owner.hit ? pickSelector(idx, this._nodePos(idx, owner.hit.object), owner.kind === 'untagged' ? null : owner) : null;
    this._closeMenu();
    if (!p) {
      this.vwPick = null;
      this.view.highlightModelNode(null);
      this.message = { text: 'Click on a part of the model', warn: true };
      this.render();
      return;
    }
    this.vwPick = { sel: p.sel, idx: p.idx };
    this.message = null;
    this.view.highlightModelNode(idx.nodes[p.idx].node);
    const tree = this._tree();
    const r = tree && [...tree.tree, ...tree.layers, ...tree.groups].find((x) => x.sel === p.sel);
    this._openMenu(e, r ? r.label : idx.nodes[p.idx].name || p.sel);
    this.render();
  }

  _openMenu(e, title) {
    const stage = this.card._stage;
    const m = document.createElement('div');
    m.className = 'fp-pickmenu';
    m.innerHTML = `<div class="title" title="${esc(this.vwPick.sel)}">${esc(title)}</div>
      <button data-act="vw-hide-here">Hide in this view</button>
      <button data-act="vw-show-here">Show in this view</button>
      <button data-act="vw-hide-all">Hide in all views</button>
      <button data-act="vw-reveal">Reveal in tree</button>`;
    m.addEventListener('click', (ev) => this._onMenuClick(ev));
    stage.append(m);
    const r = stage.getBoundingClientRect();
    const w = m.offsetWidth, h = m.offsetHeight;
    const x = Math.max(4, Math.min(e.clientX - r.left + 8, r.width - w - 4));
    const y = Math.max(4, Math.min(e.clientY - r.top + 8, r.height - h - 4));
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    this.menu = m;
    window.addEventListener('pointerdown', this._onMenuAway, true);
  }

  _closeMenu() {
    if (!this.menu) return;
    window.removeEventListener('pointerdown', this._onMenuAway, true);
    this.menu.remove();
    this.menu = null;
  }

  _onMenuClick(e) {
    const btn = e.target.closest('[data-act]');
    const pick = this.vwPick;
    if (!btn || !pick) return;
    const cur = this.card.currentView();
    this._closeMenu();
    switch (btn.dataset.act) {
      case 'vw-hide-here':
      case 'vw-show-here':
        if (!cur) return;
        this.vwPick = null;
        this.view.highlightModelNode(null);
        this._setRule(cur.id, pick.sel, btn.dataset.act === 'vw-hide-here' ? 'hidden' : 'shown');
        return;
      case 'vw-hide-all': {
        const views = { ...(this.layout.views || {}) };
        for (const v of this.card._views) {
          if (v.hidden) continue;
          views[v.id] = { ...(views[v.id] || {}), rules: setRuleState(this._layoutRules(v.id), pick.sel, 'hidden') };
        }
        this.vwPick = null;
        this.view.highlightModelNode(null);
        this.commit({ ...this.layout, views });
        return;
      }
      case 'vw-reveal': this._reveal(pick); return;
      default:
    }
  }

  // Scroll the tree row of a picked part (or of its nearest listed ancestor) into view and flash it.
  _reveal(pick) {
    this.tab = 'views';
    const tree = this._tree();
    const r = tree && tree.tree.find((x) => x.sel === pick.sel);
    if (r && r.parent && !r.parent.startsWith('level:')) this.vwExpanded.add(r.parent);
    this.render();
    const idx = this.card.viewIndex();
    let sel = pick.sel;
    const rows = () => [...this.panel.querySelectorAll('ul.vtree li[data-sel]')];
    if (!rows().some((li) => li.dataset.sel === sel) && tree && idx) {
      const shown = new Set(rows().map((li) => li.dataset.sel));
      for (let p = pick.idx; p >= 0; p = idx.nodes[p].parent) if (shown.has(tree.rowOf.get(p))) { sel = tree.rowOf.get(p); break; }
    }
    const li = rows().find((x) => x.dataset.sel === sel);
    if (!li) return;
    li.scrollIntoView({ block: 'nearest' });
    li.classList.remove('flash');
    void li.offsetWidth; // restart the animation
    li.classList.add('flash');
    setTimeout(() => li.classList.remove('flash'), 1300);
  }

  // Panel buttons of the Views tab. Returns true when handled.
  _viewsClick(act, btn) {
    const card = this.card;
    const v = this._vwView();
    if (!v) return false;
    const after = (fn) => queueMicrotask(fn); // runs after the commit's rebuild (queued first)
    switch (act) {
      case 'vw-add': {
        const { id, n } = nextViewId([...card._views.map((x) => x.id), ...Object.keys(this.layout.views || {})]);
        // a copy of the current view: all its rules (model / generated base + saved), so it looks the same
        const views = { ...(this.layout.views || {}), [id]: { added: true, label: `View ${n}`, rules: (v.rules || []).map((r) => ({ ...r })) } };
        this.vwSel = null;
        this.commit({ ...this.layout, views });
        after(() => card._setView(id));
        return true;
      }
      case 'vw-hide': {
        if (v.source === 'added') {
          const views = { ...(this.layout.views || {}) };
          delete views[v.id];
          const order = this.layout.view_order;
          this.vwSel = null;
          this.commit({ ...this.layout, views, ...(Array.isArray(order) ? { view_order: order.filter((x) => x !== v.id) } : {}) });
        } else if (v.hidden) {
          this.vwSel = null;
          card.saveViewPatch(v.id, { hidden: false });
          after(() => card._setView(v.id));
        } else {
          this.vwSel = v.id; // keep editing it, so it can be unhidden
          card.saveViewPatch(v.id, { hidden: true });
        }
        return true;
      }
      case 'vw-up':
      case 'vw-down': {
        const ids = card._views.map((x) => x.id);
        const i = ids.indexOf(v.id), j = i + (act === 'vw-up' ? -1 : 1);
        if (i < 0 || j < 0 || j >= ids.length) return true;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        this.commit({ ...this.layout, view_order: ids });
        return true;
      }
      case 'vw-save-cam':
        card.leaveSection();
        if (card._mode === 'top') {
          this.message = { text: `Saved the current top view as the start of "${v.label}".` };
          card.saveViewPatch(v.id, { camera_top: this.view.getTopCamera() });
        } else {
          this.message = { text: `Saved the current camera as the start of "${v.label}".` };
          card.saveViewPatch(v.id, { camera: this.view.getCamera() });
        }
        this.render();
        return true;
      case 'vw-pivot':
        card.leaveSection();
        this.pivoting = true;
        this._syncStageClasses();
        this.render();
        return true;
      case 'vw-pivot-cancel':
        this.cancelPivot();
        return true;
      case 'vw-expand': {
        const sel = btn.dataset.sel;
        if (this.vwExpanded.has(sel)) this.vwExpanded.delete(sel);
        else this.vwExpanded.add(sel);
        this.render();
        return true;
      }
      case 'vw-sec-reset':
        card.saveViewPatch(v.id, { section: null });
        return true;
      case 'vw-reset-cam':
      case 'vw-reset':
        card.saveViewPatch(v.id, act === 'vw-reset' ? { rules: [], camera: null, camera_top: null }
          : card._mode === 'top' ? { camera_top: null } : { camera: null });
        if (v.id === card._viewId) after(() => card._resetCamera());
        return true;
      case 'vw-eye': {
        const sel = btn.dataset.sel;
        this._setRule(v.id, sel, nextEyeState(ruleState(this._layoutRules(v.id), sel)));
        return true;
      }
      case 'vw-rm':
        this._setRule(v.id, btn.dataset.sel, 'default');
        return true;
      default:
        return false;
    }
  }

  _viewsChange(f, el) {
    const card = this.card;
    if (f === 'vw-view') {
      const v = card._views.find((x) => x.id === el.value);
      if (!v) return;
      this.vwPick = null;
      this.view.highlightModelNode(null);
      if (v.hidden) { this.vwSel = v.id; this.render(); return; }
      this.vwSel = null;
      if (v.id === card._viewId) this.render();
      else card._setView(v.id);
      return;
    }
    const v = this._vwView();
    if (!v) return;
    if (f === 'vw-sec-pos') card.saveViewPatch(v.id, { section: this._sectionFromPanel(v, Number(el.value)) });
    else if (f === 'vw-sec-dir') {
      // a new axis: start in the middle of the model along it
      const box = this.view.sectionBox();
      const dir = SECTION_DIRS.find((d) => d.id === el.value);
      if (!box || !dir) return;
      const [lo, hi] = this._sectionRange(dir.normal, box);
      const old = card.sectionPlaneNow(v);
      const same = old && !!sectionDir(old.normal).normal[0] === !!dir.normal[0];
      const section = sectionAt(dir.normal, same ? sectionPos(old) : Math.round(((lo + hi) / 2) * 20) / 20);
      card.previewSection(v.id, section, { aim: true });
      card.saveViewPatch(v.id, { section }); // drops the preview: the saved plane takes over
    } else if (f === 'vw-label') card.saveViewPatch(v.id, { label: el.value.trim() || undefined });
    else if (f === 'vw-cut') card.saveViewPatch(v.id, { cut: el.checked });
    else if (f === 'vw-zoom-to') card.saveViewPatch(v.id, { zoom_to: el.value || undefined });
    else if (f === 'vw-floor') {
      const cur = card._stateFor(v).floors;
      const floors = this.floors.map((x) => x.id).filter((id) => (id === el.dataset.id ? el.checked : cur.includes(id)));
      card.saveViewPatch(v.id, { floors });
    }
  }

  // ---------- model ----------
  onModelLoaded(changed = true) {
    if (!changed) return; // same model re-placed (alignment, opacity): the panel is already current
    if (this._freshModel) { // a newly uploaded model: everything in it counts as seen
      this._freshModel = false;
      this._snapshotKnown();
      return;
    }
    if (this.tab === 'model') this.render();
  }

  // Remember which levels/rooms the user has been shown, so the regeneration notice only reports changes.
  _snapshotKnown() {
    const man = this.card.modelBindings();
    if (!man) return;
    this.setModelProps({ known: { levels: man.manifest.levels.map((l) => l.id), rooms: man.manifest.rooms.map((r) => r.id) } });
  }

  // "Stick all to surfaces": free pins more than 15 cm from every model surface (8 horizontal rays,
  // up and down) move onto the surface their device type sticks to, else the nearest one (stickSurface).
  _stickMoves() {
    const vw = this.view, out = [];
    if (!vw.model) return out;
    const byId = new Map((this.card._markers || []).map((m) => [m.id, m]));
    for (const [id, pin] of Object.entries(this.layout.pins || {})) {
      if (!pin || pin.attach || id === this.card._mowerMarkerId) continue;
      const floorId = this.floors.some((f) => f.id === pin.floor_id) ? pin.floor_id : this.floors[0].id;
      const elev = vw.floorElevation(floorId);
      const world = worldOf({ x: pin.x, y: pin.y, z: pin.z ?? 1.2 }, elev);
      const hits = rayGroups('all').flatMap((g) => vw.surfaceRays(world, g.dirs, g.max));
      if (!needsStick(pin, nearestDistance(hits))) continue;
      const m = byId.get(id);
      const kind = m ? surfaceKind(m.domain, m.deviceClass) : null;
      const s = stickSurface(kind, hits);
      if (s) out.push({ id, pin: { ...planOf(s.point, elev), floor_id: floorId, on_model: true } });
    }
    return out;
  }

  // A pin placed while a model is loaded sits on the model and follows its alignment.
  _onModel(id) {
    const pin = (this.layout.pins || {})[id];
    return !!this.view.model || !!(pin && pin.on_model);
  }

  setModelProps(patch, rerender = true) {
    const cur = this.layout.model || {};
    let layout = { ...this.layout, model: { ...cur, ...patch } };
    // alignment change of an uploaded model (YAML alignment overrides win): pins on the model follow it
    if (!this.card._config.model && ('position' in patch || 'rotation' in patch || 'scale' in patch)) {
      const align = (m) => ({ position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1 });
      // first alignment change with a model loaded: v0.2.x pins on floors bound to a model level follow it from now on
      if (this.view.model && !cur.pins_migrated) {
        const mb = this.card.modelBindings();
        const bound = mb ? Object.values(mb.levels || {}).map((a) => a && a.floor).filter(Boolean) : [];
        layout = E.migrateLegacyPins(layout, bound);
      }
      layout = E.realignPins(layout, align(cur), align(layout.model));
    }
    this.card._commit(layout);
    if (rerender) this.render();
  }

  _modelApi() {
    return `/api/floorplan3d/model/${encodeURIComponent(this.card._config.layout_key)}`;
  }

  async _uploadModel(file) {
    if (!/\.glb$/i.test(file.name)) {
      this.message = { text: 'Choose a .glb file (binary glTF). Export one with tools/export-glb.js.', error: true };
      this.render();
      return;
    }
    this.uploading = file.name;
    this.message = null;
    this.render();
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const r = await this.hass.fetchWithAuth(this._modelApi(), { method: 'POST', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || 'Upload failed (HTTP ' + r.status + ')');
      const cur = this.layout.model || { position: [0, 0, 0], rotation: 0, scale: 1, opacity: 1 };
      this._freshModel = true;
      this.message = { text: `Uploaded ${j.name} (${(j.size / 1048576).toFixed(1)} MB).` };
      this.commit({ ...this.layout, model: { ...cur, version: j.version, name: j.name, size: j.size, uploaded: new Date().toISOString() } });
    } catch (err) {
      this._freshModel = false;
      this.message = { text: err.message, error: true };
    } finally {
      this.uploading = null;
      this.render();
    }
  }

  async _removeModel() {
    try {
      const r = await this.hass.fetchWithAuth(this._modelApi(), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error('Delete failed (HTTP ' + r.status + ')');
      this.confirmModelDelete = false;
      this.commit({ ...this.layout, model: null });
    } catch (err) {
      this.message = { text: err.message, error: true };
    }
    this.render();
  }

  _modelTab() {
    const c = this.card._config;
    if (c.model) {
      return `<p class="note warn">This card shows <b>${esc(c.model)}</b> from its YAML (<code>model:</code>).
        Remove <code>model</code> and the <code>model_*</code> options from the card YAML to upload and align the model here.</p>`
        + this._modelBindingsHtml();
    }
    if (this.card._store.backend !== 'shared') {
      return `<p class="note warn">Uploading a model needs the Floorplan 3D integration (Settings → Devices &amp; services → Add integration).
        Without it, put a .glb in /config/www and set <code>model: /local/house.glb</code> in the card YAML.</p>`;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(c.layout_key)) {
      return `<p class="note warn">layout_key "${esc(c.layout_key)}" can only contain letters, digits, - and _ for model uploads.</p>`;
    }
    const m = this.layout.model;
    let out = `<p class="hint">A 3D model of the house (.glb) shown under the plan. Parts tagged as levels, rooms and zones
      (<code>fp</code> tags, see <a href="https://github.com/istals/floorplan3d-card/blob/main/docs/model-builder-guide.md" target="_blank" rel="noopener">docs/model-builder-guide.md</a>)
      are shown per floor and become rooms; a tagged model shows whole levels (lower floors stay, upper ones are hidden); only an untagged model is cut at the top of the selected storey. It is stored in Home Assistant and only shown to logged-in users.</p>
      <div class="row"><label class="button ${this.uploading ? 'disabled' : 'primary'}">${this.uploading ? 'Uploading ' + esc(this.uploading) + '…' : (m ? 'Replace model' : 'Upload .glb')}
      <input type="file" accept=".glb,model/gltf-binary" data-field="model-file" hidden ${this.uploading ? 'disabled' : ''}></label></div>`;
    if (!m) return out;

    const floorInfo = this._modelBindingsHtml();
    const [x, y, z] = m.position || [0, 0, 0];
    const slider = (f, label, min, max, step, v) => `<label><span class="lab">${label}<span class="val" data-val="${f}">${fmt(v)}</span></span>
      <input type="range" data-field="md-${f}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
    out += `<section class="box"><h3>${esc(m.name || 'house.glb')}</h3>
      <p class="dim">${m.size ? (m.size / 1048576).toFixed(1) + ' MB' : ''}${m.uploaded ? ' · ' + esc(new Date(m.uploaded).toLocaleString()) : ''}</p>
      </section>${floorInfo}
      <div class="row"><button data-act="model-fit">Frame model</button></div>
      <div class="sub">Alignment</div>`
      + slider('x', 'East (m)', -50, 50, 0.05, x)
      + slider('y', 'North (m)', -50, 50, 0.05, y)
      + slider('z', 'Up (m)', -5, 5, 0.05, z)
      + slider('rotation', 'Rotation (°)', -180, 180, 0.5, m.rotation || 0)
      + slider('opacity', 'Opacity', 0.1, 1, 0.05, m.opacity ?? 1)
      + `<label>Scale <input type="number" step="any" min="0.0001" data-field="md-scale" value="${m.scale || 1}"></label>
      <p class="hint">Scale 0.01 for a model made in centimetres, 0.001 for millimetres.</p>
      <div class="row"><button data-act="model-delete" class="danger">${this.confirmModelDelete ? 'Really remove?' : 'Remove model'}</button></div>`;
    return out;
  }

  // Levels -> HA floors, rooms/zones -> HA areas, plus what changed since the last upload.
  _modelBindingsHtml() {
    const mb = this.card.modelBindings();
    if (!mb) return '<p class="dim">Loading model…</p>';
    const { manifest, levels, rooms, diff, notice } = mb;
    if (!(this.layout.model && this.layout.model.known) && !this._snapPending) { // first look at this model: nothing is "new" yet
      this._snapPending = true;
      Promise.resolve().then(() => { this._snapPending = false; if (!(this.layout.model && this.layout.model.known)) this._snapshotKnown(); });
    }
    const s = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const objCount = manifest.objects.length;
    let out = `<div class="sub">In the model</div><p class="hint">${s(manifest.levels.length, 'level')},
      ${s(manifest.rooms.filter((r) => r.kind === 'room').length, 'room')}, ${s(manifest.rooms.filter((r) => r.kind === 'zone').length, 'zone')},
      ${s(objCount, 'object')}${objCount ? ' (object controls come in a later version)' : ''}. Click a part of the model to find it here.</p>`;
    const ms = this.view.mergeStats;
    if (ms && ms.before) {
      const a = ms.after, b = ms.before;
      out += ms.enabled && a.meshes !== b.meshes
        ? `<p class="dim" data-info="merge-stats">Draw calls: ${b.calls} → ${a.calls} (meshes ${b.meshes} → ${a.meshes})</p>`
        : `<p class="dim" data-info="merge-stats">Draw calls: ${b.calls} (${b.meshes} meshes${ms.enabled ? '' : ', merging off'})</p>`;
    }
    if (manifest.errors.length || manifest.warnings.length) {
      out += `<details class="report" ${this._reportOpen ? 'open' : ''}><summary>${manifest.errors.length} error(s), ${manifest.warnings.length} warning(s)</summary>
        <button class="link" data-act="md-copy-report">Copy to clipboard</button><ul class="plain">`
        + manifest.errors.map((e) => `<li class="bad">${esc(e)}</li>`).join('')
        + manifest.warnings.map((w) => `<li class="dim">${esc(w)}</li>`).join('') + '</ul></details>';
    }
    const added = notice.levels.added.length + notice.rooms.added.length;
    const missing = notice.levels.missing.length + notice.rooms.missing.length;
    if (added || missing) {
      out += `<p class="note warn">Since the last setup: ${added} new part(s) (assigned automatically below, marked auto)
        and ${missing} part(s) no longer in the model. <button class="link" data-act="md-ack">OK</button></p>`;
    }
    const sel = (k, id) => (this.modelPick && this.modelPick.kind !== 'untagged' && this.modelPick.id === id && k.includes(this.modelPick.kind) ? 'sel' : '');

    if (manifest.levels.length) {
      // which HA floor a level belongs to (devices, linked floors, elevations); what each view shows is set in Views
      const opts = (v, a) => [
        ['auto', a.auto ? `auto (${a.floor ? (this.floors.find((f) => f.id === a.floor) || {}).name || a.floor : 'no floor'})` : 'auto'],
        ...this.floors.map((f) => [`floor:${f.id}`, f.name]),
        ['none', 'no floor'],
      ].map(([val, label]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(label)}</option>`).join('');
      out += '<div class="sub">Levels: belongs to HA floor</div><table class="floors">' + manifest.levels.map((l) => {
        const a = levels[l.id];
        const v = a.auto ? 'auto' : a.floor ? `floor:${a.floor}` : 'none';
        return `<tr data-pick="level:${esc(l.id)}" class="${sel(['level'], l.id)}"><td title="${esc(l.role)}">${esc(l.label)}</td>
          <td><select data-field="md-level" data-id="${esc(l.id)}">${opts(v, a)}</select></td>
          <td class="dim">${a.stale ? '<span class="bad">floor deleted</span>' : a.auto ? 'auto' : ''}</td></tr>`;
      }).join('') + '</table>';
    }

    if (manifest.rooms.length) {
      const areas = Object.values(this.hass.areas || {}).sort((a, b) => a.name.localeCompare(b.name));
      const opts = (v, auto) => `<option value="auto" ${auto ? 'selected' : ''}>auto${auto && v ? ' (' + esc((this.hass.areas[v] || {}).name || v) + ')' : ''}</option>`
        + `<option value="" ${!auto && !v ? 'selected' : ''}>— no area —</option>`
        + areas.map((a) => `<option value="${esc(a.area_id)}" ${!auto && a.area_id === v ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
      out += '<div class="sub">Rooms and zones</div><table class="floors">' + manifest.rooms.map((r) => {
        const a = rooms[r.id];
        const note = a.stale ? '<span class="bad">area deleted</span>' : !levels[r.level] || !levels[r.level].floor
          ? 'level not on a floor' : r.outlineFallback ? 'no outline' : a.auto ? 'auto' : '';
        return `<tr data-pick="${r.kind}:${esc(r.id)}" class="${sel(['room', 'zone'], r.id)}"><td title="${esc(r.kind)} in ${esc(r.level || '?')}">${esc(r.label)}</td>
          <td><select data-field="md-room" data-id="${esc(r.id)}">${opts(a.area, a.auto)}</select></td><td class="dim">${note}</td></tr>`;
      }).join('') + '</table>'
        + '<p class="hint">Rooms from the model replace rooms drawn for the same area. <a href="/config/areas/dashboard" target="_top">Create areas in Home Assistant</a>.</p>';
    }

    const gone = [...diff.levels.missing.map((id) => ['levels', id]), ...diff.rooms.missing.map((id) => ['rooms', id])];
    if (gone.length) {
      out += '<div class="sub">No longer in the model</div><ul class="plain">' + gone.map(([k, id]) =>
        `<li><code>${esc(id)}</code> <button class="link" data-act="md-forget" data-kind="${k}" data-id="${esc(id)}">Forget</button></li>`).join('') + '</ul>';
    }
    if (this.modelPick && this.modelPick.kind === 'untagged') {
      out += `<p class="note warn">“${esc(this.modelPick.path)}” is not tagged in the model, so it can't be assigned.
        Ask the model builder to tag it (docs/model-builder-guide.md).</p>`;
    }
    return out;
  }

  _dataTab() {
    const b = this.card._store.backend;
    const info = {
      shared: ['ok', 'Shared: stored by the floorplan3d integration, every user and device sees the same layout.'],
      user: ['warn', 'Per user: stored in your HA user data. Other users will not see this layout. Install the floorplan3d integration to share it.'],
      browser: ['warn', 'This browser only: other browsers and devices will not see this layout. Install the floorplan3d integration to share it.'],
    }[b] || ['warn', 'Storage not loaded yet.'];
    return `<div class="sub">Storage</div><p class="note ${info[0]}">${esc(info[1])}</p>
      <div class="sub">Export / import</div>
      <p class="hint">The layout is plain JSON (rooms in metres, x east, y north). Importing replaces the current layout.</p>
      <div class="row"><button data-act="export">Export JSON</button>
      <label class="button">Import JSON<input type="file" accept="application/json,.json" data-field="import" hidden></label></div>`;
  }

  _onPanelClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.id;
    const sel = this.room(this.selectedRoom);
    this.message = null;
    // Views tab actions commit; the rebuild after the commit renders the panel once
    if (btn.dataset.act.startsWith('vw-') && this._viewsClick(btn.dataset.act, btn)) return;
    switch (btn.dataset.act) {
      case 'tab':
        if (id !== this.tab) {
          this.picking = null;
          this.pivoting = false;
          this.modelPick = null;
          this.vwPick = null;
          this._closeMenu();
          this.view.highlightModelNode(null);
        }
        if (id !== 'objects') this.objSel = null;
        if (id !== 'devices') this.stick = null;
        this.tab = id;
        this._syncStageClasses();
        break;
      case 'obj-expand':
        if (this.objExpanded.has(btn.dataset.key)) this.objExpanded.delete(btn.dataset.key);
        else this.objExpanded.add(btn.dataset.key);
        this.render();
        return;
      case 'obj-test':
        if (!this.card.testObject(id)) this.message = { text: 'Nothing to toggle: bind a working entity first.', warn: true };
        this.render();
        return;
      case 'md-ack': this._snapshotKnown(); return;
      case 'md-copy-report': {
        const mb = this.card.modelBindings();
        if (!mb) return;
        const { errors, warnings } = mb.manifest;
        const text = [...errors.map((t) => `Error: ${t}`), ...warnings.map((t) => `Warning: ${t}`)].join('\n');
        copyText(text).then((ok) => {
          this.message = ok ? { text: `Copied ${errors.length + warnings.length} line(s).` }
            : { text: 'Copy is blocked here; select the lines and copy them by hand.', error: true };
          this.render();
        });
        return;
      }
      case 'md-forget': {
        const m = this.layout.model || {};
        const k = btn.dataset.kind;
        const next = { ...(m[k] || {}) };
        delete next[id];
        this.setModelProps({ [k]: next });
        return;
      }
      case 'draw': this.startDrawing(id); return;
      case 'pick': this.startPicking(id); return;
      case 'pick-cancel': this.cancelPicking(); return;
      case 'pick-use': this.usePickedOutline(); return;
      case 'pick-draw': { const a = this.picking && this.picking.areaId; this.picking = null; if (a) this.startDrawing(a); return; }
      case 'finish': this.finishDrawing(); return;
      case 'undo-point': this.drawing.points.pop(); this.refreshOverlay(); break;
      case 'cancel-draw': this.cancelDrawing(); return;
      case 'select-room': {
        const r = this.room(id);
        const fid = r && this.floorOf(r);
        if (fid && this.card._floor !== fid) this.card._setFloor(fid);
        this.selectRoom(id);
        return;
      }
      case 'deselect': this.selectRoom(null); return;
      case 'door-mode': this.doorMode = !this.doorMode; this._syncStageClasses(); break;
      case 'del-door': if (sel) this.commit(E.upsertRoom(this.layout, E.removeDoor(sel, Number(btn.dataset.i)))); return;
      case 'delete-room':
        if (!this.confirmDelete) { this.confirmDelete = true; break; }
        this.confirmDelete = false;
        this.selectedRoom = null;
        this.commit(E.deleteRoom(this.layout, sel.id));
        return;
      case 'add-floor': {
        const top = this.floors[this.floors.length - 1];
        const fid = E.newFloorId(this.layout, this.floors);
        this.commit(E.upsertFloor(this.layout, { id: fid, name: 'Floor ' + (this.floors.length + 1), elevation: top ? top.elevation + 3 : 0, height: 2.7 }));
        return;
      }
      case 'del-floor': this.commit(E.deleteFloor(this.layout, id)); return;
      case 'unpin': this.commit(E.clearPin(this.layout, this.selectedMarker)); return;
      case 'stick-all': this.stick = { moves: this._stickMoves() }; break;
      case 'stick-cancel': this.stick = null; break;
      case 'stick-apply': { // again now: the pins may have changed since the preview
        const moves = this._stickMoves();
        this.stick = null;
        if (!moves.length) break;
        let layout = this.layout;
        for (const mv of moves) layout = E.setPin(layout, mv.id, mv.pin, { grid: false });
        this.commit(layout);
        return;
      }
      case 'detach': { // keep where it is now, as a normal pin on the model
        const pos = this.card._positions && this.card._positions.get(this.selectedMarker);
        const pin = (this.layout.pins || {})[this.selectedMarker];
        const at = pos ? { x: pos.x, y: pos.y, z: pos.z, floor_id: pos.floorId } : pin;
        if (at) this.commit(E.setPin(this.layout, this.selectedMarker, { ...at, on_model: true }, { grid: false }));
        return;
      }
      case 'hide': {
        const mid = this.selectedMarker;
        this.selectMarker(null);
        this.commit(E.hide(this.layout, mid));
        return;
      }
      case 'deselect-marker': this.selectMarker(null); return;
      case 'unhide': this.commit(E.unhide(this.layout, id)); return;
      case 'place': {
        const fid = this.activeFloor();
        const t = this.view.controls.target;
        this.selectedMarker = id;
        this.commit(E.setPin(this.layout, id, { x: t.x, y: -t.z, z: 1.2, floor_id: fid, on_model: this._onModel(id) }));
        return;
      }
      case 'export': this._export(); return;
      case 'cal-add': {
        const m = this.mower();
        const r = readSource(this.hass.states[m.entity], m);
        if (!r) { this.message = { text: 'No position reading from the mower entity right now.', error: true }; break; }
        this.calibrating = { src: r.raw };
        this.overlayMove = false;
        if (this.card._floor !== this.card._mowerFloor()) this.card._setFloor(this.card._mowerFloor());
        break;
      }
      case 'cal-cancel': this.calibrating = null; break;
      case 'img-pick':
        this.colorPick = true;
        this.calibrating = null;
        this.overlayMove = false;
        if (this.card._floor !== this.card._mowerFloor()) this.card._setFloor(this.card._mowerFloor());
        break;
      case 'img-pick-cancel': this.colorPick = false; break;
      case 'cal-del': this.setMower({ calibration: (this.mower().calibration || []).filter((_, i) => i !== Number(btn.dataset.i)) }); return;
      case 'trail-clear': this.card.clearTrail(); break;
      case 'ov-move': this.overlayMove = !this.overlayMove; this.calibrating = null; this.colorPick = false; break;
      case 'ov-remove': this.overlayMove = false; this.setMower({ overlay: null }); return;
      case 'model-fit': this.view.fit({ model: true }); return;
      case 'model-delete':
        if (!this.confirmModelDelete) { this.confirmModelDelete = true; break; }
        this._removeModel();
        return;
      case 'mower-remove': this.calibrating = null; this.colorPick = false; this.overlayMove = false; this.commit({ ...this.layout, mower: null }); this.render(); return;
      default: return;
    }
    this._syncStageClasses();
    this.render();
  }

  _onPanelChange(e) {
    const el = e.target;
    const f = el.dataset.field;
    const sel = this.room(this.selectedRoom);
    if (f && f.startsWith('vw-')) this._viewsChange(f, el);
    else if (f === 'room-area' && sel) this.commit(E.upsertRoom(this.layout, { ...sel, area_id: el.value }));
    else if (f === 'room-outdoor' && sel) this.commit(E.upsertRoom(this.layout, { ...sel, outdoor: el.checked }));
    else if (f === 'room-floor' && sel) {
      const area = this.hass.areas && this.hass.areas[sel.area_id];
      const next = { ...sel, floor_id: el.value };
      if (area && area.floor_id === el.value) delete next.floor_id;
      this.card._setFloor(el.value);
      this.commit(E.upsertRoom(this.layout, next));
    } else if (f === 'floor-elevation' || f === 'floor-height') {
      const v = Number(el.value);
      if (!Number.isFinite(v)) return;
      const floor = this.floors.find((x) => x.id === el.dataset.id);
      const stored = (this.layout.floors || []).some((x) => x.id === floor.id);
      const patch = { id: floor.id, [f === 'floor-elevation' ? 'elevation' : 'height']: v };
      if (!stored) Object.assign(patch, { name: floor.name });
      this.commit(E.upsertFloor(this.layout, patch));
    } else if (f === 'marker-z') {
      const v = Number(el.value);
      const pos = this.card._positions.get(this.selectedMarker);
      if (!Number.isFinite(v) || !pos) return;
      const pin = (this.layout.pins || {})[this.selectedMarker];
      if (pin && pin.attach && Array.isArray(pin.offset)) {
        // attached: raise / lower the offset; object missing: keep the attach, only the fallback height changes
        const o = pin.offset;
        const off = pos.attached ? [o[0], o[1] + v - pos.z, o[2]] : o;
        this.commit(E.attachPin(this.layout, this.selectedMarker, pin.attach, off, { x: pin.x, y: pin.y, z: pos.attached ? pin.z + v - pos.z : v, floor_id: pin.floor_id }));
        return;
      }
      this.commit(E.setPin(this.layout, this.selectedMarker, { x: pos.x, y: pos.y, z: v, floor_id: pos.floorId, on_model: this._onModel(this.selectedMarker) }, { grid: !pin }));
    } else if (f === 'obj-entity') {
      const v = el.value.trim();
      this.commit(E.setObject(this.layout, el.dataset.id, { entity: v === '' ? undefined : v.toLowerCase() === 'none' ? null : v }));
      this.render();
    } else if (f === 'obj-act' || f === 'obj-act-field') {
      this._setObjAction(el);
      this.render();
    } else if (f === 'obj-hidden') {
      this.commit(E.setObject(this.layout, el.dataset.id, { hidden: el.checked }));
      this.render();
    } else if (f === 'grp-entity') {
      this.commit(E.setGroup(this.layout, el.dataset.id, { entity: el.value.trim() }));
      this.render();
    } else if (f === 'mower-entity') {
      this.setMower({ entity: el.value.trim() });
    } else if (f === 'mower-source') {
      // readings of the other kind cannot be mixed into the same calibration
      this.setMower({ source: el.value, calibration: [] });
    } else if (f === 'mower-img-entity') {
      const ic = { ...(this.mower().image || {}) };
      const v = el.value.trim();
      if (v) ic.entity = v;
      else delete ic.entity;
      this.setMower({ image: ic });
    } else if (f === 'mower-img-tolerance') {
      this.setMower({ image: { ...(this.mower().image || {}), tolerance: Math.max(0, Math.min(255, Number(el.value) || 0)) } });
    } else if (f === 'mower-xattr' || f === 'mower-yattr') {
      this.setMower({ [f === 'mower-xattr' ? 'x_attr' : 'y_attr']: el.value.trim() || (f === 'mower-xattr' ? 'x' : 'y') });
    } else if (f === 'mower-floor') {
      this.card._setFloor(el.value);
      this.setMower({ floor_id: el.value });
    } else if (f === 'mower-trail') {
      this.setMower({ trail: el.checked });
    } else if (f === 'ov-entity') {
      const v = el.value.trim();
      if (!v) this.setMower({ overlay: null });
      else {
        // first time: centre the map on the current view
        const t = this.view.controls.target;
        const first = !this.mower().overlay;
        this.setOverlay(first ? { entity: v, x: Math.round(t.x * 10) / 10, y: Math.round(-t.z * 10) / 10 } : { entity: v });
      }
    } else if (f === 'model-file') {
      const file = el.files && el.files[0];
      el.value = '';
      if (file) this._uploadModel(file);
    } else if (f === 'md-level') {
      const v = el.value;
      const m = this.layout.model || {};
      const levels = { ...(m.levels || {}) };
      const id = el.dataset.id;
      if (v === 'auto') delete levels[id]; // back to automatic
      else if (v.startsWith('floor:')) levels[id] = { floor: v.slice(6) };
      else if (v === 'none') levels[id] = { floor: null };
      else return;
      // a legacy show mode on this level becomes view rules before the binding drops it
      const c = this.card._config;
      const saved = { ...(c.model ? levelsFromFloorMap(c.model_floors) : {}), ...(m.levels || {}) };
      const mb = this.card._mb;
      const views = mb ? legacyShowRules(this.layout.views, this.card._views, id, saved, mb.manifest.levels) : this.layout.views;
      this.commit({ ...this.layout, model: { ...m, levels }, ...(views !== this.layout.views ? { views } : {}) });
      this.render();
    } else if (f === 'md-room') {
      const m = this.layout.model || {};
      const rooms = { ...(m.rooms || {}) };
      if (el.value === 'auto') delete rooms[el.dataset.id];
      else rooms[el.dataset.id] = { area: el.value || null };
      this.setModelProps({ rooms });
    } else if (f === 'md-scale') {
      const v = Number(el.value);
      if (Number.isFinite(v) && v > 0) this.setModelProps({ scale: v }, false);
    } else if (f === 'import') {
      const file = el.files && el.files[0];
      el.value = ''; // picking the same file again must fire change again
      if (file) file.text().then((text) => this._import(text));
    }
  }

  // sliders update the overlay live, without re-rendering the panel under the pointer
  _onPanelInput(e) {
    const el = e.target;
    const f = el.dataset.field;
    if (f === 'vw-sec-pos') {
      const v = this._vwView();
      const label = this.panel.querySelector('[data-val="vw-sec-pos"]');
      if (label) label.textContent = fmt(Number(el.value));
      if (v) this.card.previewSection(v.id, this._sectionFromPanel(v, Number(el.value)));
      return;
    }
    if (f && f.startsWith('md-') && el.type === 'range') {
      const key = f.slice(3);
      const v = Number(el.value);
      const label = this.panel.querySelector(`[data-val="${key}"]`);
      if (label) label.textContent = fmt(v);
      const m = this.layout.model;
      if (!m) return;
      if (key === 'x' || key === 'y' || key === 'z') {
        const pos = [...(m.position || [0, 0, 0])];
        pos['xyz'.indexOf(key)] = v;
        this.setModelProps({ position: pos }, false);
      } else this.setModelProps({ [key]: v }, false);
      return;
    }
    if (f === 'mower-img-tolerance') {
      const label = this.panel.querySelector('[data-val="img-tolerance"]');
      if (label) label.textContent = el.value;
      return;
    }
    if (!f || !f.startsWith('ov-') || el.type !== 'range') return;
    const key = f.slice(3);
    const v = Number(el.value);
    const label = this.panel.querySelector(`[data-val="${key}"]`);
    if (label) label.textContent = fmt(v);
    this.setOverlay({ [key]: v }, false);
  }

  _import(text) {
    try {
      const raw = JSON.parse(text);
      const parsed = E.parseImport(text);
      const haFloors = Object.values(this.hass.floors || {}).map((f) => ({ id: f.floor_id, elevation: (f.level ?? 0) * LEVEL_SPACING }));
      const fit = E.fitImport(parsed, haFloors, Object.keys(this.hass.areas || {}));
      const { floorMap, unknownAreas } = fit;
      // the uploaded model, the mower setup and view settings missing from the file: keep ours
      const l = E.mergeImport(fit.layout, raw, this.layout);
      this.selectedRoom = null;
      this.selectedMarker = null;
      const parts = [`Imported ${l.rooms.length} rooms, ${Object.keys(l.pins).length} pins.`];
      const mapped = Object.entries(floorMap);
      if (mapped.length) {
        const name = (id) => (this.hass.floors[id] && this.hass.floors[id].name) || id;
        parts.push('Floors mapped to Home Assistant: ' + mapped.map(([a, b]) => `${a} → ${name(b)}`).join(', ') + '.');
      }
      if (unknownAreas.length) {
        parts.push(`${unknownAreas.length} area id${unknownAreas.length === 1 ? ' is' : 's are'} not in Home Assistant (${unknownAreas.join(', ')}): ` +
          'pick the area for those rooms under Rooms → "Rooms without an HA area", or create the areas.');
      }
      this.message = { text: parts.join(' '), error: false, warn: unknownAreas.length > 0 };
      this.commit(l);
    } catch (err) {
      this.message = { text: err.message, error: true };
      this.render();
    }
  }

  _export() {
    const blob = new Blob([JSON.stringify(this.layout, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `floorplan3d-${this.card._config.layout_key}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
