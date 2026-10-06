// Model objects on the plan: per-object looks (types.js) and a fixed pool of real lights.
// The pool is created once (8 point + 4 spot) so shaders never recompile; the first 4 point
// slots always cast shadows and get the budget's shadow picks. The pool lives in its own sub-group:
// shown only with a model and `lights` not off (hiding it drops the lights from the shaders).
// Shadow maps are rendered per light (shadow.autoUpdate = false): only lit shadow slots whose
// fixture or position changed, or all lit ones when the casters changed (shadowsStale).
import * as THREE from 'three';
import { chainState, lightBudget } from './logic.js';
import { typeOf } from './types.js';
import { badTargets, aimPoint, aimsUp } from './aim.js';

const POINTS = 8, SPOTS = 4, SHADOWS = 4;
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
    for (let i = 0; i < POINTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 0, 2);
      if (i < SHADOWS) {
        l.castShadow = true; // never toggled later (a toggle recompiles every shader)
        l.shadow.mapSize.set(512, 512);
        l.shadow.bias = -0.004;
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
    view.objectsGroup.visible = false; // objects (and their lights) only while a model is loaded
    group.visible = false;
    this._lightsOn = true;
    this._shadowKeys = new Array(SHADOWS).fill(null); // per shadow slot: fixture@position its map was rendered for
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

  // keepLights: another model replaces this one (a reload), so the pool stays in the scene meanwhile
  // (dark): dropping it and adding it back would compile every lit shader twice.
  setModel(model, { keepLights = false } = {}) {
    this._keepLights = !model && keepLights;
    if (model && this.model === model) return;
    for (const p of this.parts.values()) p.type.dispose(p.part);
    this.parts.clear();
    this._darken();
    this.model = model || null;
    this._budgetSig = null;
    this._placeSig = null;
    this._poseSig = null;
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

  setBindings(bindings, groups) {
    if (bindings === this.bindings && groups === this.groups) return;
    this.bindings = bindings || new Map();
    this.groups = groups || {};
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
      const ctrl = !hidden && p.obj.group && this.groups[p.obj.group] && this.groups[p.obj.group].entity;
      const own = binding && binding.entity;
      // extra inputs a type reads (e.g. the charger's power sensor), so its look follows them too
      const extra = !hidden && own && p.type.inputs ? p.type.inputs(own) : [];
      const ents = hidden ? [] : [own, ctrl, p.obj.type === 'dock' ? mowerEntity : null, ...extra];
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
        group: p.obj.group, max: h.max, beam: h.beam, castShadow: h.castShadow,
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
      this.pool.points.slice(0, SHADOWS).forEach((l, i) => {
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
    if (changed) this.view.markDirty();
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
    this.pool.points.slice(0, SHADOWS).forEach((l, i) => {
      if (this._shadowKeys[i] && this.lights.visible) out.push(l);
      else this._shadowKeys[i] = null;
    });
    return out;
  }

  _assign(fixtures) {
    const prev = new Map([...this._slots].map(([id, s]) => [id, s.light]));
    this._darken();
    const { real, shadows } = lightBudget(fixtures, { points: POINTS, spots: SPOTS, shadows: SHADOWS });
    const pts = this.pool.points;
    const shadowSlots = pts.slice(0, SHADOWS), freeSlots = pts.slice(SHADOWS);
    const order = [...real.keys()];
    // a fixture keeps the shadow slot it had (no needless shadow map redraws)
    const take = (id) => {
      const i = shadowSlots.indexOf(prev.get(id));
      return i >= 0 ? shadowSlots.splice(i, 1)[0] : null;
    };
    // shadow picks first (slots 0..3; own slot, then any), then group lights and the rest into 4..7, then any shadow slot left
    const picks = order.filter((x) => shadows.has(x));
    const kept = new Map(picks.map((id) => [id, take(id)]));
    for (const id of picks) this._slots.set(id, { light: kept.get(id) || shadowSlots.shift(), shadow: true, factor: real.get(id).factor });
    let spot = 0;
    // group lights first, so they get the non-shadow slots 4..7 (group lights never cast shadows)
    const rest = order.filter((id) => !shadows.has(id));
    rest.sort((a, b) => (real.get(b).grouped ? 1 : 0) - (real.get(a).grouped ? 1 : 0));
    for (const id of rest) {
      const { kind, factor } = real.get(id);
      if (kind === 'spot') { this._slots.set(id, { light: this.pool.spots[spot++], shadow: false, factor }); continue; }
      const light = freeSlots.shift() || take(id) || shadowSlots.shift();
      this._slots.set(id, { light, shadow: pts.indexOf(light) < SHADOWS, factor });
    }
    const root = this.model.root;
    for (const [id, slot] of this._slots) {
      const p = this.parts.get(id);
      const h = p.part.hints, l = slot.light;
      l.position.copy(root.localToWorld(p.part.anchor.clone()));
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
    this.view.objectsGroup.remove(group);
    if (this.view.objectLayer === this) this.view.objectLayer = null;
  }
}
