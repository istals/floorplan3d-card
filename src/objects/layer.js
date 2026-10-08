// Model objects on the plan: per-object looks (types.js) and a fixed pool of real lights.
// The pool is created once per model load (N shadow point + 4 point + 4 spot; N = min(the render recipe's
// lampShadows.max, the device cap), default 4) so shaders never recompile at runtime; the first N point
// slots always cast shadows and get the budget's shadow picks. The pool lives in its own sub-group:
// shown only with a model and `lights` not off (hiding it drops the lights from the shaders).
// Shadow maps are rendered per light (shadow.autoUpdate = false): only lit shadow slots whose
// fixture or position changed, or all lit ones when the casters changed (shadowsStale).
import * as THREE from 'three';
import { chainState, lightBudget, controllersOf, budgetGroup } from './logic.js';
import { typeOf } from './types.js';
import { badTargets, aimPoint, aimsUp } from './aim.js';
import { dockFrontAxis, dockPose } from '../mower-track.js';
import { WashLayer, resolveWash, washSize, placeWashes, washOpacity, clearOfWall, washSetting } from './wash.js';

const WASH_TYPES = new Set(['light', 'light_strip']);
const WASH_SLICE_MS = 8; // wash placements (ray casts) per pass; the rest follow in the next task

const FREE_POINTS = 4, SPOTS = 4;
const DEG = Math.PI / 180;

const shown = (node) => { for (let n = node; n; n = n.parent) if (!n.visible) return false; return true; };
const colorKey = (c) => (c ? c.join(',') : '');

export class ObjectLayer {
  constructor(view) {
    this.view = view;
    const group = new THREE.Group(); // the real light pool (labels stay in objectsGroup)
    this.lights = group;
    view.objectsGroup.add(group);
    this.pool = { points: [], spots: [] };
    this._buildPool(view.lampShadowCount ? view.lampShadowCount() : 4);
    // wall washes for every lit lamp (shared materials, compiled once; see wash.js)
    this.washes = new WashLayer(view.objectsGroup, view.modelClip ? [view.modelClip] : null);
    this._washSig = null;
    view.objectsGroup.visible = false; // objects (and their lights) only while a model is loaded
    group.visible = false;
    this._lightsOn = true;
    this.model = null;
    this.parts = new Map(); // id -> { obj, type, part, chain, result, inputs }
    this.bindings = new Map();
    this.groups = {};
    this._budgetSig = null;
    this._slots = new Map(); // fixture id -> { light, shadow, factor }
    this._placeSig = null;
    this.stats = { updates: 0, evaluated: 0, budget: 0, shadowRequests: 0 }; // counters for the headless checks
    view.objectLayer = this; // the view resets us when it drops the model
  }

  // The real light pool: `shadows` shadow-casting points, 4 more points and 4 spots. Rebuilt only when the
  // shadow count changes (at a model load); lamp shadow map size / bias from the view's render settings.
  _buildPool(shadows) {
    const group = this.lights;
    if (this.pool.points.length && shadows === this._nShadow) { this._shadowLook(); return; }
    for (const l of [...this.pool.points, ...this.pool.spots]) {
      if (l.shadow && l.shadow.map) l.shadow.map.dispose();
      group.remove(l);
      if (l.target) group.remove(l.target);
      l.dispose();
    }
    if (this._slots) this._slots.clear();
    this._nShadow = shadows;
    this.pool = { points: [], spots: [] };
    for (let i = 0; i < shadows + FREE_POINTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 0, 2);
      if (i < shadows) {
        l.castShadow = true; // never toggled later (a toggle recompiles every shader)
        l.shadow.camera.near = 0.15;
        l.shadow.autoUpdate = false; // re-rendered only when flagged (needsUpdate)
      }
      this.pool.points.push(l);
      group.add(l);
    }
    for (let i = 0; i < SPOTS; i++) {
      const l = new THREE.SpotLight(0xffffff, 0, 7, 24 * DEG, 0.6, 1.4);
      this.pool.spots.push(l);
      group.add(l, l.target);
    }
    this._shadowKeys = new Array(shadows).fill(null); // per shadow slot: fixture@position its map was rendered for
    this._shadowLook();
  }

  // Lamp shadow settings (render recipe lampShadows); a new map size drops the old map (re-created on demand).
  _shadowLook() {
    const ls = (this.view.render && this.view.render.lampShadows) || { mapSize: 512, bias: -0.004, normalBias: 0, radius: 1 };
    const sm = this.view.test ? Math.min(256, ls.mapSize) : ls.mapSize; // headless test mode: smaller lamp shadow maps
    for (const l of this.pool.points.slice(0, this._nShadow)) {
      if (l.shadow.mapSize.x !== sm) {
        l.shadow.mapSize.set(sm, sm);
        if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
      }
      l.shadow.bias = ls.bias;
      l.shadow.normalBias = ls.normalBias;
      l.shadow.radius = ls.radius;
    }
  }

  get shadowSlots() {
    return this._nShadow;
  }

  // keepLights: another model replaces this one (a reload), so the pool stays in the scene meanwhile
  // (dark): dropping it and adding it back would compile every lit shader twice.
  setModel(model, { keepLights = false } = {}) {
    this._keepLights = !model && keepLights;
    if (model && this.model === model) return;
    if (this._dimNode) this._applyDim(this._dimNode, false);
    if (this._dimMats) { for (const d of this._dimMats.values()) d.dispose(); this._dimMats = null; this._dimNode = null; }
    for (const p of this.parts.values()) p.type.dispose(p.part);
    this.parts.clear();
    this.washes.clear();
    this._washSig = null;
    clearTimeout(this._washTimer);
    this._washTimer = null;
    this._darken();
    this.model = model || null;
    this._budgetSig = null;
    this._placeSig = null;
    this._poseSig = null;
    if (model) this._buildPool(this.view.lampShadowCount ? this.view.lampShadowCount() : this._nShadow);
    this._shadowKeys.fill(null);
    if (model) {
      const ctx = { root: model.root, view: this.view, levels: model.manifest.levels || [] };
      for (const obj of model.manifest.objects || []) {
        const type = typeOf(obj.type);
        try {
          this.parts.set(obj.id, { obj, type, part: type.prepare(obj, ctx), chain: null, result: null, inputs: null });
        } catch (e) {
          console.warn('floorplan3d: object', obj.id, e);
        }
      }
    }
    this._aimSpots();
    this.view.objectsGroup.visible = !!model || this._keepLights;
    this._showLights();
    this._applyPose();
    this.view.markDirty();
  }

  // Spot aim points (model root frame), once per model: hints.target unless it is too far from the lamp or
  // shared within its group (see aim.js), else straight up for uplights / down. badTargets: id -> reason.
  _aimSpots() {
    const spots = [];
    for (const [id, p] of this.parts) {
      const h = p.part.hints;
      if (!p.part.pool || !h || h.beam !== 'spot' || !p.part.anchor) continue;
      spots.push({ id, group: p.obj.group, pos: p.part.anchor.toArray(), target: h.target, distance: h.distance,
        up: h.up || aimsUp(p.obj), targetOk: !!(p.obj.hints && p.obj.hints.target_ok === true) });
    }
    this.badTargets = badTargets(spots);
    for (const s of spots) {
      const p = this.parts.get(s.id);
      p.part.aim = new THREE.Vector3(...aimPoint(s.pos, s.target, { bad: this.badTargets.has(s.id), up: s.up }));
    }
  }

  // The pool joins the scene only with a model and lights on (a change recompiles the shaders once).
  _showLights() {
    const on = (!!this.model || !!this._keepLights) && this._lightsOn;
    if (this.lights.visible === on) return false;
    this.lights.visible = on;
    return true;
  }

  // The mower object (bound and not hidden) or null.
  _mower() {
    for (const [id, p] of this.parts) {
      const b = this.bindings.get(id);
      if (p.obj.type === 'mower' && b && b.entity && !b.hidden) return { id, p, entity: b.entity };
    }
    return null;
  }

  // The dock object's pose on the plan: { x, y, heading } (anchor, front = its +Z or hints.front) or null.
  // A dock bound to the mower's entity wins over another one; hidden docks are ignored.
  dockPose() {
    const best = this._dock();
    if (!best) return null;
    const { p } = best, root = this.model.root;
    root.updateWorldMatrix(true, false);
    p.obj.node.updateWorldMatrix(true, false);
    const q = p.obj.node.getWorldQuaternion(new THREE.Quaternion());
    const dir = new THREE.Vector3(...dockFrontAxis(p.obj.hints)).applyQuaternion(q);
    const a = root.localToWorld(p.part.anchor.clone());
    return dockPose(a, dir);
  }

  // The dock object { id, p } (see dockPose) or null.
  _dock() {
    if (!this.model) return null;
    const mw = this._mower();
    let best = null;
    for (const [id, p] of this.parts) {
      if (p.obj.type !== 'dock' || !p.obj.node) continue;
      const b = this.bindings.get(id);
      if (b && b.hidden) continue;
      const score = mw && b && b.entity === mw.entity ? 2 : 1;
      if (!best || score > best.score) best = { id, p, score };
    }
    return best;
  }

  dockId() {
    const d = this._dock();
    return d ? d.id : null;
  }

  mowerId() {
    const m = this._mower();
    return m ? m.id : null;
  }

  mowerEntity() {
    const m = this._mower();
    return m ? m.entity : null;
  }

  mowerBound() {
    return !!this._mower();
  }

  // Offline mower: its model dimmed by swapping in dimmed copies of its materials (made once per
  // material and reused, so toggling never recompiles), and back.
  setMowerDim(on) {
    const m = this._mower();
    const node = m && m.p.obj.node;
    if (this._dimNode && this._dimNode !== node) this._applyDim(this._dimNode, false);
    this._dimNode = on ? node : null;
    if (node) this._applyDim(node, !!on);
  }

  _applyDim(node, on) {
    const cache = (this._dimMats = this._dimMats || new Map());
    const dim = (mat) => {
      let d = cache.get(mat);
      if (!d) {
        d = mat.clone();
        d.transparent = true;
        d.opacity = (mat.opacity ?? 1) * 0.45;
        if (d.color) d.color.multiplyScalar(0.55);
        if (d.emissive) d.emissive.multiplyScalar(0.3);
        d.userData = { ...mat.userData, fpDimOf: mat };
        cache.set(mat, d);
      }
      return d;
    };
    let changed = false;
    node.traverse((o) => {
      if (!o.isMesh) return;
      if (on && !o.userData.fpUndim) { o.userData.fpUndim = o.material; o.material = Array.isArray(o.material) ? o.material.map(dim) : dim(o.material); changed = true; }
      if (!on && o.userData.fpUndim) { o.material = o.userData.fpUndim; delete o.userData.fpUndim; changed = true; }
    });
    if (changed) this.view.markDirty();
  }

  // { x, y, floorId, heading } (plan metres, radians ccw from east) or null: moves the mower node.
  // Unchanged poses do nothing (no matrix work, no frame).
  setMowerPose(pose) {
    const next = pose ? { x: pose.x, y: pose.y, floorId: pose.floorId, heading: pose.heading, ground: Number.isFinite(pose.ground) ? pose.ground : null } : null;
    const a = this._pose, b = next;
    if (a === b || (a && b && a.x === b.x && a.y === b.y && a.floorId === b.floorId && Object.is(a.heading, b.heading) && a.ground === b.ground)) return;
    this._pose = next;
    this._applyPose();
    this.view.markDirty();
  }

  _applyPose() {
    if (!this.model) return;
    this.model.root.updateWorldMatrix(true, false);
    const sig = this.model.root.matrixWorld.elements.map((v) => v.toFixed(5)).join();
    const moved = this._poseSig && sig !== this._poseSig;
    this._poseSig = sig;
    for (const p of this.parts.values()) {
      if (!p.type.place) continue;
      if (moved) p.type.place(p.part, null); // restore, so the origin is captured again in the new alignment
      p.type.place(p.part, this._pose);
    }
  }

  // washCfg: { objects: layout.objects, tags: tag settings (all, not only those with a controller) } for
  // the "Light on wall" settings (object > tag > model).
  setBindings(bindings, groups, washCfg = null) {
    if (bindings === this.bindings && groups === this.groups && washCfg === this.washCfg) return;
    this.bindings = bindings || new Map();
    this.groups = groups || {};
    this.washCfg = washCfg;
    for (const p of this.parts.values()) p.inputs = null; // re-evaluate every chain once
  }

  update(states, ctx = {}) {
    if (!this.model) return;
    this.stats.updates++;
    const visibleLevel = ctx.visibleLevel || (() => true);
    const lightsOn = ctx.lightsOn !== false;
    this._lightsOn = lightsOn;
    let changed = this._showLights();
    const fixtures = [];
    const recolour = [];
    const mw = this._mower();
    const mowerEntity = mw ? mw.entity : null;
    for (const [id, p] of this.parts) {
      const binding = this.bindings.get(id);
      const hidden = !!(binding && binding.hidden); // hidden = ignored as a control: dark, no pool light
      const ctrls = hidden ? [] : controllersOf(p.obj, binding, this.groups).map((c) => c.entity);
      const own = binding && binding.entity;
      // extra inputs a type reads (e.g. the charger's power sensor), so its look follows them too
      const extra = !hidden && own && p.type.inputs ? p.type.inputs(own) : [];
      const ents = hidden ? [] : [own, ...ctrls, p.obj.type === 'dock' ? mowerEntity : null, ...extra];
      // HA replaces a state object when it changes: same objects, nothing to do
      const inputs = ents.map((e) => (e ? states[e] : null));
      if (!p.inputs || inputs.length !== p.inputs.length || inputs.some((x, i) => x !== p.inputs[i]) || ents.some((e, i) => e !== p.ents[i])) {
        const prev = p.result;
        p.inputs = inputs;
        p.ents = ents;
        this.stats.evaluated++;
        p.chain = hidden ? { lit: false, unavailable: false, source: null, entities: [], reason: null }
          : chainState(p.obj, binding, this.groups, states);
        p.result = p.type.update(p.part, p.chain, { ...ctx, states, entity: hidden ? null : (binding && binding.entity) || null, mowerEntity });
        changed = true;
        if (prev && (prev.level !== p.result.level || colorKey(prev.color) !== colorKey(p.result.color))) recolour.push(id);
      }
      if (p.part.label) p.part.label.visible = !!p.part.text && !hidden && visibleLevel(p.obj.level) && shown(p.obj.node);
      if (!p.part.pool || hidden) continue;
      const h = p.part.hints;
      fixtures.push({
        id, lit: lightsOn && !!p.result.lit, visible: visibleLevel(p.obj.level) && shown(p.obj.node),
        group: budgetGroup(p.obj, binding, this.groups), max: h.max, beam: h.beam, castShadow: h.castShadow,
        wash: h.beam !== 'spot' && this.washKindOf(id) !== 'none',
      });
    }
    // the model was placed elsewhere: pool positions move with it
    const root = this.model.root;
    root.updateWorldMatrix(true, false);
    const placeSig = root.matrixWorld.elements.map((v) => v.toFixed(5)).join();
    if (this._pose && placeSig !== this._poseSig) this._applyPose(); // the model was re-aligned
    if (placeSig !== this._labelSig) {
      this._labelSig = placeSig;
      for (const p of this.parts.values()) if (p.type.relayout) p.type.relayout(p.part);
    }
    const sig = placeSig + '|' + fixtures.filter((f) => f.lit && f.visible).map((f) => f.id).join();
    if (sig !== this._budgetSig) {
      this._budgetSig = sig;
      const before = this._slotSig();
      this._assign(fixtures);
      this.stats.budget++;
      // shadow maps: only lit shadow slots whose fixture or position changed (dark slots are never redrawn)
      const redraw = [];
      this.pool.points.slice(0, this._nShadow).forEach((l, i) => {
        const key = this._shadowKey(l);
        if (key && key !== this._shadowKeys[i]) redraw.push(l);
        this._shadowKeys[i] = key;
      });
      if (redraw.length) { this.stats.shadowRequests++; this.view.requestShadowUpdate(redraw); }
      if (before !== this._slotSig()) changed = true;
    } else {
      // colour / brightness only: shadow maps depend on light positions, so no redraw
      for (const id of recolour) {
        const slot = this._slots.get(id);
        if (slot) this._light(slot, this.parts.get(id));
      }
    }
    if (this._updateWashes(placeSig, fixtures)) changed = true;
    if (changed) this.view.markDirty();
  }

  // Washes: one per lit, visible light / light_strip (beam hint or a real light), placed the first time it is lit
  // (and again after the model moved), coloured by its light; brighter where no pool light shines. Cheap when
  // nothing changed (signature). Placement ray casts are time-sliced; returns true when a wash changed.
  // The wash kind of an object: its "Light on wall" setting, else its tags', else the model's beam (resolveWash).
  washKindOf(id) {
    const r = this._washOf(id);
    return r ? r.kind : null;
  }

  // { kind, set: true when the object or one of its tags has a setting } or null.
  _washOf(id) {
    const p = this.parts.get(id);
    if (!p) return null;
    const cfg = this.washCfg || {}, b = this.bindings.get(id), tagCfg = cfg.tags || {};
    const own = cfg.objects && cfg.objects[id] ? cfg.objects[id].wash : undefined;
    const tags = b && Array.isArray(b.tags) ? b.tags : p.obj.group ? [p.obj.group] : [];
    const set = !!washSetting(own) || tags.some((t) => Object.hasOwn(tagCfg, t) && !!tagCfg[t] && !!washSetting(tagCfg[t].wash));
    return { kind: resolveWash(p.obj.hints, own, tags, tagCfg), set };
  }

  // The wall next to a lamp (world hit, facing the lamp) or null; cast once per model placement.
  _wallOf(p, a, placeSig) {
    if (!this.view.surfaceRays) return null;
    if (!p.wallHit || p.wallHit.sig !== placeSig) p.wallHit = { sig: placeSig, hit: WashLayer.wall(this.view, a) };
    return p.wallHit.hit;
  }

  _updateWashes(placeSig, fixtures) {
    const vis = new Map(fixtures.map((f) => [f.id, f.lit && f.visible]));
    const want = [];
    for (const [id, p] of this.parts) {
      if (!WASH_TYPES.has(p.obj.type)) continue;
      const { kind, set } = this._washOf(id);
      if (!(p.part.pool || (p.obj.hints && p.obj.hints.beam) || set)) {
        if (p.wash) for (const m of p.wash.meshes) this.washes.paint(m, null, 0);
        continue;
      }
      const on = kind !== 'none' && (vis.has(id) ? vis.get(id) : !!(this._lightsOn && p.result && p.result.lit && shown(p.obj.node)));
      want.push({ id, p, on, kind });
    }
    const sig = placeSig + '|' + want.map(({ id, p, on, kind }) => (on ? `${id}:${kind}:${p.result.level}:${colorKey(p.result.color)}:${this._slots.has(id) ? 1 : 0}` : '')).join(';');
    if (sig === this._washSig) return false;
    const t0 = performance.now();
    let pending = false, changed = false;
    const root = this.model.root;
    for (const { id, p, on, kind } of want) {
      if (!on) {
        if (p.wash) for (const m of p.wash.meshes) if (m.visible) { this.washes.paint(m, null, 0); changed = true; }
        continue;
      }
      const wsig = placeSig + '|' + kind;
      if (!p.wash || p.wash.sig !== wsig) {
        if (performance.now() - t0 > WASH_SLICE_MS) { pending = true; continue; }
        const a = root.localToWorld(p.part.anchor.clone());
        let aimDir = null;
        if (kind === 'spot' && p.part.aim) aimDir = root.localToWorld(p.part.aim.clone()).sub(a).normalize().toArray();
        const wall = kind === 'spot' ? undefined : this._wallOf(p, a, placeSig);
        const surf = this.view.surfaceRays ? WashLayer.surfaces(this.view, a, kind, aimDir, wall) : {};
        const placements = placeWashes(kind, a.toArray(), washSize(p.part.hints), surf);
        // a mesh per quad (two for 'both'), made once and reused; spare ones stay hidden
        const meshes = p.wash ? p.wash.meshes.slice() : [];
        const n = Math.max(meshes.length, placements.length, 1);
        for (let i = 0; i < n; i++) meshes[i] = this.washes.place(meshes[i], placements[i] || null);
        p.wash = { meshes, sig: wsig, placements };
      }
      const opacity = washOpacity(p.result.level, this._slots.has(id));
      p.wash.meshes.forEach((m, i) => this.washes.paint(m, p.result.color || [255, 255, 255], p.wash.placements[i] ? opacity : 0));
      changed = true;
    }
    this._washSig = pending ? null : sig;
    if (pending && !this._washTimer) {
      this._washTimer = setTimeout(() => {
        this._washTimer = null;
        if (!this.model) return;
        if (this._updateWashes(placeSig, fixtures)) this.view.markDirty();
      }, 0);
    }
    return changed;
  }

  // fixture@position of a lit shadow slot, null when the slot is dark
  _shadowKey(light) {
    for (const [id, s] of this._slots) if (s.light === light) return `${id}@${light.position.toArray().join()}`;
    return null;
  }

  // The shadow casters changed (model, visibility, cut, section): the lit shadow slots to redraw.
  // Dark slots forget their key, so they are redrawn once they light up.
  shadowsStale() {
    const out = [];
    this.pool.points.slice(0, this._nShadow).forEach((l, i) => {
      if (this._shadowKeys[i] && this.lights.visible) out.push(l);
      else this._shadowKeys[i] = null;
    });
    return out;
  }

  _assign(fixtures) {
    const prev = new Map([...this._slots].map(([id, s]) => [id, s.light]));
    this._darken();
    const { real, shadows } = lightBudget(fixtures, { points: this._nShadow + FREE_POINTS, spots: SPOTS, shadows: this._nShadow });
    const pts = this.pool.points;
    const shadowSlots = pts.slice(0, this._nShadow), freeSlots = pts.slice(this._nShadow);
    const order = [...real.keys()];
    // a fixture keeps the shadow slot it had (no needless shadow map redraws)
    const take = (id) => {
      const i = shadowSlots.indexOf(prev.get(id));
      return i >= 0 ? shadowSlots.splice(i, 1)[0] : null;
    };
    // shadow picks first (shadow slots; own slot, then any), then group lights and the rest into the free points, then any shadow slot left
    const picks = order.filter((x) => shadows.has(x));
    const kept = new Map(picks.map((id) => [id, take(id)]));
    for (const id of picks) this._slots.set(id, { light: kept.get(id) || shadowSlots.shift(), shadow: true, factor: real.get(id).factor });
    let spot = 0;
    // group lights first, so they get the non-shadow slots (group lights never cast shadows)
    const rest = order.filter((id) => !shadows.has(id));
    rest.sort((a, b) => (real.get(b).grouped ? 1 : 0) - (real.get(a).grouped ? 1 : 0));
    for (const id of rest) {
      const { kind, factor } = real.get(id);
      if (kind === 'spot') { this._slots.set(id, { light: this.pool.spots[spot++], shadow: false, factor }); continue; }
      const light = freeSlots.shift() || take(id) || shadowSlots.shift();
      this._slots.set(id, { light, shadow: pts.indexOf(light) < this._nShadow, factor });
    }
    const root = this.model.root;
    const placeSig = root.matrixWorld.elements.map((v) => v.toFixed(5)).join();
    for (const [id, slot] of this._slots) {
      const p = this.parts.get(id);
      const h = p.part.hints, l = slot.light;
      l.position.copy(root.localToWorld(p.part.anchor.clone()));
      // a point light right on a wall (or door) burns a hot spot into it: kept 0.15 m off the wall it faces
      if (!l.isSpotLight) l.position.fromArray(clearOfWall(l.position.toArray(), this._wallOf(p, l.position.clone(), placeSig)));
      l.distance = h.distance;
      l.decay = h.decay;
      if (l.isSpotLight) {
        l.angle = h.angle * DEG;
        l.penumbra = h.penumbra;
        // aim from _aimSpots: a plausible target, else straight up (uplights) / down from the lamp itself
        if (p.part.aim) l.target.position.copy(root.localToWorld(p.part.aim.clone()));
        else l.target.position.copy(l.position).y -= 1;
        l.target.updateMatrixWorld();
      }
      l.updateMatrixWorld();
      this._light(slot, p);
    }
  }

  _slotSig() {
    return [...this._slots].map(([id, s]) => `${id}:${s.light.id}:${s.light.position.toArray().join()}`).join(';');
  }

  _light(slot, p) {
    const r = p.result;
    const c = r.color || [255, 255, 255];
    slot.light.color.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
    slot.light.intensity = r.level * p.part.hints.max * slot.factor;
  }

  _darken() {
    for (const l of [...this.pool.points, ...this.pool.spots]) l.intensity = 0;
    this._slots.clear();
  }

  // World positions of every object's anchor (card world).
  anchors() {
    if (!this.model) return [];
    const root = this.model.root;
    root.updateWorldMatrix(true, false);
    return [...this.parts].map(([id, p]) => ({ id, world: root.localToWorld(p.part.anchor.clone()) }));
  }

  // World position of one object's anchor (null when the object is gone).
  anchorOf(id) {
    const p = this.model && this.parts.get(id);
    if (!p) return null;
    this.model.root.updateWorldMatrix(true, false);
    return this.model.root.localToWorld(p.part.anchor.clone());
  }

  objectAt(id) {
    const p = this.parts.get(id);
    return p ? { obj: p.obj, part: p.part, chain: p.chain, result: p.result, binding: this.bindings.get(id) || null } : null;
  }

  dispose() {
    this.setModel(null);
    const group = this.lights;
    for (const l of this.pool.spots) group.remove(l.target);
    for (const l of [...this.pool.points, ...this.pool.spots]) { group.remove(l); l.dispose(); }
    this.washes.dispose();
    this.view.objectsGroup.remove(group);
    if (this.view.objectLayer === this) this.view.objectLayer = null;
  }
}
