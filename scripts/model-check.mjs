// Headless check of the GLB underlay and the export snippet:
// - demo with ?model=1: model loads, level groups follow the floor chips, roof is cut away
// - a missing model shows a notice instead of breaking the card
// - tools/export-glb.js exports a named scene to a valid .glb without lights/helpers
//   node scripts/model-check.mjs [--shard k/n] [--only group,group] [--jobs N] [--list]
// Without --shard / --only the section groups run as parallel shards (--jobs, default 3).
import fs from 'node:fs';
import path from 'node:path';
import { openDemo, newPage, root } from './lib/demo-browser.mjs';
import { Sections, parseArgs, selectGroups } from './lib/sections.mjs';
import { inverseTransformPoint, transformPoint } from '../src/bindings.js';
import { alignModelPoint } from '../src/views.js';
import { pixelToPlan } from '../src/mower-image.js';
import { fitOutline, HOUSE_OUTLINE } from '../src/load-outline.js';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' – ' + detail : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wait until the 400 ms camera tween has finished (fixed sleeps flake under load)
const settle = async (page, card) => { await page.waitForFunction(`!${card}._view._tween`, { timeout: 5000 }).catch(() => {}); await idle(page); };
const card = 'document.querySelector("floorplan3d-card")';
// Instead of fixed sleeps after camera moves, renders and state changes: two frames, then until the
// view and card are idle (no camera tween, frame drawn, no occlusion pass, rebuild, surface job or
// pending single tap), at most 5 s.
const idle = (page) => page.evaluate(`new Promise((done) => {
  const t0 = performance.now();
  let n = 0;
  const tick = () => {
    const c = ${card}, v = c && c._view;
    const ok = ++n > 2 && (!v || (!v._tween && !v.dirty && !v._occTimer && !c._pending && !c._surfJob && !(c._taps && c._taps.pending.size)));
    if (ok || performance.now() - t0 > 5000) done(ok); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`);
// move the camera and wait for the occlusion pass that follows it to finish (no fixed sleeps)
const camAndOcclusion = async (page, cam) => {
  const before = await page.evaluate(`${card}._view.stats.occDone`);
  // an explicit full pass too: the camera may already be there (no change event, no pass of its own)
  await page.evaluate(`(() => { const v = ${card}._view; v.setCamera(${typeof cam === 'string' ? cam : JSON.stringify(cam)}, { instant: true }); v._scheduleOcclusion(0); })()`);
  await page.waitForFunction(`(() => { const v = ${card}._view; return !v._tween && v.stats.occDone > ${before} && !v._occFull && !v._occTimer; })()`, { timeout: 5000 })
    .catch(() => console.log('     (occlusion pass did not finish in 5 s)'));
};
let allErrors = [];
const sections = new Sections();
let s; // the optional runs at the end (own browsers)

function rewriteGlbJson(buf, edit) {
  const jsonLen = buf.readUInt32LE(12);
  const json = edit(JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)));
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + jsonLen); // BIN chunk unchanged
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + j.length + rest.length, 8);
  head.writeUInt32LE(j.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, j, rest]);
}

// 1. model in the demo
sections.add('model', { group: 'model', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
  await idle(page);
  const st = () => page.evaluate(`(() => { const v = ${card}._view; const vis = (id) => v.modelManifest().levels.find((l) => l.id === id)?.node.visible; return {
    level0: vis('level0'), level1: vis('level1'), exterior: vis('exterior'), roof: vis('roof'),
    cut: v.modelClip.constant, floors: v.modelManifest().levels.map((l) => l.id) }; })()`);
  const sh = (name) => page.screenshot({ path: path.join(root, 'screenshots', name) });
  fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
  let v = await st();
  check('model loaded with level groups', JSON.stringify(v.floors) === '["level0","level1","exterior","roof"]', JSON.stringify(v.floors));
  const chipList = () => page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.chip')].map((b) => b.textContent)`);
  check('chips are the model\'s views in order', JSON.stringify(await chipList()) === '["Exterior","Ground floor","First floor"]', JSON.stringify(await chipList()));
  const chip = async (id) => { await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=${id}]').click()`); await idle(page); };
  // devices by the level of their model room (roomless ones by HA floor): shown / hidden / faded
  const devs = () => page.evaluate(`(() => { const c = ${card}, v = c._view; const lvl = new Map(v.modelManifest().rooms.map((r) => [r.id, r.level]));
    const out = {};
    for (const m of c._markers) {
      const p = c._positions.get(m.id), o = v.markerObjects.get(m.id);
      if (!p || !o) continue;
      const room = p.auto === false || p.live ? null : (c._modelRooms.find((r) => r.area_id === m.areaId) || {}).modelId;
      const k = room ? lvl.get(room) : p.live ? 'mower' : 'pin:' + p.floorId;
      const e = out[k] = out[k] || { shown: 0, hidden: 0, faded: 0 };
      if (o.obj.visible) e.shown++; else e.hidden++;
      if (o.obj.element.classList.contains('fp-faded')) e.faded++;
    }
    return out; })()`);
  const noneFaded = (d) => Object.values(d).every((e) => e.faded === 0);
  await chip('ground');
  v = await st();
  check('Ground floor view: level0 + exterior shown, level1 + roof hidden, tagged model not cut',
    v.level0 === true && v.level1 === false && v.exterior === true && v.roof === false && v.cut > 1000, JSON.stringify(v));
  let d = await devs();
  check('Ground floor view: ground-floor devices shown, first-floor devices hidden, outdoor shown',
    d.level0.shown > 0 && d.level0.hidden === 0 && d.level1.shown === 0 && d.level1.hidden > 0 && d.exterior.hidden === 0 && noneFaded(d), JSON.stringify(d));
  await sleep(500);
  await sh('look-day.png');
  await sh('model-ground.png');

  // render fixes: depth range, glass shadows, depth kept when ghosted, markers behind walls
  const depth = await page.evaluate(`(() => { const c = ${card}._view.persp; return { near: c.near, far: c.far }; })()`);
  check('depth range: near >= 0.2, far within 50..500 after load', depth.near >= 0.2 && depth.far >= 50 && depth.far <= 500, JSON.stringify(depth));
  // a 200 m terrain: the far plane must still reach its farthest corner from the exterior view at max distance
  await chip('exterior');
  const terrain = await page.evaluate(`(async () => { const c = ${card}, v = c._view;
    const sofa = v.model.root.getObjectByName('sofa_body'); // borrow the bundle's three classes
    const three = { Vector3: v.persp.position.constructor };
    const g = sofa.geometry.clone(); // a 200 x 0.1 x 200 m box centred on the origin
    g.computeBoundingBox();
    const bb = g.boundingBox, cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
    g.translate(-cx, -cy, -cz).scale(200 / (bb.max.x - bb.min.x), 0.1 / (bb.max.y - bb.min.y), 200 / (bb.max.z - bb.min.z));
    const m = new sofa.constructor(g, sofa.material.clone());
    m.name = 'test_terrain'; m.userData.fp = { layer: 'terrain' }; m.position.set(6, -0.3, -4.5);
    v.model.root.add(m); c._loadModel(); await new Promise((r) => setTimeout(r, 100));
    const cam = v.getCamera(), t = cam.target, p = cam.position, d = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    v.setCamera({ target: t, position: p.map((x, i) => t[i] + ((x - t[i]) * 130) / d) }, { instant: true });
    await new Promise((r) => setTimeout(r, 300));
    v.persp.updateMatrixWorld();
    let far = 0; m.updateMatrixWorld(true);
    for (const [x, z] of [[-100, -100], [100, -100], [100, 100], [-100, 100]]) {
      const w = new three.Vector3(x, 0, z).applyMatrix4(m.matrixWorld).applyMatrix4(v.persp.matrixWorldInverse);
      far = Math.max(far, -w.z);
    }
    const out = { cornerDepth: far, near: v.persp.near, far: v.persp.far, dist: 130 };
    v.model.root.remove(m); g.dispose(); m.material.dispose(); c._loadModel(); v.setCamera(cam, { instant: true });
    await new Promise((r) => setTimeout(r, 100));
    return out; })()`);
  check('far plane covers a 200 m terrain from 130 m away', terrain.cornerDepth < terrain.far && terrain.far <= 500 * 1.05, JSON.stringify(terrain));
  await chip('ground');
  const shadows = await page.evaluate(`(() => { const r = ${card}._view.model.root; const pane = r.getObjectByName('window_pane_living');
    const body = r.getObjectByName('sofa_body');
    let clip = 0; r.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m.clippingPlanes && m.clippingPlanes.length) clip++; });
    return { pane: pane && [pane.castShadow, pane.receiveShadow], sofa: body && body.castShadow, clip, normalBias: ${card}._view.sun.shadow.normalBias }; })()`);
  check('glass pane casts no shadow (still receives), furniture casts', !!shadows.pane && shadows.pane[0] === false && shadows.pane[1] === true && shadows.sofa === true, JSON.stringify(shadows));
  check('tagged model: no clipping planes on its materials; sun normalBias 0.02', shadows.clip === 0 && shadows.normalBias === 0.02, JSON.stringify(shadows));
  const ghost = await page.evaluate(`(async () => { const c = ${card}, v = c._view; const m = v.model.root.getObjectByName('sofa_body').material;
    const pane = v.model.root.getObjectByName('window_pane_living').material;
    c._config = { ...c._config, model_opacity: 0.6 }; c._loadModel(); await new Promise((r) => setTimeout(r, 100));
    const out = { depthWrite: m.depthWrite, alphaHash: m.alphaHash, transparent: m.transparent, opacity: m.opacity, paneOpacity: pane.opacity, paneTransparent: pane.transparent };
    c._config = { ...c._config, model_opacity: 1 }; c._loadModel(); await new Promise((r) => setTimeout(r, 100));
    out.back = { alphaHash: m.alphaHash, opacity: m.opacity, depthWrite: m.depthWrite };
    return out; })()`);
  check('opacity 0.6: opaque material keeps depthWrite, glass untouched; 1 restores',
    ghost.depthWrite === true && ghost.transparent === true && ghost.opacity === 0.6 && ghost.paneTransparent === true && Math.abs(ghost.paneOpacity - 0.35) < 1e-6
    && ghost.back.opacity === 1 && ghost.back.depthWrite === true, JSON.stringify(ghost));
  // a ground-floor marker seen from outside the south facade, through the wall
  const occ = await page.evaluate(`(() => { const c = ${card}, v = c._view;
    for (const [id, m] of v.markerObjects) {
      const p = m.obj.position;
      if (!m.obj.visible || m.floorId !== 'ground' || p.y < 0.3 || p.y > 2.0 || -p.z < 1 || -p.z > 4.5 || p.x < 0.5 || p.x > 11.5) continue;
      return { id, pos: p.toArray() };
    }
    return null; })()`);
  if (occ) {
    const camBefore = await page.evaluate(`${card}._view.getCamera()`);
    await camAndOcclusion(page, { position: [occ.pos[0], occ.pos[1] + 2, occ.pos[2] + 12], target: occ.pos });
    const cls = (id) => page.evaluate(`${card}._view.markerObjects.get(${JSON.stringify(id)}).obj.element.classList.contains('fp-occluded')`);
    check('a marker behind the south wall is fp-occluded from a camera outside', await cls(occ.id), JSON.stringify(occ));
    const style = (id) => page.evaluate(`(() => { const s = getComputedStyle(${card}._view.markerObjects.get(${JSON.stringify(id)}).obj.element); return [s.opacity, s.pointerEvents]; })()`);
    check('occluded marker: faint, not clickable in view mode', JSON.stringify(await style(occ.id)) === '["0.25","none"]', JSON.stringify(await style(occ.id)));
    await page.evaluate(`${card}._toggleEdit()`);
    await settle(page, card);
    await camAndOcclusion(page, { position: [occ.pos[0], occ.pos[1] + 2, occ.pos[2] + 12], target: occ.pos });
    // edit mode rebuilds markers: wait until the (new) element is connected and classed
    await page.waitForFunction(`(() => { const m = ${card}._view.markerObjects.get(${JSON.stringify(occ.id)}); return m && m.obj.element.isConnected && m.obj.element.classList.contains('fp-occluded') && getComputedStyle(m.obj.element).opacity === '0.5'; })()`, { timeout: 8000 }).catch(() => {});
    const es = await style(occ.id);
    check('occluded marker in edit mode: half opacity, still draggable', (await cls(occ.id)) && JSON.stringify(es) === '["0.5","auto"]', JSON.stringify(es));
    await page.evaluate(`${card}._toggleEdit()`);
    await idle(page);
    await camAndOcclusion(page, { position: [occ.pos[0], occ.pos[1] + 14, occ.pos[2] + 3], target: occ.pos });
    check('same marker seen from above (no wall in between) is not occluded', !(await cls(occ.id)));
    await page.evaluate(`${card}._view.setCamera(${JSON.stringify(camBefore)}, { instant: true })`);
    await idle(page);
  } else {
    check('found a ground-floor marker near the south facade for the occlusion check', false);
  }
  await chip('first');
  v = await st();
  check('First floor view: both storeys stack, exterior shown, roof hidden', v.level0 && v.level1 && v.exterior && !v.roof, JSON.stringify(v));
  d = await devs();
  check('First floor view: ground-floor devices hidden (not faded), first-floor and outdoor devices shown',
    d.level0.shown === 0 && d.level0.hidden > 0 && d.level1.shown > 0 && d.level1.hidden === 0 && d.exterior.hidden === 0 && noneFaded(d), JSON.stringify(d));
  // pins take the room / zone under them (the floor lamp stands in the living room), the mower is outdoors
  check('First floor view: a ground-floor pin in a ground-floor room is hidden', d['pin:ground'] && d['pin:ground'].shown === 0, JSON.stringify(d['pin:ground']));
  check('First floor view: the live mower is shown (exterior visible)', !d.mower || d.mower.shown === 1, JSON.stringify(d.mower));
  await sh('model-first.png');
  const shownMarkers = () => page.evaluate(`[...${card}._view.markerObjects.values()].filter((m) => m.obj.visible).length`);
  const allMarkers = await page.evaluate(`${card}._view.markerObjects.size`);
  await chip('exterior');
  v = await st();
  check('Exterior view: every level shown uncut', v.level0 && v.level1 && v.exterior && v.roof && v.cut > 1000, JSON.stringify(v));
  const faded = () => page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-marker.fp-faded').length`);
  check('Exterior view (overview): every device shown, none faded', (await faded()) === 0 && (await shownMarkers()) === allMarkers, `${await shownMarkers()}/${allMarkers}`);
  check('Exterior view (overview): no room labels', (await page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-room-label:not(.fp-obj-label)').length`)) === 0);
  await page.screenshot({ path: path.join(root, 'screenshots', 'model-exterior.png') });
  await page.evaluate(`${card}._setFloor('first')`);
  await idle(page);
  check('_setFloor prefers the storey view over the overview linked to the same floor', (await page.evaluate(`${card}._viewId`)) === 'first', await page.evaluate(`${card}._viewId`));
  await chip('ground');
  check('single floor: no faded markers', (await faded()) === 0);
  check('no notice', await page.evaluate(`${card}.shadowRoot.querySelector('.notice').hidden`));

  // side section: show all + one global clipping plane, camera looks at the cut, markers beyond it hidden
  const secBtn = `${card}.shadowRoot.querySelector('button.section')`;
  const sides = () => page.evaluate(`(() => { const out = []; ${card}._view.model.root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) out.push(m.side); }); return out.join(','); })()`);
  check('Section button shown in 3D with a model', (await page.evaluate(`${secBtn}.hidden`)) === false);
  const sides0 = await sides();
  const cam0 = await page.evaluate(`${card}._view.getCamera()`);
  await page.evaluate(`${secBtn}.click()`);
  await sleep(700);
  const secState = () => page.evaluate(`(() => { const c = ${card}, v = c._view, p = v.sectionClip;
    let removedHidden = 0, removedShown = 0, keptShown = 0;
    for (const m of v.markerObjects.values()) {
      if (!p) break;
      if (p.distanceToPoint(m.obj.position) < 0) { if (m.obj.visible) removedShown++; else removedHidden++; } else if (m.obj.visible) keptShown++;
    }
    let dbl = 0, n = 0;
    v.model.root.traverse((o) => { if (o.isMesh) { n++; if ([].concat(o.material).every((x) => x.side === 2)) dbl++; } });
    const roof = v.modelManifest().levels.find((l) => l.id === 'roof').node;
    let roofShown = true; for (let o = roof; o; o = o.parent) if (!o.visible) roofShown = false;
    return { planes: v.renderer.clippingPlanes.length, roofShown, removedHidden, removedShown, keptShown, dbl, n, cam: v.getCamera(),
      on: c.shadowRoot.querySelector('button.section').classList.contains('on') }; })()`);
  await page.waitForFunction((c0) => JSON.stringify(document.querySelector('floorplan3d-card')._view.getCamera()) !== c0, { timeout: 8000 }, JSON.stringify(cam0)).catch(() => {});
  await settle(page, card);
  let sec = await secState();
  check('Section on: one global clipping plane, roof shown, button on', sec.planes === 1 && sec.roofShown && sec.on, JSON.stringify(sec));
  check('Section on: model materials double-sided', sec.n > 0 && sec.dbl === sec.n, `${sec.dbl}/${sec.n}`);
  check('Section on: camera moved to the cut', JSON.stringify(sec.cam) !== JSON.stringify(cam0), JSON.stringify([cam0, sec.cam]));
  check('Section on: markers on the removed side hidden, kept side shown', sec.removedHidden > 0 && sec.removedShown === 0 && sec.keptShown > 0, JSON.stringify(sec));
  await sh('model-section.png');
  const pk = await page.evaluate(`(() => { const v = ${card}._view, r = v.renderer.domElement.getBoundingClientRect(); let hits = 0, cut = 0;
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) { const h = v.pickModel(r.left + (r.width * i) / 8, r.top + (r.height * j) / 8);
      if (!h) continue; hits++; if (v.sectionClip.distanceToPoint({ x: h.hit.point[0], y: h.hit.point[1], z: h.hit.point[2] }) < -1e-6) cut++; }
    return { hits, cut }; })()`);
  check('Section on: model picks ignore the removed half', pk.hits > 0 && pk.cut === 0, JSON.stringify(pk));
  await page.evaluate(`${secBtn}.click()`);
  await sleep(600);
  sec = await secState();
  v = await st();
  check('Section off: planes cleared, roof hidden again in the storey view', sec.planes === 0 && !v.roof && !sec.on, JSON.stringify({ planes: sec.planes, roof: v.roof }));
  check('Section off: model materials\' side restored', (await sides()) === sides0);
  d = await devs();
  check('Section off: ground-floor devices back to the view rules', d.level0.shown > 0 && d.level1.shown === 0, JSON.stringify(d));
  await page.evaluate(`${secBtn}.click()`);
  await idle(page);
  await page.evaluate(`${card}.shadowRoot.querySelector('.seg button[data-mode=top]').click()`);
  await idle(page);
  check('Top view clears the section and hides the button', (await page.evaluate(`${card}._view.renderer.clippingPlanes.length === 0 && ${secBtn}.hidden && !${card}._section`)));
  await page.evaluate(`${card}.shadowRoot.querySelector('.seg button[data-mode="3d"]').click()`);
  await idle(page);

  const look = await page.evaluate(`(() => { const v = ${card}._view; return { tm: v.renderer.toneMapping, sm: v.renderer.shadowMap.enabled,
    sr: v.sun.shadow.camera.right, pr: v.renderer.getPixelRatio(),
    fills: (() => { let n = 0; v.staticGroup.traverse((o) => { if (o.isMesh && o.userData.roomId) n++; }); return n; })(),
    labels: ${card}.shadowRoot.querySelectorAll('.fp-room-label:not(.fp-obj-label)').length, tagged: v.isTagged(),
    hasModel: ${card}._stage.classList.contains('has-model'), dayHidden: ${card}.shadowRoot.querySelector('button.daynight').hidden }; })()`);
  check('ACES tone mapping with a model', look.tm === 4, String(look.tm));
  check('shadows on, shadow camera fitted to the model', look.sm === true && look.sr < 200 && look.sr < 40, `${look.sm} ${look.sr}`);
  check('pixel ratio capped', look.pr <= 1.5, String(look.pr));
  check('no room fills; ground view labels its own rooms with sizes', look.fills === 0 && look.labels > 0
    && (await page.evaluate(`${card}.shadowRoot.querySelector('.fp-room-label:not(.fp-obj-label)').textContent`)).includes(' m'), JSON.stringify(look));
  check('stage has has-model, day/night button shown', look.hasModel && !look.dayHidden);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await idle(page);
  check('edit mode shows room labels', (await page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-room-label:not(.fp-obj-label)').length`)) > 0);
  const traced = await page.evaluate(`(() => {
    const ed = ${card}._edit, v = ${card}._view;
    let found = null;
    v.model.root.traverse((m) => {
      if (found || !m.isMesh) return;
      const t = v.meshTriangles(m);
      for (let i = 0; i + 8 < t.length && !found; i += 9) {
        const ux = t[i+3]-t[i], uz = t[i+5]-t[i+2], vx = t[i+6]-t[i], vz = t[i+8]-t[i+2];
        if (Math.abs(uz * vx - ux * vz) > 1e-3 && Math.abs(t[i+1] - t[i+4]) < 1e-6 && Math.abs(t[i+1] - t[i+7]) < 1e-6)
          found = { m, hit: [(t[i]+t[i+3]+t[i+6])/3, t[i+1], (t[i+2]+t[i+5]+t[i+8])/3] };
      }
    });
    if (!found) return null;
    const r = ed._traceOutline(found.m, found.hit);
    return r.poly ? r.poly.length : 0;
  })()`);
  check('pick: a floor piece of the model gives an outline polygon', traced >= 3, String(traced));
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await idle(page);
  check('leaving edit mode restores the view\'s labels', (await page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-room-label:not(.fp-obj-label)').length`)) === look.labels);
  // framing uses the room polygons even though no fills/outlines/walls are rendered with a model
  await page.evaluate(`${card}._setFloor('ground'); ${card}._view.setMode('3d'); ${card}._view.fit({ instant: true })`);
  await idle(page);
  const dist = () => page.evaluate(`(() => { const v = ${card}._view; return v.persp.position.distanceTo(v.controls.target); })()`);
  const ext = await page.evaluate(`(() => { let a = 1e9, b = -1e9, c = 1e9, d = -1e9; for (const { room } of ${card}._view._rooms) for (const [x, y] of room.polygon) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); } return Math.max(b - a, d - c); })()`);
  const d0 = await dist();
  check('model + rooms: camera frames the rooms', ext > 0 && d0 < 2.5 * ext, `dist ${d0.toFixed(1)} ext ${ext.toFixed(1)}`);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await sleep(600);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await sleep(900);
  const d1 = await dist();
  check('edit mode on/off keeps the camera distance within 5 %', Math.abs(d1 - d0) / d0 < 0.05, `${d0.toFixed(2)} -> ${d1.toFixed(2)}`);
  // chip switch keeps the camera; Reset view frames again
  const camAt = () => page.evaluate(`${card}._view.persp.position.toArray().map((x) => x.toFixed(2)).join()`);
  await page.evaluate(`${card}._view.setCamera({ position: [30, 30, 30], target: [0, 0, 0] }, { instant: true })`);
  const c0 = await camAt();
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=first]').click()`);
  await sleep(600);
  check('chip switch keeps the camera', (await camAt()) === c0, `${c0} -> ${await camAt()}`);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.reset').click()`);
  await sleep(700);
  check('Reset view moves the camera', (await camAt()) !== c0);
  await page.evaluate(`${card}.saveViewPatch('first', { camera: { position: [20, 25, 20], target: [5, 0, -4] } })`);
  await idle(page);
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=first]').click()`);
  await idle(page);
  await settle(page, card);
  check('saved view camera restored on chip switch', (await camAt()) === '20.00,25.00,20.00', await camAt());
  await page.evaluate(`${card}.saveViewPatch('first', { camera: null })`);
  await idle(page);
  await page.evaluate(`${card}._setFloor('ground')`);
  await sleep(600);

  const lights = () => page.evaluate(`({ sun: ${card}._view.sun.intensity, hemi: ${card}._view.hemi.intensity, cast: ${card}._view.sun.castShadow })`);
  const day = await lights();
  await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
  await idle(page);
  const night = await lights();
  check('night: sun off, hemisphere 0.14', night.sun === 0 && night.cast === true && Math.abs(night.hemi - 0.14) < 0.001, JSON.stringify(night));
  check('button icon is the moon at night', (await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight ha-icon').getAttribute('icon')`)) === 'mdi:weather-night');
  await sh('look-night.png');
  await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
  await idle(page);
  check('auto without sun.sun is day', JSON.stringify(await lights()) === JSON.stringify(day) && day.sun > 0, JSON.stringify(day));

  // sky: auto follows sun.sun, button cycles auto -> day -> night -> auto, mode persists
  const mode = () => page.evaluate(`${card}._skyMode`);
  const tint = (e, a) => page.evaluate(`window.__setDemoSun(${e}, ${a})`);
  check('sky mode starts auto', (await mode()) === 'auto');
  await tint(-20, 180);
  await idle(page);
  const sNight = await lights();
  check('auto: sun at -20 deg -> hemi 0.14, sun 0', Math.abs(sNight.hemi - 0.14) < 0.001 && sNight.sun === 0, JSON.stringify(sNight));
  await tint(30, 180);
  await idle(page);
  const sDay = await lights();
  check('auto: sun at +30 deg -> hemi 0.9, sun 2.6', Math.abs(sDay.hemi - 0.9) < 0.001 && Math.abs(sDay.sun - 2.6) < 0.001, JSON.stringify(sDay));
  const shadowsBefore = await page.evaluate(`${card}._view.stats.shadow`);
  await tint(30.2, 180.2);
  await idle(page);
  check('a sun move under 1 deg does not redraw shadows', (await page.evaluate(`${card}._view.stats.shadow`)) === shadowsBefore);
  await tint(45, 220);
  await idle(page);
  check('a larger sun move redraws shadows', (await page.evaluate(`${card}._view.stats.shadow`)) > shadowsBefore);
  const btn = `${card}.shadowRoot.querySelector('button.daynight')`;
  const seq = [];
  for (let i = 0; i < 3; i++) { await page.evaluate(`${btn}.click()`); seq.push(await mode()); }
  check('button cycles auto -> day -> night -> auto', seq.join() === 'day,night,auto', seq.join());
  await page.evaluate(`${btn}.click()`);
  check('mode persists in localStorage', (await page.evaluate(`localStorage.getItem('floorplan3d.sky')`)) === 'day');
  await page.evaluate(`${btn}.click()`);
  await page.evaluate(`${btn}.click()`);
  await tint(60, 180);
  await idle(page);
  check('auto again after the cycle: sun at +60 deg is day', (await page.evaluate(`${card}._skyMode`)) === 'auto' && (await lights()).sun > 2.5);
  await tint(-3, 180);
  await idle(page);
  const horizon = await page.evaluate(`({ y: ${card}._view.sun.position.y - ${card}._view.sun.target.position.y, i: ${card}._view.sun.intensity })`);
  check('sun below the horizon lights nothing and never from below', horizon.i < 0.3 && horizon.y > 0, JSON.stringify(horizon));

  // sun / moon on a dome around the house + compass ring, faint moonlight, no shader recompiles per update
  const bodies = () => page.evaluate(`(() => { const v = ${card}._view, cam = v.camera, d = v._dome;
    const o = (s) => { if (!s || !s.visible) return null; const p = s.position.clone().project(cam);
      const rel = s.position.clone().sub(d.centre); return { ndc: [p.x, p.y, p.z].map((x) => Math.round(x * 100) / 100), inView: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z >= -1 && p.z <= 1,
        el: Math.asin(rel.y / rel.length()) * 180 / Math.PI, az: (Math.atan2(rel.x, rel.z) * 180 / Math.PI + 360) % 360, r: rel.length() }; };
    return { sun: o(v.skySprites.sun), moon: o(v.skySprites.moon), ring: !!v.skyRing && v.skyRing.visible, dome: d && d.radius,
      moonLight: v.moonLight.intensity, north: v.model.north || 0, programs: v.renderer.info.programs.length,
      lights: v.scene.children.filter((x) => x.isLight).length }; })()`);
  await page.evaluate('window.__demoNow = Date.UTC(2024, 3, 24, 0, 30)'); // full moon, up at 52 N 5 E
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`);
  await settle(page, card);
  await tint(25, 200);
  await idle(page);
  let b = await bodies();
  // north 0: azimuth 200 (from north, clockwise) = south-south-west = +z, a bit -x: atan2(x, z) ~ -20 deg -> 340
  check('sky: sun 25 deg / 200 deg on the dome (elevation 25, south-ish), ring shown', !!b.sun && Math.abs(b.sun.el - 25) < 0.5 && Math.abs(b.sun.r - b.dome) < 0.01
    && (b.north !== 0 || Math.abs(b.sun.az - 340) < 1) && b.ring && b.dome >= 12, JSON.stringify(b));
  check('sky: sun inside the camera frustum in the exterior view', !!b.sun && b.sun.inView, JSON.stringify(b));
  await sh('sky-3d.png');
  await page.evaluate(`${card}._setMode('top')`);
  await settle(page, card);
  await idle(page);
  b = await bodies();
  check('sky: sun and ring visible in top view', !!b.sun && b.sun.inView && b.ring, JSON.stringify(b));
  await sh('sky-top.png');
  await page.evaluate(`${card}._setMode('3d')`);
  await settle(page, card);
  await tint(-20, 0);
  await idle(page);
  b = await bodies();
  const progs = b.programs, lightCount = b.lights;
  check('sky: sun at -20 deg -> sun hidden, moon up, faint moonlight', !b.sun && !!b.moon && b.moon.el > 0 && b.moonLight > 0.15 && b.moonLight <= 0.2, JSON.stringify(b));
  await tint(-1, 270);
  await idle(page);
  check('sky: sun at -1 deg still shown (down to -2)', !!(await bodies()).sun);
  for (const [e, a] of [[-15, 10], [-25, 30], [20, 120], [-20, 0]]) { await tint(e, a); await idle(page); }
  await page.evaluate('window.__demoNow = Date.UTC(2024, 3, 24, 2, 30)');
  await tint(-21, 5);
  await idle(page);
  b = await bodies();
  check('sky: no shader recompile / light change per sun or moon update', b.programs === progs && b.lights === lightCount, `${progs} -> ${b.programs}, lights ${lightCount} -> ${b.lights}`);
  await page.evaluate(`${btn}.click()`);
  await page.evaluate(`${btn}.click()`); // night
  await idle(page);
  b = await bodies();
  check('sky: manual Night -> moon at 35 deg, sun hidden, moonlight 0.17', (await mode()) === 'night' && !!b.moon && Math.abs(b.moon.el - 35) < 0.5 && !b.sun && Math.abs(b.moonLight - 0.17) < 0.001, JSON.stringify(b));
  await sh('look-moon.png');
  await page.evaluate(`${card}.setConfig({ ...${card}._config, sky_bodies: false })`);
  await idle(page);
  b = await bodies();
  check('sky: sky_bodies false hides sun, moon and ring', !b.sun && !b.moon && !b.ring, JSON.stringify(b));
  await page.evaluate(`${btn}.click()`); // auto
  await tint(30, 180);
  await idle(page);
  b = await bodies();
  check('sky: sky_bodies false stays hidden in auto', !b.sun && !b.moon && !b.ring, JSON.stringify(b));
  await page.evaluate(`${card}.setConfig({ ...${card}._config, sky_bodies: true })`);
  await idle(page);
  b = await bodies();
  check('sky: sky_bodies true shows the sun and ring again', !!b.sun && b.ring, JSON.stringify(b));
  await page.evaluate('delete window.__demoNow');
  allErrors.push(...s.errors);
});

// 1w. weather: clouds on the dome, sun / shadow / fill follow the cloud coverage, slow drift without recompiles
// 1b. render recipe (fp.render of the demo house): exposure, fov, lamp shadow pool, Model tab line; render: default ignores it
const renderState = (page) => page.evaluate(`(() => { const c = ${card}, v = c._view, l = c._objects;
  return { exposure: v.renderer.toneMappingExposure, fov: v.persp.fov, from: v.renderFrom, shadows: l.shadowSlots,
    points: l.pool.points.length, cast: l.pool.points.filter((x) => x.castShadow).length, cap: v.shadowCap(), units: v.renderer.capabilities.maxTextures, recipeMap: v.render.lampShadows.mapSize,
    mapSize: l.pool.points[0].shadow.mapSize.x, bias: l.pool.points[0].shadow.bias, sunBias: v.sun.shadow.bias, far: v.persp.far }; })()`);
sections.add('render-recipe', { group: 'model', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._objects.model`, { timeout: 30000 });
  await idle(page);
  const r = await renderState(page);
  check('render recipe: exposure 1.1 and fov 38 from the model', r.exposure === 1.1 && r.fov === 38 && r.from && r.from.keys === 11, JSON.stringify(r));
  check('render recipe: lamp shadow slots = min(6, device max, texture units - 9), pool = slots + 4', r.shadows === Math.max(0, Math.min(6, r.cap.max, r.units - 9)) && r.points === r.shadows + 4 && r.cast === r.shadows, JSON.stringify(r));
  check('render recipe: lamp map size at most 1024 and the device cap', r.recipeMap === Math.min(1024, r.cap.mapSize), JSON.stringify(r));
  check('render recipe: lamp / sun shadow bias from the recipe (test mode map size)', r.bias === -0.0008 && r.sunBias === -0.0003 && r.mapSize === 256, JSON.stringify(r));
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await idle(page);
  await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model')?.click()`);
  await idle(page);
  const line = await page.evaluate(`${card}.shadowRoot.querySelector('[data-info=render-recipe]')?.textContent || ''`);
  check('Model tab: Render recipe: from model (11 keys)', line === 'Render recipe: from model (11 keys)', line);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
});
sections.add('render-default', { group: 'model', query: { model: '1', view: '3d', render: 'default' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._objects.model`, { timeout: 30000 });
  await idle(page);
  const r = await renderState(page);
  check('render: default ignores the recipe (exposure 1.25, fov 35, 4 lamp shadows)', r.exposure === 1.25 && r.fov === 35 && r.from === null && r.shadows === 4 && r.points === 8, JSON.stringify(r));
});

// 1c. sun time scrubber (Auto): 03:00 / 06:00 / 12:00 today from the HA location (sunPosition), shadows once it settles
sections.add('sun-time', { group: 'model', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
  await page.evaluate('window.__demoMowerPaused = true');
  // a June day; HA's time zone Amsterdam, the browser's New York: the slider follows HA's (the page is shared:
  // everything is put back at the end)
  await page.emulateTimezone('America/New_York');
  await page.evaluate(`(() => { window.__demoNow = Date.UTC(2024, 5, 21, 7, 0); const c = ${card}; c.hass = { ...c._hass, config: { ...c._hass.config, time_zone: 'Europe/Amsterdam' } }; })()`);
  try { await sunTimeChecks(page); } finally {
    await page.evaluate(`(() => { window.__demoNow = undefined; window.__fpScrubIdleMs = undefined; const c = ${card}; c.setSunTime(null); c.hass = { ...c._hass, config: { ...c._hass.config, time_zone: 'UTC' } }; })()`).catch(() => {});
    await page.emulateTimezone().catch(() => {});
  }
});
async function sunTimeChecks(page) {
  for (let i = 0; i < 3 && (await page.evaluate(`${card}._skyMode`)) !== 'auto'; i++) await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
  await idle(page);
  const btn = await page.evaluate(`(() => { const b = ${card}.shadowRoot.querySelector('button.suntime'); return !!b && !b.hidden; })()`);
  check('sun time button shown in Auto with a model (3D)', btn);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.suntime').click()`);
  const pop = await page.evaluate(`!${card}.shadowRoot.querySelector('.fp-suntime').hidden`);
  check('sun time popover opens', pop);
  const at = async (min) => {
    await page.evaluate(`(() => { const r = ${card}.shadowRoot.querySelector('.fp-suntime input'); r.value = '${min}'; r.dispatchEvent(new Event('change')); })()`);
    await idle(page);
    return page.evaluate(`(() => { const c = ${card}, v = c._view; return { sun: c._sunNow, night: v.sky.night, light: v.sun.intensity, label: c.shadowRoot.querySelector('button.suntime .t').textContent }; })()`);
  };
  const { sunPosition } = await import('../src/sky.js');
  const ref = (t) => sunPosition(t, 52.0, 5.0);
  const t3 = await at(180), t6 = await at(360), t12 = await at(720);
  const ok = (r) => r.sun && Math.abs(r.sun.elevation - ref(r.sun.at).elevation) < 0.01 && Math.abs(r.sun.azimuth - ref(r.sun.at).azimuth) < 0.01;
  check('scrubbed sun = sunPosition(HA location, today at the time)', ok(t3) && ok(t6) && ok(t12), JSON.stringify({ t3, t6, t12 }));
  check('slider time is in HA\'s time zone (06:00 Amsterdam = 04:00 UTC), not the browser\'s', t6.sun.at === Date.UTC(2024, 5, 21, 4, 0), new Date(t6.sun.at).toISOString());
  check('03:00 in June: sun below the horizon (night)', t3.sun.elevation < 0 && t3.night > 0.5 && t3.light === 0, JSON.stringify(t3));
  check('06:00: low sun (0..20 deg, east)', t6.sun.elevation > 0 && t6.sun.elevation < 20 && t6.sun.azimuth > 45 && t6.sun.azimuth < 100, JSON.stringify(t6));
  check('12:00: high sun (> 55 deg), brighter than 06:00', t12.sun.elevation > 55 && t12.light >= t6.light && t12.night === 0, JSON.stringify(t12));
  check('button shows the scrubbed time', t12.label === '12:00', t12.label);
  // dragging: lights now, sun shadow map 150 ms after the last move
  const n0 = await page.evaluate(`${card}._view.stats.shadowLights`);
  await page.evaluate(`(() => { const r = ${card}.shadowRoot.querySelector('.fp-suntime input'); r.value = '600'; r.dispatchEvent(new Event('input')); })()`);
  const mid = await page.evaluate(`({ n: ${card}._view.stats.shadowLights, stale: ${card}._view._sunStale, el: ${card}._sunNow.elevation })`);
  check('dragging: the sun moves, its shadow map waits', mid.n === n0 && mid.stale === true && Math.abs(mid.el - t12.sun.elevation) > 1, JSON.stringify({ n0, mid }));
  await page.waitForFunction(`${card}._view.stats.shadowLights > ${n0}`, { timeout: 3000 }).catch(() => {});
  const after = await page.evaluate(`({ n: ${card}._view.stats.shadowLights, stale: ${card}._view._sunStale })`);
  check('settled (150 ms): the sun shadow map redrawn once', after.n === n0 + 1 && after.stale === false, JSON.stringify(after));
  await page.evaluate(`${card}.shadowRoot.querySelector('.fp-suntime button.now').click()`);
  await idle(page);
  const live = await page.evaluate(`({ t: ${card}._sunTime, pop: ${card}.shadowRoot.querySelector('.fp-suntime').hidden, label: ${card}.shadowRoot.querySelector('button.suntime .t').textContent })`);
  check('Now: back to the live sun, popover closed', live.t === null && live.pop === true && live.label === '', JSON.stringify(live));
  const sbtn = `${card}.shadowRoot.querySelector('button.suntime')`, set = (m) => page.evaluate(`(() => { const r = ${card}.shadowRoot.querySelector('.fp-suntime input'); r.value = '${m}'; r.dispatchEvent(new Event('change')); })()`);
  // closing the popover returns to live
  await page.evaluate(`${sbtn}.click()`);
  await set(480);
  await page.evaluate(`${sbtn}.click()`);
  check('closing the popover: back to live', (await page.evaluate(`${card}._sunTime`)) === null);
  // tab shown again: back to live
  await page.evaluate(`${sbtn}.click()`);
  await set(480);
  await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
  check('tab visible again: back to live', (await page.evaluate(`${card}._sunTime`)) === null);
  // no slider input for the idle time (2 min; shortened here): back to live
  await page.evaluate('window.__fpScrubIdleMs = 300');
  await page.evaluate(`${sbtn}.click()`);
  await set(480);
  const was = await page.evaluate(`${card}._sunTime`);
  await page.waitForFunction(`${card}._sunTime === null`, { timeout: 3000 }).catch(() => {});
  check('idle: back to live after the timeout', was === 480 && (await page.evaluate(`${card}._sunTime`)) === null, String(was));
}

sections.add('weather', { group: 'model', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
  await page.evaluate('window.__demoMowerPaused = true');
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`);
  await settle(page, card);
  await page.evaluate('window.__setDemoSun(30, 200)');
  const wx = async (c, cond = 'partlycloudy') => { await page.evaluate(`window.__setDemoWeather(${c}, ${JSON.stringify(cond)})`); await idle(page); };
  const sky = () => page.evaluate(`(() => { const v = ${card}._view, cl = (v._cloudSprites || []).filter((x) => x.visible);
    return { clouds: cl.length, sun: v.sun.intensity, hemi: v.hemi.intensity, shadow: v.sun.shadow.intensity, radius: v.sun.shadow.radius,
      disc: v.skySprites.sun ? v.skySprites.sun.material.opacity : null, onDome: cl.every((x) => Math.abs(x.position.distanceTo(v._dome.centre) / v._dome.radius - 0.985) < 0.001),
      helpers: cl.every((x) => x.userData.helper && x.material.depthTest && !x.material.depthWrite), programs: v.renderer.info.programs.length, frames: v.stats.cloudFrames }; })()`);
  await wx(0, 'sunny');
  const clear = await sky();
  check('weather 0 %: no clouds, full sun, hard shadow', clear.clouds === 0 && clear.sun > 2.5 && clear.shadow === 1 && clear.disc === 1, JSON.stringify(clear));
  await wx(60);
  const part = await sky();
  check('weather 60 %: 7 clouds on the dome, sun x0.55, shadow 0.61, more fill', part.clouds === 7 && part.onDome && part.helpers && Math.abs(part.sun / clear.sun - 0.55) < 0.001
    && Math.abs(part.shadow - 0.61) < 0.001 && Math.abs(part.hemi / clear.hemi - 1.21) < 0.001 && Math.abs(part.disc - 0.52) < 0.001, JSON.stringify(part));
  await wx(62);
  check('weather: a change under 5 points is not applied', (await sky()).sun === part.sun);
  await wx(100, 'cloudy');
  const over = await sky();
  check('weather 100 %: 12 clouds, sun x0.25, shadow 0.35', over.clouds === 12 && Math.abs(over.sun / clear.sun - 0.25) < 0.001 && Math.abs(over.shadow - 0.35) < 0.001 && over.radius === 4, JSON.stringify(over));
  await wx(null, 'cloudy');
  check('weather: condition only (cloudy) -> 85 %', (await sky()).clouds === 10);
  await wx(60);
  await page.evaluate(`(() => { const v = ${card}._view; if (v.test) v.test.drift = true; })()`); // test mode holds the clouds still
  await page.evaluate(`(() => { const r = ${card}._view.renderer, seen = new Set(r.info.programs.map((p) => p.id)), f = r.render.bind(r);
    window.__newPrograms = []; r.render = (sc, cam) => { f(sc, cam); for (const p of r.info.programs) if (!seen.has(p.id)) { seen.add(p.id); window.__newPrograms.push(p.id); } }; })()`);
  await sleep(500);
  await page.evaluate('window.__newPrograms.length = 0');
  const pos0 = await page.evaluate(`${card}._view._cloudSprites[4].position.toArray()`);
  const f0 = (await sky()).frames, t0 = Date.now();
  await sleep(5000);
  const f1 = (await sky()).frames, secs = (Date.now() - t0) / 1000;
  const pos1 = await page.evaluate(`${card}._view._cloudSprites[4].position.toArray()`);
  const created = await page.evaluate('window.__newPrograms.length');
  check('clouds drift for 5 s: no new shader programs, <= 3 frames/s, they moved', created === 0 && f1 > f0 && (f1 - f0) / secs <= 3.3 && pos0.some((x, i) => Math.abs(x - pos1[i]) > 0.01),
    `created ${created}, ${((f1 - f0) / secs).toFixed(1)} fps`);
  await page.screenshot({ path: path.join(root, 'screenshots', 'weather-cloudy.png') });
  await page.evaluate(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })`);
  await idle(page);
  const h0 = (await sky()).frames;
  await sleep(1500);
  check('tab hidden: no drift frames', (await sky()).frames === h0);
  await page.evaluate('delete document.visibilityState');
  await page.evaluate(`${card}._view.setOnScreen(false)`);
  await idle(page);
  const o0 = (await sky()).frames;
  await sleep(1500);
  check('card off screen: no drift frames', (await sky()).frames === o0);
  await page.evaluate(`${card}._view.setOnScreen(true)`);
  await wx(100, 'cloudy');
  await page.evaluate(`${card}._setMode('top')`);
  await settle(page, card);
  await sleep(500);
  const top0 = (await sky()).frames;
  await sleep(1200);
  const top = await sky();
  check('top view at 100 %: no cloud sprite visible, no drift frames', top.clouds === 0 && top.frames === top0, JSON.stringify(top));
  await page.screenshot({ path: path.join(root, 'screenshots', 'weather-top.png') });
  await page.evaluate(`${card}._setMode('3d')`);
  await settle(page, card);
  const camSaved = await page.evaluate(`JSON.stringify(${card}._view.getCamera())`);
  const high = await page.evaluate(`(() => { const v = ${card}._view, d = v._dome; v.setCamera({ position: [d.centre.x + 1, d.centre.y + d.radius * 4, d.centre.z + 1], target: [d.centre.x, d.centre.y, d.centre.z] }, { instant: true });
    v._placeSkyBodies(); return v._cloudSprites.filter((x) => x.visible).length; })()`);
  check('high orbit looking down (camera > 65 deg over the house): clouds hidden', high === 0, String(high));
  await page.evaluate(`${card}._view.setCamera(${camSaved}, { instant: true })`);
  await idle(page);
  await wx(60);
  await page.evaluate('window.__setDemoSun(-20, 0)');
  await idle(page);
  const night = await page.evaluate(`(() => { const v = ${card}._view, m = v._cloudMats[0].color; return { clouds: v._cloudSprites.filter((x) => x.visible).length, r: m.r, b: m.b }; })()`);
  check('night: clouds stay, dim grey-blue', night.clouds === 7 && night.r < 0.5 && night.b > night.r, JSON.stringify(night));
  await page.evaluate('window.__setDemoSun(30, 200)');
  await page.evaluate(`${card}.setConfig({ ...${card}._config, clouds: false })`);
  await idle(page);
  let c = await sky();
  check('clouds: false hides the clouds, the light still follows the weather', c.clouds === 0 && Math.abs(c.sun / clear.sun - 0.55) < 0.001, JSON.stringify(c));
  await page.evaluate(`${card}.setConfig({ ...${card}._config, clouds: true, sky_bodies: false })`);
  await idle(page);
  check('sky_bodies: false hides the clouds too', (await sky()).clouds === 0);
  await page.evaluate(`${card}.setConfig({ ...${card}._config, sky_bodies: true, weather: 'none' })`);
  await idle(page);
  c = await sky();
  check('weather: none -> clear sky', c.clouds === 0 && Math.abs(c.sun - clear.sun) < 0.001, JSON.stringify(c));
  allErrors.push(...s.errors);
});

// 1u. uplights: the demo's wall uplights aim straight up; a shared (bad) target in their group is ignored
sections.add('uplights', { group: 'model', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
  await page.evaluate('window.__setDemoSun(-20, 0)'); // night: lamps on
  await sleep(500);
  const aims = () => page.evaluate(`(() => { const c = ${card}, L = c._objects, v = c._view;
    const out = {}; for (const [id, slot] of L._slots) { const l = slot.light; if (!l.isSpotLight) continue;
      const a = L.anchorOf(id); out[id] = { at: l.position.toArray().map((x) => +x.toFixed(3)), d: l.target.position.clone().sub(l.position).toArray().map((x) => +x.toFixed(3)),
        own: a.distanceTo(l.position) < 1e-6, on: l.intensity > 0 }; }
    return { out, warnings: v.modelManifest().warnings, bad: Object.fromEntries(L.badTargets || []) }; })()`);
  let a = await aims();
  const ups = ['wall_uplight_1', 'wall_uplight_2'];
  check('demo uplights: spots aimed straight up from their own lamps, no model warning', ups.every((id) => a.out[id] && a.out[id].on && a.out[id].own && a.out[id].d[0] === 0 && a.out[id].d[2] === 0 && a.out[id].d[1] > 1.9)
    && !a.warnings.some((w) => /spot target/.test(w)), JSON.stringify(a));
  const bad = path.join(root, 'screenshots', 'uplights-bad.glb');
  fs.writeFileSync(bad, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) if (n.extras && n.extras.fp && /^wall_uplight_/.test(n.extras.fp.id)) n.extras.fp.hints = { ...n.extras.fp.hints, target: [6.25, 0, 0.5] };
    return json;
  }));
  await page.evaluate(`${card}.setConfig({ ...${card}._config, model: '/screenshots/uplights-bad.glb' })`);
  await page.waitForFunction(`(${card}._view.modelManifest()?.warnings || []).some((w) => /spot target/.test(w))`, { timeout: 15000 }).catch(() => {});
  await sleep(800);
  a = await aims();
  check('shared bad target: Model warning names both uplights', a.warnings.includes('spot target looks wrong (shared / too far): wall_uplight_1, wall_uplight_2'), JSON.stringify(a.warnings));
  check('shared bad target ignored: each spot aims up from its own lamp', ups.every((id) => a.out[id] && a.out[id].own && a.out[id].d[0] === 0 && a.out[id].d[2] === 0 && a.out[id].d[1] > 1.9)
    && a.out.wall_uplight_1.at[0] !== a.out.wall_uplight_2.at[0] && a.bad.wall_uplight_1 === 'shared', JSON.stringify(a));
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await idle(page);
  await page.evaluate(() => { const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model'); if (b) b.click(); });
  await idle(page);
  const report = await page.evaluate(`(${card}.shadowRoot.querySelector('.panel details.report') || {}).textContent || ''`);
  check('Model tab lists the spot target warning', /spot target looks wrong \(shared \/ too far\): wall_uplight_1, wall_uplight_2/.test(report), report.slice(0, 200));
  fs.unlinkSync(bad);
  allErrors.push(...s.errors);
});

// 1a. static meshes merged at load (per owner + material), merge: false keeps every part, node: rules keep theirs
sections.add('merge', { group: 'objects', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._view.mergeStats`, { timeout: 30000 });
  const stats = () => page.evaluate(`JSON.stringify(${card}._view.mergeStats)`).then(JSON.parse);
  // shader programs created since the last read: per render, the ids new in renderer.info.programs
  await page.evaluate(`(() => { const r = ${card}._view.renderer, seen = new Set(r.info.programs.map((p) => p.id)), f = r.render.bind(r);
    window.__newPrograms = [];
    r.render = (sc, cam) => { f(sc, cam); for (const p of r.info.programs) if (!seen.has(p.id)) { seen.add(p.id); window.__newPrograms.push(p.id); } }; })()`);
  // created: new programs; transient: created but already released (compiled for a passing state);
  // otherNew: new programs used by materials outside the model
  const programs = () => page.evaluate(`(() => { const v = ${card}._view, r = v.renderer, other = new Set(), live = new Set(r.info.programs.map((p) => p.id));
    v.scene.traverse((o) => { if (!o.material) return; let inModel = false; for (let n = o; n; n = n.parent) if (n === v.modelGroup) inModel = true;
      if (!inModel) for (const m of [].concat(o.material)) { const p = r.properties.get(m).currentProgram; if (p) other.add(p.id); } });
    const created = window.__newPrograms.splice(0);
    return { live: live.size, created: created.length, transient: created.filter((id) => !live.has(id)).length, otherNew: created.filter((id) => other.has(id)).length }; })()`);
  await sleep(1000);
  await programs();
  await sleep(10000); // the demo mower moves every 500 ms: marker, map
  const moving = await programs();
  check('mower moving for 10 s: no new shader programs', moving.created === 0, JSON.stringify(moving));
  const on = await stats();
  check('merge: fewer meshes and draw calls, same triangles', on.enabled && on.after.meshes < on.before.meshes && on.after.calls < on.before.calls
    && on.after.triangles === on.before.triangles && on.merged > 0, JSON.stringify(on));
  const placed = await page.evaluate(`(() => { const v = ${card}._view, m = v.model.manifest, bad = [], inObj = [];
    v.model.root.traverse((o) => {
      if (!/^fp_merged_/.test(o.name)) return;
      const p = o.parent, ok = p === v.model.root || m.byNode.has(p) || !!(p.userData.fp && p.userData.fp.layer) || !!p.name;
      if (!ok || !o.matrix.equals(new o.matrix.constructor())) bad.push(o.parent.name);
    });
    for (const e of m.objects) e.node.traverse((o) => { if (/^fp_merged_/.test(o.name)) inObj.push(e.id); });
    const owners = []; v.model.root.traverse((o) => { if (/^fp_merged_/.test(o.name)) owners.push(m.ownerOf(o) ? m.ownerOf(o).id : null); });
    return { bad, inObj, owners: owners.length, tagged: owners.filter(Boolean).length }; })()`);
  check('merged meshes sit under their owner at identity, none inside objects, owners resolve', placed.bad.length === 0 && placed.inObj.length === 0 && placed.owners > 0 && placed.tagged === placed.owners, JSON.stringify(placed));
  check('node index rebuilt over the merged tree', await page.evaluate(`(() => { const c = ${card}; return !!c._index && c._index.nodes.some((n) => /fp_merged_/.test(n.path)); })()`));
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await idle(page);
  await page.evaluate(() => {
    const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model');
    if (b) b.click();
  });
  await idle(page);
  const tabText = await page.evaluate(`(${card}.shadowRoot.querySelector('.panel [data-info=merge-stats]') || {}).textContent || ''`);
  check('Model tab shows the draw calls before → after', tabText === `Draw calls: ${on.before.calls} → ${on.after.calls} (meshes ${on.before.meshes} → ${on.after.meshes})`, tabText);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await idle(page);
  // the owner and material of a merged mesh: find one of its source meshes with merge off
  const probe = await page.evaluate(`(() => { let o = null; ${card}._view.model.root.traverse((x) => { if (!o && /^fp_merged_/.test(x.name)) o = x; });
    return { owner: o.parent.name, mat: o.material.name }; })()`);
  // settle first: leaving edit mode rebuilds its outlines over the next frames (their shaders come and go)
  for (let i = 0, quiet = 0; i < 20 && quiet < 2; i++) { await sleep(500); quiet = (await programs()).created ? 0 : quiet + 1; }
  await page.evaluate(`${card}.setConfig({ ...${card}._config, merge: false })`);
  await page.waitForFunction(`!!${card}._view.mergeStats && !${card}._view.mergeStats.enabled`, { timeout: 10000 });
  await idle(page);
  const reload = await programs();
  check('merge reload: only the model\'s own shaders compile, once (no look / light-pool round trip)', reload.transient === 0 && reload.otherNew === 0, JSON.stringify(reload));
  const off = await stats();
  check('merge: false reloads with every mesh and the old draw-call count', off.after.meshes === on.before.meshes && off.after.calls === on.before.calls && off.merged === 0, JSON.stringify(off));
  const targets = await page.evaluate(`(() => { const c = ${card}; const t = [];
    c._view.model.root.traverse((x) => { if (x.isMesh && x.parent && x.parent.name === ${JSON.stringify(probe.owner)} && x.material.name === ${JSON.stringify(probe.mat)} && !x.children.length) t.push(x); });
    return t.map((m) => c._index && c._index.nodes.find((i) => i.node === m)).filter(Boolean).slice(0, 2).map((n) => ({ path: n.path })); })()`);
  const target = targets[0] || null;
  check('found a merge candidate mesh with merge off', !!target, JSON.stringify(probe));
  if (target) {
    const views = { ground: { rules: [{ hide: 'node:' + target.path }] } };
    await page.evaluate(`${card}.setConfig({ ...${card}._config, merge: true, views: ${JSON.stringify(views)} })`);
    await page.waitForFunction(`!!${card}._view.mergeStats && ${card}._view.mergeStats.enabled`, { timeout: 10000 });
    await idle(page);
    await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
    await idle(page);
    const kept = await page.evaluate(`(() => { const c = ${card}; const n = c._index.nodes.find((i) => i.path === ${JSON.stringify(target.path)});
      return n ? { mesh: !!n.node.isMesh, visible: n.node.visible, merged: !!n.node.userData.merged } : null; })()`);
    check('a mesh named by a node: rule is not merged and the rule still hides it', !!kept && kept.mesh && !kept.merged && kept.visible === false, JSON.stringify(kept));
    const again = await stats();
    check('merging again with the rule: still fewer draw calls than merge off', again.after.calls < off.after.calls, JSON.stringify(again));
  }
  if (targets[1]) {
    // a layout rule (e.g. an imported layout) for a part that was merged away: the model loads once more around it
    const sel = 'node:' + targets[1].path;
    const model0 = await page.evaluate(`(window.__m0 = ${card}._view.model, true)`);
    await page.evaluate(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, views: { ...(l.views || {}), first: { ...((l.views || {}).first || {}), rules: [{ hide: ${JSON.stringify(sel)} }] } } }); })()`);
    await page.waitForFunction(`${card}._view.model && ${card}._view.model !== window.__m0 && !!${card}._view.mergeStats`, { timeout: 10000 }).catch(() => {});
    await idle(page);
    const re = await page.evaluate(`(() => { const c = ${card}, ms = c._view.mergeStats; const n = c._index && c._index.nodes.find((i) => i.path === ${JSON.stringify(targets[1].path)});
      return { reloaded: c._view.model !== window.__m0, keep: !!ms && ms.keep.includes(${JSON.stringify(sel)}), mesh: !!n && !!n.node.isMesh && !n.node.userData.merged }; })()`);
    check('a later layout node: rule on a merged part reloads the model once and keeps that part', model0 && re.reloaded && re.keep && re.mesh, JSON.stringify(re));
    await page.evaluate(`(window.__m1 = ${card}._view.model, ${card}._schedule())`);
    await sleep(500);
    check('no second reload', await page.evaluate(`${card}._view.model === window.__m1`));
  }
  allErrors.push(...s.errors);
});

// 1b. model objects: tap toggles, hold opens the popup, a drag never toggles (the demo model's hall ceiling lamp)
sections.add('objects-tap', { group: 'objects', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, { timeout: 30000 });
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  const injected = await page.evaluate(`(() => { const o = ${card}._objects.objectAt('lamp_hall'); return o ? o.obj.node.name : null; })()`);
  check('the demo model has the hall ceiling lamp object', !!injected, String(injected));
  await idle(page);
  const at = () => page.evaluate(`(() => { const c = ${card}; const a = c._objects.anchors().find((x) => x.id === 'lamp_hall');
    return a && c._view.projectWorld(a.world); })()`);
  const hall = () => page.evaluate(`${card}._hass.states['light.demo_hall'].state`);
  const calls = () => page.evaluate('(window.__serviceCalls || []).length');
  let p = await at();
  check('lamp anchor projects onto the screen', !!p, JSON.stringify(p));
  const before = await hall();
  await page.mouse.click(p[0] + 12, p[1] + 8); // within 30 px
  await idle(page);
  check('tap near the lamp toggles its light', (await hall()) !== before, `${before} -> ${await hall()}`);
  check('the bound light has no marker of its own', !(await page.evaluate(`${card}._markers.some((m) => m.entityId === 'light.demo_hall')`)));
  const n0 = await calls();
  p = await at();
  await page.mouse.move(p[0], p[1]);
  await page.mouse.down();
  await page.mouse.move(p[0] + 40, p[1] + 10, { steps: 5 });
  await page.mouse.up();
  await idle(page);
  check('a drag that starts on the lamp (orbit) never toggles', (await calls()) === n0);
  await settle(page, card);
  p = await at();
  await page.mouse.move(p[0], p[1]);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await idle(page);
  const pop = () => page.evaluate(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-popup');
    return el && { title: el.querySelector('.fp-pop-title').textContent, rows: [...el.querySelectorAll('.fp-pop-row')].map((r) => r.className.replace('fp-pop-row ', '')),
      vis: el.style.visibility, t: el.style.transform }; })()`);
  let pp = await pop();
  check('hold opens the popup (toggle + brightness) without toggling', !!pp && pp.title === 'Hall ceiling lamp' && pp.rows.join() === 'toggle,brightness' && pp.vis !== 'hidden' && (await calls()) === n0, JSON.stringify(pp));
  const head = await page.evaluate(`(() => { const b = ${card}.shadowRoot.querySelector('.fp-popup .fp-pop-badges');
    return b && { status: (b.querySelector('.fp-status') || {}).dataset?.status || null, logo: !!b.querySelector('.fp-logo') }; })()`);
  check('popup header shows the status dot (no logo by default)', !!head && head.status === (await hall() === 'on' ? 'green' : 'grey') && !head.logo, JSON.stringify(head));
  await page.screenshot({ path: path.join(root, 'screenshots', 'object-popup.png') });
  await page.evaluate(`(() => { const r = ${card}.shadowRoot.querySelector('.fp-popup .brightness input'); r.value = '100'; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const last = await page.evaluate('JSON.stringify(window.__serviceCalls[window.__serviceCalls.length - 1])');
  check('brightness slider sends light.turn_on once on release', last === JSON.stringify(['light', 'turn_on', { entity_id: 'light.demo_hall', brightness: 100 }]), last);
  const st1 = await hall();
  await page.evaluate(`${card}.shadowRoot.querySelector('.fp-popup .toggle .fp-switch').click()`);
  await idle(page);
  pp = await pop();
  check('popup switch toggles and the popup stays open', (await hall()) !== st1 && !!pp, `${st1} -> ${await hall()}`);
  await page.keyboard.press('Escape');
  await idle(page);
  check('Esc closes the popup', !(await pop()));
  // the tap that closes the popup does not also act (tap on the lamp itself)
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await idle(page);
  const n2 = await calls();
  await page.mouse.click(p[0], p[1]);
  await idle(page);
  check('a tap that closes the popup does not toggle', !(await pop()) && (await calls()) === n2);
  // popup hidden while its anchor is off-screen
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await idle(page);
  const cam0 = await page.evaluate(`${card}._view.getCamera()`);
  await page.evaluate(`(() => { const v = ${card}._view; const c = v.getCamera();
    const d = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
    v.setCamera({ position: c.position, target: [c.position[0] - d[0], c.position[1] - d[1], c.position[2] - d[2]] }, { instant: true }); })()`);
  await idle(page);
  pp = await pop();
  check('popup hidden while its anchor is behind the camera', !!pp && pp.vis === 'hidden', JSON.stringify(pp));
  await page.keyboard.press('Escape');
  await page.evaluate(`${card}._view.setCamera(${JSON.stringify(cam0)}, { instant: true })`);
  await idle(page);
  // popup closes on outside tap and on view change
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await idle(page);
  await page.mouse.click(30, 520);
  await idle(page);
  check('outside tap closes the popup', !(await pop()));
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await idle(page);
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`);
  await idle(page);
  check('view change closes the popup', !(await pop()));
  // edit mode: object taps are off until the Objects tab exists
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await idle(page);
  const n1 = await calls();
  p = await at();
  if (p) await page.mouse.click(p[0], p[1]);
  await idle(page);
  check('edit mode: tapping the lamp does not toggle it', (await calls()) === n1);
  {
  // Objects tab (edit mode)
  const sr = `${card}.shadowRoot`;
  const tabBtn = () => page.evaluate(`!![...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Objects')`);
  check('Objects tab is shown (the model has objects)', await tabBtn());
  check('Objects tab sits after Devices', await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].map((b) => b.textContent.trim()).slice(0, 3).join()`) === 'Rooms,Devices,Objects');
  await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Objects').click()`);
  await idle(page);
  check('rooms start collapsed (no object rows)', (await page.evaluate(`${sr}.querySelectorAll('li.obj').length`)) === 0);
  // click the lamp in 3D: selects (expands) its row, does not toggle
  const nObj = await calls();
  const hall0 = await hall();
  p = await at();
  await page.mouse.click(p[0], p[1]);
  await idle(page);
  const rowInfo = () => page.evaluate(`(() => { const li = ${sr}.querySelector('li.obj[data-obj=lamp_hall]'); if (!li) return null;
    const inp = li.querySelector('[data-field=obj-entity]'); return { sel: li.classList.contains('sel'), ph: inp.placeholder, val: inp.value, badge: (li.querySelector('.badge') || {}).textContent || '' }; })()`);
  let ri = await rowInfo();
  check('tapping the lamp in 3D selects its row', !!ri && ri.sel, JSON.stringify(ri));
  check('the tap did not toggle it', (await calls()) === nObj && (await hall()) === hall0);
  check('row shows the auto entity', !!ri && ri.badge === 'auto' && ri.ph === 'light.demo_hall' && ri.val === '', JSON.stringify(ri));
  // rebind to another entity
  const other = await page.evaluate(`Object.keys(${card}._hass.states).find((e) => e.startsWith('light.') && e !== 'light.demo_hall')`);
  const setEntity = (v) => page.evaluate(`(() => { const i = ${sr}.querySelector('[data-field=obj-entity][data-id=lamp_hall]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setEntity(other);
  await idle(page);
  const bound = () => page.evaluate(`(() => { const b = ${card}._bindings.get('lamp_hall'); const o = ${card}._objects.objectAt('lamp_hall'); return { cfg: ${card}._layout.objects && ${card}._layout.objects.lamp_hall, e: b.entity, layer: o.binding.entity }; })()`);
  let bd = await bound();
  check('changing the entity rebinds the object', bd.e === other && bd.layer === other && bd.cfg && bd.cfg.entity === other, JSON.stringify(bd));
  await setEntity('light.does_not_exist');
  await idle(page);
  ri = await rowInfo();
  check('an unknown entity shows "entity not found"', !!ri && ri.badge === 'entity not found', JSON.stringify(ri));
  const hasTest = () => page.evaluate(`!!${sr}.querySelector('li.obj[data-obj=lamp_hall] button[data-act=obj-test]')`);
  check('no Test button on an unbound row', !(await hasTest()));
  await setEntity('');
  await idle(page);
  bd = await bound();
  check('clearing the entity returns to auto', bd.e === 'light.demo_hall' && !bd.cfg, JSON.stringify(bd));
  // Test toggles through callService
  const c0 = await calls();
  const h0 = await hall();
  await page.evaluate(`${sr}.querySelector('li.obj[data-obj=lamp_hall] button[data-act=obj-test]').click()`);
  await idle(page);
  check('Test toggles the bound light', (await calls()) === c0 + 1 && (await hall()) !== h0, `${c0} -> ${await calls()}`);
  // Hide
  await page.evaluate(`(() => { const c = ${sr}.querySelector('[data-field=obj-hidden][data-id=lamp_hall]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  check('hide marks the object hidden', await page.evaluate(`!!${card}._bindings.get('lamp_hall').hidden && ${card}._layout.objects.lamp_hall.hidden === true`));
  check('no Test button on a hidden row', !(await hasTest()));
  await page.evaluate(`(() => { const c = ${sr}.querySelector('[data-field=obj-hidden][data-id=lamp_hall]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  check('un-hide drops the entry', await page.evaluate(`!${card}._bindings.get('lamp_hall').hidden && !(${card}._layout.objects || {}).lamp_hall`));
  check('Test button back on the bound row', await hasTest());
  // label: rename the lamp -> the row and the popup title show it; clearing returns to the model label
  const setLabel = (v) => page.evaluate(`(() => { const i = ${sr}.querySelector('[data-field=obj-label][data-id=lamp_hall]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const lbl = () => page.evaluate(`(() => { const li = ${sr}.querySelector('li.obj[data-obj=lamp_hall]'); const i = li.querySelector('[data-field=obj-label]');
    return { name: li.querySelector('.name').textContent, ph: i.placeholder, cfg: ((${card}._layout.objects || {}).lamp_hall || {}).label || null }; })()`);
  await setLabel('  Hall pendant ');
  await idle(page);
  let lb = await lbl();
  check('Label input renames the object (stored, row name)', lb.cfg === 'Hall pendant' && lb.name === 'Hall pendant' && lb.ph === 'Hall ceiling lamp', JSON.stringify(lb));
  await page.evaluate(`${card}._openObjectPopup('lamp_hall')`); // what a hold on the lamp opens
  await idle(page);
  pp = await pop();
  check('renamed lamp: the popup title shows the new label', !!pp && pp.title === 'Hall pendant', JSON.stringify(pp));
  await page.evaluate(`${card}._popup.close()`);
  await setLabel('');
  await idle(page);
  lb = await lbl();
  check('clearing the label returns to the model label', lb.cfg === null && lb.name === 'Hall ceiling lamp', JSON.stringify(lb));
  await page.screenshot({ path: path.join(root, 'screenshots', 'objects-tab.png') });
  // leaving the tab turns object taps off again
  await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Devices').click()`);
  await idle(page);
  check('object taps are off again outside the Objects tab', await page.evaluate(`!${card}._objectTapsOn()`));
  }
  allErrors.push(...s.errors);
});

// 1b2. HA-style actions from the card YAML: navigate on tap, perform-action on hold, double tap on one
// object never delays single taps on another, missing target -> message, confirmation, popup links, markers
// 1c. light popup: rows from the bound light's capabilities (smart bulb: colour, colour temperature, effects)
sections.add('light-popup', { group: 'objects', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, { timeout: 30000 });
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  await idle(page);
  const sr = `${card}.shadowRoot`;
  const lamp = 'light.demo_kitchen';
  // the model lists only the toggle (fp.ui.popup) for this lamp: the light's capabilities still add rows
  await page.evaluate(`${card}._objects.objectAt('lamp_kitchen').obj.ui = { popup: ['toggle'] }`);
  const open = async () => {
    await page.evaluate(`(() => { const c = ${card}; const a = c._objects.anchors().find((x) => x.id === 'lamp_kitchen'); c._popup.open(c._objects.objectAt('lamp_kitchen').obj, a.world); })()`);
    await idle(page);
  };
  const rows = () => page.evaluate(`[...${sr}.querySelectorAll('.fp-popup .fp-pop-row')].map((r) => r.className.replace('fp-pop-row ', ''))`);
  const lastCall = () => page.evaluate('JSON.stringify(window.__serviceCalls[window.__serviceCalls.length - 1])');
  const nCalls = () => page.evaluate('(window.__serviceCalls || []).length');
  await open();
  const r0 = await rows();
  check('model list [toggle] + smart bulb: toggle, brightness, wheel, Kelvin, effect rows', r0.join() === 'toggle,brightness,color,color_temp,effect', r0.join());
  check('brightness has 4 preset buttons', (await page.evaluate(`${sr}.querySelectorAll('.fp-popup .fp-presets button').length`)) === 4);
  const sizes = await page.evaluate(`(() => { const c = ${sr}.querySelector('.fp-popup canvas.fp-wheel'); const b = c.getBoundingClientRect();
    const g = c.getContext('2d'); const px = g.getImageData(c.width / 2 + 40, c.height / 2, 1, 1).data; return { w: b.width, h: b.height, a: px[3] }; })()`);
  check('colour wheel is 132 px and drawn', sizes.w === 132 && sizes.h === 132 && sizes.a > 0, JSON.stringify(sizes));
  check('the colour temperature row shows "3000 K"', (await page.evaluate(`${sr}.querySelector('.fp-popup .color_temp .fp-pop-value').textContent`)) === '3000 K');
  const eff = await page.evaluate(`[...${sr}.querySelectorAll('.fp-popup .effect option')].map((o) => o.value).join('|')`);
  check('effects: music-like first', eff === '|Music pulse|Sound reactive|Rainbow|Candle', eff);
  await page.screenshot({ path: path.join(root, 'screenshots', 'light-popup.png') });
  // a pointer down / up on the wheel: one light.turn_on with hs_color; pointer events never reach the stage
  const n0 = await nCalls();
  const wheel = await page.evaluate(`(() => { const b = ${sr}.querySelector('.fp-popup canvas.fp-wheel').getBoundingClientRect(); return { x: b.left + b.width * 0.8, y: b.top + b.height / 2 }; })()`);
  await page.evaluate(`window.__stagePointer = 0; ${sr}.querySelector('.stage').addEventListener('pointerdown', () => { window.__stagePointer++; })`);
  await page.mouse.move(wheel.x, wheel.y);
  await page.mouse.down();
  await page.mouse.move(wheel.x + 2, wheel.y + 2, { steps: 3 });
  check('dragging on the wheel sends nothing yet', (await nCalls()) === n0);
  await page.mouse.up();
  await idle(page);
  const hc = JSON.parse(await lastCall());
  check('release on the wheel: one light.turn_on with hs_color', (await nCalls()) === n0 + 1 && hc[0] === 'light' && hc[1] === 'turn_on' && hc[2].entity_id === lamp
    && Array.isArray(hc[2].hs_color) && hc[2].hs_color.length === 2 && hc[2].hs_color[1] > 50 && hc[2].hs_color[0] < 40, JSON.stringify(hc));
  check('the wheel gesture did not reach the stage', (await page.evaluate('window.__stagePointer')) === 0);
  check('the marker shows the colour; popup still open', await page.evaluate(`!${sr}.querySelector('.fp-popup .fp-wheel-dot').hidden`) && (await rows()).length === 5);
  // colour temperature: one call on release
  const n1 = await nCalls();
  await page.evaluate(`(() => { const r = ${sr}.querySelector('.fp-popup .color_temp input'); r.value = '4500'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('the Kelvin slider only previews while moving', (await nCalls()) === n1 && (await page.evaluate(`${sr}.querySelector('.fp-popup .color_temp .fp-pop-value').textContent`)) === '4500 K');
  await page.evaluate(`${sr}.querySelector('.fp-popup .color_temp input').dispatchEvent(new Event('change', { bubbles: true }))`);
  check('Kelvin slider release: one color_temp_kelvin call', (await lastCall()) === JSON.stringify(['light', 'turn_on', { entity_id: lamp, color_temp_kelvin: 4500 }]) && (await nCalls()) === n1 + 1, await lastCall());
  // presets and effect
  await page.evaluate(`${sr}.querySelector('.fp-popup .fp-presets button[data-pct="30"]').click()`);
  check('preset 30 % sends brightness_pct', (await lastCall()) === JSON.stringify(['light', 'turn_on', { entity_id: lamp, brightness_pct: 30 }]), await lastCall());
  await page.evaluate(`(() => { const e = ${sr}.querySelector('.fp-popup .effect select'); e.value = 'Candle'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await new Promise((r) => setTimeout(r, 600)); // the effect call is debounced (arrow keys)
  await idle(page);
  check('choosing an effect sends light.turn_on with effect', (await lastCall()) === JSON.stringify(['light', 'turn_on', { entity_id: lamp, effect: 'Candle' }]), await lastCall());
  check('the effect select shows the new effect', (await page.evaluate(`${sr}.querySelector('.fp-popup .effect select').value`)) === 'Candle');
  await page.keyboard.press('Escape');
  await idle(page);
  // layout list [toggle] is respected: edit mode, Objects tab, Popup "Only on / off"
  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await idle(page);
  await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Objects').click()`);
  await idle(page);
  await page.evaluate(`${card}._edit.selectObject('lamp_kitchen')`);
  await idle(page);
  const popSel = `${sr}.querySelector('select[data-field=obj-popup][data-id=lamp_kitchen]')`;
  const opts = await page.evaluate(`(() => { const s = ${popSel}; return s && [...s.options].map((o) => o.textContent).join('|'); })()`);
  check('Objects tab has a Popup select: Automatic / Only on / off', opts === 'Automatic|Only on / off', String(opts));
  await page.evaluate(`(() => { const s = ${popSel}; s.value = 'toggle'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  const saved = await page.evaluate(`JSON.stringify(${card}._layout.objects.lamp_kitchen.ui)`);
  check('Only on / off saves ui.popup = [toggle] in the layout', saved === '{"popup":["toggle"]}', saved);
  await page.evaluate(`${sr}.querySelector('button.edit').click()`); // leave edit mode
  await idle(page);
  await open();
  check('with the layout list only the toggle row remains', (await rows()).join() === 'toggle', (await rows()).join());
  await page.keyboard.press('Escape');
  await idle(page);
  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await idle(page);
  await page.evaluate(`(() => { const s = ${popSel}; s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  const back = await page.evaluate(`JSON.stringify((${card}._layout.objects || {}).lamp_kitchen || null)`);
  check('Automatic removes the key again', !/popup/.test(back), back);
});

sections.add('actions', { group: 'objects', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, { timeout: 30000 });
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  await page.evaluate(`(() => {
    window.__locs = [];
    window.addEventListener('location-changed', () => window.__locs.push(location.pathname + location.search));
    window.__upAt = 0;
    window.addEventListener('pointerup', () => { window.__upAt = performance.now(); }, true);
  })()`);
  const origin = await page.evaluate('location.pathname + location.search');
  const setActions = async (actions) => {
    await page.evaluate(`(() => { const c = ${card}; c.setConfig({ ...c._config, actions: ${JSON.stringify(actions)} }); })()`);
    await page.waitForFunction(`!!${card}._view.model && ${card}._objects.parts.size > 0`, { timeout: 30000 });
    await settle(page, card);
  };
  const at = (id) => page.evaluate(`(() => { const c = ${card}, a = c._objects.anchorOf(${JSON.stringify(id)}); return a && c._view.projectWorld(a); })()`);
  const calls = () => page.evaluate('(window.__serviceCalls || []).length');
  const lastCall = () => page.evaluate('JSON.stringify((window.__serviceCalls || []).slice(-1)[0] || null)');
  const hold = async (p) => { await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await idle(page); };

  await setActions({
    'object:lamp_hall': {
      tap_action: { action: 'navigate', navigation_path: '/fp-test/nav' },
      hold_action: { action: 'perform-action', perform_action: 'light.turn_on', data: { brightness: 42 }, target: { entity_id: 'light.demo_hall' } },
    },
  });
  let p = await at('lamp_hall');
  check('actions: the hall lamp projects on screen', !!p, JSON.stringify(p));
  let n0 = await calls();
  await page.mouse.click(p[0], p[1]);
  await idle(page);
  const locs = await page.evaluate('window.__locs.slice()');
  check('actions: tap with navigate pushes the path and fires location-changed', locs.at(-1) === '/fp-test/nav' && (await calls()) === n0, JSON.stringify(locs));
  await page.evaluate(`history.replaceState(null, '', ${JSON.stringify(origin)})`);
  p = await at('lamp_hall');
  await hold(p);
  check('actions: hold with perform-action calls the service with data and target',
    (await lastCall()) === JSON.stringify(['light', 'turn_on', { brightness: 42 }, { entity_id: 'light.demo_hall' }]) && !(await page.evaluate(`!!${card}.shadowRoot.querySelector('.fp-popup')`)), await lastCall());

  // a malformed perform_action: no call, a visible message; no target is fine (HA allows target-less actions)
  await setActions({ 'object:lamp_hall': { hold_action: { action: 'perform-action', perform_action: 'turn_on' } } });
  n0 = await calls();
  p = await at('lamp_hall');
  await hold(p);
  const toastText = () => page.evaluate(`(() => { const t = ${card}.shadowRoot.querySelector('.fp-toast'); return t && !t.hidden ? t.textContent : null; })()`);
  let toast = await toastText();
  check('actions: a malformed perform_action -> no call, a message in the card', (await calls()) === n0 && /domain\.action/.test(toast || ''), String(toast));
  await setActions({ 'object:lamp_hall': { hold_action: { action: 'perform-action', perform_action: 'script.good_night' } } });
  p = await at('lamp_hall');
  await hold(p);
  check('actions: perform-action without a target calls the service', (await lastCall()) === JSON.stringify(['script', 'good_night', {}]), await lastCall());
  // a rejected service call: a message, no unhandled rejection
  await page.evaluate(`(() => { const c = ${card}; window.__demoMowerPaused = true; window.__realHass = c._hass;
    c._hass = { ...c._hass, callService: () => Promise.reject(new Error('Service not found')) }; })()`);
  p = await at('lamp_hall');
  await hold(p);
  toast = await toastText();
  check('actions: a failing service call shows its error in the card', toast === 'Service not found', String(toast));
  await page.evaluate(`(() => { const c = ${card}; window.__demoMowerPaused = false; if (c._hass.callService !== window.__realHass.callService) c._hass = window.__realHass; })()`);

  // double tap on the living lamp; the hall lamp's single taps stay immediate
  await setActions({ 'object:lamp_living': { double_tap_action: { action: 'perform-action', perform_action: 'light.turn_off', target: { entity_id: 'light.demo_living' } } } });
  const pl = await at('lamp_living'), ph = await at('lamp_hall');
  check('actions: both lamps project on screen', !!pl && !!ph);
  const since = async (k) => page.evaluate(`window.__serviceCalls.slice(${k}).map((c, i) => ({ c, t: window.__serviceCallTimes[${k} + i] }))`);
  let k = await calls();
  await page.mouse.click(pl[0], pl[1]); // pending: waits 250 ms for a second tap
  await page.mouse.click(ph[0], ph[1]); // other object: immediate
  const tUp = await page.evaluate('window.__upAt');
  await sleep(50); // inside the 250 ms double-tap window
  const early = await since(k);
  const hallCall = early.find((x) => x.c[2] && x.c[2].entity_id === 'light.demo_hall');
  check('actions: a single tap on another object is not delayed by a pending double tap',
    !!hallCall && hallCall.t - tUp < 100 && !early.some((x) => x.c[2] && x.c[2].entity_id === 'light.demo_living'), JSON.stringify(early.map((x) => [x.c[2], Math.round(x.t - tUp)])));
  await idle(page);
  let later = (await since(k)).map((x) => x.c);
  check('actions: the pending single tap runs after 250 ms (toggle)', later.some((c) => c[1] === 'toggle' && c[2].entity_id === 'light.demo_living'), JSON.stringify(later));
  k = await calls();
  await page.mouse.click(pl[0], pl[1]);
  await sleep(60); // the second tap inside the double-tap window
  await page.mouse.click(pl[0], pl[1]);
  await idle(page);
  later = (await since(k)).map((x) => x.c);
  check('actions: a double tap runs the double_tap_action only', later.length === 1 && later[0][1] === 'turn_off' && later[0][3].entity_id === 'light.demo_living', JSON.stringify(later));

  // confirmation: an in-card dialog, nothing until OK
  await setActions({ 'object:lamp_hall': { tap_action: { action: 'toggle', confirmation: { text: 'Toggle the hall?' } } } });
  n0 = await calls();
  p = await at('lamp_hall');
  await page.mouse.click(p[0], p[1]);
  await idle(page);
  const dlg = await page.evaluate(`(() => { const d = ${card}.shadowRoot.querySelector('.fp-confirm'); return d && d.textContent; })()`);
  check('actions: confirmation shows an in-card dialog, no call yet', /Toggle the hall\?/.test(dlg || '') && (await calls()) === n0, String(dlg));
  await page.evaluate(`${card}.shadowRoot.querySelector('.fp-confirm [data-c=yes]').click()`);
  await idle(page);
  check('actions: OK runs the action and closes the dialog', (await calls()) === n0 + 1 && !(await page.evaluate(`!!${card}.shadowRoot.querySelector('.fp-confirm')`)), await lastCall());

  // popup links: history from the YAML popup list
  await setActions({ 'object:lamp_hall': { popup: ['toggle', 'history', { label: 'Lights view', navigate: '/fp-test/lights' }] } });
  p = await at('lamp_hall');
  await hold(p);
  const links = await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.fp-popup .fp-pop-row.link')].map((r) => r.textContent.trim())`);
  check('actions: popup shows the link rows at the bottom', links.join() === 'History,Lights view', JSON.stringify(links));
  await page.screenshot({ path: path.join(root, 'screenshots', 'object-popup-links.png') });
  await page.evaluate(`${card}.shadowRoot.querySelector('.fp-popup .fp-pop-link').click()`);
  await idle(page);
  check('actions: the History link navigates to /history?entity_id=…', (await page.evaluate('window.__locs.at(-1)')) === '/history?entity_id=light.demo_hall', await page.evaluate('window.__locs.at(-1)'));
  await page.evaluate(`history.replaceState(null, '', ${JSON.stringify(origin)})`);
  await page.keyboard.press('Escape');

  // markers: YAML keyed by entity id (a marker away from model objects: objects win a tap under the finger)
  const mk = await page.evaluate(`(() => { const c = ${card}; const m = c._markers.find((x) => { const el = c._markerEls.get(x.id); if (!el) return false;
    const r = el.querySelector('.fp-dot').getBoundingClientRect(), px = r.x + r.width / 2, py = r.y + r.height / 2;
    // reachable under the pointer (markers behind model walls take no taps)
    return r.width > 0 && el.offsetParent && el.contains(c.shadowRoot.elementFromPoint(px, py)) && !el.classList.contains('fp-occluded') && !c._objectHit(px, py, 30); });
    if (!m) return null; const r = c._markerEls.get(m.id).querySelector('.fp-dot').getBoundingClientRect(); return { e: m.entityId, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (mk) {
    await setActions({ [mk.e]: { tap_action: { action: 'navigate', navigation_path: '/fp-test/marker' } } });
    const r = await page.evaluate(`(() => { const c = ${card}; const m = c._markers.find((x) => x.entityId === ${JSON.stringify(mk.e)}); const b = c._markerEls.get(m.id).querySelector('.fp-dot').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    await page.mouse.click(r[0], r[1]);
    await idle(page);
    check('actions: a marker tap runs its YAML tap_action (navigate)', (await page.evaluate('window.__locs.at(-1)')) === '/fp-test/marker', `${mk.e}: ${await page.evaluate('window.__locs.at(-1)')}`);
    await page.evaluate(`history.replaceState(null, '', ${JSON.stringify(origin)})`);
  } else check('actions: a visible marker exists for the marker check', false);
  await setActions(undefined);
  allErrors.push(...s.errors);
});

// 1c. mower object: the model node follows the live position, the mower marker is gone (the demo model's mower)
sections.add('mower-object', { group: 'lamps', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, { timeout: 30000 });
  await settle(page, card);
  await page.waitForFunction(`!!${card}._objects.objectAt('mower') && !!${card}._objects.mowerBound() && !!${card}._mowerLive`, { timeout: 5000 }).catch(() => {});
  check('the demo model\'s mower object is bound to lawn_mower.demo', await page.evaluate(`${card}._bindings.get('mower').entity === 'lawn_mower.demo'`));
  const pos = () => page.evaluate(`(() => { const c = ${card}; const o = c._objects.objectAt('mower');
    const w = o.obj.node.getWorldPosition(new c._view.camera.position.constructor());
    const g = o.part.glow && o.part.glow.material; return { x: w.x, z: w.z, marker: !!c._mowerMarkerId, live: !!c._mowerLive && !!c._mowerLive.x, em: g ? g.emissive.g : -1 }; })()`);
  const a = await pos();
  await sleep(2500);
  const b = await pos();
  check('mower node moves with the live position', Math.hypot(a.x - b.x, a.z - b.z) > 0.01, JSON.stringify([a, b]));
  check('the mower marker is replaced by the object', !a.marker && !b.marker);
  check('mower glow takes the mowing colour', b.em > 0.1, JSON.stringify(b));
  // warning over the mower: error = red, stuck (mowing, no movement for N min, fake clock) = yellow, docked = none
  await page.evaluate('window.__demoMowerPaused = true');
  const setMs = (state) => page.evaluate(`(() => { const c = ${card}, st = c._hass.states, s = st['lawn_mower.demo'];
    c.hass = { ...c._hass, states: { ...st, 'lawn_mower.demo': { ...s, state: ${JSON.stringify(state)} } } }; })()`);
  const warn = () => page.evaluate(`(() => { const w = ${card}._view.warning; return w ? { kind: w.kind, visible: w.sprite.visible } : null; })()`);
  await setMs('error');
  await idle(page);
  const w1 = await warn();
  check('mower error shows the red warning', !!w1 && w1.kind === 'error' && w1.visible, JSON.stringify(w1));
  // an eave over the mower (a copy of the lawn under it, 2.4 m up): mower ground and warning stay on the lawn
  const eave = await page.evaluate(`(() => { const c = ${card}, v = c._view, L = c._mowerLive, fl = L.floorId;
    const clear = () => { v._surfMeshes = null; v._ground.clear(); v._mowerGround.clear(); };
    const cx = (Math.floor(L.x / 0.5) + 0.5) * 0.5, cy = (Math.floor(L.y / 0.5) + 0.5) * 0.5;
    const before = v.mowerGround(L.x, L.y, fl);
    const hit = before == null ? null : v.surfaceRays([cx, before + 0.5, -cy], [[0, -1, 0]], 1)[0];
    if (!hit) return { err: 'no lawn under the mower', before };
    const lawn = hit.object, e = lawn.clone();
    lawn.parent.add(e);
    const w = e.getWorldPosition(e.position.clone()); w.y += 2.4;
    e.position.copy(lawn.parent.worldToLocal(w));
    e.updateMatrixWorld(true);
    clear();
    const top = v._groundRay(cx, cy), after = v.mowerGround(L.x, L.y, fl);
    c._updateMowerWarning();
    const warnY = v.warning && v.warning.sprite.position.y;
    e.parent.remove(e); clear(); c._updateMowerWarning();
    return { before, after, top: top && top.y, warnY };
  })()`);
  check('an eave over the mower: the bounded ray keeps the lawn height (roof ignored), the warning stays low',
    !eave.err && eave.top > eave.before + 2 && Math.abs(eave.after - eave.before) < 0.01 && Math.abs(eave.warnY - (eave.before + 0.6)) < 0.01, JSON.stringify(eave));
  const f0 = await page.evaluate(`${card}._view.stats.frames`);
  await sleep(1300);
  check('the warning pulses (frames only while shown)', (await page.evaluate(`${card}._view.stats.frames`)) - f0 >= 2);
  await setMs('mowing');
  await idle(page);
  check('no warning while mowing normally', (await warn()) === null);
  await page.evaluate(`(() => { const real = Date.now; window.__realNow = real; Date.now = () => real() + 6 * 60000; })()`);
  await page.evaluate(`${card}._updateMowerWarning()`);
  const w2 = await warn();
  check('mowing without movement shows the yellow stuck warning', !!w2 && w2.kind === 'stuck' && w2.visible, JSON.stringify(w2));
  await setMs('docked');
  await idle(page);
  check('docked: no warning', (await warn()) === null);
  const f1 = await page.evaluate(`${card}._view.stats.frames`);
  await sleep(1300);
  check('no frames rendered while idle without a warning', (await page.evaluate(`${card}._view.stats.frames`)) - f1 <= 1);
  await page.evaluate('Date.now = window.__realNow; window.__demoMowerPaused = false');
  await setMs('mowing');
  // the demo model's climate unit shows its temperature as a label
  await page.waitForFunction(`[...${card}.shadowRoot.querySelectorAll('.fp-obj-label')].some((x) => x.textContent.includes('21.5'))`, { timeout: 3000 }).catch(() => {});
  const lbl = await page.evaluate(`(() => { const e = [...${card}.shadowRoot.querySelectorAll('.fp-obj-label')].find((x) => x.textContent.includes('21.5')); return e ? e.textContent : null; })()`);
  check('climate object shows a temperature label', !!lbl, String(lbl));
  allErrors.push(...s.errors);
});

// 1d. the demo model's objects: automatic binding, glow + pool lights, light / shadow budget, the facade group
// and its controller, dock / charger looks, lights: off, idle updates (no budget or shadow work)
sections.add('demo-objects', { group: 'lamps', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass && ${card}._objects.parts.size > 0`, { timeout: 30000 });
  await page.evaluate('window.__demoMowerPaused = true');
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  const BOUND = {
    lamp_living: 'light.demo_living', lamp_hall: 'light.demo_hall', lamp_kitchen: 'light.demo_kitchen', kitchen_strip: 'light.demo_strip',
    facade_1: 'light.demo_facade', facade_2: 'light.demo_facade', facade_3: 'light.demo_facade', terrace_spot: 'light.demo_terrace',
    wall_uplight_1: 'light.demo_facade', wall_uplight_2: 'light.demo_facade',
    climate_living: 'climate.demo_living', mower: 'lawn_mower.demo', dock: 'lawn_mower.demo', ev_charger: 'sensor.demo_charger',
  };
  const binds = await page.evaluate(`Object.fromEntries([...${card}._bindings].map(([id, b]) => [id, b.entity]))`);
  check('demo objects: all 14 bind automatically from suggest.entity',
    Object.keys(binds).length === 14 && Object.entries(BOUND).every(([id, e]) => binds[id] === e), JSON.stringify(binds));
  const markerEnts = await page.evaluate(`${card}._markers.map((m) => m.entityId)`);
  const leaked = Object.values(BOUND).filter((e) => markerEnts.includes(e));
  check('demo objects: bound entities have no markers of their own', leaked.length === 0, leaked.join());
  check('demo objects: the facade group controller (not bound to an object) keeps its marker', markerEnts.includes('switch.demo_facade'));
  const ids = Object.keys(BOUND);
  const look = () => page.evaluate(`(() => { const c = ${card}, l = c._objects, all = [...l.pool.points, ...l.pool.spots];
    const lit = all.filter((x) => x.intensity > 0);
    const near = (id) => { const a = l.anchorOf(id); return a ? lit.filter((x) => x.position.distanceTo(a) < 0.05).map((x) => +x.intensity.toFixed(3)) : null; };
    const glow = (id) => { const o = l.objectAt(id), g = o && o.part.glow; if (!g) return -1; const m = [].concat(g.material)[0]; return +(m.emissiveIntensity * Math.max(m.emissive.r, m.emissive.g, m.emissive.b)).toFixed(3); };
    const ids = ${JSON.stringify(ids)};
    const ts = l.anchorOf('terrace_spot'), spot = l.pool.spots.find((x) => x.intensity > 0 && ts && x.position.distanceTo(ts) < 0.05);
    return { lit: lit.length, shadows: lit.filter((x) => x.castShadow).length, slots: [...l._slots.keys()],
      near: Object.fromEntries(ids.map((id) => [id, near(id)])), glow: Object.fromEntries(ids.map((id) => [id, glow(id)])),
      spotTarget: spot ? spot.target.position.toArray() : null,
      facadeLit: lit.filter((x) => ['facade_1', 'facade_2', 'facade_3'].some((id) => x.position.distanceTo(l.anchorOf(id)) < 0.05)).length }; })()`);
  let L = await look();
  check('lamp on: glow emissive and a pool light with intensity > 0 at the lamp', L.glow.lamp_living > 0 && L.near.lamp_living.length === 1 && L.near.lamp_living[0] > 0, JSON.stringify({ g: L.glow.lamp_living, n: L.near.lamp_living }));
  check('lamp off: no glow, no pool light', L.glow.lamp_hall === 0 && L.near.lamp_hall.length === 0, JSON.stringify({ g: L.glow.lamp_hall, n: L.near.lamp_hall }));
  check('at most 12 pool lights lit, at most 4 of them casting shadows', L.lit > 0 && L.lit <= 12 && L.shadows <= 4, JSON.stringify({ lit: L.lit, shadows: L.shadows }));
  check('facade group on: a pool light at each of the three fixtures (small group lights each lamp), all three glow',
    L.facadeLit === 3 && L.slots.filter((x) => x.startsWith('facade_')).length === 3 && ['facade_1', 'facade_2', 'facade_3'].every((id) => L.glow[id] > 0), JSON.stringify({ f: L.facadeLit, slots: L.slots }));
  const paving = await page.evaluate(`(() => { const r = {}; ${card}._view.model.root.traverse((o) => { if (o.isMesh && /^(exterior_floor_5|driveway_floor_1)$/.test(o.name)) { const m = [].concat(o.material)[0]; r[o.name] = { po: !!m.polygonOffset, f: m.polygonOffsetFactor, ro: o.renderOrder, map: !!m.map }; } }); return r; })()`);
  check('coplanar paving: the textured sheet gets polygonOffset -2 and renders later, the plain one is untouched',
    !!paving.exterior_floor_5 && paving.exterior_floor_5.map && paving.exterior_floor_5.po && paving.exterior_floor_5.f === -2 && paving.exterior_floor_5.ro === 1
    && !!paving.driveway_floor_1 && !paving.driveway_floor_1.po, JSON.stringify(paving));
  check('terrace spot: a lit spot light aimed at its hints.target', L.near.terrace_spot.length === 1 && !!L.spotTarget && Math.hypot(L.spotTarget[0] - 2.5, L.spotTarget[1], L.spotTarget[2] - 1.5) < 0.05, JSON.stringify({ n: L.near.terrace_spot, t: L.spotTarget }));
  check('light strip: glows, no real light (no hints.max)', L.glow.kitchen_strip > 0 && L.near.kitchen_strip.length === 0, JSON.stringify({ g: L.glow.kitchen_strip, n: L.near.kitchen_strip }));
  check('EV charger charging: LED lit, power label', L.glow.ev_charger > 0 && (await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.fp-obj-label')].some((x) => x.textContent.includes('7.4 kW'))`)), JSON.stringify(L.glow.ev_charger));
  check('dock LED dark while the mower mows', L.glow.dock === 0, String(L.glow.dock));
  const setState = (e, state, attrs) => page.evaluate(`(() => { const c = ${card}, st = c._hass.states, s = st[${JSON.stringify(e)}];
    c.hass = { ...c._hass, states: { ...st, [${JSON.stringify(e)}]: { ...s, state: ${JSON.stringify(state)}, attributes: { ...s.attributes, ...${JSON.stringify(attrs || {})} } } } }; })()`);
  await setState('lawn_mower.demo', 'docked');
  await idle(page);
  check('dock LED lit once the mower is docked', (await look()).glow.dock > 0);
  await setState('lawn_mower.demo', 'mowing');
  // brightness: the pool light follows (bri / 255 x hints.max)
  await page.evaluate(`${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_living', brightness: 51 })`);
  await idle(page);
  L = await look();
  check('brightness 51 -> the lamp\'s pool light at 51/255 x max 20 = 4', L.near.lamp_living.length === 1 && Math.abs(L.near.lamp_living[0] - 4) < 0.05, JSON.stringify(L.near.lamp_living));
  // a tap on the lamp toggles its entity (the mock records callService)
  const lampAt = (id) => page.evaluate(`(() => { const c = ${card}, a = c._objects.anchorOf(${JSON.stringify(id)}); return a && c._view.projectWorld(a); })()`);
  let p = await lampAt('lamp_living');
  const calls0 = await page.evaluate('(window.__serviceCalls || []).length');
  if (p) await page.mouse.click(p[0], p[1]);
  await idle(page);
  const lastCall = await page.evaluate('JSON.stringify((window.__serviceCalls || []).slice(-1)[0] || null)');
  check('a tap on the living lamp calls light.toggle for light.demo_living', !!p && (await page.evaluate('(window.__serviceCalls || []).length')) === calls0 + 1
    && lastCall === JSON.stringify(['light', 'toggle', { entity_id: 'light.demo_living' }]), lastCall);
  check('toggled off: its glow and pool light are gone', await look().then((x) => x.glow.lamp_living === 0 && x.near.lamp_living.length === 0));
  await page.evaluate(`${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_living' })`);
  await idle(page);
  // group controller off: the fixtures go dark, the popup says why
  await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  L = await look();
  check('group controller off: facade fixtures dark, no pool light (own light still on)',
    ['facade_1', 'facade_2', 'facade_3'].every((id) => L.glow[id] === 0) && L.facadeLit === 0 && (await page.evaluate(`${card}._hass.states['light.demo_facade'].state`)) === 'on', JSON.stringify(L.glow));
  await page.evaluate(`${card}._runObjectAction('facade_2', 'hold')`);
  await idle(page);
  const popText = await page.evaluate(`(${card}.shadowRoot.querySelector('.fp-popup') || {}).textContent || ''`);
  check('popup of a dark facade lamp says the group switch is off', popText.includes('Facade switch is off'), popText.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: path.join(root, 'screenshots', 'object-group-popup.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  check('group controller on again: the facade lights up', (await look()).facadeLit === 3);
  // ten state updates that touch no object: no budget recompute, no object re-evaluation, no shadow redraw
  await idle(page);
  const counters = () => page.evaluate(`({ ...${card}._objects.stats, shadow: ${card}._view.stats.shadow, frames: ${card}._view.stats.frames, shadowLights: ${card}._view.stats.shadowLights })`);
  const c0 = await counters();
  for (let i = 0; i < 10; i++) {
    await page.evaluate(`(() => { const c = ${card}, st = c._hass.states, t = st['sensor.kitchen_temperature'];
      c.hass = { ...c._hass, states: { ...st, 'sensor.kitchen_temperature': { ...t, state: String(18 + ${i}) } } }; })()`);
    await idle(page);
  }
  await idle(page);
  const c1 = await counters();
  check('10 unrelated hass updates: layer updated, no budget recompute, no re-evaluation, no shadow update',
    c1.updates >= c0.updates + 10 && c1.budget === c0.budget && c1.evaluated === c0.evaluated && c1.shadowRequests === c0.shadowRequests && c1.shadow === c0.shadow,
    JSON.stringify({ c0, c1 }));
  check('10 unrelated hass updates: no frame rendered, no shadow map flagged', c1.frames === c0.frames && c1.shadowLights === c0.shadowLights, JSON.stringify({ f0: c0.frames, f1: c1.frames, s0: c0.shadowLights, s1: c1.shadowLights }));
  // shadow maps per light: a lamp without a shadow slot toggling redraws no map; one with a slot redraws only its own
  const shadowFlags = () => page.evaluate(`(() => { const c = ${card}, l = c._objects, v = c._view;
    return { n: v.stats.shadowLights, auto: [v.sun, ...l.pool.points.slice(0, 4)].map((x) => x.shadow.autoUpdate) }; })()`);
  let sf0 = await shadowFlags();
  check('pool shadow lights and the sun redraw on demand only (shadow.autoUpdate false)', sf0.auto.every((x) => x === false), JSON.stringify(sf0.auto));
  await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  let sf1 = await shadowFlags();
  check('facade group (no shadow slot) off and on: no shadow map redrawn', sf1.n === sf0.n, JSON.stringify({ sf0: sf0.n, sf1: sf1.n }));
  await page.evaluate(`${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_hall' })`);
  await idle(page);
  sf1 = await shadowFlags();
  check('hall lamp on: at most its own shadow map (lit ones keep their slots)', sf1.n - sf0.n <= 1, JSON.stringify({ sf0: sf0.n, sf1: sf1.n }));
  await page.evaluate(`${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_hall' })`);
  await idle(page);
  check('hall lamp off: nothing redrawn', (await shadowFlags()).n === sf1.n);
  // a lamp behind walls / the roof (Exterior view: every level shown) is not toggled by a tap on its
  // screen position (occlusion-aware hit test)
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`);
  await settle(page, card);
  const cam0 = await page.evaluate(`${card}._view.getCamera()`);
  const hiddenAt = await page.evaluate(`(() => { const c = ${card}, v = c._view, l = c._objects, a = l.anchorOf('lamp_living'), node = l.objectAt('lamp_living').obj.node;
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * Math.PI * 2, pos = [a.x + Math.cos(t) * 14, a.y + 4, a.z + Math.sin(t) * 14];
      v.setCamera({ position: pos, target: a.toArray() }, { instant: true });
      v.controls.update();
      v.camera.updateMatrixWorld();
      const p = v.projectWorld(a);
      if (p && v.pointHidden(a, node)) return p;
    }
    return null; })()`);
  await settle(page, card);
  const callsBefore = await page.evaluate('(window.__serviceCalls || []).length');
  if (hiddenAt) await page.mouse.click(hiddenAt[0], hiddenAt[1]);
  await idle(page);
  const tapCalls = await page.evaluate(`(window.__serviceCalls || []).slice(${callsBefore})`);
  check('exterior view: a tap on the living lamp hidden by the floor above / roof does not toggle it', !!hiddenAt && !tapCalls.some((c) => c[2] && c[2].entity_id === 'light.demo_living'), JSON.stringify({ hiddenAt, tapCalls }));
  for (const c of tapCalls) if (c[1] === 'toggle') await page.evaluate(`${card}._hass.callService(${JSON.stringify(c[0])}, 'toggle', ${JSON.stringify(c[2])})`); // undo another object's toggle
  await page.keyboard.press('Escape');
  await page.evaluate(`${card}._view.setCamera(${JSON.stringify(cam0)}, { instant: true })`);
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  await page.screenshot({ path: path.join(root, 'screenshots', 'objects-lit.png') });
  // night: the lamps carry the scene
  await page.evaluate('window.__setDemoSun(-20, 200)');
  await idle(page);
  await page.screenshot({ path: path.join(root, 'screenshots', 'objects-night.png') });
  sf0 = await shadowFlags();
  await page.evaluate('window.__setDemoSun(-25, 230)');
  await idle(page);
  sf1 = await shadowFlags();
  check('sun below the horizon moving 30 deg: its shadow map is not redrawn', sf1.n === sf0.n, JSON.stringify({ sf0: sf0.n, sf1: sf1.n }));
  await page.evaluate('window.__setDemoSun(20, 230)');
  await idle(page);
  check('sunrise: the sun shadow map is redrawn', (await shadowFlags()).n > sf1.n);
  await page.evaluate('window.__setDemoSun(-20, 200)');
  await idle(page);
  // lights: off -> emissive only
  await page.evaluate(`${card}.setConfig({ ...${card}._config, lights: 'off' })`);
  await page.waitForFunction(`!!${card}._view.model && ${card}._objects.parts.size > 0`, { timeout: 30000 });
  await idle(page);
  L = await look();
  check('lights: off -> every pool light at intensity 0, lamps still glow', L.lit === 0 && L.glow.lamp_living > 0, JSON.stringify({ lit: L.lit, g: L.glow.lamp_living }));
  const sceneLights = () => page.evaluate(`(() => { const c = ${card}, pool = new Set([...c._objects.pool.points, ...c._objects.pool.spots]); let n = 0, labels = 0;
    c._view.scene.traverseVisible((o) => { if (pool.has(o)) n++; });
    c._view.objectsGroup.traverseVisible((o) => { if (o.isCSS2DObject) labels++; });
    return { pool: n, labels }; })()`);
  const SL = await sceneLights();
  check('lights: off -> no pool light in the scene (sub-group hidden), object labels still shown', SL.pool === 0 && SL.labels > 0, JSON.stringify(SL));
  await page.evaluate(`${card}.setConfig({ ...${card}._config, lights: 'auto' })`);
  await idle(page);
  const poolSize = await page.evaluate(`${card}._objects.pool.points.length + ${card}._objects.pool.spots.length`); // shadow slots (render recipe, device cap) + 4 points + 4 spots
  check('lights: auto again -> pool lights back', (await look()).lit > 0 && (await sceneLights()).pool === poolSize, String(poolSize));
  // Objects tab: every row bound (no "entity not found"); the group controller field
  await page.evaluate('window.__setDemoSun(30, 180)');
  const sr = `${card}.shadowRoot`;
  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await idle(page);
  await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Objects').click()`);
  await idle(page);
  for (let i = 0; i < 20; i++) {
    const opened = await page.evaluate(`(() => { const b = [...${sr}.querySelectorAll('[data-act=obj-expand]')].find((x) => x.textContent.trim() === '▸'); if (b) b.click(); return !!b; })()`);
    if (!opened) break;
    await idle(page);
  }
  const rows = await page.evaluate(`[...${sr}.querySelectorAll('li.obj')].map((li) => ({ id: li.dataset.obj, badge: (li.querySelector('.badge') || {}).textContent || '', test: !!li.querySelector('[data-act=obj-test]') }))`);
  check('Objects tab: 14 rows, all "auto", none "entity not found"', rows.length === 14 && rows.every((r) => r.badge === 'auto'), JSON.stringify(rows));
  check('Objects tab: lamps have a Test button', ['lamp_living', 'facade_1', 'terrace_spot'].every((id) => (rows.find((r) => r.id === id) || {}).test));
  const grp = () => page.evaluate(`(() => { const g = ${sr}.querySelector('label.grp[data-grp=facade]'); return g && { warn: !!g.querySelector('.badge.warn'), val: g.querySelector('input').value,
    saved: JSON.stringify((${card}._layout.tags || {}).facade || null), eff: JSON.stringify(${card}._groups.facade || null) }; })()`);
  const setGrp = async (v) => { await page.evaluate(`(() => { const i = ${sr}.querySelector('[data-field=grp-entity][data-id=facade]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(250); };
  let g = await grp();
  check('Groups: facade controller switch.demo_facade, found', !!g && !g.warn && g.val === 'switch.demo_facade', JSON.stringify(g));
  await page.evaluate(`${card}._hass.callService('switch', 'turn_off', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  await setGrp('switch.demo_typo');
  g = await grp();
  check('Groups: a controller HA does not know shows "entity not found" and is ignored by the chain',
    !!g && g.warn && g.eff === 'null' && (await look()).facadeLit === 3, JSON.stringify(g));
  await setGrp('none');
  g = await grp();
  check('Groups: "none" removes the controller (nothing stored)', !!g && g.saved === 'null' && g.val === '' && !g.warn, JSON.stringify(g));
  await setGrp('switch.demo_facade');
  g = await grp();
  check('Groups: controller back, the switch is off -> facade dark', !!g && !g.warn && (await look()).facadeLit === 0, JSON.stringify(g));
  // tags: defaults = fp.group + HA labels; a tag added on the row; a second controller tag joins the chain
  const chips = (id) => page.evaluate(`[...${sr}.querySelectorAll('li.obj[data-obj=${id}] .otag')].map((x) => x.firstChild.textContent)`);
  check('Tags: facade_1 shows its model group and HA label (facade, Outdoor)', JSON.stringify(await chips('facade_1')) === '["facade","Outdoor"]', JSON.stringify(await chips('facade_1')));
  await page.evaluate(`${card}._hass.callService('switch', 'turn_on', { entity_id: 'switch.demo_facade' })`);
  await page.evaluate(`(() => { const i = ${sr}.querySelector('[data-field=tag-add][data-id=terrace_spot]'); i.value = 'night'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  const ts = await page.evaluate(`JSON.stringify(${card}._layout.objects.terrace_spot)`);
  check('Tags: + tag on a row saves the full list', ts.includes('"tags":["Outdoor","night"]'), ts);
  await page.evaluate(`(() => { const i = ${sr}.querySelector('[data-field=grp-entity][data-id=night]'); i.value = 'switch.demo_facade'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  await page.evaluate(`${card}._hass.callService('switch', 'turn_off', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  const spotChain = await page.evaluate(`JSON.stringify(${card}._objects.objectAt('terrace_spot').chain)`);
  check('Tags: a controller on the new tag gates the spot (switch off -> dark)', spotChain.includes('"lit":false') && spotChain.includes('switch.demo_facade'), spotChain.slice(0, 200));
  await page.evaluate(`(() => { const b = ${sr}.querySelector('[data-act=tag-rm][data-id=terrace_spot][data-tag=night]'); b.click(); })()`);
  await idle(page);
  const ts2 = await page.evaluate(`JSON.stringify((${card}._layout.objects || {}).terrace_spot || null)`);
  check('Tags: x removes it; back to the defaults (nothing stored)', !ts2.includes('tags'), ts2);
  await page.evaluate(`${card}._hass.callService('switch', 'turn_on', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  await page.screenshot({ path: path.join(root, 'screenshots', 'objects-tab-demo.png') });
  allErrors.push(...s.errors);
});

// 1w. wall washes for every lit lamp, tap hints, marker shapes
// 3b. docked: mower and dock are one object (one tap dot; a tap on the dock opens the mower popup with the dock row);
// mowing: two objects again
sections.add('mower-dock-one', { group: 'lamps', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass && ${card}._objects.parts.size > 0 && ${card}._bindings && ${card}._bindings.has('dock')`, { timeout: 30000 });
  await page.evaluate('window.__demoMowerPaused = true');
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`);
  await settle(page, card);
  await page.evaluate(`${card}._layout.tap_hints = 'always'`); // every dot drawn
  const setState = (state, attrs) => page.evaluate(`(() => { const c = ${card}, st = c._hass.states, s = st['lawn_mower.demo'];
    c.hass = { ...c._hass, states: { ...st, 'lawn_mower.demo': { ...s, state: ${JSON.stringify(state)}, attributes: { ...s.attributes, ...${JSON.stringify(attrs || {})} } } } }; })()`);
  const st = () => page.evaluate(`(() => { const c = ${card}, l = c._objects; c._syncHints();
    const at = (id) => { const a = l.anchors().find((x) => x.id === id); return a ? c._view.projectWorld(a.world) : null; };
    const d = at('dock'), m = at('mower');
    return { group: c._dockGroup(), dots: c._hints.items.map((x) => x.id), dockHit: d ? c._objectHit(d[0], d[1], 6) : 'no-dock', mowerHit: m ? c._objectHit(m[0], m[1], 6) : 'no-mower', d, m }; })()`);
  await setState('mowing');
  await idle(page);
  const mow = await st();
  check('mowing: mower and dock are two objects (two dots, own taps)', !mow.group && mow.dots.includes('dock') && mow.dots.includes('mower') && mow.dockHit !== 'mower', JSON.stringify(mow));
  await setState('docked', { battery_level: 87 });
  await idle(page);
  const dk = await st();
  check('docked: one object (the dock has no dot of its own)', !!dk.group && dk.group.dock === 'dock' && !dk.dots.includes('dock') && dk.dots.includes('mower'), JSON.stringify(dk));
  check('docked: a tap on the dock is a tap on the mower', dk.dockHit === 'mower' && dk.mowerHit === 'mower', JSON.stringify(dk));
  // a real tap where the dock is: the mower popup with the dock row
  await page.evaluate(`${card}._popup.close()`);
  await page.mouse.click(dk.d[0], dk.d[1]);
  await page.waitForFunction(`!!${card}._popup.el`, { timeout: 3000 }).catch(() => {});
  const pop = await page.evaluate(`(() => { const c = ${card}, el = c._popup.el; return el ? { id: c._popup._id, rows: [...el.querySelectorAll('.fp-pop-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()) } : null; })()`);
  check('docked: tapping the dock opens the mower popup with "Dock Docked · 87 %"', !!pop && pop.id === 'mower' && pop.rows.some((t) => /^Dock\s*Docked · 87 %$/.test(t)), JSON.stringify(pop));
  await page.evaluate(`${card}._popup.close()`);
  await setState('mowing');
  await idle(page);
  const back = await st();
  check('mowing again: two objects', !back.group && back.dots.includes('dock'), JSON.stringify(back));
});

sections.add('washes', { group: 'lamps', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 560 } }, async (s) => {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && ${card}._objects.parts.size > 0`, { timeout: 20000 });
  await page.evaluate('window.__setDemoSun(-25, 0)'); // night
  await sleep(800);
  const W = () => page.evaluate(`(() => { const c = ${card}, l = c._objects; return { shown: [...l.washes.meshes].filter((m) => m.visible).length,
    walls: [...l.parts].filter(([, p]) => p.wash && p.wash.placements.some((pl, i) => pl.surface === 'wall' && p.wash.meshes[i].visible)).map(([id]) => id),
    quads: Object.fromEntries([...l.parts].filter(([, p]) => p.wash).map(([id, p]) => [id, p.wash.meshes.filter((m) => m.visible).length])),
    made: l.washes.stats.created, programs: c._view.renderer.info.programs.length }; })()`);
  let w = await W();
  check('washes: lit facade lamps and uplights wash the south wall', ['facade_1', 'facade_3', 'wall_uplight_1', 'wall_uplight_2'].every((id) => w.walls.includes(id)), JSON.stringify(w));
  const progs = w.programs, made = w.made;
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
    await page.evaluate(`${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_terrace' })`);
    await idle(page);
  }
  w = await W();
  check('washes: toggling lamps compiles no shader and makes no new wash', w.programs === progs && w.made === made, JSON.stringify({ progs, made, w }));
  await page.evaluate(`${card}._hass.callService('switch', 'turn_off', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  w = await W();
  check('washes: controller off hides the facade washes', !w.walls.some((id) => id.startsWith('facade_')), JSON.stringify(w.walls));
  // Light on wall: tag facade = both -> two quads (down + up) per lit facade lamp, no new shader program
  await page.evaluate(`${card}._hass.callService('switch', 'turn_on', { entity_id: 'switch.demo_facade' })`);
  await page.evaluate(`${card}._commit({ ...${card}._layout, tags: { ...${card}._layout.tags, facade: { ...(${card}._layout.tags || {}).facade, wash: 'both' } } })`);
  await sleep(600);
  w = await W();
  // facade_2 has no wall within reach and nothing under it (no wash at all, as before)
  check('Light on wall: tag facade = both -> 2 wash quads per lit facade lamp', ['facade_1', 'facade_3'].every((id) => w.quads[id] === 2), JSON.stringify(w.quads));
  const progsBoth = w.programs;
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
    await sleep(250);
  }
  w = await W();
  check('Light on wall: both keeps the shader programs constant (toggling too)', w.programs === progs && w.programs === progsBoth, JSON.stringify({ progs, progsBoth, now: w.programs }));
  // the object's own setting wins over its tag
  await page.evaluate(`${card}._commit({ ...${card}._layout, objects: { ...${card}._layout.objects, facade_2: { ...((${card}._layout.objects || {}).facade_2 || {}), wash: 'none' } } })`);
  await sleep(500);
  w = await W();
  check('Light on wall: object none beats tag both', w.quads.facade_2 === 0 && w.quads.facade_1 === 2, JSON.stringify(w.quads));
  // the point light keeps 0.15 m off the wall it faces (no hot spot on the wall / door behind it)
  const gap = await page.evaluate(`(() => { const l = ${card}._objects; let worst = Infinity; for (const [id, s] of l._slots) {
    const p = l.parts.get(id), h = p.wallHit && p.wallHit.hit; if (!h || s.light.isSpotLight) continue;
    const d = (s.light.position.x - h.point[0]) * h.normal[0] + (s.light.position.y - h.point[1]) * h.normal[1] + (s.light.position.z - h.point[2]) * h.normal[2];
    worst = Math.min(worst, d); } return worst; })()`);
  check('real point lights stay >= 0.15 m off their wall', gap === Infinity || gap >= 0.149, String(gap));
  await page.evaluate(`${card}._commit({ ...${card}._layout, objects: { ...${card}._layout.objects, facade_2: (({ wash, ...r }) => r)((${card}._layout.objects || {}).facade_2 || {}) } })`);
  await sleep(500);
  await page.screenshot({ path: path.join(root, 'screenshots', 'washes-both-night.png') });
  // glare: a large glow mesh (the 3 m kitchen strip) glows less per level than a small bulb
  await page.evaluate(`${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_strip', brightness: 255 })`);
  await page.evaluate(`${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_living', brightness: 255 })`);
  await idle(page);
  const glare = await page.evaluate(`(() => { const l = ${card}._objects, k = (id) => { const p = l.parts.get(id), m = p.part.glow.material;
    return (Array.isArray(m) ? m[0] : m).emissiveIntensity / (3 * p.result.level); }; return { strip: k('kitchen_strip'), bulb: k('lamp_living') }; })()`);
  check('glare: the large strip glow gets a lower emissive intensity than the small bulb', glare.bulb === 1 && glare.strip < 0.5, JSON.stringify(glare));
  await page.evaluate(`${card}._hass.callService('switch', 'turn_off', { entity_id: 'switch.demo_facade' })`); // as the tap hint checks expect
  await idle(page);
  // tap hints: always -> dots; facade hollow while its controller is off; a tap says why
  await page.evaluate(`${card}._commit({ ...${card}._layout, tap_hints: 'always' })`);
  await idle(page);
  const H = () => page.evaluate(`(() => { const h = ${card}._hints; return { vis: h.group.visible, items: h.items.map((i) => i.id + ':' + (i.ok ? 1 : 0)),
    filled: h.layers.filled.geometry.drawRange.count, hollow: h.layers.hollow.geometry.drawRange.count, programs: ${card}._view.renderer.info.programs.length }; })()`);
  let h = await H();
  check('tap hints: a dot per tappable object, facade hollow (controller off)', h.vis && h.items.includes('facade_1:0') && h.items.includes('lamp_living:1') && h.hollow >= 3 && h.filled > 0, JSON.stringify(h));
  await page.evaluate(`${card}._runObjectAction('facade_1', 'tap')`);
  await idle(page);
  const toast = await page.evaluate(`${card}._toastEl.hidden ? '' : ${card}._toastEl.textContent`);
  check('tap hints: tapping an unreachable lamp says "Turn on first: …" and toggles nothing',
    toast.startsWith('Turn on first') && (await page.evaluate(`${card}._hass.states['light.demo_facade'].state`)) === 'on', toast);
  await page.evaluate(`${card}._hass.callService('switch', 'turn_on', { entity_id: 'switch.demo_facade' })`);
  await idle(page);
  h = await H();
  check('tap hints: controller on -> facade dots filled', h.items.includes('facade_1:1'), JSON.stringify(h.items));
  await page.evaluate(`${card}._commit({ ...${card}._layout, tap_hints: 'off' })`);
  await idle(page);
  check('tap hints: off hides them', !(await H()).vis);
  // marker shapes
  const shapes = await page.evaluate(`(() => { const out = {}; for (const el of ${card}.shadowRoot.querySelectorAll('.fp-marker')) {
    const k = [...el.classList].filter((c) => c.startsWith('kind-')).join(); out[k] = (out[k] || 0) + 1; } return out; })()`);
  check('markers: shapes by role (control circles, value squares, binary, info)', shapes['kind-control'] > 0 && shapes['kind-value'] > 0 && shapes['kind-binary'] > 0, JSON.stringify(shapes));
  // keep_objects: the terrace zone hidden with "Hide surfaces, keep devices" keeps facade_1 (nested in it) lit and tappable
  const vid = await page.evaluate(`${card}.currentView().id`);
  await page.evaluate(`${card}.saveViewPatch(${JSON.stringify(vid)}, { rules: [...(${card}._layout.views?.[${JSON.stringify(vid)}]?.rules || []), { hide: 'zone:terrace', keep_objects: true }] })`);
  await sleep(500);
  const keep = await page.evaluate(`(() => { const c = ${card}, idx = c._index, l = c._objects;
    const z = idx.nodes.findIndex((n) => n.tag && n.tag.kind === 'zone' && n.tag.id === 'terrace');
    const lampNode = l.objectAt('facade_1').obj.node;
    let inZone = false; for (let o = lampNode; o; o = o.parent) if (o === idx.nodes[z].node) inZone = true;
    const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
    const surfaces = []; idx.nodes[z].node.traverse((o) => { if (o.isMesh) { let obj = false; for (let p = o; p && p !== idx.nodes[z].node; p = p.parent) if (p.userData && p.userData.fp && p.userData.fp.kind === 'object') obj = true; if (!obj) surfaces.push(shown(o) && o.layers.mask !== 0); } });
    return { inZone, lampShown: shown(lampNode), lit: !!l.objectAt('facade_1').result.lit, surfaces, wash: l.parts.get('facade_1').wash.meshes.some((m) => m.visible) }; })()`);
  check('keep_objects: hidden terrace zone keeps its nested facade lamp shown and lit, its surfaces hidden',
    keep.inZone && keep.lampShown && keep.lit && keep.wash && keep.surfaces.length > 0 && keep.surfaces.every((x) => !x), JSON.stringify(keep));
  const fa = await page.evaluate(`(() => { const c = ${card}; const a = c._objects.anchors().find((x) => x.id === 'facade_1'); return a && c._view.projectWorld(a.world); })()`);
  const facadeBefore = await page.evaluate(`${card}._hass.states['light.demo_facade'].state`);
  if (fa) await page.mouse.click(fa[0], fa[1]);
  await sleep(450);
  const facadeAfter = await page.evaluate(`${card}._hass.states['light.demo_facade'].state`);
  check('keep_objects: the kept facade lamp is tappable (tap toggles it)', !!fa && facadeAfter !== facadeBefore, `${JSON.stringify(fa)} ${facadeBefore} -> ${facadeAfter}`);
  await page.evaluate(`${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_facade' })`);
  await page.screenshot({ path: path.join(root, 'screenshots', 'keep-objects-night.png') });
  allErrors.push(...s.errors);
});

// 2. missing model
sections.add('missing-model', { group: 'upload', query: { model: '/demo/missing.glb' } }, async (s) => {
  await s.page.waitForFunction(`!${card}.shadowRoot.querySelector('.notice').hidden`, { timeout: 10000 });
  const text = await s.page.evaluate(`${card}.shadowRoot.querySelector('.notice').textContent`);
  check('missing model shows a notice', text.includes('missing.glb'), text);
  check('card still renders markers', (await s.page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-marker').length`)) > 0);
  allErrors.push(...s.errors.filter((e) => !e.includes('missing.glb') && !e.includes('404')));
});

// 2b. upload a model in edit mode (Model tab), align it, remove it
sections.add('upload', { group: 'upload', query: { view: '3d', height: '560px' }, viewport: { width: 1500, height: 680 } }, async (s) => {
  const { page } = s;
  const panel = (sel) => `${card}.shadowRoot.querySelector(".panel ${sel}")`;
  const clickText = (t) => page.evaluate((t) => {
    const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === t);
    if (b) b.click();
    return !!b;
  }, t);
  await page.evaluate(`${card}.shadowRoot.querySelector("button.edit").click()`);
  await idle(page);
  await clickText('Model');
  await idle(page);
  check('model tab offers upload', (await page.evaluate(`${panel('label.button')}?.textContent || ''`)).includes('Upload .glb'));
  const upload = async (file) => {
    const input = await page.evaluateHandle(panel('[data-field=model-file]'));
    await input.uploadFile(file);
  };
  const bad = path.join(root, 'screenshots', 'not-a-model.glb');
  fs.writeFileSync(bad, 'hello');
  await upload(bad);
  await page.waitForFunction(`!!${panel('.msg.error')}`, { timeout: 5000 });
  check('non-glb rejected with message', (await page.evaluate(`${panel('.msg.error')}.textContent`)).includes('glTF'));
  fs.unlinkSync(bad);

  await upload(path.join(root, 'demo', 'house.glb'));
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
  await idle(page);
  const lm = await page.evaluate(`${card}._layout.model`);
  check('upload stored in layout', lm && lm.name === 'house.glb' && lm.version && lm.size > 1000, JSON.stringify(lm));
  check('model loaded with level groups', JSON.stringify(await page.evaluate(`${card}._view.modelManifest().levels.map((l) => l.id)`)) === '["level0","level1","exterior","roof"]');
  const lv = () => page.evaluate(`JSON.stringify(Object.fromEntries(Object.entries(${card}.modelBindings().levels).map(([k, v]) => [k, v.show + ':' + v.floor])))`);
  check('levels map by order, exterior with ground, roof all-only',
    (await lv()) === JSON.stringify({ level0: 'with:ground', level1: 'with:first', exterior: 'always:ground', roof: 'all-only:null' }), await lv());
  check('rooms come from the model', await page.evaluate(`${card}._modelRooms.some((r) => r.id === 'm:kitchen' && r.floor_id === 'ground')`));
  check('model room replaces the drawn kitchen', await page.evaluate(`${card}._allRooms().filter((r) => r.area_id === 'kitchen').length === 1`));
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = "90"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-opacity]')}; s.value = "0.5"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await idle(page);
  check('rotation slider turns the model', Math.round(await page.evaluate(`${card}._view.modelGroup.rotation.y * 180 / Math.PI`)) === 90);
  check('opacity applied', await page.evaluate(`(() => { let o; ${card}._view.model.root.traverse((m) => { if (m.isMesh && o === undefined) o = m.material.opacity; }); return o === 0.5; })()`));
  check('slider kept (no re-render)', await page.evaluate(`${panel('[data-field=md-rotation]')}.value === "90"`));
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = "0"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await idle(page);
  await page.screenshot({ path: path.join(root, 'screenshots/model-upload.png') });
  // rotation moves the rooms with the model
  const k0 = await page.evaluate(`JSON.stringify(${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon[1])`);
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = '90'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await idle(page);
  check('rotation moves rooms', (await page.evaluate(`JSON.stringify(${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon[1])`)) !== k0);
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await idle(page);
  // a marker dropped on the model follows the model's alignment
  {
    await page.evaluate(`${card}._setMode('3d'); ${card}._setFloor('ground'); ${card}._view.fit({ model: true, instant: true })`);
    await clickText('Devices'); // markers are draggable here (the Model tab picks the model instead)
    await idle(page);
    const kp = await page.evaluate(`${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon`);
    const tx = kp.reduce((a, p) => a + p[0], 0) / kp.length, ty = kp.reduce((a, p) => a + p[1], 0) / kp.length;
    const pick = await page.evaluate(`(() => { const c = ${card}, v = c._view;
      for (const m of c._markers) {
        const p = c._positions.get(m.id), o = v.markerObjects.get(m.id);
        if (!p || !o || !o.obj.visible || p.floorId !== 'ground' || m.id === c._mowerMarkerId) continue;
        const r = o.obj.element.querySelector('.fp-dot').getBoundingClientRect();
        if (r.width) return { id: m.id, z: p.z, from: [r.x + r.width / 2, r.y + r.height / 2] };
      }
      return null; })()`);
    const to = await page.evaluate(`${card}._view.screenPoint(${tx}, ${ty}, ${pick.z}, 'ground')`);
    await page.mouse.move(...pick.from);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps: 8 });
    await page.mouse.up();
    await idle(page);
    const pin0 = await page.evaluate(`${card}._layout.pins[${JSON.stringify(pick.id)}]`);
    await clickText('Model'); // alignment sliders
    await idle(page);
    check('pin dropped on the model has on_model', !!(pin0 && pin0.on_model), JSON.stringify(pin0));
    const align = () => page.evaluate(`(() => { const m = ${card}._layout.model; return { position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1 }; })()`);
    const a0 = await align();
    await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = "30"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await idle(page);
    const a1 = await align();
    const pin1 = await page.evaluate(`${card}._layout.pins[${JSON.stringify(pick.id)}]`);
    const r = (a0.rotation - a1.rotation) * Math.PI / 180; // rotated old position about the model origin
    const ox = pin0.x - a0.position[0], oy = pin0.y - a0.position[1];
    const want = [a1.position[0] + ox * Math.cos(-r) - oy * Math.sin(-r), a1.position[1] + ox * Math.sin(-r) + oy * Math.cos(-r)];
    check('rotating the model 30° rotates the pin with it', a1.rotation === 30 && Math.hypot(pin1.x - want[0], pin1.y - want[1]) <= 0.01,
      `${JSON.stringify(pin0)} -> ${JSON.stringify(pin1)}, want ${want}`);
    const l0 = inverseTransformPoint([pin0.x, pin0.y], a0), l1 = inverseTransformPoint([pin1.x, pin1.y], a1);
    check('pin keeps its spot in model coordinates', Math.hypot(l0[0] - l1[0], l0[1] - l1[1]) <= 0.01, `${l0} vs ${l1}`);
    const w = await page.evaluate(`${card}._view.markerObjects.get(${JSON.stringify(pick.id)}).obj.position.toArray()`);
    check('marker world position follows the pin', Math.hypot(w[0] - pin1.x, w[2] + pin1.y) <= 0.01, `${w} vs ${pin1.x},${pin1.y}`);
    const inside = await page.evaluate(`(() => { const poly = ${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon, x = ${pin1.x}, y = ${pin1.y};
      let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; })()`);
    check('pin still inside the rotated model room', inside);
    // back to 0°: the pin returns; then drop it so the checks below see the original layout
    await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = "0"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await idle(page);
    const pin2 = await page.evaluate(`${card}._layout.pins[${JSON.stringify(pick.id)}]`);
    check('rotating back restores the pin', Math.hypot(pin2.x - pin0.x, pin2.y - pin0.y) <= 0.001, JSON.stringify(pin2));
    await page.evaluate(`(() => { const c = ${card}; const pins = { ...c._layout.pins }; delete pins[${JSON.stringify(pick.id)}]; c._commit({ ...c._layout, pins }); })()`);
  }
  // assign a room to no area
  await page.evaluate(`(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-room][data-id=kitchen]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  check('room binding saved', JSON.stringify(await page.evaluate(`${card}._layout.model.rooms`)) === '{"kitchen":{"area":null}}', JSON.stringify(await page.evaluate(`${card}._layout.model.rooms`)));
  // click to pick: the kitchen floor in top view
  await page.evaluate(`${card}._setMode('top')`);
  await page.evaluate(`${card}._view.fit({ model: true })`);
  await idle(page);
  const pt = await page.evaluate(`${card}._view.screenPoint(9.5, 2, 0, 'ground')`);
  await page.mouse.click(pt[0], pt[1]);
  await idle(page);
  check('click picks the room', JSON.stringify(await page.evaluate(`${card}._edit.modelPick`)) === '{"kind":"room","id":"kitchen"}'
    && await page.evaluate(`!!${card}.shadowRoot.querySelector('tr.sel[data-pick="room:kitchen"]')`), JSON.stringify(await page.evaluate(`${card}._edit.modelPick`)));
  await page.evaluate(`${card}._setMode('3d')`);
  await idle(page);
  // a model whose level ids differ again (and without views of its own): the ids keep their order mapping
  const renamed = path.join(root, 'screenshots', 'renamed.glb');
  const ren = { level0: 'lvl_a0', level1: 'lvl_a1' };
  fs.writeFileSync(renamed, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) {
      const fp = n.extras && n.extras.fp;
      if (fp && fp.views) delete fp.views;
      if (fp && fp.kind === 'level' && ren[fp.id]) fp.id = ren[fp.id];
    }
    return json;
  }));
  await upload(renamed);
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.some((l) => l.id === 'lvl_a0')`, { timeout: 30000 });
  await idle(page);
  fs.unlinkSync(renamed);
  check('renamed levels still map by order', (await lv()) === JSON.stringify({ lvl_a0: 'with:ground', lvl_a1: 'with:first', exterior: 'always:ground', roof: 'all-only:null' }), await lv());
  const vis = () => page.evaluate(`(() => { const l = ${card}._view.modelManifest().levels; return [l[0].node.visible, l[1].node.visible]; })()`);
  check('ground shows its own storey only', JSON.stringify(await vis()) === '[true,false]');
  // legacy show modes (written before levels became "belongs to HA floor") stay readable
  const setLevel = (id, b) => page.evaluate(`${card}._edit.setModelProps({ levels: { ...(${card}._layout.model.levels || {}), ${JSON.stringify(id)}: ${JSON.stringify(b)} } })`);
  const selectLevel = (id, value) => page.evaluate(`(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-level][data-id=${id}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setLevel('exterior', { show: 'always', floor: 'ground' });
  await idle(page);
  check('exterior "always" keeps its zones', await page.evaluate(`${card}._modelRooms.some((r) => r.id === 'm:garden')`)
    && JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)) === '{"show":"always","floor":"ground"}', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)));
  check('exterior "always" does not remap storeys', (await lv()) === JSON.stringify({ exterior: 'always:ground', lvl_a0: 'with:ground', lvl_a1: 'with:first', roof: 'all-only:null' }), await lv());
  check('legacy show mode reads as its floor in the dropdown', await page.evaluate(`${card}.shadowRoot.querySelector('[data-field=md-level][data-id=exterior]').value === 'floor:ground'`));
  await setLevel('exterior', { show: 'hidden', floor: 'ground' });
  await idle(page);
  check('exterior "hidden" does not remap storeys', (await lv()) === JSON.stringify({ exterior: 'hidden:ground', lvl_a0: 'with:ground', lvl_a1: 'with:first', roof: 'all-only:null' }), await lv());
  await selectLevel('exterior', 'auto');
  await idle(page);
  check('mapped level visible on its floor', JSON.stringify(await vis()) === '[true,false]');
  check('level rows marked auto', (await page.evaluate(`${panel('table.floors')}.textContent`)).includes('auto'));
  check('level dropdown: auto, HA floors, no floor', (await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('[data-field=md-level][data-id=exterior] option')].map((o) => o.value).join()`)) === 'auto,floor:ground,floor:first,none',
    await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('[data-field=md-level][data-id=exterior] option')].map((o) => o.value).join()`));
  await selectLevel('exterior', 'none');
  await idle(page);
  check('"no floor" writes { floor: null }', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)) === '{"floor":null}'
    && JSON.parse(await lv()).exterior === 'always:null' && await page.evaluate(`${card}.shadowRoot.querySelector('[data-field=md-level][data-id=exterior]').value === 'none'`), await lv());
  await selectLevel('exterior', 'floor:first');
  await idle(page);
  check('choosing a floor writes { floor }', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)) === '{"floor":"first"}');
  await selectLevel('exterior', 'auto');
  await setLevel('lvl_a1', { show: 'always', floor: 'first' });
  await idle(page);
  check('legacy "always shown"', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.lvl_a1`)).includes('"always"') && JSON.stringify(await vis()) === '[true,true]', JSON.stringify(await page.evaluate(`${card}._layout.model.levels`)));
  await setLevel('lvl_a0', { show: 'hidden', floor: 'ground' });
  await idle(page);
  check('legacy "hidden"', JSON.stringify(await vis()) === '[false,true]');
  await selectLevel('lvl_a0', 'auto');
  await idle(page);
  check('choose "auto" removes the saved binding, the legacy mode stays as view rules', !('lvl_a0' in (await page.evaluate(`${card}._layout.model.levels`)))
    && JSON.stringify(await vis()) === '[false,true]'
    && JSON.stringify(await page.evaluate(`${card}._layout.views.all.rules`)).includes('{"hide":"level:lvl_a0"}'), JSON.stringify(await page.evaluate(`${card}._layout.views`)))
  check('dropdown shows auto again', await page.evaluate(`${card}.shadowRoot.querySelector('[data-field=md-level][data-id=lvl_a0]').value === 'auto'`));

  // untagged model: loads whole, no rooms
  const untagged = path.join(root, 'screenshots', 'untagged.glb');
  fs.writeFileSync(untagged, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) { delete n.extras; if (n.name === 'roof') n.name = 'top'; } // legacy name "roof" would still tag a level
    return json;
  }));
  await upload(untagged);
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 0`, { timeout: 30000 });
  fs.unlinkSync(untagged);
  check('untagged model loads whole', await page.evaluate(`${card}._view.model.root.visible && ${card}._modelRooms.length === 0`));
  await idle(page);
  check('stale bindings offered for forgetting', await page.evaluate(`!!${card}.shadowRoot.querySelector('[data-act=md-forget]')`));
  await page.evaluate(`${card}.shadowRoot.querySelector('[data-act=md-forget]').click()`);
  await idle(page);
  await upload(path.join(root, 'demo', 'house.glb'));
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.length === 4`, { timeout: 30000 });
  await idle(page);
  const cam0 = await page.evaluate(`${card}._view.camera.position.toArray().join()`);
  await clickText('Frame model');
  await idle(page);
  check('frame model moves the camera', (await page.evaluate(`${card}._view.camera.position.toArray().join()`)) !== cam0);
  // day/night survives a model reload
  const dn = `${card}.shadowRoot.querySelector('button.daynight')`;
  const skyTo = async (m) => { for (let i = 0; i < 3 && (await page.evaluate(`${card}._skyMode`)) !== m; i++) await page.evaluate(`${dn}.click()`); };
  await skyTo('night');
  await upload(path.join(root, 'demo', 'house.glb'));
  await sleep(1500);
  check('night kept after re-upload', (await page.evaluate(`${card}._skyMode`)) === 'night' && (await page.evaluate(`${card}._view.sun.intensity`)) === 0);
  await skyTo('day');
  await idle(page);
  check('back to day', (await page.evaluate(`${card}._view.sun.intensity`)) > 1 && (await page.evaluate(`${card}._view.sun.castShadow`)) === true);

  // legacy model (no fp tags, floor:<id> / site / roof names): auto mapping, per-chip visibility, no regeneration notice
  const legacy = path.join(root, 'screenshots', 'legacy.glb');
  const legacyNames = { level0: 'floor:ground', level1: 'floor:first', exterior: 'site' };
  fs.writeFileSync(legacy, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) { delete n.extras; if (legacyNames[n.name]) n.name = legacyNames[n.name]; }
    return json;
  }));
  await upload(legacy);
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.some((l) => l.id === 'site')`, { timeout: 30000 });
  await idle(page);
  fs.unlinkSync(legacy);
  check('legacy names read as levels', (await page.evaluate(`${card}._view.modelManifest().levels.map((l) => l.id).join()`)) === 'ground,first,site,roof',
    await page.evaluate(`${card}._view.modelManifest().levels.map((l) => l.id).join()`));
  check('legacy levels map automatically', (await lv()) === JSON.stringify({ ground: 'with:ground', first: 'with:first', site: 'always:ground', roof: 'all-only:null' }), await lv());
  const legacyVis = () => page.evaluate(`(() => { const l = ${card}._view.modelManifest().levels; return [l[0].node.visible, l[1].node.visible]; })()`);
  await page.evaluate(`${card}._setFloor('ground')`);
  await idle(page);
  check('legacy: ground chip shows ground only', JSON.stringify(await legacyVis()) === '[true,false]');
  const storeyTop = (id) => page.evaluate(`(() => { const f = ${card}._floors.find((x) => x.id === ${JSON.stringify(id)}); return f.elevation + (f.height || 2.7); })()`);
  check('legacy: cut at the top of the ground storey (not the 1 m wall height)', Math.abs((await page.evaluate(`${card}._view.modelClip.constant`)) - (await storeyTop('ground'))) < 1e-6 && (await storeyTop('ground')) > 2,
    `${await page.evaluate(`${card}._view.modelClip.constant`)} vs ${await storeyTop('ground')}`);
  await page.evaluate(`${card}._setFloor('first')`);
  await idle(page);
  check('legacy: first chip stacks the storeys', JSON.stringify(await legacyVis()) === '[true,true]');
  await clickText('Data');
  await clickText('Model');
  await idle(page);
  check('no "Since the last setup" notice after upload', !(await page.evaluate(`${panel('')}.textContent`)).includes('Since the last setup'));

  // importing a plan export keeps the uploaded model and the view settings, and maps foreign floor ids onto HA floors
  await page.evaluate(`${card}.saveViewPatch(${card}._viewId, { label: 'Kept view' })`);
  await idle(page);
  const keptId = await page.evaluate(`${card}._viewId`);
  await clickText('Data');
  const plan = path.join(root, 'screenshots', 'plan-export.json');
  fs.writeFileSync(plan, JSON.stringify({ version: 1, floors: [{ id: 'level0', elevation: 0, height: 2.8 }],
    rooms: [{ id: 'x', area_id: 'kitchen', floor_id: 'level0', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }] }));
  const imp = await page.evaluateHandle(panel('[data-field=import]'));
  await imp.uploadFile(plan);
  await sleep(600);
  fs.unlinkSync(plan);
  check('import keeps the uploaded model', await page.evaluate(`!!(${card}._layout.model && ${card}._view.model)`));
  check('import of a file without views keeps the view settings', (await page.evaluate(`(${card}._layout.views || {})[${JSON.stringify(keptId)}]?.label`)) === 'Kept view');
  check('import maps floor ids onto HA floors', (await page.evaluate(`${card}._layout.rooms[0].floor_id`)) === 'ground'
    && (await page.evaluate(`${panel('.msg')}.textContent`)).includes('level0 → Ground floor'));
  for (let i = 0; i < 3 && (await page.evaluate(`${card}._skyMode`)) !== 'night'; i++) await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`); // night, then remove the model
  await idle(page);
  await clickText('Model');
  await idle(page);
  await clickText('Remove model');
  await clickText('Really remove?');
  await idle(page);
  check('remove clears model', (await page.evaluate(`${card}._layout.model`)) === null && !(await page.evaluate(`${card}._view.model`)));
  check('removal resets the look', await page.evaluate(`(() => { const c = ${card}; return !c._stage.classList.contains('has-model')
    && c.shadowRoot.querySelector('button.daynight').hidden && c._view.renderer.toneMapping === 0 && c._view.renderer.shadowMap.enabled === false; })()`));
  const dayLook = await page.evaluate(`(() => { const v = ${card}._view; return { hemi: v.hemi.intensity, sun: v.sun.intensity, tm: v.renderer.toneMapping }; })()`);
  check('removing the model at night restores the day look', dayLook.hemi === 2.2 && dayLook.sun === 1.4 && dayLook.tm === 0, JSON.stringify(dayLook));
  allErrors.push(...s.errors);
});

// 2d. model views and layers in edit mode (demo/house.glb uploaded): views from the model, per-view
// layer rules, click-in-3D menu, saved camera, linked floors, pick a room outline, untagged copies
sections.add('model-views', { group: 'views', query: { view: '3d', height: '560px' }, viewport: { width: 1500, height: 680 } }, async (s) => {
  const { page } = s;
  const sr = `${card}.shadowRoot`;
  const clickText = async (t) => {
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === t);
      if (b) b.click();
      return !!b;
    }, t);
    await idle(page);
    return ok;
  };
  const upload = async (file) => {
    await clickText('Model');
    const input = await page.evaluateHandle(`${sr}.querySelector('.panel [data-field=model-file]')`);
    await input.uploadFile(file);
  };
  const chip = async (id) => { await page.evaluate(`${sr}.querySelector('.chip[data-view=${id}]').click()`); await idle(page); };
  const chipIds = () => page.evaluate(`[...${sr}.querySelectorAll('.chip')].map((b) => b.dataset.view)`);
  const nodeVis = (name) => page.evaluate(`(() => { const n = ${card}._view.model.root.getObjectByName(${JSON.stringify(name)}); for (let p = n; p; p = p.parent) if (!p.visible) return false; return !!n; })()`);
  // a screen point over a plan spot that is not covered by a marker or other DOM (so the click reaches the canvas)
  const freePoint = (spots, z, floor) => page.evaluate((spots, z, floor) => {
    const c = document.querySelector('floorplan3d-card');
    for (const [x, y] of spots) {
      const [cx, cy] = c._view.screenPoint(x, y, z, floor);
      const el = c.shadowRoot.elementFromPoint(cx, cy);
      if (el && el.tagName === 'CANVAS') return [cx, cy];
    }
    return null;
  }, spots, z, floor);
  const grid = (x0, x1, y0, y1) => { const out = []; for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) out.push([x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * j) / 4]); return out; };
  const devs = () => page.evaluate(`(() => { const c = ${card}, v = c._view; const lvl = new Map(v.modelManifest().rooms.map((r) => [r.id, r.level]));
    const out = {};
    for (const m of c._markers) {
      const p = c._positions.get(m.id), o = v.markerObjects.get(m.id);
      if (!p || !o) continue;
      const room = p.auto === false || p.live ? null : (c._modelRooms.find((r) => r.area_id === m.areaId) || {}).modelId;
      const k = room ? lvl.get(room) : p.live ? 'mower' : (m.id === 'device:tv' ? 'outside:' : 'pin:') + p.floorId;
      const e = out[k] = out[k] || { shown: 0, hidden: 0 };
      if (o.obj.visible) e.shown++; else e.hidden++;
    }
    return out; })()`);

  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await idle(page);
  await upload(path.join(root, 'demo', 'house.glb'));
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 4`, { timeout: 30000 });
  await idle(page);
  check('uploaded model: chips are its views in order', JSON.stringify(await chipIds()) === '["exterior","ground","first"]'
    && JSON.stringify(await page.evaluate(`[...${sr}.querySelectorAll('.chip')].map((b) => b.textContent)`)) === '["Exterior","Ground floor","First floor"]', JSON.stringify(await chipIds()));
  await chip('ground');
  await clickText('Views');
  check('room labels in edit mode show sizes', await page.evaluate(`(() => { const l = [...${sr}.querySelectorAll('.fp-room-label:not(.fp-obj-label)')].map((x) => x.textContent); return l.length > 0 && l.every((t) => t.includes('×') || t.includes('m²')); })()`));

  // layer eye: furniture hidden in this view only
  const furniture = ['sofa', 'coffee_table', 'kitchen_table', 'bed'];
  const eye = () => page.evaluate(`${sr}.querySelector('.panel li[data-sel="layer:furniture"] .eye').click()`);
  check('Views tab lists the furniture and ceiling layers', await page.evaluate(`!!${sr}.querySelector('.panel li[data-sel="layer:furniture"]') && !!${sr}.querySelector('.panel li[data-sel="layer:ceiling"]')`));
  await eye(); await idle(page);
  await eye(); await idle(page);
  const rulesOf = (id) => page.evaluate(`JSON.stringify(((${card}._layout.views || {})[${JSON.stringify(id)}] || {}).rules || [])`);
  check('eye on layer:furniture stores a hide rule for this view', (await rulesOf('ground')) === '[{"hide":"layer:furniture"}]', await rulesOf('ground'));
  const furnVis = async () => { const out = []; for (const n of furniture) out.push(await nodeVis(n)); return out; };
  check('furniture hidden in the Ground floor view', (await furnVis()).every((x) => x === false), JSON.stringify(await furnVis()));
  check('room floors stay visible', await nodeVis('kitchen'));
  await chip('first');
  check('furniture visible again in the First floor view', (await furnVis()).every((x) => x === true) && (await nodeVis('desk')), JSON.stringify(await furnVis()));
  check('other view has no rule', (await rulesOf('first')) === '[]');
  await chip('ground');
  await eye(); await idle(page);
  check('third eye click: back to default', (await rulesOf('ground')) === '[]' && (await furnVis()).every((x) => x === true), await rulesOf('ground'));

  // click in 3D -> menu -> Hide in this view; Reveal in tree
  await page.evaluate(`${card}._setMode('top')`);
  await page.evaluate(`${card}._view.fit({ instant: true })`);
  await idle(page);
  let pt = await freePoint(grid(0.3, 2.1, 2.65, 3.35), 0.45, 'ground');
  check('a free spot over the sofa', !!pt);
  if (pt) {
    await page.mouse.click(pt[0], pt[1]);
    await idle(page);
    const menu = await page.evaluate(`(() => { const m = ${sr}.querySelector('.fp-pickmenu'); return m ? [...m.querySelectorAll('button')].map((b) => b.textContent) : null; })()`);
    check('click on furniture opens the menu', JSON.stringify(menu) === '["Hide in this view","Hide surfaces, keep devices","Show in this view","Hide in all views","Reveal in tree"]', JSON.stringify(menu));
    check('the pick is the sofa group', (await page.evaluate(`${card}._edit.vwPick && ${card}._edit.vwPick.sel`)) === 'node:house/level0/sofa', await page.evaluate(`${card}._edit.vwPick && ${card}._edit.vwPick.sel`));
    await page.evaluate(`${sr}.querySelector('.fp-pickmenu [data-act=vw-hide-here]').click()`);
    await idle(page);
    check('"Hide in this view" hides the sofa only', !(await nodeVis('sofa')) && (await nodeVis('coffee_table')) && (await rulesOf('ground')) === '[{"hide":"node:house/level0/sofa"}]', await rulesOf('ground'));
    check('menu closed', await page.evaluate(`!${sr}.querySelector('.fp-pickmenu')`));
  }
  pt = await freePoint(grid(2.1, 3.1, 1.35, 1.85), 0.45, 'ground');
  if (pt) {
    await page.mouse.click(pt[0], pt[1]);
    await idle(page);
    await page.evaluate(`(() => { const b = ${sr}.querySelector('.panel .tab-body'); b.scrollTop = 0; })()`);
    await page.evaluate(`${sr}.querySelector('.fp-pickmenu [data-act=vw-reveal]').click()`);
    await idle(page);
    const rev = await page.evaluate(`(() => { const li = ${sr}.querySelector('.panel li[data-sel="node:house/level0/coffee_table"]'); if (!li) return null;
      const b = ${sr}.querySelector('.panel .tab-body').getBoundingClientRect(), r = li.getBoundingClientRect();
      return { flash: li.classList.contains('flash'), inView: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 }; })()`);
    check('"Reveal in tree" scrolls to the coffee table row and flashes it', !!rev && rev.flash && rev.inView, JSON.stringify(rev));
  } else check('a free spot over the coffee table', false);
  await page.evaluate(`${card}.saveViewPatch('ground', { rules: [] })`);
  await idle(page);
  await page.evaluate(`${card}._setMode('3d')`);
  await idle(page);

  // saved camera: save, move, switch away and back
  await page.evaluate(`${card}._view.setCamera({ position: [18, 22, 16], target: [6, 0, -4] }, { instant: true })`);
  await idle(page);
  await page.evaluate(`${sr}.querySelector('.panel [data-act=vw-save-cam]').click()`);
  await idle(page);
  const saved = await page.evaluate(`${card}._layout.views.ground.camera`);
  check('"Save current view as start" stores the camera', !!saved && Math.hypot(saved.position[0] - 18, saved.position[1] - 22, saved.position[2] - 16) < 0.01, JSON.stringify(saved));
  await page.evaluate(`${card}._view.setCamera({ position: [40, 35, 40], target: [0, 0, 0] }, { instant: true })`);
  await chip('first');
  await chip('ground');
  await sleep(500);
  const back = await page.evaluate(`(() => { const c = ${card}._view.getCamera(); return c; })()`);
  const dp = Math.hypot(...back.position.map((x, i) => x - saved.position[i])), dt = Math.hypot(...back.target.map((x, i) => x - saved.target[i]));
  check('saved camera restored after switching away and back (within 0.1 m)', dp < 0.1 && dt < 0.1, `${dp.toFixed(3)} / ${dt.toFixed(3)}`);
  await page.evaluate(`${sr}.querySelector('.panel [data-act=vw-reset-cam]').click()`);
  await idle(page);
  check('Reset camera clears it', !(await page.evaluate(`(${card}._layout.views.ground || {}).camera`)));

  // linked floors: unchecking the Ground floor link hides its roomless devices outside every room / zone
  // (a pin far off the plan), not the room devices, pins inside a room or the mower (outdoors)
  await page.evaluate(`(() => { const c = ${card}; c._edit.commit({ ...c._layout, pins: { ...c._layout.pins, 'device:tv': { x: -30, y: -30, z: 1, floor_id: 'ground' } } }); })()`);
  await idle(page);
  let d = await devs();
  const roomless0 = d['outside:ground'] ? d['outside:ground'].shown : 0;
  const setLink = (id, on) => page.evaluate(`(() => { const el = ${sr}.querySelector('.panel [data-field=vw-floor][data-id=${id}]'); el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setLink('ground', false);
  await idle(page);
  d = await devs();
  check('unlinking the floor hides its devices outside rooms; pins in rooms and the mower stay', roomless0 > 0 && d['outside:ground'].shown === 0 && d.level0.shown > 0
    && d['pin:ground'].shown > 0 && (!d.mower || d.mower.shown === 1)
    && JSON.stringify((await page.evaluate(`${card}._layout.views.ground.floors`))) === '[]', JSON.stringify(d));
  await setLink('ground', true);
  await idle(page);
  d = await devs();
  check('linking it again shows them', d['outside:ground'].shown === roomless0, JSON.stringify(d));
  await page.evaluate(`(() => { const c = ${card}; const pins = { ...c._layout.pins }; delete pins['device:tv']; c._edit.commit({ ...c._layout, pins }); })()`);
  await idle(page);

  // pick on a tagged room floor links the model room
  await page.evaluate(`(() => { const c = ${card}; c._edit.commit({ ...c._layout, rooms: c._layout.rooms.filter((r) => r.area_id !== 'kitchen') }); })()`);
  await page.evaluate(`${card}._edit.setModelProps({ rooms: { kitchen: { area: null } } })`);
  await idle(page);
  await clickText('Rooms');
  const pickBtn = () => page.evaluate(() => {
    const li = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel li')].find((x) => x.querySelector('.name') && x.querySelector('.name').textContent.trim() === 'Kitchen');
    const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Pick');
    if (b) b.click();
    return !!b;
  });
  check('Rooms tab offers Pick for the unlinked kitchen', await pickBtn());
  await idle(page);
  await page.evaluate(`${card}._setMode('top')`);
  await page.evaluate(`${card}._view.fit({ instant: true })`);
  await idle(page);
  const kitchenSpots = [[8, 1], [8.2, 4.2], [11.5, 0.5], [11.5, 4.5], [8.5, 6], [9, 0.5], [10, 4.5]];
  pt = await freePoint(kitchenSpots, 0, 'ground');
  if (pt) await page.mouse.click(pt[0], pt[1]);
  await idle(page);
  check('pick on a tagged room floor links the model room', (await page.evaluate(`${card}._layout.model.rooms.kitchen.area`)) === 'kitchen' && !(await page.evaluate(`${card}._edit.picking`)),
    JSON.stringify(await page.evaluate(`${card}._layout.model.rooms`)));
  await page.evaluate(`${card}._setMode('3d')`);
  await idle(page);

  // legacy copy (no extras, legacy level names): generated views, cut on, no elevation inputs, picking traces the floor
  const legacy = path.join(root, 'screenshots', 'legacy-views.glb');
  const legacyNames = { level0: 'floor:ground', level1: 'floor:first', exterior: 'site' };
  fs.writeFileSync(legacy, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) { delete n.extras; if (legacyNames[n.name]) n.name = legacyNames[n.name]; }
    return json;
  }));
  await upload(legacy);
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.some((l) => l.id === 'site')`, { timeout: 30000 });
  await idle(page);
  fs.unlinkSync(legacy);
  check('legacy copy: generated views ground / first / All', JSON.stringify(await chipIds()) === '["ground","first","all"]', JSON.stringify(await chipIds()));
  check('legacy copy is not tagged', !(await page.evaluate(`${card}._view.isTagged()`)));
  await chip('ground');
  await clickText('Views');
  check('legacy copy: "Cut at storey height" present and on', await page.evaluate(`${sr}.querySelector('.panel [data-field=vw-cut]')?.checked === true`));
  const legacyTop = await page.evaluate(`(() => { const f = ${card}._floors.find((x) => x.id === 'ground'); return f.elevation + (f.height || 2.7); })()`);
  check('legacy copy: model cut at the top storey elevation + height (not + 1.0)', legacyTop > 2 && Math.abs((await page.evaluate(`${card}._view.modelClip.constant`)) - legacyTop) < 1e-6,
    `${await page.evaluate(`${card}._view.modelClip.constant`)} vs ${legacyTop}`);
  check('legacy copy: materials carry the model clipping plane', await page.evaluate(`(() => { let n = 0, c = 0; ${card}._view.model.root.traverse((o) => { if (o.isMesh) { n++; if ([].concat(o.material).every((m) => m.clippingPlanes && m.clippingPlanes.length === 1)) c++; } }); return n > 0 && n === c; })()`));
  await clickText('Rooms');
  check('legacy copy: no elevation inputs in the Rooms tab', await page.evaluate(`!${sr}.querySelector('.panel [data-field=floor-elevation]')`));
  // drop the drawn kitchen again (the model has no rooms), then pick its floor: traced outline
  await page.evaluate(`(() => { const c = ${card}; c._edit.commit({ ...c._layout, rooms: c._layout.rooms.filter((r) => r.area_id !== 'kitchen') }); })()`);
  await idle(page);
  const kitchenArea = await page.evaluate(`(() => { const p = ${JSON.stringify([[7.5, 0], [12, 0], [12, 5], [9.5, 5], [9.5, 6.5], [7.5, 6.5]])}; let a = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); })()`);
  const pickAndTrace = async () => {
    await pickBtn();
    await idle(page);
    await page.evaluate(`${card}._setMode('top')`);
    await page.evaluate(`${card}._view.fit({ instant: true })`);
    await idle(page);
    const p = await freePoint(kitchenSpots, 0, 'ground');
    if (p) await page.mouse.click(p[0], p[1]);
    await page.waitForFunction(`${card}._edit.picking && ${card}._edit.picking.poly`, { timeout: 5000 }).catch(() => {});
    await idle(page);
    return page.evaluate(`(() => { const p = ${card}._edit.picking && ${card}._edit.picking.poly; if (!p) return null; let a = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); })()`);
  };
  let area = await pickAndTrace();
  check('pick traces the kitchen floor (area within 0.5 m²)', area !== null && Math.abs(area - kitchenArea) < 0.5, `${area} vs ${kitchenArea}`);
  check('preview offers "Use this outline" and "Draw instead"', await page.evaluate(`(() => { const t = [...${sr}.querySelectorAll('.panel button')].map((b) => b.textContent.trim()); return t.includes('Use this outline') && t.includes('Draw instead'); })()`));
  await clickText('Use this outline');
  const made = await page.evaluate(`${card}._layout.rooms.find((r) => r.area_id === 'kitchen')`);
  check('"Use this outline" creates the room', !!made && made.floor_id === 'ground' && made.polygon.length >= 6, JSON.stringify(made && { floor: made.floor_id, n: made.polygon.length }));
  await page.evaluate(`(() => { const c = ${card}; c._edit.selectRoom(null); c._edit.commit({ ...c._layout, rooms: c._layout.rooms.filter((r) => r.area_id !== 'kitchen') }); })()`);
  // a traced outline is not reused after the model moved (cache keyed by the alignment)
  const traceAt = (x) => page.evaluate(`(() => { const c = ${card}, v = c._view, V = v.persp.position.constructor;
    v.modelGroup.updateMatrixWorld(true);
    v.raycaster.set(new V(${x}, 1.2, -1), new V(0, -1, 0));
    const hit = v.raycaster.intersectObject(v.model.root, true).find((h) => h.object.isMesh && h.point.y < 0.15);
    if (!hit) return null;
    const r = c._edit._traceOutline(hit.object, hit.point.toArray());
    return Math.min(...r.poly.map((p) => p[0])); })()`);
  const minX0 = await traceAt(8);
  await page.evaluate(`${card}._edit.setModelProps({ position: [0.5, 0, 0] }, false)`);
  await idle(page);
  const minX1 = await traceAt(8.5);
  check('outline traced again after realigning the model (moved 0.5 m)', minX0 !== null && minX1 !== null && Math.abs(minX1 - minX0 - 0.5) < 0.06, `${minX0} -> ${minX1}`);
  await page.evaluate(`${card}._edit.setModelProps({ position: [0, 0, 0] }, false)`);
  await idle(page);
  await idle(page);
  await pickAndTrace();
  await clickText('Draw instead');
  check('"Draw instead" starts drawing the area', (await page.evaluate(`${card}._edit.drawing && ${card}._edit.drawing.areaId`)) === 'kitchen' && !(await page.evaluate(`${card}._edit.picking`)));
  await page.keyboard.press('Escape');
  await idle(page);
  check('Esc cancels drawing', !(await page.evaluate(`${card}._edit.drawing`)));
  await pickBtn();
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  check('Esc cancels picking', !(await page.evaluate(`${card}._edit.picking`)));
  await page.evaluate(`${card}._setMode('3d')`);

  // Views tab: side section position slider (live while dragging, saved on release)
  await clickText('Views');
  await idle(page);
  const secPos = `${sr}.querySelector('.panel [data-field=vw-sec-pos]')`;
  check('Views tab: side section direction + position', await page.evaluate(`!!${secPos} && !!${sr}.querySelector('.panel [data-field=vw-sec-dir]')`));
  const live = await page.evaluate(`(() => { const el = ${secPos}, c = ${card}, v = c._view; const pos = Math.round((Number(el.min) + 1) * 100) / 100;
    el.value = String(pos); el.dispatchEvent(new Event('input', { bubbles: true }));
    return { pos, planes: v.renderer.clippingPlanes.length, c: v.sectionClip && v.sectionClip.constant, n: v.sectionClip && v.sectionClip.normal.toArray(),
      saved: ((c._layout.views || {})[c._viewId] || {}).section || null }; })()`);
  check('Views tab: dragging the slider cuts live, nothing saved yet', live.planes === 1 && Math.abs(live.c - live.pos) < 1e-6 && live.n[0] === -1 && !live.saved, JSON.stringify(live));
  await page.evaluate(`${secPos}.dispatchEvent(new Event('change', { bubbles: true }))`);
  await sleep(500);
  const secSaved = await page.evaluate(`(() => { const c = ${card}; return { s: ((c._layout.views || {})[c._viewId] || {}).section, c: c._view.sectionClip && c._view.sectionClip.constant,
    slider: Number(${secPos}.value) }; })()`);
  check('Views tab: release saves layout.views[id].section, the cut stays', !!secSaved.s && secSaved.s.constant === live.pos && secSaved.c === live.pos && secSaved.slider === live.pos, JSON.stringify(secSaved));
  await page.evaluate(`${sr}.querySelector('button.section').click()`);
  await idle(page);
  check('Section button off clears the cut', await page.evaluate(`${card}._view.renderer.clippingPlanes.length === 0`));
  check('Reset section clears the saved cut', await clickText('Reset section'));
  await idle(page);
  check('Reset section: nothing saved', await page.evaluate(`(() => { const c = ${card}; return !((c._layout.views || {})[c._viewId] || {}).section; })()`));

  // Camera: rotation centre per view, zoom pivot, separate top-view camera
  await page.evaluate(`${card}._setView('ground', { instant: true })`);
  await idle(page);
  check('zoom_to default center: controls.zoomToCursor false', await page.evaluate(`${card}._view.controls.zoomToCursor === false`));
  await page.waitForFunction(`!!${card}._view.pivotMarker && ${card}._view.pivotMarker.visible`, { timeout: 3000 }).catch(() => {});
  check('Views tab shows the rotation centre cross', await page.evaluate(`!!${card}._view.pivotMarker && ${card}._view.pivotMarker.visible`));
  check('Set rotation centre button', await clickText('Set rotation centre'));
  check('Set rotation centre arms a click', await page.evaluate(`${card}._edit.pivoting === true`));
  await page.keyboard.press('Escape');
  await idle(page);
  check('Esc cancels Set rotation centre', await page.evaluate(`!${card}._edit.pivoting`));
  await clickText('Set rotation centre');
  // the screen point of a ground-floor room centre and what the model has under it
  const aim = await page.evaluate(`(() => { const c = ${card}, v = c._view, r = c._roomList.find((x) => x.floorId === 'ground' && !x.room.outdoor);
    const p = r.room.polygon, cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length;
    const w = v.controls.target.clone().set(cx, v.floorElevation('ground'), -cy).project(v.camera), b = v.renderer.domElement.getBoundingClientRect();
    const x = b.left + (w.x + 1) / 2 * b.width, y = b.top + (1 - w.y) / 2 * b.height;
    const hit = v.pivotPoint(x, y, v.floorElevation('ground'));
    return { x, y, hit, cam: v.getCamera() }; })()`);
  await page.evaluate(({ x, y }) => { const e = document.querySelector('floorplan3d-card')._edit; e.canvasDown({ button: 0, clientX: x, clientY: y }); e.canvasUp({ clientX: x, clientY: y }); }, aim);
  await settle(page, card);
  const near = (a, b, tol = 0.05) => !!a && !!b && a.every((x, i) => Math.abs(x - b[i]) <= tol);
  const piv = await page.evaluate(`(() => { const c = ${card}, v = c._view; return { target: v.controls.target.toArray(), pos: v.persp.position.toArray(),
    saved: ((c._layout.views || {}).ground || {}).camera || null, cross: v.pivotMarker && v.pivotMarker.position.toArray(), pivoting: c._edit.pivoting }; })()`);
  check('Set rotation centre: controls.target is the clicked point (±0.05)', !!aim.hit && near(piv.target, aim.hit), JSON.stringify({ hit: aim.hit, t: piv.target }));
  const d0 = aim.cam.position.map((x, i) => x - aim.cam.target[i]), d1 = piv.pos.map((x, i) => x - piv.target[i]);
  check('Set rotation centre: camera keeps its angle and distance', near(d0, d1, 0.05), JSON.stringify({ d0, d1 }));
  check('Set rotation centre: saved as the view camera', !!piv.saved && near(piv.saved.target, aim.hit) && !piv.pivoting, JSON.stringify(piv.saved));
  check('rotation centre cross follows the target', near(piv.cross, piv.target, 0.01), JSON.stringify(piv.cross));
  await page.evaluate(`${card}._setView('first')`);
  await settle(page, card);
  await page.evaluate(`${card}._view.setCamera({ position: [25, 25, 25], target: [0, 0, 0] }, { instant: true })`);
  await page.evaluate(`${card}._setView('ground')`);
  await settle(page, card);
  const pivBack = await page.evaluate(`(() => { const v = ${card}._view; return { target: v.controls.target.toArray(), pos: v.persp.position.toArray() }; })()`);
  check('switching views and back restores the rotation centre', near(pivBack.target, piv.saved.target, 0.01) && near(pivBack.pos, piv.saved.position, 0.01), JSON.stringify(pivBack));
  await page.evaluate(`${card}._view.setCamera({ position: [25, 25, 25], target: [0, 0, 0] }, { instant: true })`);
  await page.evaluate(`${sr}.querySelector('button.reset').click()`);
  await settle(page, card);
  check('Reset view honours the saved rotation centre', near(await page.evaluate(`${card}._view.controls.target.toArray()`), piv.saved.target, 0.01));
  // per-view zoom pivot
  await page.evaluate(`(() => { const el = ${sr}.querySelector('.panel [data-field=vw-zoom-to]'); el.value = 'cursor'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  check('per-view zoom_to cursor: saved and applied', await page.evaluate(`${card}._layout.views.ground.zoom_to === 'cursor' && ${card}._view.controls.zoomToCursor === true`));
  await page.evaluate(`${card}._setView('first')`);
  await idle(page);
  check('other view keeps the default centre pivot', await page.evaluate(`${card}._view.controls.zoomToCursor === false`));
  await page.evaluate(`${card}._setView('ground')`);
  await idle(page);
  await page.evaluate(`(() => { const el = ${sr}.querySelector('.panel [data-field=vw-zoom-to]'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await idle(page);
  check('zoom_to back to the card default', await page.evaluate(`!${card}._layout.views.ground.zoom_to && ${card}._view.controls.zoomToCursor === false`));
  // top view: its own camera
  await page.evaluate(`${card}._setMode('top')`);
  await idle(page);
  check('top mode: zoom pivot kept on the rebuilt controls', await page.evaluate(`${card}._view.controls.zoomToCursor === false`));
  await page.evaluate(`${card}._view.setTopCamera({ center: [3, 2], zoom: 1.6 }, { instant: true })`);
  await clickText('Save current view as start');
  await idle(page);
  const top = await page.evaluate(`(() => { const v = ${card}._layout.views.ground; return { top: v.camera_top, cam: v.camera }; })()`);
  check('top mode: Save current view stores camera_top (3D camera untouched)', JSON.stringify(top.top) === '{"center":[3,2],"zoom":1.6}' && near(top.cam.target, piv.saved.target, 0.01), JSON.stringify(top));
  await page.evaluate(`${card}._setView('first')`);
  await sleep(600);
  check('top mode: a view without camera_top keeps the top camera', JSON.stringify(await page.evaluate(`${card}._view.getTopCamera()`)) === '{"center":[3,2],"zoom":1.6}', JSON.stringify(await page.evaluate(`${card}._view.getTopCamera()`)));
  await page.evaluate(`${card}._view.setTopCamera({ center: [-4, 7], zoom: 0.8 }, { instant: true })`);
  await page.evaluate(`${card}._setView('ground')`);
  await settle(page, card);
  check('top mode: camera_top restored after switching views', JSON.stringify(await page.evaluate(`${card}._view.getTopCamera()`)) === '{"center":[3,2],"zoom":1.6}', JSON.stringify(await page.evaluate(`${card}._view.getTopCamera()`)));
  await page.evaluate(`${card}._view.setTopCamera({ center: [-4, 7], zoom: 0.8 }, { instant: true })`);
  await page.evaluate(`${sr}.querySelector('button.reset').click()`);
  await settle(page, card);
  check('top mode: Reset view returns to camera_top', JSON.stringify(await page.evaluate(`${card}._view.getTopCamera()`)) === '{"center":[3,2],"zoom":1.6}');
  await page.screenshot({ path: path.join(root, 'screenshots', 'model-camera-top.png') });
  await page.evaluate(`${card}._setMode('3d')`);
  await idle(page);
  const cam3 = await page.evaluate(`(() => { const v = ${card}._view; return { target: v.controls.target.toArray(), pos: v.persp.position.toArray() }; })()`);
  check('Top -> 3D restores the view camera (±0.1 m)', near(cam3.target, piv.saved.target, 0.1) && near(cam3.pos, piv.saved.position, 0.1), JSON.stringify({ cam3, saved: piv.saved }));
  // no saved camera: back to the camera before Top
  await page.evaluate(`${card}._setView('first', { instant: true })`);
  await page.evaluate(`${card}._view.setCamera({ position: [21, 19, 23], target: [4, 0, -3] }, { instant: true })`);
  await page.evaluate(`${card}._setMode('top')`);
  await idle(page);
  await page.evaluate(`${card}._setMode('3d')`);
  await idle(page);
  check('Top -> 3D without a saved camera returns to the previous 3D camera', near(await page.evaluate(`${card}._view.persp.position.toArray()`), [21, 19, 23], 0.1));
  await page.evaluate(`${card}._setView('ground', { instant: true })`);
  await idle(page);
  // section on: Save / Set rotation centre leave the section first
  await page.evaluate(`${card}.setSection(true)`);
  await sleep(500);
  check('section on before save', await page.evaluate(`${card}._section === true`));
  await clickText('Save current view as start');
  await idle(page);
  const secCam = await page.evaluate(`(() => { const c = ${card}; return { on: c._section, planes: c._view.renderer.clippingPlanes.length, cam: c._layout.views.ground.camera }; })()`);
  check('Save current view with the section on: section off first, the view camera saved', !secCam.on && secCam.planes === 0
    && near(secCam.cam.target, piv.saved.target, 0.1) && near(secCam.cam.position, piv.saved.position, 0.1), JSON.stringify(secCam));
  await page.evaluate(`${card}.setSection(true)`);
  await sleep(500);
  await clickText('Set rotation centre');
  check('Set rotation centre with the section on: section off first', await page.evaluate(`!${card}._section && ${card}._view.renderer.clippingPlanes.length === 0 && ${card}._edit.pivoting === true`));
  await page.keyboard.press('Escape');
  await idle(page);
  await clickText('Reset this view');
  await idle(page);
  check('Reset this view drops camera and camera_top', await page.evaluate(`(() => { const v = ${card}._layout.views.ground || {}; return !v.camera && !v.camera_top; })()`));
  await clickText('Rooms');
  check('rotation centre cross hidden outside the Views tab', await page.evaluate(`!${card}._view.pivotMarker`));

  // fully untagged copy (no extras, no legacy names): one generated "All" view, an overview
  const untagged = path.join(root, 'screenshots', 'untagged-views.glb');
  fs.writeFileSync(untagged, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) { delete n.extras; if (n.name === 'roof') n.name = 'top'; }
    return json;
  }));
  await upload(untagged);
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 0`, { timeout: 30000 });
  await idle(page);
  fs.unlinkSync(untagged);
  check('untagged copy: a single generated "All" view (no chips)', JSON.stringify(await page.evaluate(`${card}._views.map((v) => v.id + ':' + v.source)`)) === '["all:generated"]'
    && (await chipIds()).length === 0, JSON.stringify(await page.evaluate(`${card}._views.map((v) => v.id)`)));
  await clickText('Views');
  check('untagged copy: "Cut at storey height" present, off by default in "All"', await page.evaluate(`${sr}.querySelector('.panel [data-field=vw-cut]')?.checked === false`));
  await clickText('Rooms');
  check('untagged copy: no elevation inputs in the Rooms tab', await page.evaluate(`!${sr}.querySelector('.panel [data-field=floor-elevation]')`));
  const ov = await page.evaluate(`(() => { const c = ${card}; return { overview: c._viewState.overview, shown: [...c._view.markerObjects.values()].filter((m) => m.obj.visible).length, all: c._view.markerObjects.size }; })()`);
  check('untagged copy is an overview: every device shown', ov.overview === true && ov.shown === ov.all, JSON.stringify(ov));
  allErrors.push(...s.errors);
});

// 2g. magnetic drag (demo/house.glb uploaded): a marker sticks to a wall, attaches to a model object
// (the living-room ceiling lamp), follows it when the model is realigned, Alt-drag never attaches, Detach keeps the spot
sections.add('magnetic', { group: 'views', query: { view: '3d', height: '560px' }, viewport: { width: 1500, height: 680 } }, async (s) => {
  const { page } = s;
  const sr = `${card}.shadowRoot`;
  const clickText = async (t) => {
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === t);
      if (b) b.click();
      return !!b;
    }, t);
    await idle(page);
    return ok;
  };
  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await idle(page);
  await clickText('Model');
  const input = await page.evaluateHandle(`${sr}.querySelector('.panel [data-field=model-file]')`);
  await input.uploadFile(path.join(root, 'demo', 'house.glb'));
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 4`, { timeout: 30000 });
  await idle(page);
  await page.evaluate(`${sr}.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  await clickText('Devices');
  // closer to the living room: the ceiling lamp is a small disc, too small to hit from the default distance
  // (the demo house's render recipe has fov 38: 0.92 x the distance frames it as fov 35 did from [8, 8.5, 8])
  await page.evaluate(`${card}._view.setCamera({ position: [7.6, 7.9, 7.15], target: [3, 1, -2.5] }, { instant: true })`);
  await settle(page, card);
  // the demo model's living-room ceiling lamp (a real object, bound to light.demo_living)
  const injected = await page.evaluate(`(() => { const o = ${card}._objects.objectAt('lamp_living'); return o ? o.obj.node.name : null; })()`);
  check('magnetic: the demo model has the living-room lamp object', !!injected, String(injected));
  await idle(page);
  // the lamp is small on screen: search around its projected anchor for a pixel whose model hit is the lamp
  // (and that no marker covers)
  const findLamp = () => page.evaluate(`(() => { const c = ${card}, v = c._view, a = c._objects.anchorOf('lamp_living');
    const p = a && v.projectWorld(a);
    if (!p) return null;
    for (let rad = 0; rad <= 30; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
      const x = p[0] + dx, y = p[1] + dy, h = v.surfaceAt(x, y);
      if (h && h.owner && h.owner.id === 'lamp_living' && !c.shadowRoot.elementFromPoint(x, y)?.closest?.('.fp-marker')) return { x, y };
    }
    return null; })()`);
  // screen points: a wall face (vertical normal, 0.7–2.3 m up) and the lamp
  const targets = await page.evaluate(`(() => { const c = ${card}, v = c._view, r = v.renderer.domElement.getBoundingClientRect();
    let wall = null;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let y = r.top + 20; y < r.bottom - 20; y += 12) for (let x = r.left + 20; x < r.right - 20; x += 12) {
      const h = v.surfaceAt(x, y);
      if (!h || h.owner && h.owner.kind === 'object') continue;
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(h.normal.y) < 0.1 && h.point.y > 0.7 && h.point.y < 2.3 && (!wall || d < wall.d))
        wall = { x, y, d, point: [h.point.x, -h.point.z], n: [h.normal.x, -h.normal.z] };
    }
    return { wall }; })()`);
  targets.lamp = await findLamp();
  check('magnetic: found a wall face and the lamp on screen', !!targets.wall && !!targets.lamp, JSON.stringify(targets));
  // draggable markers: shown, not the mower, the pointer at their centre reaches them
  const markers = await page.evaluate(`(() => { const c = ${card}, out = [];
    for (const [id, el] of c._markerEls) {
      const o = c._view.markerObjects.get(id);
      if (!o || !o.obj.visible || id === c._mowerMarkerId) continue;
      const b = el.querySelector('.fp-dot').getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = c.shadowRoot.elementFromPoint(x, y);
      if (hit && el.contains(hit)) out.push({ id, x, y });
    }
    return out; })()`);
  check('magnetic: three draggable markers', markers.length >= 3, String(markers.length));
  const drag = async (m, to, alt = false) => {
    await page.mouse.move(m.x, m.y);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move((m.x + to.x) / 2, (m.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await idle(page);
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
    await sleep(250);
  };
  const pinOf = (id) => page.evaluate(`JSON.stringify((${card}._layout.pins || {})[${JSON.stringify(id)}] || null)`).then(JSON.parse);
  if (targets.wall && targets.lamp && markers.length >= 3) {
    const [a, b, c3] = markers;
    // 1) wall
    await drag(a, targets.wall);
    let pin = await pinOf(a.id);
    const w = targets.wall;
    const dist = pin ? Math.hypot(pin.x - w.point[0], pin.y - w.point[1]) : 99;
    check('magnetic: marker dropped on a wall sticks to it (z 0.5–2.6, x/y on the wall ±0.1, on_model, not attached)',
      !!pin && pin.z > 0.5 && pin.z < 2.6 && dist <= 0.1 && pin.on_model === true && !pin.attach, JSON.stringify({ pin, wall: w, dist }));
    check('magnetic: the wall marker sits off the wall towards the viewer', !!pin && ((pin.x - w.point[0]) * w.n[0] + (pin.y - w.point[1]) * w.n[1]) > 0.02, JSON.stringify(pin));
    check('magnetic: highlight cleared after the drop', await page.evaluate(`!${card}._view.pickHelper`));
    // empty sky: the marker keeps its last snapped spot (no fling to a far plane hit)
    const sky = await page.evaluate(`(() => { const c = ${card}, v = c._view, r = v.renderer.domElement.getBoundingClientRect();
      for (let y = r.top + 15; y < r.bottom - 15; y += 15) for (let x = r.left + 15; x < r.right - 15; x += 15)
        if (!v.surfaceAt(x, y) && c.shadowRoot.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y };
      return null; })()`);
    if (sky) {
      const aNow = await page.evaluate(`(() => { const c = ${card}, el = c._markerEls.get(${JSON.stringify(a.id)}).querySelector('.fp-dot').getBoundingClientRect(); return { x: el.left + el.width / 2, y: el.top + el.height / 2 }; })()`);
      await page.mouse.move(aNow.x, aNow.y);
      await page.mouse.down();
      await page.mouse.move(sky.x, sky.y, { steps: 8 });
      await idle(page);
      await page.mouse.up();
      await sleep(250);
      const ps = await pinOf(a.id);
      // the path crosses the model first: the marker stays at the last surface it stuck to, inside the model
      const box = await page.evaluate(`${card}._view.modelBox()`);
      const inBox = !!ps && ps.x >= box.min[0] - 0.1 && ps.x <= box.max[0] + 0.1 && -ps.y >= box.min[2] - 0.1 && -ps.y <= box.max[2] + 0.1
        && ps.z + 0 >= box.min[1] - 0.1 && ps.z <= box.max[1] + 0.1;
      check('magnetic: dragging out over empty sky keeps the last snapped spot (inside the model)', inBox, JSON.stringify({ after: ps, box, sky }));
    } else check('magnetic: found empty sky on screen', false);
    // 2) lamp
    await drag(b, targets.lamp);
    pin = await pinOf(b.id);
    check('magnetic: drop on the lamp attaches (attach + offset, on_model)', !!pin && pin.attach === 'lamp_living' && Array.isArray(pin.offset) && pin.on_model === true, JSON.stringify(pin));
    const where = (id) => page.evaluate(`(() => { const c = ${card}; const p = c._positions.get(${JSON.stringify(id)}); const o = c._view.markerObjects.get(${JSON.stringify(id)});
      const a = c._objects.anchorOf('lamp_living');
      return { pos: p, world: o && o.obj.position.toArray(), anchor: a && a.toArray() }; })()`);
    const w0 = await where(b.id);
    const off0 = w0.world.map((v, i) => v - w0.anchor[i]);
    check('magnetic: attached marker = anchor + stored offset', pin && off0.every((v, i) => Math.abs(v - pin.offset[i]) < 0.002), JSON.stringify({ off0, offset: pin && pin.offset }));
    // 3) realign the model: the attached marker follows the lamp, its pin is not realigned
    await page.evaluate(`${card}._edit.setModelProps({ position: [0.5, 0, 0] }, false)`);
    await idle(page);
    const w1 = await where(b.id);
    const pin1 = await pinOf(b.id);
    const off1 = w1.world.map((v, i) => v - w1.anchor[i]);
    check('magnetic: realigned model -> the attached marker follows the lamp (+0.5 m east)',
      Math.abs(w1.anchor[0] - w0.anchor[0] - 0.5) < 0.01 && Math.abs(w1.world[0] - w0.world[0] - 0.5) < 0.01 && off1.every((v, i) => Math.abs(v - off0[i]) < 0.002),
      JSON.stringify({ w0, w1 }));
    check('magnetic: realign keeps attach + offset, moves only the fallback position (+0.5 m)',
      !!pin1 && pin1.attach === pin.attach && JSON.stringify(pin1.offset) === JSON.stringify(pin.offset) && Math.abs(pin1.x - pin.x - 0.5) < 0.002 && pin1.y === pin.y,
      JSON.stringify(pin1));
    // the object vanishes: the marker falls back to its stored position, then comes back with it
    const gone = await page.evaluate(`(() => { const c = ${card}, id = ${JSON.stringify(b.id)}, l = c._objects, part = l.parts.get('lamp_living');
      l.parts.delete('lamp_living'); c._refreshAttached();
      const p = c._positions.get(id), pin = c._layout.pins[id];
      const out = { fell: !p.attached && Math.abs(p.x - pin.x) < 1e-6 && Math.abs(p.y - pin.y) < 1e-6 && Math.abs(p.z - pin.z) < 1e-6 };
      l.parts.set('lamp_living', part); c._refreshAttached();
      out.back = c._positions.get(id).attached === 'lamp_living';
      return out; })()`);
    check('magnetic: object gone -> stored fallback position, back -> follows it again', gone.fell && gone.back, JSON.stringify(gone));
    // the lamp moved: find it on screen again
    const lamp2 = await findLamp();
    // 4) Alt-drag onto the lamp: free drag, no attach
    if (lamp2) {
      const z0 = (await page.evaluate(`${card}._positions.get(${JSON.stringify(c3.id)}).z`));
      // the realign moved the room markers too: the marker's screen point again
      const c3Now = await page.evaluate(`(() => { const el = ${card}._markerEls.get(${JSON.stringify(c3.id)}).querySelector('.fp-dot').getBoundingClientRect(); return { id: ${JSON.stringify(c3.id)}, x: el.left + el.width / 2, y: el.top + el.height / 2 }; })()`);
      await drag(c3Now, lamp2, true);
      const pc = await pinOf(c3.id);
      check('magnetic: Alt-drag onto the lamp does not attach and keeps the height', !!pc && !pc.attach && Math.abs(pc.z - z0) < 0.001, JSON.stringify({ pc, z0 }));
    } else check('magnetic: lamp found again after the realign', false);
    // 5) Detach: select the attached marker, Detach keeps its spot as a normal pin on the model
    const before = (await where(b.id)).pos;
    await page.evaluate(`${card}._edit.selectMarker(${JSON.stringify(b.id)})`);
    await idle(page);
    check('magnetic: selected attached marker shows "Attached to Living ceiling lamp" and Detach',
      await page.evaluate(`${sr}.querySelector('.panel').textContent.includes('Attached to Living ceiling lamp') && !!${sr}.querySelector('.panel [data-act=detach]')`));
    await page.evaluate(`${sr}.querySelector('.panel [data-act=detach]').click()`);
    await sleep(250);
    const pd = await pinOf(b.id);
    check('magnetic: Detach -> normal pin (on_model) at the same spot',
      !!pd && !pd.attach && !pd.offset && pd.on_model === true && Math.abs(pd.x - before.x) < 0.002 && Math.abs(pd.y - before.y) < 0.002 && Math.abs(pd.z - before.z) < 0.002,
      JSON.stringify({ pd, before }));
    await page.screenshot({ path: path.join(root, 'screenshots', 'magnetic-drag.png') });
  }
  allErrors.push(...s.errors);
});

// 2h. devices on model surfaces: auto-placed wall sensor on the wall, pins untouched, drag preview
// ring over a wall, "Stick all to surfaces" moves a floating pin (demo/house.glb from the YAML)
sections.add('surfaces', { group: 'mower', query: { model: '1', view: '3d', height: '560px' }, viewport: { width: 1500, height: 680 } }, async (s) => {
  const { page } = s;
  const sr = `${card}.shadowRoot`;
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
  await page.waitForFunction(`(() => { const c = ${card}; return !!c._surf && !c._surfJob && c._positions.get('device:living_climate').base; })()`, { timeout: 5000 }).catch(() => {});
  // the wall sensor: moved off its computed point, 5 cm (< 0.1 m) off a wall, its 3D marker there too
  const wallInfo = await page.evaluate(`(() => { const c = ${card}, v = c._view, p = c._positions.get('device:living_climate');
    const e = v.floorElevation(p.floorId), w = [p.x, e + p.z, -p.y];
    const dirs = []; for (let i = 0; i < 8; i++) dirs.push([Math.cos(i * Math.PI / 4), 0, Math.sin(i * Math.PI / 4)]);
    const hits = v.surfaceRays(w, dirs, 2.5).filter((h) => Math.abs(h.normal[1]) < 0.3);
    const o = v.markerObjects.get('device:living_climate');
    return { p, d: Math.min(...hits.map((h) => h.distance)), obj: o && o.obj.position.toArray(), w }; })()`);
  check('surface: auto-placed wall sensor sits within 0.1 m of the model wall (moved from its computed point)',
    !!wallInfo.p.base && wallInfo.d <= 0.1 && Math.hypot(wallInfo.p.x - wallInfo.p.base.x, wallInfo.p.y - wallInfo.p.base.y) > 0.01
      && wallInfo.obj && wallInfo.obj.every((v, i) => Math.abs(v - wallInfo.w[i]) < 1e-6), JSON.stringify(wallInfo));
  const ceil = await page.evaluate(`(() => { const p = ${card}._positions.get('device:living_ceiling'); return { p, ok: !!p.base && p.z < p.base.z + 0.001 }; })()`);
  check('surface: ceiling light 5 cm below the model ceiling', ceil.ok, JSON.stringify(ceil.p));
  const lamp = await page.evaluate(`JSON.stringify(${card}._positions.get('device:floor_lamp'))`).then(JSON.parse);
  check('surface: a pinned marker is never auto moved', lamp.auto === false && !lamp.base && lamp.x === 0.6 && lamp.y === 4.3 && lamp.z === 1.5, JSON.stringify(lamp));
  // no work on a plain state update: cache hit, same positions
  const again = await page.evaluate(`(() => { const c = ${card}, before = c._positions.get('device:living_climate'), n = c._surf.map.size;
    c._buildMarkers(); const after = c._positions.get('device:living_climate');
    return { same: before.x === after.x && before.y === after.y && before.z === after.z, n, n2: c._surf.map.size, job: !!c._surfJob }; })()`);
  check('surface: a marker rebuild reuses the cached spots (no new rays, no job)', again.same && again.n === again.n2 && !again.job, JSON.stringify(again));

  // drag preview: edit mode, Devices tab, drag a marker over a wall
  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await idle(page);
  await page.evaluate(`${sr}.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  const clickText = async (t) => {
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === t);
      if (b) b.click();
      return !!b;
    }, t);
    await idle(page);
    return ok;
  };
  await clickText('Devices');
  await page.evaluate(`${card}._view.setCamera({ position: [8, 8.5, 8], target: [3, 1, -2.5] }, { instant: true })`);
  await settle(page, card);
  const wall = await page.evaluate(`(() => { const c = ${card}, v = c._view, r = v.renderer.domElement.getBoundingClientRect();
    let best = null; const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let y = r.top + 20; y < r.bottom - 20; y += 12) for (let x = r.left + 20; x < r.right - 20; x += 12) {
      const h = v.surfaceAt(x, y);
      if (!h || h.owner && h.owner.kind === 'object' || c.shadowRoot.elementFromPoint(x, y)?.closest?.('.fp-marker')) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(h.normal.y) < 0.1 && h.point.y > 0.7 && h.point.y < 2.3 && (!best || d < best.d)) best = { x, y, d };
    }
    return best; })()`);
  const mk = await page.evaluate(`(() => { const c = ${card};
    for (const [id, el] of c._markerEls) {
      const o = c._view.markerObjects.get(id);
      if (!o || !o.obj.visible || id === c._mowerMarkerId) continue;
      const b = el.querySelector('.fp-dot').getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = c.shadowRoot.elementFromPoint(x, y);
      if (hit && el.contains(hit)) return { id, x, y };
    }
    return null; })()`);
  check('surface: found a wall and a draggable marker on screen', !!wall && !!mk, JSON.stringify({ wall, mk }));
  if (wall && mk) {
    await page.mouse.move(mk.x, mk.y);
    await page.mouse.down();
    await page.mouse.move((mk.x + wall.x) / 2, (mk.y + wall.y) / 2, { steps: 4 });
    await page.mouse.move(wall.x, wall.y, { steps: 6 });
    await idle(page);
    const pv = await page.evaluate(`(() => { const v = ${card}._view, g = v._preview;
      return { shown: !!g && g.visible && v._previewRing.visible, face: !!g && v._previewFace.visible, helper: !!g && g.userData.helper && v._previewRing.userData.helper,
        ringN: g && new v._previewRing.position.constructor(0, 0, 1).applyQuaternion(v._previewRing.quaternion).toArray() }; })()`);
    check('surface: drag over a wall shows the preview ring (helper) and the tinted face, ring facing out of the wall',
      pv.shown && pv.face && pv.helper && Math.abs(pv.ringN[1]) < 0.3, JSON.stringify(pv));
    await page.screenshot({ path: path.join(root, 'screenshots', 'surface-preview.png') });
    await page.mouse.up();
    await sleep(250);
    check('surface: preview hidden after the drop', await page.evaluate(`!${card}._view._preview.visible`));
  }

  // Stick all: a pin floating in the middle of the living room moves onto a surface; on-surface pins stay
  await page.evaluate(`${card}._edit.selectMarker(null)`);
  await page.evaluate(`(() => { const c = ${card}; const pins = { ...(c._layout.pins || {}) };
    pins['device:living_climate'] = { x: 2.5, y: 3.6, z: 1.5, floor_id: 'ground' };
    c._edit.commit({ ...c._layout, pins }); })()`);
  await idle(page);
  const pinsBefore = await page.evaluate(`JSON.stringify(${card}._layout.pins)`).then(JSON.parse);
  await clickText('Stick all to surfaces');
  const txt = await page.evaluate(`${sr}.querySelector('.panel .stick')?.textContent || ''`);
  const nMoves = await page.evaluate(`${card}._edit.stick && ${card}._edit.stick.moves.length`);
  check('surface: Stick all previews the count with Apply / Cancel', /\d+ markers? will move/.test(txt) && nMoves >= 1
    && await page.evaluate(`!!${sr}.querySelector('.panel [data-act=stick-apply]') && !!${sr}.querySelector('.panel [data-act=stick-cancel]')`), txt.trim());
  check('surface: nothing saved before Apply', await page.evaluate(`JSON.stringify(${card}._layout.pins)`) === JSON.stringify(pinsBefore));
  await clickText('Apply');
  await idle(page);
  const after = await page.evaluate(`(() => { const c = ${card}, v = c._view, pin = c._layout.pins['device:living_climate'];
    const w = [pin.x, v.floorElevation('ground') + pin.z, -pin.y];
    const dirs = [[0, 1, 0], [0, -1, 0]]; for (let i = 0; i < 8; i++) dirs.push([Math.cos(i * Math.PI / 4), 0, Math.sin(i * Math.PI / 4)]);
    return { pin, d: Math.min(...v.surfaceRays(w, dirs, 4).map((h) => h.distance)), panel: !!c.shadowRoot.querySelector('.panel .stick') }; })()`);
  check('surface: Apply moved the floating pin onto a surface (≤ 0.1 m, on_model) and closed the preview',
    after.d <= 0.1 && after.pin.on_model === true && (after.pin.x !== 2.5 || after.pin.y !== 3.6 || after.pin.z !== 1.5) && !after.panel, JSON.stringify(after));
  await clickText('Stick all to surfaces');
  const txt2 = await page.evaluate(`${sr}.querySelector('.panel .stick')?.textContent || ''`);
  check('surface: Stick all again -> nothing left to move', /already sits on a surface/.test(txt2), txt2.trim());
  allErrors.push(...s.errors);
});

// 2i. mower on the lawn: map, marker and model at the model's ground (any HA floor elevation),
// shown with the outdoors, align by points (Cancel restores, Done keeps), edit-only
sections.add('mower-lawn', { group: 'mower', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 700 } }, async (s) => {
  const { page } = s;
  // wait for a state; a timeout is reported (and fails the check that asserts it)
  const until = (expr, label, timeout = 8000) => page.waitForFunction(expr, { timeout }).then(() => true, () => { console.log(`     (timed out waiting for ${label})`); return false; });
  const ev = (expr) => page.evaluate(expr);
  const panelBtn = (t) => ev(`(() => { const b = [...${card}.shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === ${JSON.stringify(t)}); if (b) b.click(); return !!b; })()`);
  const commitMower = (patch, ov = null) => ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, mower: { ...l.mower, ...${JSON.stringify(patch)}${ov ? `, overlay: { ...l.mower.overlay, ...${JSON.stringify(ov)} }` : ''} } }); })()`);
  const ovSig = `${card}._view.mapPlane && ${card}._view.mapPlane.userData.sig`;
  check('map overlay loaded', await until(`!!${card}._view.model && !!${card}._view.mapPlane && !!${card}._view.mapPlane.material.map`, 'the map overlay', 15000));
  const planeY = () => ev(`${card}._view.mapPlane.position.y`);
  const lawn = await ev(`${card}._view.groundAt(16.5, 1.5)`);
  let y = await planeY();
  check('map overlay lies on the demo lawn', lawn !== null && Math.abs(lawn) < 0.02 && y - lawn >= 0 && y - lawn <= 0.05, `lawn ${lawn}, plane ${y}`);

  // the user's case: the garden's HA floor at 7 m
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, floors: [...(l.floors || []), { id: 'garden_f', name: 'Garden', elevation: 7, height: 2.7 }],
    mower: { ...l.mower, floor_id: 'garden_f' } }); })()`);
  check('mower floor at 7 m', await until(`${card}._mowerFloor() === 'garden_f' && ${card}._view.mapPlane.userData.floorId === 'garden_f'`, 'the 7 m floor'));
  y = await planeY();
  const elev = await ev(`${card}._view.floorElevation('garden_f')`);
  check('map overlay stays on the lawn with the floor at 7 m', elev === 7 && y - lawn >= 0 && y - lawn <= 0.05, `elevation ${elev}, plane ${y}`);
  check('map shown in the ground view (exterior visible), whatever the HA floor', await ev(`${card}._view.mapPlane.visible`));
  // the demo model's mower object stands on the lawn
  const mowerY = `(() => { const o = ${card}._objects.objectAt('mower'); return o && o.obj.node ? o.obj.node.getWorldPosition(o.obj.node.position.clone()).y : null; })()`;
  check('mower model on the lawn with the floor at 7 m', await until(`(() => { const y = ${mowerY}; return y !== null && y < 1; })()`, 'the mower model on the lawn'), String(await ev(mowerY)));
  // without the model's mower object: the live marker, on the lawn too
  await ev(`(() => { const c = ${card}; c._commit({ ...c._layout, objects: { ...(c._layout.objects || {}), mower: { hidden: true } } }); })()`);
  const markerY = `(() => { const c = ${card}, o = c._mowerMarkerId && c._view.markerObjects.get(c._mowerMarkerId); return o ? o.obj.position.y : null; })()`;
  check('mower marker on the lawn with the floor at 7 m', await until(`(() => { const y = ${markerY}; return y !== null && y < 1.5; })()`, 'the mower marker'), String(await ev(markerY)));
  check('mower marker shown with the exterior', await ev(`(() => { const c = ${card}; const o = c._view.cssObjects.find((x) => x.kind === 'marker' && x.id === c._mowerMarkerId); return !!o && o.obj.visible; })()`));
  // a view without the exterior hides map and marker
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, views: { ...(l.views || {}), indoor: { added: true, label: 'Indoor', rules: [{ hide: 'all' }, { show: 'level:level0' }] } } }); })()`);
  await until(`!!${card}._views && ${card}._views.some((v) => v.id === 'indoor')`, 'the indoor view');
  await ev(`${card}._setView('indoor', { instant: true })`);
  check('indoor view hides map and marker', await until(`(() => { const c = ${card}, v = c._view; const m = v.cssObjects.find((x) => x.kind === 'marker' && x.id === c._mowerMarkerId);
    return !v.mapPlane.visible && (!m || !m.obj.visible); })()`, 'the indoor view to hide the mower'));
  await ev(`${card}._setView('ground', { instant: true })`);
  check('ground view shows them again', await until(`${card}._view.mapPlane.visible`, 'the map in the ground view'));
  await commitMower({}, { height_offset: 0.3 });
  check('height offset raises the map', await until(`Math.abs(${card}._view.mapPlane.position.y - ${y} - 0.3) < 1e-6`, 'the offset'), String(await planeY()));

  // align by points: start from a wrong overlay, click 2 image spots and where they really are on the lawn
  const truth = { x: 16.5, y: 1.5, rotation: 0, width: 9 };
  const wrong = { x: 15.2, y: 2.6, rotation: 17, width: 11.5, height_offset: 0 };
  await commitMower({}, wrong);
  await until(`${card}._layout.mower.overlay.x === 15.2 && (${ovSig} || '').includes('|15.2|')`, 'the wrong overlay');
  await ev(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await until(`${card}._editing && !!${card}.shadowRoot.querySelector('.panel button')`, 'edit mode');
  await ev(`[...${card}.shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Mower').click()`);
  await until(`${card}._edit.tab === 'mower'`, 'the Mower tab');
  await ev(`${card}._view.setCamera({ position: [16.5, 16, 4.5], target: [16.5, 0, -1.5] }, { instant: true })`);
  await settle(page, card);
  const W = 450, H = 850;
  const alignTwo = async () => {
    for (const [px, py] of [[75, 125], [375, 725]]) {
      const n = await ev(`${card}._edit.aligning.pairs.length`);
      // the image point in the 2D picker on the original picture
      await until(`!!${card}._edit.picker`, 'the align picker');
      await idle(page); // the picker has its size (fit) before the click
      const a = await ev(`${card}._edit.picker.clientOf(${px}, ${py})`);
      await page.mouse.click(a[0], a[1]);
      await until(`!!${card}._edit.aligning && !!${card}._edit.aligning.pending`, 'the image point');
      const real = pixelToPlan(px, py, W, H, truth);
      const b = await ev(`(() => { const v = ${card}._view; return v.projectWorld(v.camera.position.clone().set(${real.x}, 0, ${-real.y})); })()`);
      await page.mouse.click(b[0], b[1]);
      await until(`!!${card}._edit.aligning && ${card}._edit.aligning.pairs.length === ${n + 1}`, 'the model point');
    }
    check('align: image points picked in the picker', await ev(`${card}._edit.aligning.pairs.every((p, i) => Math.abs(p.px - [75, 375][i]) <= 1 && Math.abs(p.py - [125, 725][i]) <= 1)`));
  };
  check('Align by points armed', (await panelBtn('Align by points')) && !!(await ev(`${card}._edit.aligning`)));
  await alignTwo();
  const fit0 = await ev(`${card}._layout.mower.overlay`);
  check('aligning moves the overlay', Math.abs(fit0.x - truth.x) <= 0.05, JSON.stringify(fit0));
  check('Cancel restores the starting overlay', (await panelBtn('Cancel')) && await until(`(() => { const o = ${card}._layout.mower.overlay; return !${card}._edit.aligning && o.x === 15.2 && o.y === 2.6 && o.rotation === 17 && o.width === 11.5; })()`, 'the restored overlay'),
    JSON.stringify(await ev(`${card}._layout.mower.overlay`)));
  check('Align by points again', (await panelBtn('Align by points')) && !!(await ev(`${card}._edit.aligning`)));
  await alignTwo();
  const fit = await ev(`${card}._layout.mower.overlay`);
  check('align by 2 points reproduces the overlay', Math.abs(fit.x - truth.x) <= 0.05 && Math.abs(fit.y - truth.y) <= 0.05 && Math.abs(fit.rotation - truth.rotation) <= 0.5
    && Math.abs(fit.width - truth.width) <= 0.1, JSON.stringify(fit));
  check('Done keeps the fit', (await panelBtn('Done')) && await until(`!${card}._edit.aligning`, 'Done') && (await ev(`${card}._layout.mower.overlay.x`)) === fit.x);

  // edit-only: hidden in view mode (still loaded for detection), shown again in edit mode
  await ev(`(() => { const el = ${card}.shadowRoot.querySelector('[data-field=ov-edit-only]'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('edit-only stored, map shown while editing', await until(`${card}._layout.mower.overlay.edit_only === true && ${card}._view.mapPlane.visible`, 'edit-only while editing'));
  await ev(`${card}.shadowRoot.querySelector('button.edit').click()`);
  check('edit-only: map hidden in view mode, image still loaded', await until(`(() => { const p = ${card}._view.mapPlane; return !${card}._editing && !!p && !p.visible && !!p.material.map && !!p.userData.loaded; })()`, 'the hidden map'));
  await ev(`${card}.shadowRoot.querySelector('button.edit').click()`);
  check('edit-only: map back in edit mode', await until(`${card}._editing && ${card}._view.mapPlane.visible`, 'the map in edit mode'));
  await ev(`${card}._view.setCamera({ position: [16.5, 9, 8], target: [16.5, 0, -1.5] }, { instant: true })`);
  await settle(page, card);
  await page.screenshot({ path: path.join(root, 'screenshots', 'mower-map-aligned.png') });

  // map picture processing on the live map: background transparent, mowed stripes light, no-mow shaded,
  // the icon hidden (or not), clipped to the garden zone; stripes / mowed share; a size change keeps it right
  await ev('window.__demoMowerPaused = true');
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, objects: { ...(l.objects || {}), mower: {} }, mower: { ...l.mower, source: 'image', calibration: [],
    image: { color: [255, 59, 48], tolerance: 40, min_pixels: 4 },
    overlay: { entity: 'image.sunseeker_live_map', x: 17.5, y: 1.5, rotation: 0, width: 9, opacity: 0.55, refresh: 10, height_offset: 0,
      bg_color: [47, 93, 44], mowed_color: [127, 194, 111], nomow_color: [140, 140, 140] } } }); })()`);
  const tick = async () => { await ev('window.__demoMowerPaused = false'); await sleep(700); await ev('window.__demoMowerPaused = true'); await idle(page); };
  await tick();
  const processed = (w) => until(`(() => { const c = ${card}, p = c._view.mapPlane; const t = p && p.material.map, im = p && p.userData.loaded && p.userData.loaded.image;
    return !!t && t.isCanvasTexture && !!im && (im.naturalWidth || im.width) === ${w} && t.image.width === ${w} && !!c._imageBlob && c._imageBlob.imgW === ${w} && !!c._mapStats; })()`, `the processed ${w} px map`, 15000);
  check('map processed into a canvas texture', await processed(450));
  // 3D picks read the clicked map pixel (overlay on the lawn, mower floor at 7 m): the ray hits the map plane
  await ev(`${card}._view.setCamera({ position: [17.5, 9, 6], target: [17.5, 0, -1.5] }, { instant: true })`);
  await settle(page, card);
  const pickAt = async (kind, px, py) => {
    const ov = await ev(`${card}._layout.mower.overlay`);
    const q = pixelToPlan(px, py, 450, 850, ov);
    await ev(`${card}._view.setCamera({ position: [${q.x}, 8, ${-q.y + 5}], target: [${q.x}, 0, ${-q.y}] }, { instant: true })`); // the point mid-stage, clear of the toolbar
    await settle(page, card);
    const sp = await ev(`(() => { const v = ${card}._view; return v.projectWorld(v.camera.position.clone().set(${q.x}, v.mapPlane.position.y, ${-q.y})); })()`);
    await ev(`(() => { const e = ${card}._edit; e.colorPick = ${JSON.stringify(kind)}; e._syncStageClasses(); })()`);
    await page.mouse.click(sp[0], sp[1]);
    await idle(page);
  };
  const dot = await ev(`(() => { const b = ${card}._imageBlob; return b && [b.px, b.py]; })()`);
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, mower: { ...l.mower, image: { ...l.mower.image, color: undefined, colors: [] } } }); })()`);
  await pickAt(true, dot[0], dot[1]);
  const pc = await ev(`(${card}._layout.mower.image.colors || [])[0]`);
  check('3D pick on the mower dot stores the dot colour (floor at 7 m, map on the lawn)', !!pc && pc[0] > 200 && pc[1] < 120 && pc[2] < 120, JSON.stringify({ dot, pc }));
  await pickAt('bg', 8, 8);
  const bgc = await ev(`(${card}._layout.mower.overlay.bg_colors || []).slice(-1)[0]`);
  check('3D pick on the background stores the background colour (the darker margin shade)', !!bgc && Math.abs(bgc[0] - 40) < 6 && Math.abs(bgc[1] - 79) < 6 && Math.abs(bgc[2] - 38) < 6, JSON.stringify(bgc));
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, mower: { ...l.mower, image: { ...l.mower.image, colors: [[255, 59, 48]] }, overlay: { ...l.mower.overlay, bg_colors: undefined, bg_color: [47, 93, 44] } } }); })()`);
  const mapCheck = () => ev(`(() => {
    const c = ${card}, p = c._view.mapPlane, img = p.userData.loaded.image, o = c._layout.mower.overlay;
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height, cv = p.material.map.image, w = cv.width, h = cv.height;
    const out = cv.getContext('2d').getImageData(0, 0, w, h).data;
    const tmp = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = tmp.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const raw = g.getImageData(0, 0, w, h).data;
    const near = (k, col, tol) => Math.max(Math.abs(raw[k] - col[0]), Math.abs(raw[k + 1] - col[1]), Math.abs(raw[k + 2] - col[2])) <= tol;
    const n = { bg: [0, 0], mowed: [0, 0], nomow: [0, 0], outside: [0, 0] };
    const b = c._imageBlob, bx = b.px * w / W, by = b.py * h / H, r = 16 * w / 450;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4, a = out[k + 3], px = o.x + ((x + 0.5) / w - 0.5) * o.width;
      if (Math.hypot(x + 0.5 - bx, y + 0.5 - by) < r) continue; // the icon
      if (px > 21.05) { n.outside[0]++; if (a === 0) n.outside[1]++; continue; }
      if (px > 20.95) continue;
      if (near(k, o.bg_color, 6)) { n.bg[0]++; if (a === 0) n.bg[1]++; }
      else if (near(k, o.mowed_color, 6)) { n.mowed[0]++; if (a > 0 && a < 255 && out[k] >= raw[k]) n.mowed[1]++; }
      else if (near(k, o.nomow_color, 6)) { n.nomow[0]++; if (a > 0 && a < 255 && out[k] < 80) n.nomow[1]++; }
    }
    const ki = (Math.floor(by) * w + Math.floor(bx)) * 4;
    return { w, h, W, H, n, iconRaw: [raw[ki], raw[ki + 1], raw[ki + 2]], iconOut: [out[ki], out[ki + 1], out[ki + 2], out[ki + 3]],
      info: c.mapInfo(), zone: c._mapStats && c._mapStats.zone, aspect: p.userData.aspect, sz: p.scale.z,
      // the demo stripes run at 30° on the image; the bearing is against true north (model north + alignment)
      want: (() => { const m = c._view.model, b = Math.round(90 - 30 - (m ? m.north || 0 : 0) + (m ? c._modelAlign().rotation || 0 : 0)); return ((b % 180) + 180) % 180; })() }; })()`);
  const mapOk = (m, label) => {
    const all = (k, min) => m.n[k][0] >= min && m.n[k][1] === m.n[k][0];
    check(`${label}: background pixels transparent`, all('bg', 1000), JSON.stringify(m.n.bg));
    check(`${label}: mowed stripes light and translucent`, all('mowed', 1000), JSON.stringify(m.n.mowed));
    check(`${label}: no-mow pixels shaded`, all('nomow', 100), JSON.stringify(m.n.nomow));
    check(`${label}: outside the garden zone transparent`, m.zone === 'garden' && all('outside', 100), JSON.stringify({ zone: m.zone, outside: m.n.outside }));
    check(`${label}: mower icon hidden`, m.iconRaw[0] > 200 && m.iconRaw[1] < 120 && m.iconOut[3] === 0, JSON.stringify([m.iconRaw, m.iconOut]));
    const deg = Number((/^(\d+)° \(.+\)$/.exec(m.info.stripes || '') || [])[1]);
    const off = Math.abs(deg - m.want) % 180;
    check(`${label}: stripes against true north and mowed share`, Math.min(off, 180 - off) <= 3 && /^\d+ %$/.test(m.info.mowed || ''), JSON.stringify({ ...m.info, want: m.want }));
  };
  const m1 = await mapCheck();
  mapOk(m1, 'live map');
  check('processing runs in a worker', await ev(`!!${card}._mapProc._worker && !${card}._mapProc._workerDead`));
  const blob0 = await ev(`JSON.stringify(${card}._imageBlob)`);
  await ev(`(() => { const v = ${card}._view; v.reprocessMap(); v.reprocessMap(); v.reprocessMap(); })()`);
  await idle(page);
  check('reprocessing the same picture does not step the tracker', (await ev(`JSON.stringify(${card}._imageBlob)`)) === blob0);
  await commitMower({}, { hide_icon: false });
  check('icon shown when "Hide mower icon" is off', await until(`(() => { const c = ${card}, p = c._view.mapPlane, b = c._imageBlob, cv = p.material.map.image;
    const d = cv.getContext('2d').getImageData(Math.floor(b.px * cv.width / b.imgW), Math.floor(b.py * cv.height / b.imgH), 1, 1).data; return d[0] > 200 && d[1] < 120 && d[3] === 255; })()`, 'the icon'));
  await commitMower({}, { hide_icon: true });
  await ev(`${card}._edit.render()`);
  check('Mower tab shows stripes and mowed share', /Stripes: \d+° \(.+\) · Mowed: \d+ %/.test(await ev(`${card}.shadowRoot.querySelector('.mower-live').textContent`)),
    await ev(`${card}.shadowRoot.querySelector('.mower-live').textContent`));
  check('Mower tab has the map picture controls', await ev(`(() => { const s = ${card}.shadowRoot; const t = [...s.querySelectorAll('.panel button')].map((b) => b.textContent.trim());
    return ['Pick background colour', 'Pick mowed colour', 'Pick no-mow colour'].every((x) => t.includes(x)) && !!s.querySelector('[data-field=ov-hide-icon]') && !!s.querySelector('[data-field=ov-zone]'); })()`));
  const popRows = await ev(`(() => { const c = ${card}, o = c._objects.objectAt('mower'); if (!o) return null; c._popup.open(o.obj, null);
    const t = [...c.shadowRoot.querySelectorAll('.fp-popup .fp-pop-row')].map((r) => r.textContent.trim()); c._popup.close(); return t; })()`);
  check('mower popup shows Stripes and Mowed', !!popRows && popRows.some((t) => /^Stripes\s*\d+°/.test(t)) && popRows.some((t) => /^Mowed\s*\d+ %/.test(t)), JSON.stringify(popRows));
  // the camera image changes size between refreshes: same alignment, masks follow
  await ev('window.__demoMapScale = 2');
  await tick();
  check('map processed at the new size', await processed(900));
  const m2 = await mapCheck();
  check('size change keeps the aspect and the plane size', Math.abs(m2.aspect - m1.aspect) < 1e-9 && Math.abs(m2.sz - m1.sz) < 1e-9 && m2.w === 900, JSON.stringify([m1.aspect, m2.aspect, m2.w]));
  mapOk(m2, 'resized live map');
  await ev('window.__demoMapScale = 1');
  await tick();
  await processed(450);
  const tex1 = await ev(`${card}._view.mapPlane.material.map.uuid`);
  await tick();
  await processed(450);
  check('same-size refreshes reuse the canvas texture', (await ev(`${card}._view.mapPlane.material.map.uuid`)) === tex1);
  await ev(`${card}._view.setCamera({ position: [17.5, 24, 6], target: [17.5, 0, -1.5] }, { instant: true })`);
  await settle(page, card);
  await page.screenshot({ path: path.join(root, 'screenshots', 'mower-map-processed.png') });
  await ev('window.__demoMowerPaused = false');
  allErrors.push(...s.errors);
});

// 2j. auto mode: the live map (camera) against the static map of the same device, the mower found by
// its picture (position and heading), the dock ignored; mowed share from the progress sensor; device
// rows in the popup; offline / rain chips
sections.add('mower-auto', { group: 'mower', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 700 } }, async (s) => {
  const { page } = s;
  const ev = (expr) => page.evaluate(expr);
  const until = (expr, label, timeout = 10000) => page.waitForFunction(expr, { timeout }).then(() => true, () => { console.log(`     (timed out waiting for ${label})`); return false; });
  await until(`!!${card}._view.model`, 'the model', 20000);
  await ev('window.__demoMowerPaused = true');
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, objects: { ...(l.objects || {}), mower: { entity: 'lawn_mower.robo' } }, mower: { entity: 'lawn_mower.robo', source: 'image', floor_id: l.mower.floor_id, calibration: [],
    overlay: { entity: 'camera.robo_live_map', x: 16.5, y: 1.5, rotation: 0, width: 9, opacity: 0.6, refresh: 2 } } }); })()`);
  check('auto mode: static map and mower picture detected', await until(`(() => { const a = ${card}.mowerAuto(); return !!a && a.static === 'image.robo_map' && a.picture === 'image.robo_mower_image'; })()`, 'auto mode'));
  const T = 0.7;
  await ev(`window.__setRobot(${T})`);
  const want = { x: 225 + 150 * Math.cos(T), y: 425 - 150 * Math.sin(T) };
  const near = `(() => { const b = ${card}._imageBlob; return !!b && Math.hypot(b.px - ${want.x}, b.py - ${want.y}) < 2 && !!${card}._iconHead; })()`;
  check('auto mode: the mower found by its picture (within 2 px)', await until(near, 'the mower in the live map', 15000), JSON.stringify({ blob: await ev(`${card}._imageBlob`), want, res: await ev(`${card}._imageResult`) }));
  const head = async () => ev(`(() => { const c = ${card}, p = c._objects._pose; return { pose: p && p.heading, src: c._headingSource, icon: c._iconHead }; })()`);
  const diff = (a, b) => { const d = (((a - b) % 360) + 540) % 360 - 180; return Math.abs(d); };
  let hd = await head();
  check('auto mode: heading from the picture (model within 10°)', hd.src === 'picture' && hd.pose !== null && diff(hd.pose * 180 / Math.PI, T * 180 / Math.PI + 90) <= 10, JSON.stringify(hd));
  const T2 = 2.6;
  await ev(`window.__setRobot(${T2})`);
  await until(`(() => { const b = ${card}._imageBlob; return !!b && Math.hypot(b.px - ${225 + 150 * Math.cos(T2)}, b.py - ${425 - 150 * Math.sin(T2)}) < 2; })()`, 'the moved mower', 15000);
  await ev(`window.__setRobot(${T2 + 0.002})`); // a second frame: a jump > 120° needs two
  await sleep(2500);
  hd = await head();
  check('auto mode: the model turns with the icon', diff(hd.pose * 180 / Math.PI, T2 * 180 / Math.PI + 90) <= 10, JSON.stringify(hd));
  check('auto mode: the dock is not the mower', await ev(`(() => { const d = ${card}._dockPx; return !!d && Math.hypot(d.px - 391, d.py - 786) < 6; })()`), JSON.stringify(await ev(`${card}._dockPx`)));
  const mapPx = await ev(`(() => { const t = ${card}._view.mapPlane.material.map; if (!t || !t.isCanvasTexture) return null; const g = t.image.getContext('2d');
    const a = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data); return { bg: a(5, 5), lawnS: a(100, 600), mowed: a(250, 90), nomow: a(225, 395) }; })()`);
  check('auto mode: unchanged transparent, mowed light, no-mow shaded', !!mapPx && mapPx.bg[3] === 0 && mapPx.lawnS[3] === 0 && mapPx.nomow[3] > 0 && mapPx.nomow[0] < 40
    && (mapPx.mowed[3] > 0 || (await ev(`${card}._mapStats.share`)) > 0.2), JSON.stringify(mapPx));
  check('mowed share from the progress sensor', /^39 %$/.test((await ev(`${card}.mapInfo()`)).mowed) && (await ev(`${card}.mapInfo().mowedSource`)) === 'progress sensor');
  // popup rows of the device (the model's mower object)
  const rows = await ev(`(() => { const c = ${card}, o = c._objects.objectAt('mower'); if (!o) return null; c._popup.open(o.obj, null);
    const t = [...c.shadowRoot.querySelectorAll('.fp-popup .fp-pop-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()); c._popup.close(); return t; })()`);
  const has = (re) => !!rows && rows.some((t) => re.test(t));
  check('mower popup: device rows', has(/^Mower status\s*Working/) && has(/^Battery\s*82 %/) && has(/^Rain\s*Dry/) && has(/^Wifi\s*-61 dBm/) && has(/^Zone A area\s*210 m²/) && has(/^Time left\s*≈ 61 min/) && has(/^Error code\s*0 \(OK\)/), JSON.stringify(rows));
  // offline: chip, no warning, stuck paused; rain: rainy chip
  await ev(`window.__setDemoStates({ 'binary_sensor.robo_online': 'off' })`);
  check('offline chip next to the mower', await until(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-mower-chip.offline'); return !!el && el.textContent.includes('offline'); })()`, 'the offline chip'));
  const off = await ev(`(() => { const c = ${card}, o = c._objects.objectAt('mower'); c._popup.open(o.obj, null); const t = c.shadowRoot.querySelector('.fp-popup').textContent; c._popup.close(); return t; })()`);
  check('popup: offline since', /Offline\s*since \d+ min/.test(off), off.slice(0, 200));
  check('offline: the mower model is dimmed (shared dimmed materials)', await until(`(() => { const n = ${card}._objects._dimNode; let d = 0; if (n) n.traverse((o) => { if (o.isMesh && o.userData.fpUndim) d++; }); return d > 0; })()`, 'the dimmed mower'));
  await ev(`window.__setDemoStates({ 'binary_sensor.robo_online': 'on', 'sensor.robo_rain_sensor': 'Wet' })`);
  check('rain chip (weather-rainy) while wet', await until(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-mower-chip.rain ha-icon'); return !!el && el.getAttribute('icon') === 'mdi:weather-rainy'; })()`, 'the rain chip'));
  await ev(`window.__setDemoStates({ 'sensor.robo_rain_sensor': 'Dry countdown', 'sensor.robo_rain_sensor_countdown': '12' })`);
  check('drying chip with minutes left', await until(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-mower-chip.drying'); return !!el && el.textContent.includes('12 min') && el.querySelector('ha-icon').getAttribute('icon') === 'mdi:weather-partly-rainy'; })()`, 'the drying chip'));
  await ev(`window.__setDemoStates({ 'sensor.robo_rain_sensor': 'Dry' })`);
  check('chip gone when dry and online', await until(`!${card}.shadowRoot.querySelector('.fp-mower-chip')`, 'no chip'));
  // error code auto-detected (0 = OK, 12 = error)
  await ev(`window.__setDemoStates({ 'sensor.robo_errorcode': '12' })`);
  check('error code sensor auto-detected: 12 is an error', await until(`(() => { const w = ${card}._warning; return !!w && w.kind === 'error'; })()`, 'the error'), JSON.stringify(await ev(`${card}._warningText()`)));
  check('popup text "Error code 12"', (await ev(`JSON.stringify(${card}._warningText())`)).includes('Error code 12'));
  await ev(`window.__setDemoStates({ 'sensor.robo_errorcode': '0' })`);
  check('error code 0: no warning', await until(`!${card}._warning`, 'no warning'));
  check('online again: the mower model back to its materials', await until(`(() => { let d = 0; const m = ${card}._objects._mower(); if (m) m.p.obj.node.traverse((o) => { if (o.isMesh && o.userData.fpUndim) d++; }); return d === 0; })()`, 'the undimmed mower'));
  // main-thread time per refresh: auto pass in the worker vs on the main thread (no worker)
  const timing = async () => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      await ev(`window.__setRobot(${1 + i * 0.05})`);
      await sleep(900);
      out.push(await ev(`(() => { const p = ${card}._perf && ${card}._perf.last; return p ? p.main : 0; })()`));
    }
    return out.sort((a, b) => a - b)[1];
  };
  const inWorker = await timing();
  await ev(`(() => { const p = ${card}._mapProc; p._killWorker(); })()`);
  const onMain = await timing();
  console.log(`     auto pass main-thread time per refresh: worker ${inWorker.toFixed(1)} ms, main thread ${onMain.toFixed(1)} ms`);
  check('auto mode in the worker keeps the main thread light', inWorker < onMain, `${inWorker} vs ${onMain}`);
  // a static map that does not match the live map (another aspect): flagged, no auto detection
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, mower: { ...l.mower, static_entity: 'image.robo_mower_image' } }); })()`);
  await ev(`window.__setRobot(1.4)`);
  check('mismatching static map flagged', await until(`${card}._autoMismatch === true`, 'the mismatch'));
  await ev(`(() => { const c = ${card}, l = c._layout; const m = { ...l.mower }; delete m.static_entity; c._commit({ ...l, mower: m }); })()`);
  await ev(`window.__setRobot(1.45)`);
  check('matching static map again', await until(`${card}._autoMismatch === false`, 'no mismatch'));
  // edit mode: the Mower tab shows auto mode, the checklist rows and the heading
  await ev(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await until(`${card}._editing`, 'edit mode');
  await ev(`[...${card}.shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Mower').click()`);
  await until(`${card}._edit.tab === 'mower'`, 'the Mower tab');
  const tab = await ev(`${card}.shadowRoot.querySelector('.panel').textContent.replace(/\\s+/g, ' ')`);
  check('Mower tab: auto mode, entities and heading', /Auto \(static map \+ mower picture\)/.test(tab) && tab.includes('image.robo_map') && /Heading \d+° \(mower picture\)/.test(tab), tab.slice(0, 400));
  const rowsIds = await ev(`[...${card}.shadowRoot.querySelectorAll('.mower-setup .setup-row')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim())`);
  check('checklist: static map and mower picture rows', rowsIds.some((t) => t.includes('Static map')) && rowsIds.some((t) => t.includes('Mower picture')) && !rowsIds.some((t) => t.includes('Mower colour')), JSON.stringify(rowsIds));
  await ev(`(() => { const el = ${card}.shadowRoot.querySelector('[data-field=mower-auto-off]'); el.click(); })()`);
  check('"Use colour picks instead" turns auto mode off', await until(`${card}._layout.mower.auto === false && !${card}.mowerAuto()`, 'auto off'));
  await ev(`${card}._view.setCamera({ position: [16.5, 16, 6], target: [16.5, 0, -1.5] }, { instant: true })`);
  await ev(`(() => { const el = ${card}.shadowRoot.querySelector('[data-field=mower-auto-off]'); el.click(); })()`);
  await sleep(2500);
  await page.screenshot({ path: path.join(root, 'screenshots', 'mower-auto.png') });
  await ev('window.__demoMowerPaused = false');
  allErrors.push(...s.errors);
});

// 2k. docked: the mower at the dock object (its orientation), no detection; undocking tracks from the
// dock (the icon over the dock icon is not dropped as the dock); the Mower tab status line
sections.add('mower-docked', { group: 'mower', query: { model: '1', view: '3d' }, viewport: { width: 1400, height: 700 } }, async (s) => {
  const { page } = s;
  const ev = (expr) => page.evaluate(expr);
  const until = (expr, label, timeout = 10000) => page.waitForFunction(expr, { timeout }).then(() => true, () => { console.log(`     (timed out waiting for ${label})`); return false; });
  await until(`!!${card}._view.model`, 'the model', 20000);
  await ev('window.__demoMowerPaused = true');
  // mowing first (the map's dock icon and the icon size are learned), then home to the dock
  await ev(`window.__setRobotAt(300, 600, 0.3)`);
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, objects: { ...(l.objects || {}), mower: { entity: 'lawn_mower.robo' }, dock: { entity: 'lawn_mower.robo' } },
    mower: { entity: 'lawn_mower.robo', source: 'image', floor_id: l.mower.floor_id, calibration: [],
    overlay: { entity: 'camera.robo_live_map', x: 16.5, y: 1.5, rotation: 0, width: 9, opacity: 0.6, refresh: 2 } } }); })()`);
  const near = (x, y, r = 4) => `(() => { const b = ${card}._imageBlob; return !!b && Math.hypot(b.px - ${x}, b.py - ${y}) < ${r}; })()`;
  check('mowing: found by its picture', await until(`${near(300, 600)} && ${card}._imageBlob.matched`, 'the mowing mower', 20000), JSON.stringify(await ev(`${card}._imageBlob`)));
  check('the map dock icon learned', await until(`(() => { const d = ${card}._dockPx; return !!d && Math.hypot(d.px - 391, d.py - 786) < 6; })()`, 'the dock icon'), JSON.stringify(await ev(`${card}._dockPx`)));
  await ev(`window.__setDemoStates({ 'lawn_mower.robo': 'docked', 'sensor.robo_mower_status': 'Charging' })`);
  await ev(`window.__setRobotAt(391, 786, 0)`); // the mower icon over the dock icon
  const atDock = `(() => { const c = ${card}, d = c._objects.dockPose(), p = c._objects._pose; return !!d && !!p && Math.hypot(p.x - d.x, p.y - d.y) < 1e-6 && Math.abs(p.heading - d.heading) < 1e-6; })()`;
  check('docked: the mower stands at the dock object, turned as the dock', await until(atDock, 'the mower at the dock'), JSON.stringify(await ev(`(() => { const c = ${card}; return { dock: c._objects.dockPose(), pose: c._objects._pose }; })()`)));
  await sleep(2500);
  check('docked: still at the dock after map refreshes (not the map centre)', await ev(atDock));
  check('status line: At dock (charging)', (await ev(`${card}.mowerStatusText()`)) === 'At dock (charging)', await ev(`${card}.mowerStatusText()`));
  check('docked: no detection while docked', await ev(`!${card}._lastFrame || !${card}._trk.docked || ${card}._imageBlob.px === 300 || Math.hypot(${card}._imageBlob.px - 300, ${card}._imageBlob.py - 600) < 4`));
  // undock: the icon still over the dock icon, then driving away
  await ev(`window.__setDemoStates({ 'lawn_mower.robo': 'mowing', 'sensor.robo_mower_status': 'Working' })`);
  await ev(`window.__setRobotAt(392, 782, 0.1)`);
  check('undocking: found over the dock icon (not dropped as the dock)', await until(near(392, 782, 5), 'the mower over the dock', 15000), JSON.stringify({ b: await ev(`${card}._imageBlob`), r: await ev(`${card}._imageResult`), trk: await ev(`${card}._trk`) }));
  await ev(`window.__setRobotAt(380, 735, 0.4)`);
  check('driving away: tracked', await until(near(380, 735), 'the mower leaving', 15000), JSON.stringify(await ev(`${card}._imageBlob`)));
  await ev(`window.__setRobotAt(360, 690, 0.6)`);
  check('further: tracked, no longer leaving the dock', await until(`${near(360, 690)} && !${card}._trk.leaving`, 'the mower away from the dock', 15000), JSON.stringify(await ev(`${card}._trk`)));
  check('status line: Tracked on map (score …)', /^Tracked on map \(score 0\.\d\d\)$/.test(await ev(`${card}.mowerStatusText()`)), await ev(`${card}.mowerStatusText()`));
  // tracking window: the next refreshes do not search the whole picture
  const fullAt = await ev(`${card}._trk.lastFull`);
  await ev(`window.__setRobotAt(350, 670, 0.6)`);
  await until(near(350, 670), 'the next position', 15000);
  check('tracking window: no full search for a small move', (await ev(`${card}._trk.lastFull`)) === fullAt, JSON.stringify(await ev(`${card}._lastFrame`)));
  check('the map never read on the page (worker)', await ev(`!!${card}._mapProc._worker`));
  const tab = await (async () => {
    await ev(`${card}.shadowRoot.querySelector('button.edit').click()`);
    await until(`${card}._editing`, 'edit mode');
    await ev(`[...${card}.shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Mower').click()`);
    await until(`${card}._edit.tab === 'mower'`, 'the Mower tab');
    return ev(`${card}.shadowRoot.querySelector('.panel').textContent.replace(/\\s+/g, ' ')`);
  })();
  check('Mower tab: the status line', /Tracked on map \(score 0\.\d\d\)/.test(tab), tab.slice(0, 300));
  await ev(`window.__setDemoStates({ 'lawn_mower.robo': 'docked' })`);
  check('docked again: back at the dock', await until(atDock, 'the mower back at the dock'));
  check('Mower tab: At dock (docked)', await until(`${card}.shadowRoot.querySelector('.panel').textContent.includes('At dock (docked)')`, 'the dock status'));
  await ev('window.__demoMowerPaused = false');
  allErrors.push(...s.errors);
});

// 2c. no model: today's look
sections.add('no-model', { group: 'upload', query: { view: '3d' } }, async (s) => {
  const { page } = s;
  const r = await page.evaluate(`(() => { const v = ${card}._view; return { tm: v.renderer.toneMapping, sm: v.renderer.shadowMap.enabled, pr: v.renderer.getPixelRatio(),
    labels: ${card}.shadowRoot.querySelectorAll('.fp-room-label:not(.fp-obj-label)').length, dayHidden: ${card}.shadowRoot.querySelector('button.daynight').hidden }; })()`);
  check('no model: NoToneMapping, no shadows', r.tm === 0 && r.sm === false, JSON.stringify(r));
  check('no model: room labels present, day/night hidden, pixel ratio capped', r.labels > 0 && r.dayHidden && r.pr <= 1.5, JSON.stringify(r));
  await page.evaluate(`${card}._setFloor('all')`);
  await idle(page);
  check('no model: "All" does not fade markers', (await page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-marker.fp-faded').length`)) === 0);
  allErrors.push(...s.errors);
});

// 2e. edit panel keeps its scroll position and the slider being dragged
sections.add('panel-scroll', { group: 'upload', query: { view: '3d', height: '560px' }, viewport: { width: 1500, height: 680 } }, async (s) => {
  const { page } = s;
  await page.evaluate(`${card}.shadowRoot.querySelector("button.edit").click()`);
  await idle(page);
  await page.evaluate(`[...${card}.shadowRoot.querySelectorAll(".panel button")].find((b) => b.textContent.trim() === "Model").click()`);
  const inp = await page.evaluateHandle(`${card}.shadowRoot.querySelector("[data-field=model-file]")`);
  await inp.uploadFile(path.join(root, 'demo/house.glb'));
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 20000 });
  await sleep(800);
  const body = `${card}.shadowRoot.querySelector(".panel .tab-body")`;
  const keeps = async (label, act) => {
    await page.evaluate(`(() => { const b = ${body}; b.scrollTop = b.scrollHeight; })()`);
    const before = await page.evaluate(`${body}.scrollTop`);
    await page.evaluate(act);
    await sleep(500);
    const after = await page.evaluate(`${body}.scrollTop`);
    check(`panel scroll kept after ${label}`, before > 100 && Math.abs(after - before) < 2, `${before} -> ${after}`);
  };
  await keeps('rotation slider', `(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-rotation]'); s.value = '10'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await keeps('opacity slider', `(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-opacity]'); s.value = '0.8'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await keeps('room select', `(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-room]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  // a slider being dragged must stay the same element (pointer down, several input ticks)
  const same = await page.evaluate(`(async () => {
    const root = ${card}.shadowRoot; const s = root.querySelector('[data-field=md-rotation]');
    s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    for (const v of ['20', '30', '40']) { s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 150)); }
    const stillThere = root.querySelector('[data-field=md-rotation]') === s;
    s.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return stillThere;
  })()`);
  check('dragged slider is not replaced while dragging', same);
  allErrors.push(...s.errors);
});

// 3. export snippet round trip
sections.add('export', { group: 'upload', query: null }, async (s) => {
  const { page, errors } = await newPage(s.browser);
  await page.goto(`${s.base}/scripts/fixtures/export-test.html`);
  await page.waitForFunction('window.ready === true');
  // a real download would leave headless Chrome hanging on close
  await page.evaluate('HTMLAnchorElement.prototype.click = function () { window.__downloaded = this.download; }');
  await page.evaluate(fs.readFileSync(path.join(root, 'tools/export-glb.js'), 'utf8'));
  await page.waitForFunction('!!window.__floorplan3dGlb', { timeout: 10000 });
  const glb = Buffer.from(await page.evaluate('Array.from(new Uint8Array(window.__floorplan3dGlb))'));
  check('export is a binary glTF', glb.toString('ascii', 0, 4) === 'glTF');
  check('download offered as house.glb', (await page.evaluate('window.__downloaded')) === 'house.glb');
  const jsonLen = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
  const names = gltf.nodes.map((n) => n.name);
  check('floor groups exported', names.includes('floor:ground') && names.includes('floor:first'), names.join(', '));
  check('lights, cameras and helpers dropped', !gltf.extensions?.KHR_lights_punctual && !gltf.cameras && gltf.nodes.length === 4, `${gltf.nodes.length} nodes`);
  allErrors.push(...errors.filter((e) => !e.includes('GPU stall')));
  await page.close();
});

// 5. final review fixes: no occlusion / shadow work for irrelevant state updates (I1), mower and
// pins in an exterior-only view (I2), model view cameras follow the model alignment (I3)
{
  const camsName = `house-cams-${process.pid}.glb`;
  const cams = path.join(root, 'screenshots', camsName);
  const modelCam = { position: [14, 12, 10], target: [6, 0, -4] };
  const modelTop = { center: [6, 4], zoom: 1.2 };
  const before = () => {
    fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
    fs.writeFileSync(cams, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
      for (const n of json.nodes || []) {
        const fp = n.extras && n.extras.fp;
        if (fp && fp.views) fp.views = fp.views.map((v) => (v.id === 'ground' ? { ...v, camera: modelCam, camera_top: modelTop } : v));
      }
      return json;
    }));
  };
  sections.add('review', { group: 'review', query: { model: `/screenshots/${camsName}`, view: '3d' }, viewport: { width: 1400, height: 560 }, before }, async (s) => {
  try {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
    await sleep(1500);
    // these checks are about the live mower marker: hide the model's mower object, so the marker is back
    await page.evaluate(`(() => { const c = ${card}; c._commit({ ...c._layout, objects: { ...(c._layout.objects || {}), mower: { hidden: true } } }); })()`);
    await page.waitForFunction(`!!${card}._mowerMarkerId`, { timeout: 5000 }).catch(() => {});
    // I1: 10 hass updates (a sensor value, a light's brightness) with the camera still and the mower parked
    await page.evaluate('window.__demoMowerPaused = true');
    await sleep(800);
    await page.evaluate(`(() => { const v = ${card}._view; v.stats = { occPasses: 0, occPartial: 0, occDone: 0, shadow: 0 }; })()`);
    for (let i = 0; i < 10; i++) {
      await page.evaluate(`(() => { const c = ${card}, st = c.hass.states;
        const t = st['sensor.kitchen_temperature'], l = st['light.kitchen'];
        c.hass = { ...c.hass, states: { ...st, 'sensor.kitchen_temperature': { ...t, state: String(20 + ${i}) },
          'light.kitchen': { ...l, attributes: { ...l.attributes, brightness: ${100 + i * 10} } } } }; })()`);
      await idle(page);
    }
    await sleep(800);
    let stats = await page.evaluate(`${card}._view.stats`);
    check('10 state updates, nothing relevant changed: 0 occlusion passes, 0 shadow map renders', stats.occPasses === 0 && stats.occPartial === 0 && stats.shadow === 0, JSON.stringify(stats));
    check('the state updates still reached the markers', await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.fp-val, .fp-in')].some((e) => e.textContent.startsWith('29'))`));
    // a moving mower: only its own marker is re-tested
    const mpos = () => page.evaluate(`(() => { const c = ${card}; const o = c._view.markerObjects.get(c._mowerMarkerId); return o ? o.obj.position.toArray().map((x) => x.toFixed(2)).join() : null; })()`);
    const p0 = await mpos();
    await page.evaluate(`(() => { const v = ${card}._view; v.stats = { occPasses: 0, occPartial: 0, occDone: 0, shadow: 0 }; })()`);
    await page.evaluate('window.__demoMowerPaused = false');
    await sleep(2600);
    await page.evaluate('window.__demoMowerPaused = true');
    stats = await page.evaluate(`${card}._view.stats`);
    const p1 = await mpos();
    check('moving mower: marker moves, partial occlusion only, no full pass, no shadow render', p0 !== p1 && stats.occPasses === 0 && stats.shadow === 0 && stats.occPartial > 0, `${p0} -> ${p1} ${JSON.stringify(stats)}`);
    // the shadow map still updates when something relevant changes (a view switch)
    await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=first]').click()`);
    await sleep(500);
    stats = await page.evaluate(`${card}._view.stats`);
    check('a view switch re-renders the shadow map and runs a full occlusion pass', stats.shadow > 0 && stats.occPasses > 0, JSON.stringify(stats));

    // I2: an added Garden view (hide all, show role:exterior) shows the mower and a pin in the garden zone
    await page.evaluate(`(() => { const c = ${card}, l = c._layout;
      c._commit({ ...l, views: { ...(l.views || {}), garden: { added: true, label: 'Garden', rules: [{ hide: 'all' }, { show: 'role:exterior' }] } },
        pins: { ...l.pins, 'device:kettle_plug': { x: 14, y: -5, z: 1, floor_id: 'ground' }, 'device:tv': { x: 9, y: 2, z: 1, floor_id: 'ground' } } }); })()`);
    await idle(page);
    await page.evaluate(`${card}._setView('garden')`);
    await idle(page);
    const vis = (id) => page.evaluate(`(() => { const c = ${card}; const o = c._view.markerObjects.get(${id}); return o ? o.obj.visible : null; })()`);
    const gv = { mower: await vis(`c._mowerMarkerId`), gardenPin: await vis(`'device:kettle_plug'`), kitchenPin: await vis(`'device:tv'`),
      chip: await page.evaluate(`!!${card}.shadowRoot.querySelector('.chip.on[data-view=garden]')`) };
    check('Garden view: mower and the pin in the garden zone shown, a pin in the (hidden) kitchen not', gv.mower === true && gv.gardenPin === true && gv.kitchenPin === false && gv.chip, JSON.stringify(gv));

    // I3: model view cameras (3D and top centre) follow the model alignment; identity first
    const near = (a, b, tol = 0.02) => a.every((x, i) => Math.abs(x - b[i]) < tol);
    const camNow = () => page.evaluate(`${card}._view.getCamera()`);
    await page.evaluate(`${card}._setView('ground', { instant: true })`);
    await idle(page);
    let cam = await camNow();
    check('model view camera at identity alignment', near(cam.position, modelCam.position) && near(cam.target, modelCam.target), JSON.stringify(cam));
    const align = { position: [2, 1, 0.5], rotation: 90, scale: 1.5 };
    await page.evaluate(`${card}.setConfig({ ...${card}._config, model_position: ${JSON.stringify(align.position)}, model_rotation: ${align.rotation}, model_scale: ${align.scale} })`);
    await sleep(500);
    await page.evaluate(`${card}._setView('exterior', { instant: true })`);
    await page.evaluate(`${card}._setView('ground', { instant: true })`);
    await idle(page);
    cam = await camNow();
    const want = { position: alignModelPoint(modelCam.position, align), target: alignModelPoint(modelCam.target, align) };
    check('model view camera follows the model alignment', near(cam.position, want.position) && near(cam.target, want.target), JSON.stringify({ cam, want }));
    await page.evaluate(`${card}._setMode('top')`);
    await idle(page);
    await page.evaluate(`${card}._setView('ground', { instant: true })`);
    await idle(page);
    const top = await page.evaluate(`${card}._view.getTopCamera()`);
    const wantC = transformPoint(modelTop.center, align);
    check('model camera_top centre (and zoom / scale) follows the alignment', near(top.center, wantC) && Math.abs(top.zoom - modelTop.zoom / align.scale) < 0.01, JSON.stringify({ top, wantC }));
    await page.evaluate(`${card}._setMode('3d')`);
    await idle(page);

    // edit mode on / off keeps the camera exactly (no re-framing)
    await page.evaluate(`${card}._view.setCamera({ position: [30, 20, 25], target: [4, 0, -3] }, { instant: true })`);
    await idle(page);
    const before = await camNow();
    await page.evaluate(`${card}._toggleEdit()`);
    await idle(page);
    const inEdit = await camNow();
    // one floor on its own in edit mode (no view linked to just it), then Done: the view's chip is lit again
    await page.evaluate(`${card}.saveViewPatch('ground', { floors: [] })`);
    await idle(page);
    await page.evaluate(`${card}._setFloor('ground')`);
    const floorOnly = await page.evaluate(`${card}._floorOnly`);
    await page.evaluate(`${card}._view.setCamera(${JSON.stringify(before)}, { instant: true })`);
    await page.evaluate(`${card}._toggleEdit()`);
    await idle(page);
    const after = await camNow();
    check('edit mode on / off keeps the camera', near(before.position, inEdit.position) && near(before.position, after.position) && near(before.target, after.target), JSON.stringify([before, inEdit, after]));
    check('Done after a single-floor pick: back to the view, its chip lit', floorOnly === 'ground' && (await page.evaluate(`!${card}._floorOnly && !!${card}.shadowRoot.querySelector('.chip.on')`)));
    // detached while editing: window listeners (keys, pick menu) removed
    const detached = await page.evaluate(`(() => { const c = ${card}, removed = [];
      const orig = window.removeEventListener;
      window.removeEventListener = function (t, fn, o) { removed.push([t, fn]); return orig.call(this, t, fn, o); };
      c._toggleEdit();
      const parent = c.parentNode, next = c.nextSibling;
      c.remove();
      window.removeEventListener = orig;
      const ok = removed.some(([t, fn]) => t === 'keydown' && fn === c._edit._onKey);
      parent.insertBefore(c, next);
      c._toggleEdit();
      return ok; })()`);
    check('disconnect while editing removes the window keydown listener', detached);
    allErrors.push(...s.errors);
  } finally {
    fs.rmSync(cams, { force: true });
  }
  });
}

// 6. model loading: progress text, local model cache (second load without the glb download), the
// plan drawing shown while loading, IndexedDB fallback without Cache Storage
sections.add('model-cache', { group: 'review', query: { model: '1', view: '3d' } }, async (s) => {
  const { page } = s;
  const gets = [];
  const onReq = (r) => { if (r.url().includes('/demo/house.glb')) gets.push(r.method()); };
  page.on('request', onReq);
  try {
    await page.evaluate((q) => window.__demoReset(q), { test: '1', model: '1', view: '3d' }); // loaded again, now watched
    await page.waitForFunction(`!!${card}._view.model && ${card}._loadUI.readyAt !== null`, { timeout: 20000 });
    let shown = null;
    let st = await page.evaluate(`(() => { const c = ${card}, ui = c._loadUI; return { log: ui.log, barHidden: ui.bar.hidden, cached: c._modelFromCache }; })()`);
    check('progress: download, then "Preparing model…", then gone', st.log.some((t) => /^Downloading [\d.]+ \/ [\d.]+ MB$/.test(t)) && st.log.includes('Preparing model…') && st.barHidden, JSON.stringify(st));
    check('first load downloads the glb', gets.includes('GET') && st.cached === false, JSON.stringify(gets));
    const outline = await page.evaluate(`localStorage.getItem('fp3d-outline:default')`);
    const stored = outline && JSON.parse(outline);
    check('after a load the room outlines are remembered per layout key', Array.isArray(stored) && stored.length > 2 && stored.every((p) => p.length >= 3) && outline.length < 20480, String(outline).slice(0, 120));
    const gone = await page.evaluate(`!${card}.shadowRoot.querySelector('.fp-loadplan') && !${card}._stage.querySelector('.fp-loadplan')`);
    check('after the load the drawing overlay is gone', gone);
    // the same demo again, caches kept; the model's HEAD answered late so the drawing has time to show
    gets.length = 0;
    await page.setRequestInterception(true);
    const delay = (r) => {
      if (r.isInterceptResolutionHandled()) return;
      if (r.url().includes('/demo/house.glb') && r.method() === 'HEAD') setTimeout(() => r.continue(), 600);
      else r.continue();
    };
    page.on('request', delay);
    try {
      await page.evaluate((q) => window.__demoReset(q, { keepCaches: true }), { test: '1', model: '1', view: '3d' });
      await page.waitForFunction(`!!${card}.shadowRoot.querySelector('.fp-loadplan .draw')`, { timeout: 20000 });
      await page.evaluate(`(() => { // record how the camera moves once the model is there
        const v = ${card}._view, rec = window.__camRec = { moves: [], tween: false };
        const mv = v._moveCamera.bind(v);
        v._moveCamera = (pos, target, instant) => { rec.moves.push({ instant: !!instant || !v._framed, model: !!v.model }); return mv(pos, target, instant); };
        const tick = () => { if (v.model && v._tween) rec.tween = true; if (!rec.stop) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })()`);
      shown = await page.evaluate(`(() => { const e = ${card}.shadowRoot.querySelector('.fp-loadplan'); const d = e.querySelector('.draw').getAttribute('d'); return { d, vis: getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 50, text: e.querySelector('.txt').textContent, parent: e.parentElement.className }; })()`);
      const lock = await page.evaluate(`(() => { const c = ${card}, e = c.shadowRoot.querySelector('.fp-loadplan'); let leaked = 0;
        const f = () => { leaked++; };
        c._stage.addEventListener('pointerdown', f); c._stage.addEventListener('click', f);
        const r = e.getBoundingClientRect(), o = { bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        e.dispatchEvent(new PointerEvent('pointerdown', o)); e.dispatchEvent(new MouseEvent('click', o));
        c._stage.removeEventListener('pointerdown', f); c._stage.removeEventListener('click', f);
        const top = c.shadowRoot.elementFromPoint(o.clientX, o.clientY);
        return { leaked, controls: c._view.controls.enabled, onDrawing: !!top && !!top.closest('.fp-loadplan') }; })()`);
      check('while loading: the drawing swallows pointer input and the orbit controls are off', lock.leaked === 0 && lock.controls === false && lock.onDrawing, JSON.stringify(lock));
      await page.waitForFunction(`!!${card}._view.model && ${card}._loadUI.readyAt !== null`, { timeout: 20000 });
    } finally {
      page.off('request', delay);
      await page.setRequestInterception(false);
    }
    st = await page.evaluate(`(() => { const c = ${card}, ui = c._loadUI; return { log: ui.log, cached: c._modelFromCache }; })()`);
    check('second load: the model from the cache, no glb download', st.cached === true && !gets.includes('GET'), JSON.stringify({ gets, cached: st.cached }));
    const house = fitOutline(HOUSE_OUTLINE).d;
    check('second load: the drawing is visible over the stage with a non-empty path', shown && shown.vis && /^M[\d. ]+L/.test(shown.d) && /stage/.test(shown.parent), JSON.stringify(shown));
    check('second load: the remembered outline is drawn, not the house fallback', shown && shown.d && house !== shown.d, JSON.stringify({ d: shown && shown.d.slice(0, 60), house: house && house.slice(0, 60) }));
    const cam = await page.evaluate(`(() => { window.__camRec.stop = true; return window.__camRec; })()`);
    check('first camera pose after a load is applied instantly (no fly-in)', cam.moves.filter((m) => m.model).every((m) => m.instant) && !cam.tween && cam.moves.length > 0, JSON.stringify(cam));
    check('second load: the progress text is under the drawing', shown && shown.text.length > 0, JSON.stringify(shown));
    check('second load: no download progress, only "Preparing model…"', !st.log.some((t) => t.startsWith('Downloading')) && st.log.includes('Preparing model…'), JSON.stringify(st.log));
    await page.waitForFunction(`!${card}.shadowRoot.querySelector('.fp-loadplan')`, { timeout: 5000 }).catch(() => {});
    const after = await page.evaluate(`(() => { const c = ${card}, v = c._view; return { gone: !${card}.shadowRoot.querySelector('.fp-loadplan'), controls: v.controls.enabled, tween: !!v._tween }; })()`);
    check('drawing faded out and removed, controls enabled, no camera animation running', after.gone && after.controls && !after.tween, JSON.stringify(after));
    // plain http on the LAN: no Cache Storage -> the model blob in IndexedDB
    const idb = await page.evaluate(`(async () => {
      const c = ${card};
      const own = Object.getOwnPropertyDescriptor(window, 'caches');
      Object.defineProperty(window, 'caches', { value: undefined, configurable: true });
      let n = 0;
      const buf = new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0]).buffer;
      const fetchFn = async () => { n++; return new Response(buf, { headers: { 'content-length': '8' } }); };
      const base = location.origin + '/api/floorplan3d/model/idb-test';
      const a = await c._modelBytes(base, 'v1::', fetchFn), c1 = c._modelFromCache;
      const b = await c._modelBytes(base, 'v1::', fetchFn), c2 = c._modelFromCache;
      await c._modelBytes(base, 'v2::', fetchFn); // a new version: fetched again
      if (own) Object.defineProperty(window, 'caches', own); else delete window.caches;
      return { n, c1, c2, same: a.byteLength === 8 && b.byteLength === 8 };
    })()`);
    check('no Cache Storage: model cached in IndexedDB, new version fetched again', idb.n === 2 && idb.c1 === false && idb.c2 === true && idb.same, JSON.stringify(idb));
    // a stalled download: aborted after the timeout (60 s; shortened here), the error shown, controls enabled again
    const stall = await page.evaluate(`(async () => {
      const c = ${card}, v = c._view, ui = c._loadUI;
      window.__fpModelTimeoutMs = 300;
      let aborted = false;
      const fetchFn = ({ signal }) => new Promise((res, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }));
      ui.loading(); // the drawing is up as during a real load
      const err = await v.setModel({ id: 'stall', name: 'stall.glb', data: () => c._modelBytes(location.origin + '/stall.glb', null, fetchFn) });
      ui.done(!!v.model && !err, err || '');
      window.__fpModelTimeoutMs = undefined;
      return { err, aborted, bar: ui.bar.hidden ? null : ui.bar.textContent, controls: v.controls.enabled };
    })()`);
    check('stalled download: timed out, aborted, error shown, controls enabled', /timed out/.test(stall.err || '') && stall.aborted && /timed out/.test(stall.bar || '') && stall.controls, JSON.stringify(stall));
    // a cached copy that does not parse: evicted and fetched once more
    const bad = await page.evaluate(`(async () => {
      const c = ${card}, v = c._view;
      const base = location.origin + '/api/floorplan3d/model/bad-test';
      await c._modelBytes(base, 'b1', async () => new Response(new Uint8Array([1, 2, 3, 4]))); // junk stored in the cache
      let n = 0;
      const good = async () => { n++; return fetch('/demo/house.glb'); };
      c._modelEvicted = 0;
      const err = await v.setModel({ id: 'bad-then-good', name: 'bad.glb', data: () => { c._modelSrc = { base, version: 'b1', fetchFn: good }; return c._modelBytes(base, 'b1', good); }, dataFresh: () => c._modelFresh() });
      return { err, model: !!v.model, evicted: c._modelEvicted, fetched: n, cachedAfter: c._modelFromCache };
    })()`);
    check('cached model that fails to parse: evicted, fetched once, loads', bad.err === null && bad.model && bad.evicted === 1 && bad.fetched === 1 && bad.cachedAfter === false, JSON.stringify(bad));
    allErrors.push(...s.errors.filter((e) => !/stall\.glb|bad\.glb/.test(e))); // the deliberate failures above
  } finally {
    page.off('request', onReq);
  }
});

// about 150 s per shard of 3 (measured): lamps + views + review | objects + upload | model + mower
sections.order(['lamps', 'objects', 'model', 'views', 'upload', 'mower', 'review']);
const args = parseArgs(process.argv.slice(2));
if (args.list) {
  for (const g of sections.groups) console.log(`${g.name}: ${g.sections.map((x) => x.name).join(', ')}`);
  process.exit(0);
}
if (!args.shard && !args.only && args.jobs > 1) process.exit(await sections.runShards(import.meta.filename, args.jobs));
// every shard writes screenshots, so create the folder before any section runs
fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
await sections.run(selectGroups(sections.groups, args), {
  onError: (name, e) => { console.log(`FAIL ${name} threw: ${e && e.stack ? e.stack : e}`); failures.push(name); },
});
const optional = !args.only && (!args.shard || args.shard[0] === 1);

// 4. optional: a real model, screenshots only (REAL_MODEL=/path/to/house.glb)
if (optional && process.env.REAL_MODEL) {
  s = await openDemo({ view: '3d', height: '700px' }, { width: 1500, height: 820 });
  try {
    const { page } = s;
    await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
    await idle(page);
    await page.evaluate(() => {
      const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model');
      if (b) b.click();
    });
    await idle(page);
    const input = await page.evaluateHandle(`${card}.shadowRoot.querySelector('.panel [data-field=model-file]')`);
    await input.uploadFile(process.env.REAL_MODEL);
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 60000 });
    await sleep(500);
    await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`); // leave edit mode
    await sleep(800);
    const ids = await page.evaluate(`${card}._floors.map((f) => f.id).concat('all')`);
    for (const id of ids) {
      await page.evaluate(`${card}._setFloor(${JSON.stringify(id)})`);
      await sleep(1200);
      await page.screenshot({ path: path.join(root, 'screenshots', `real-${id}-day.png`) });
      console.log('screenshot', `screenshots/real-${id}-day.png`);
    }
    await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
    await sleep(800);
    await page.screenshot({ path: path.join(root, 'screenshots', `real-${ids[ids.length - 1]}-night.png`) });
    console.log('screenshot', `screenshots/real-${ids[ids.length - 1]}-night.png`);
    allErrors.push(...s.errors);
  } finally {
    await s.close();
  }
}

// 5. optional: the user's own model (USER_MODEL=/path/to/house.glb): merge stats printed, never fails
if (optional && process.env.USER_MODEL) {
  for (const merge of [true, false]) {
    let u;
    try {
      u = await openDemo({ view: '3d', height: '700px', ...(merge ? {} : { merge: '0' }) }, { width: 1500, height: 820 });
      const { page } = u;
      await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
      await idle(page);
      await page.evaluate(() => {
        const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model');
        if (b) b.click();
      });
      await idle(page);
      const input = await page.evaluateHandle(`${card}.shadowRoot.querySelector('.panel [data-field=model-file]')`);
      const t0 = Date.now();
      await input.uploadFile(process.env.USER_MODEL);
      await page.waitForFunction(`!!${card}._view.model && !!${card}._view.mergeStats`, { timeout: 120000 });
      const ms = Date.now() - t0;
      await sleep(1500);
      const st = await page.evaluate(`JSON.stringify(${card}._view.mergeStats)`).then(JSON.parse);
      const info = await page.evaluate(`(() => { const sr = ${card}.shadowRoot, v = ${card}._view;
        v.dirty = true; return { text: (sr.querySelector('[data-info=merge-stats]') || {}).textContent || null, nodes: ${card}._index ? ${card}._index.nodes.length : null,
          frameCalls: v.renderer.info.render.calls }; })()`);
      console.log(`user model (merge ${merge ? 'on' : 'off'}): meshes ${st.before.meshes} -> ${st.after.meshes}, draw calls ${st.before.calls} -> ${st.after.calls},`
        + ` triangles ${st.before.triangles} -> ${st.after.triangles}, groups ${st.groups}, merged ${st.merged}; load ${ms} ms; index nodes ${info.nodes}; tab "${info.text}"`);
      if (u.errors.length) console.log('user model page errors:\n' + u.errors.join('\n'));
      await page.screenshot({ path: path.join(root, 'screenshots', `user-model-merge-${merge ? 'on' : 'off'}.png`) });
    } catch (e) {
      console.log('user model check could not run:', e.message);
    } finally {
      if (u) await u.close();
    }
  }
}

if (allErrors.length) console.error('page errors:\n' + allErrors.join('\n'));
if (failures.length || allErrors.length) process.exit(1);
console.log('all model checks passed');
process.exit(0);
