// Headless check of the GLB underlay and the export snippet:
// - demo with ?model=1: model loads, level groups follow the floor chips, roof is cut away
// - a missing model shows a notice instead of breaking the card
// - tools/export-glb.js exports a named scene to a valid .glb without lights/helpers
import fs from 'node:fs';
import path from 'node:path';
import { openDemo, newPage, root } from './lib/demo-browser.mjs';
import { inverseTransformPoint, transformPoint } from '../src/bindings.js';
import { alignModelPoint } from '../src/views.js';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' – ' + detail : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wait until the 400 ms camera tween has finished (fixed sleeps flake under load)
const settle = async (page, card) => { await page.waitForFunction(`!${card}._view._tween`, { timeout: 5000 }).catch(() => {}); await sleep(100); };
const card = 'document.querySelector("floorplan3d-card")';
// move the camera and wait for the occlusion pass that follows it to finish (no fixed sleeps)
const camAndOcclusion = async (page, cam) => {
  const before = await page.evaluate(`${card}._view.stats.occDone`);
  // an explicit full pass too: the camera may already be there (no change event, no pass of its own)
  await page.evaluate(`(() => { const v = ${card}._view; v.setCamera(${typeof cam === 'string' ? cam : JSON.stringify(cam)}, { instant: true }); v._scheduleOcclusion(0); })()`);
  await page.waitForFunction(`(() => { const v = ${card}._view; return !v._tween && v.stats.occDone > ${before} && !v._occFull && !v._occTimer; })()`, { timeout: 5000 })
    .catch(() => console.log('     (occlusion pass did not finish in 5 s)'));
};
let allErrors = [];

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
let s = await openDemo({ model: '1', view: '3d' }, { width: 1400, height: 560 });
try {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 10000 });
  await sleep(300);
  const st = () => page.evaluate(`(() => { const v = ${card}._view; const vis = (id) => v.modelManifest().levels.find((l) => l.id === id)?.node.visible; return {
    level0: vis('level0'), level1: vis('level1'), exterior: vis('exterior'), roof: vis('roof'),
    cut: v.modelClip.constant, floors: v.modelManifest().levels.map((l) => l.id) }; })()`);
  const sh = (name) => page.screenshot({ path: path.join(root, 'screenshots', name) });
  fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
  let v = await st();
  check('model loaded with level groups', JSON.stringify(v.floors) === '["level0","level1","exterior","roof"]', JSON.stringify(v.floors));
  const chipList = () => page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.chip')].map((b) => b.textContent)`);
  check('chips are the model\'s views in order', JSON.stringify(await chipList()) === '["Exterior","Ground floor","First floor"]', JSON.stringify(await chipList()));
  const chip = async (id) => { await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=${id}]').click()`); await sleep(300); };
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
    await sleep(300);
    await camAndOcclusion(page, { position: [occ.pos[0], occ.pos[1] + 14, occ.pos[2] + 3], target: occ.pos });
    check('same marker seen from above (no wall in between) is not occluded', !(await cls(occ.id)));
    await page.evaluate(`${card}._view.setCamera(${JSON.stringify(camBefore)}, { instant: true })`);
    await sleep(300);
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
  await sleep(300);
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
  await sleep(200);
  await page.evaluate(`${card}.shadowRoot.querySelector('.seg button[data-mode=top]').click()`);
  await sleep(200);
  check('Top view clears the section and hides the button', (await page.evaluate(`${card}._view.renderer.clippingPlanes.length === 0 && ${secBtn}.hidden && !${card}._section`)));
  await page.evaluate(`${card}.shadowRoot.querySelector('.seg button[data-mode="3d"]').click()`);
  await sleep(300);

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
  await sleep(400);
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
  await sleep(400);
  check('leaving edit mode restores the view\'s labels', (await page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-room-label:not(.fp-obj-label)').length`)) === look.labels);
  // framing uses the room polygons even though no fills/outlines/walls are rendered with a model
  await page.evaluate(`${card}._setFloor('ground'); ${card}._view.setMode('3d'); ${card}._view.fit({ instant: true })`);
  await sleep(200);
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
  await sleep(200);
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=first]').click()`);
  await sleep(100);
  await settle(page, card);
  check('saved view camera restored on chip switch', (await camAt()) === '20.00,25.00,20.00', await camAt());
  await page.evaluate(`${card}.saveViewPatch('first', { camera: null })`);
  await sleep(200);
  await page.evaluate(`${card}._setFloor('ground')`);
  await sleep(600);

  const lights = () => page.evaluate(`({ sun: ${card}._view.sun.intensity, hemi: ${card}._view.hemi.intensity, cast: ${card}._view.sun.castShadow })`);
  const day = await lights();
  await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
  await sleep(300);
  const night = await lights();
  check('night: sun off, hemisphere 0.14', night.sun === 0 && night.cast === true && Math.abs(night.hemi - 0.14) < 0.001, JSON.stringify(night));
  check('button icon is the moon at night', (await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight ha-icon').getAttribute('icon')`)) === 'mdi:weather-night');
  await sh('look-night.png');
  await page.evaluate(`${card}.shadowRoot.querySelector('button.daynight').click()`);
  await sleep(300);
  check('auto without sun.sun is day', JSON.stringify(await lights()) === JSON.stringify(day) && day.sun > 0, JSON.stringify(day));

  // sky: auto follows sun.sun, button cycles auto -> day -> night -> auto, mode persists
  const mode = () => page.evaluate(`${card}._skyMode`);
  const tint = (e, a) => page.evaluate(`window.__setDemoSun(${e}, ${a})`);
  check('sky mode starts auto', (await mode()) === 'auto');
  await tint(-20, 180);
  await sleep(300);
  const sNight = await lights();
  check('auto: sun at -20 deg -> hemi 0.14, sun 0', Math.abs(sNight.hemi - 0.14) < 0.001 && sNight.sun === 0, JSON.stringify(sNight));
  await tint(30, 180);
  await sleep(300);
  const sDay = await lights();
  check('auto: sun at +30 deg -> hemi 0.9, sun 2.6', Math.abs(sDay.hemi - 0.9) < 0.001 && Math.abs(sDay.sun - 2.6) < 0.001, JSON.stringify(sDay));
  const shadowsBefore = await page.evaluate(`${card}._view.stats.shadow`);
  await tint(30.2, 180.2);
  await sleep(200);
  check('a sun move under 1 deg does not redraw shadows', (await page.evaluate(`${card}._view.stats.shadow`)) === shadowsBefore);
  await tint(45, 220);
  await sleep(200);
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
  await sleep(200);
  check('auto again after the cycle: sun at +60 deg is day', (await page.evaluate(`${card}._skyMode`)) === 'auto' && (await lights()).sun > 2.5);
  await tint(-3, 180);
  await sleep(200);
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
  await sleep(400);
  let b = await bodies();
  // north 0: azimuth 200 (from north, clockwise) = south-south-west = +z, a bit -x: atan2(x, z) ~ -20 deg -> 340
  check('sky: sun 25 deg / 200 deg on the dome (elevation 25, south-ish), ring shown', !!b.sun && Math.abs(b.sun.el - 25) < 0.5 && Math.abs(b.sun.r - b.dome) < 0.01
    && (b.north !== 0 || Math.abs(b.sun.az - 340) < 1) && b.ring && b.dome >= 12, JSON.stringify(b));
  check('sky: sun inside the camera frustum in the exterior view', !!b.sun && b.sun.inView, JSON.stringify(b));
  await sh('sky-3d.png');
  await page.evaluate(`${card}._setMode('top')`);
  await settle(page, card);
  await sleep(400);
  b = await bodies();
  check('sky: sun and ring visible in top view', !!b.sun && b.sun.inView && b.ring, JSON.stringify(b));
  await sh('sky-top.png');
  await page.evaluate(`${card}._setMode('3d')`);
  await settle(page, card);
  await tint(-20, 0);
  await sleep(300);
  b = await bodies();
  const progs = b.programs, lightCount = b.lights;
  check('sky: sun at -20 deg -> sun hidden, moon up, faint moonlight', !b.sun && !!b.moon && b.moon.el > 0 && b.moonLight > 0.15 && b.moonLight <= 0.2, JSON.stringify(b));
  await tint(-1, 270);
  await sleep(300);
  check('sky: sun at -1 deg still shown (down to -2)', !!(await bodies()).sun);
  for (const [e, a] of [[-15, 10], [-25, 30], [20, 120], [-20, 0]]) { await tint(e, a); await sleep(150); }
  await page.evaluate('window.__demoNow = Date.UTC(2024, 3, 24, 2, 30)');
  await tint(-21, 5);
  await sleep(300);
  b = await bodies();
  check('sky: no shader recompile / light change per sun or moon update', b.programs === progs && b.lights === lightCount, `${progs} -> ${b.programs}, lights ${lightCount} -> ${b.lights}`);
  await page.evaluate(`${btn}.click()`);
  await page.evaluate(`${btn}.click()`); // night
  await sleep(300);
  b = await bodies();
  check('sky: manual Night -> moon at 35 deg, sun hidden, moonlight 0.17', (await mode()) === 'night' && !!b.moon && Math.abs(b.moon.el - 35) < 0.5 && !b.sun && Math.abs(b.moonLight - 0.17) < 0.001, JSON.stringify(b));
  await sh('look-moon.png');
  await page.evaluate(`${card}.setConfig({ ...${card}._config, sky_bodies: false })`);
  await sleep(300);
  b = await bodies();
  check('sky: sky_bodies false hides sun, moon and ring', !b.sun && !b.moon && !b.ring, JSON.stringify(b));
  await page.evaluate(`${btn}.click()`); // auto
  await tint(30, 180);
  await sleep(300);
  b = await bodies();
  check('sky: sky_bodies false stays hidden in auto', !b.sun && !b.moon && !b.ring, JSON.stringify(b));
  await page.evaluate(`${card}.setConfig({ ...${card}._config, sky_bodies: true })`);
  await sleep(300);
  b = await bodies();
  check('sky: sky_bodies true shows the sun and ring again', !!b.sun && b.ring, JSON.stringify(b));
  await page.evaluate('delete window.__demoNow');
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 1a. static meshes merged at load (per owner + material), merge: false keeps every part, node: rules keep theirs
s = await openDemo({ model: '1', view: '3d' }, { width: 1400, height: 560 });
try {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._view.mergeStats`, { timeout: 10000 });
  const stats = () => page.evaluate(`JSON.stringify(${card}._view.mergeStats)`).then(JSON.parse);
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
  await sleep(200);
  await page.evaluate(() => {
    const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model');
    if (b) b.click();
  });
  await sleep(200);
  const tabText = await page.evaluate(`(${card}.shadowRoot.querySelector('.panel [data-info=merge-stats]') || {}).textContent || ''`);
  check('Model tab shows the draw calls before → after', tabText === `Draw calls: ${on.before.calls} → ${on.after.calls} (meshes ${on.before.meshes} → ${on.after.meshes})`, tabText);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await sleep(200);
  // the owner and material of a merged mesh: find one of its source meshes with merge off
  const probe = await page.evaluate(`(() => { let o = null; ${card}._view.model.root.traverse((x) => { if (!o && /^fp_merged_/.test(x.name)) o = x; });
    return { owner: o.parent.name, mat: o.material.name }; })()`);
  await page.evaluate(`${card}.setConfig({ ...${card}._config, merge: false })`);
  await page.waitForFunction(`!!${card}._view.mergeStats && !${card}._view.mergeStats.enabled`, { timeout: 10000 });
  await sleep(300);
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
    await sleep(300);
    await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
    await sleep(300);
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
    await sleep(300);
    const re = await page.evaluate(`(() => { const c = ${card}, ms = c._view.mergeStats; const n = c._index && c._index.nodes.find((i) => i.path === ${JSON.stringify(targets[1].path)});
      return { reloaded: c._view.model !== window.__m0, keep: !!ms && ms.keep.includes(${JSON.stringify(sel)}), mesh: !!n && !!n.node.isMesh && !n.node.userData.merged }; })()`);
    check('a later layout node: rule on a merged part reloads the model once and keeps that part', model0 && re.reloaded && re.keep && re.mesh, JSON.stringify(re));
    await page.evaluate(`(window.__m1 = ${card}._view.model, ${card}._schedule())`);
    await sleep(500);
    check('no second reload', await page.evaluate(`${card}._view.model === window.__m1`));
  }
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 1b. model objects: tap toggles, hold opens the popup, a drag never toggles (the demo model's hall ceiling lamp)
s = await openDemo({ model: '1', view: '3d' }, { width: 1400, height: 560 });
try {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, { timeout: 10000 });
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  const injected = await page.evaluate(`(() => { const o = ${card}._objects.objectAt('lamp_hall'); return o ? o.obj.node.name : null; })()`);
  check('the demo model has the hall ceiling lamp object', !!injected, String(injected));
  await sleep(200);
  const at = () => page.evaluate(`(() => { const c = ${card}; const a = c._objects.anchors().find((x) => x.id === 'lamp_hall');
    return a && c._view.projectWorld(a.world); })()`);
  const hall = () => page.evaluate(`${card}._hass.states['light.demo_hall'].state`);
  const calls = () => page.evaluate('(window.__serviceCalls || []).length');
  let p = await at();
  check('lamp anchor projects onto the screen', !!p, JSON.stringify(p));
  const before = await hall();
  await page.mouse.click(p[0] + 12, p[1] + 8); // within 30 px
  await sleep(200);
  check('tap near the lamp toggles its light', (await hall()) !== before, `${before} -> ${await hall()}`);
  check('the bound light has no marker of its own', !(await page.evaluate(`${card}._markers.some((m) => m.entityId === 'light.demo_hall')`)));
  const n0 = await calls();
  p = await at();
  await page.mouse.move(p[0], p[1]);
  await page.mouse.down();
  await page.mouse.move(p[0] + 40, p[1] + 10, { steps: 5 });
  await page.mouse.up();
  await sleep(200);
  check('a drag that starts on the lamp (orbit) never toggles', (await calls()) === n0);
  await settle(page, card);
  p = await at();
  await page.mouse.move(p[0], p[1]);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await sleep(200);
  const pop = () => page.evaluate(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-popup');
    return el && { title: el.querySelector('.fp-pop-title').textContent, rows: [...el.querySelectorAll('.fp-pop-row')].map((r) => r.className.replace('fp-pop-row ', '')),
      vis: el.style.visibility, t: el.style.transform }; })()`);
  let pp = await pop();
  check('hold opens the popup (toggle + brightness) without toggling', !!pp && pp.title === 'Hall ceiling lamp' && pp.rows.join() === 'toggle,brightness' && pp.vis !== 'hidden' && (await calls()) === n0, JSON.stringify(pp));
  await page.screenshot({ path: path.join(root, 'screenshots', 'object-popup.png') });
  await page.evaluate(`(() => { const r = ${card}.shadowRoot.querySelector('.fp-popup .brightness input'); r.value = '100'; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const last = await page.evaluate('JSON.stringify(window.__serviceCalls[window.__serviceCalls.length - 1])');
  check('brightness slider sends light.turn_on once on release', last === JSON.stringify(['light', 'turn_on', { entity_id: 'light.demo_hall', brightness: 100 }]), last);
  const st1 = await hall();
  await page.evaluate(`${card}.shadowRoot.querySelector('.fp-popup .toggle .fp-switch').click()`);
  await sleep(200);
  pp = await pop();
  check('popup switch toggles and the popup stays open', (await hall()) !== st1 && !!pp, `${st1} -> ${await hall()}`);
  await page.keyboard.press('Escape');
  await sleep(100);
  check('Esc closes the popup', !(await pop()));
  // the tap that closes the popup does not also act (tap on the lamp itself)
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await sleep(100);
  const n2 = await calls();
  await page.mouse.click(p[0], p[1]);
  await sleep(200);
  check('a tap that closes the popup does not toggle', !(await pop()) && (await calls()) === n2);
  // popup hidden while its anchor is off-screen
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await sleep(100);
  const cam0 = await page.evaluate(`${card}._view.getCamera()`);
  await page.evaluate(`(() => { const v = ${card}._view; const c = v.getCamera();
    const d = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
    v.setCamera({ position: c.position, target: [c.position[0] - d[0], c.position[1] - d[1], c.position[2] - d[2]] }, { instant: true }); })()`);
  await sleep(300);
  pp = await pop();
  check('popup hidden while its anchor is behind the camera', !!pp && pp.vis === 'hidden', JSON.stringify(pp));
  await page.keyboard.press('Escape');
  await page.evaluate(`${card}._view.setCamera(${JSON.stringify(cam0)}, { instant: true })`);
  await sleep(300);
  // popup closes on outside tap and on view change
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await sleep(100);
  await page.mouse.click(30, 520);
  await sleep(100);
  check('outside tap closes the popup', !(await pop()));
  p = await at();
  await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await sleep(100);
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`);
  await sleep(100);
  check('view change closes the popup', !(await pop()));
  // edit mode: object taps are off until the Objects tab exists
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
  await sleep(300);
  const n1 = await calls();
  p = await at();
  if (p) await page.mouse.click(p[0], p[1]);
  await sleep(200);
  check('edit mode: tapping the lamp does not toggle it', (await calls()) === n1);
  {
  // Objects tab (edit mode)
  const sr = `${card}.shadowRoot`;
  const tabBtn = () => page.evaluate(`!![...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Objects')`);
  check('Objects tab is shown (the model has objects)', await tabBtn());
  check('Objects tab sits after Devices', await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].map((b) => b.textContent.trim()).slice(0, 3).join()`) === 'Rooms,Devices,Objects');
  await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Objects').click()`);
  await sleep(200);
  check('rooms start collapsed (no object rows)', (await page.evaluate(`${sr}.querySelectorAll('li.obj').length`)) === 0);
  // click the lamp in 3D: selects (expands) its row, does not toggle
  const nObj = await calls();
  const hall0 = await hall();
  p = await at();
  await page.mouse.click(p[0], p[1]);
  await sleep(300);
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
  await sleep(300);
  const bound = () => page.evaluate(`(() => { const b = ${card}._bindings.get('lamp_hall'); const o = ${card}._objects.objectAt('lamp_hall'); return { cfg: ${card}._layout.objects && ${card}._layout.objects.lamp_hall, e: b.entity, layer: o.binding.entity }; })()`);
  let bd = await bound();
  check('changing the entity rebinds the object', bd.e === other && bd.layer === other && bd.cfg && bd.cfg.entity === other, JSON.stringify(bd));
  await setEntity('light.does_not_exist');
  await sleep(300);
  ri = await rowInfo();
  check('an unknown entity shows "entity not found"', !!ri && ri.badge === 'entity not found', JSON.stringify(ri));
  const hasTest = () => page.evaluate(`!!${sr}.querySelector('li.obj[data-obj=lamp_hall] button[data-act=obj-test]')`);
  check('no Test button on an unbound row', !(await hasTest()));
  await setEntity('');
  await sleep(300);
  bd = await bound();
  check('clearing the entity returns to auto', bd.e === 'light.demo_hall' && !bd.cfg, JSON.stringify(bd));
  // Test toggles through callService
  const c0 = await calls();
  const h0 = await hall();
  await page.evaluate(`${sr}.querySelector('li.obj[data-obj=lamp_hall] button[data-act=obj-test]').click()`);
  await sleep(200);
  check('Test toggles the bound light', (await calls()) === c0 + 1 && (await hall()) !== h0, `${c0} -> ${await calls()}`);
  // Hide
  await page.evaluate(`(() => { const c = ${sr}.querySelector('[data-field=obj-hidden][data-id=lamp_hall]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  check('hide marks the object hidden', await page.evaluate(`!!${card}._bindings.get('lamp_hall').hidden && ${card}._layout.objects.lamp_hall.hidden === true`));
  check('no Test button on a hidden row', !(await hasTest()));
  await page.evaluate(`(() => { const c = ${sr}.querySelector('[data-field=obj-hidden][data-id=lamp_hall]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  check('un-hide drops the entry', await page.evaluate(`!${card}._bindings.get('lamp_hall').hidden && !(${card}._layout.objects || {}).lamp_hall`));
  check('Test button back on the bound row', await hasTest());
  await page.screenshot({ path: path.join(root, 'screenshots', 'objects-tab.png') });
  // leaving the tab turns object taps off again
  await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Devices').click()`);
  await sleep(200);
  check('object taps are off again outside the Objects tab', await page.evaluate(`!${card}._objectTapsOn()`));
  }
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 1b2. HA-style actions from the card YAML: navigate on tap, perform-action on hold, double tap on one
// object never delays single taps on another, missing target -> message, confirmation, popup links, markers
s = await openDemo({ model: '1', view: '3d' }, { width: 1400, height: 560 });
try {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, { timeout: 10000 });
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
    await page.waitForFunction(`!!${card}._view.model && ${card}._objects.parts.size > 0`, { timeout: 10000 });
    await settle(page, card);
  };
  const at = (id) => page.evaluate(`(() => { const c = ${card}, a = c._objects.anchorOf(${JSON.stringify(id)}); return a && c._view.projectWorld(a); })()`);
  const calls = () => page.evaluate('(window.__serviceCalls || []).length');
  const lastCall = () => page.evaluate('JSON.stringify((window.__serviceCalls || []).slice(-1)[0] || null)');
  const hold = async (p) => { await page.mouse.move(p[0], p[1]); await page.mouse.down(); await sleep(700); await page.mouse.up(); await sleep(150); };

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
  await sleep(200);
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
  await sleep(50);
  const early = await since(k);
  const hallCall = early.find((x) => x.c[2] && x.c[2].entity_id === 'light.demo_hall');
  check('actions: a single tap on another object is not delayed by a pending double tap',
    !!hallCall && hallCall.t - tUp < 100 && !early.some((x) => x.c[2] && x.c[2].entity_id === 'light.demo_living'), JSON.stringify(early.map((x) => [x.c[2], Math.round(x.t - tUp)])));
  await sleep(400);
  let later = (await since(k)).map((x) => x.c);
  check('actions: the pending single tap runs after 250 ms (toggle)', later.some((c) => c[1] === 'toggle' && c[2].entity_id === 'light.demo_living'), JSON.stringify(later));
  k = await calls();
  await page.mouse.click(pl[0], pl[1]);
  await sleep(60);
  await page.mouse.click(pl[0], pl[1]);
  await sleep(400);
  later = (await since(k)).map((x) => x.c);
  check('actions: a double tap runs the double_tap_action only', later.length === 1 && later[0][1] === 'turn_off' && later[0][3].entity_id === 'light.demo_living', JSON.stringify(later));

  // confirmation: an in-card dialog, nothing until OK
  await setActions({ 'object:lamp_hall': { tap_action: { action: 'toggle', confirmation: { text: 'Toggle the hall?' } } } });
  n0 = await calls();
  p = await at('lamp_hall');
  await page.mouse.click(p[0], p[1]);
  await sleep(150);
  const dlg = await page.evaluate(`(() => { const d = ${card}.shadowRoot.querySelector('.fp-confirm'); return d && d.textContent; })()`);
  check('actions: confirmation shows an in-card dialog, no call yet', /Toggle the hall\?/.test(dlg || '') && (await calls()) === n0, String(dlg));
  await page.evaluate(`${card}.shadowRoot.querySelector('.fp-confirm [data-c=yes]').click()`);
  await sleep(100);
  check('actions: OK runs the action and closes the dialog', (await calls()) === n0 + 1 && !(await page.evaluate(`!!${card}.shadowRoot.querySelector('.fp-confirm')`)), await lastCall());

  // popup links: history from the YAML popup list
  await setActions({ 'object:lamp_hall': { popup: ['toggle', 'history', { label: 'Lights view', navigate: '/fp-test/lights' }] } });
  p = await at('lamp_hall');
  await hold(p);
  const links = await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.fp-popup .fp-pop-row.link')].map((r) => r.textContent.trim())`);
  check('actions: popup shows the link rows at the bottom', links.join() === 'History,Lights view', JSON.stringify(links));
  await page.screenshot({ path: path.join(root, 'screenshots', 'object-popup-links.png') });
  await page.evaluate(`${card}.shadowRoot.querySelector('.fp-popup .fp-pop-link').click()`);
  await sleep(100);
  check('actions: the History link navigates to /history?entity_id=…', (await page.evaluate('window.__locs.at(-1)')) === '/history?entity_id=light.demo_hall', await page.evaluate('window.__locs.at(-1)'));
  await page.evaluate(`history.replaceState(null, '', ${JSON.stringify(origin)})`);
  await page.keyboard.press('Escape');

  // markers: YAML keyed by entity id (a marker away from model objects: objects win a tap under the finger)
  const mk = await page.evaluate(`(() => { const c = ${card}; const m = c._markers.find((x) => { const el = c._markerEls.get(x.id); if (!el) return false;
    const r = el.querySelector('.fp-dot').getBoundingClientRect(); return r.width > 0 && el.offsetParent && !c._objectHit(r.x + r.width / 2, r.y + r.height / 2, 30); });
    if (!m) return null; const r = c._markerEls.get(m.id).querySelector('.fp-dot').getBoundingClientRect(); return { e: m.entityId, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (mk) {
    await setActions({ [mk.e]: { tap_action: { action: 'navigate', navigation_path: '/fp-test/marker' } } });
    const r = await page.evaluate(`(() => { const c = ${card}; const m = c._markers.find((x) => x.entityId === ${JSON.stringify(mk.e)}); const b = c._markerEls.get(m.id).querySelector('.fp-dot').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    await page.mouse.click(r[0], r[1]);
    await sleep(150);
    check('actions: a marker tap runs its YAML tap_action (navigate)', (await page.evaluate('window.__locs.at(-1)')) === '/fp-test/marker', `${mk.e}: ${await page.evaluate('window.__locs.at(-1)')}`);
    await page.evaluate(`history.replaceState(null, '', ${JSON.stringify(origin)})`);
  } else check('actions: a visible marker exists for the marker check', false);
  await setActions(undefined);
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 1c. mower object: the model node follows the live position, the mower marker is gone (the demo model's mower)
s = await openDemo({ model: '1', view: '3d' }, { width: 1400, height: 560 });
try {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, { timeout: 10000 });
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
  // the demo model's climate unit shows its temperature as a label
  await page.waitForFunction(`[...${card}.shadowRoot.querySelectorAll('.fp-obj-label')].some((x) => x.textContent.includes('21.5'))`, { timeout: 3000 }).catch(() => {});
  const lbl = await page.evaluate(`(() => { const e = [...${card}.shadowRoot.querySelectorAll('.fp-obj-label')].find((x) => x.textContent.includes('21.5')); return e ? e.textContent : null; })()`);
  check('climate object shows a temperature label', !!lbl, String(lbl));
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 1d. the demo model's objects: automatic binding, glow + pool lights, light / shadow budget, the facade group
// and its controller, dock / charger looks, lights: off, idle updates (no budget or shadow work)
s = await openDemo({ model: '1', view: '3d' }, { width: 1400, height: 560 });
try {
  const { page } = s;
  await page.waitForFunction(`!!${card}._view.model && !!${card}._hass && ${card}._objects.parts.size > 0`, { timeout: 10000 });
  await page.evaluate('window.__demoMowerPaused = true');
  await page.evaluate(`${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  const BOUND = {
    lamp_living: 'light.demo_living', lamp_hall: 'light.demo_hall', lamp_kitchen: 'light.demo_kitchen', kitchen_strip: 'light.demo_strip',
    facade_1: 'light.demo_facade', facade_2: 'light.demo_facade', facade_3: 'light.demo_facade', terrace_spot: 'light.demo_terrace',
    climate_living: 'climate.demo_living', mower: 'lawn_mower.demo', dock: 'lawn_mower.demo', ev_charger: 'sensor.demo_charger',
  };
  const binds = await page.evaluate(`Object.fromEntries([...${card}._bindings].map(([id, b]) => [id, b.entity]))`);
  check('demo objects: all 12 bind automatically from suggest.entity',
    Object.keys(binds).length === 12 && Object.entries(BOUND).every(([id, e]) => binds[id] === e), JSON.stringify(binds));
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
    const spot = l.pool.spots.find((x) => x.intensity > 0);
    return { lit: lit.length, shadows: lit.filter((x) => x.castShadow).length, slots: [...l._slots.keys()],
      near: Object.fromEntries(ids.map((id) => [id, near(id)])), glow: Object.fromEntries(ids.map((id) => [id, glow(id)])),
      spotTarget: spot ? spot.target.position.toArray() : null,
      facadeLit: lit.filter((x) => ['facade_1', 'facade_2', 'facade_3'].some((id) => x.position.distanceTo(l.anchorOf(id)) < 0.05)).length }; })()`);
  let L = await look();
  check('lamp on: glow emissive and a pool light with intensity > 0 at the lamp', L.glow.lamp_living > 0 && L.near.lamp_living.length === 1 && L.near.lamp_living[0] > 0, JSON.stringify({ g: L.glow.lamp_living, n: L.near.lamp_living }));
  check('lamp off: no glow, no pool light', L.glow.lamp_hall === 0 && L.near.lamp_hall.length === 0, JSON.stringify({ g: L.glow.lamp_hall, n: L.near.lamp_hall }));
  check('at most 12 pool lights lit, at most 4 of them casting shadows', L.lit > 0 && L.lit <= 12 && L.shadows <= 4, JSON.stringify({ lit: L.lit, shadows: L.shadows }));
  check('facade group on: exactly one pool light for the three fixtures, all three glow',
    L.facadeLit === 1 && L.slots.filter((x) => x.startsWith('facade_')).length === 1 && ['facade_1', 'facade_2', 'facade_3'].every((id) => L.glow[id] > 0), JSON.stringify({ f: L.facadeLit, slots: L.slots }));
  check('terrace spot: a lit spot light aimed at its hints.target', L.near.terrace_spot.length === 1 && !!L.spotTarget && Math.hypot(L.spotTarget[0] - 2.5, L.spotTarget[1], L.spotTarget[2] - 1.5) < 0.05, JSON.stringify({ n: L.near.terrace_spot, t: L.spotTarget }));
  check('light strip: glows, no real light (no hints.max)', L.glow.kitchen_strip > 0 && L.near.kitchen_strip.length === 0, JSON.stringify({ g: L.glow.kitchen_strip, n: L.near.kitchen_strip }));
  check('EV charger charging: LED lit, power label', L.glow.ev_charger > 0 && (await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.fp-obj-label')].some((x) => x.textContent.includes('7.4 kW'))`)), JSON.stringify(L.glow.ev_charger));
  check('dock LED dark while the mower mows', L.glow.dock === 0, String(L.glow.dock));
  const setState = (e, state, attrs) => page.evaluate(`(() => { const c = ${card}, st = c._hass.states, s = st[${JSON.stringify(e)}];
    c.hass = { ...c._hass, states: { ...st, [${JSON.stringify(e)}]: { ...s, state: ${JSON.stringify(state)}, attributes: { ...s.attributes, ...${JSON.stringify(attrs || {})} } } } }; })()`);
  await setState('lawn_mower.demo', 'docked');
  await sleep(150);
  check('dock LED lit once the mower is docked', (await look()).glow.dock > 0);
  await setState('lawn_mower.demo', 'mowing');
  // brightness: the pool light follows (bri / 255 x hints.max)
  await page.evaluate(`${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_living', brightness: 51 })`);
  await sleep(200);
  L = await look();
  check('brightness 51 -> the lamp\'s pool light at 51/255 x max 20 = 4', L.near.lamp_living.length === 1 && Math.abs(L.near.lamp_living[0] - 4) < 0.05, JSON.stringify(L.near.lamp_living));
  // a tap on the lamp toggles its entity (the mock records callService)
  const lampAt = (id) => page.evaluate(`(() => { const c = ${card}, a = c._objects.anchorOf(${JSON.stringify(id)}); return a && c._view.projectWorld(a); })()`);
  let p = await lampAt('lamp_living');
  const calls0 = await page.evaluate('(window.__serviceCalls || []).length');
  if (p) await page.mouse.click(p[0], p[1]);
  await sleep(200);
  const lastCall = await page.evaluate('JSON.stringify((window.__serviceCalls || []).slice(-1)[0] || null)');
  check('a tap on the living lamp calls light.toggle for light.demo_living', !!p && (await page.evaluate('(window.__serviceCalls || []).length')) === calls0 + 1
    && lastCall === JSON.stringify(['light', 'toggle', { entity_id: 'light.demo_living' }]), lastCall);
  check('toggled off: its glow and pool light are gone', await look().then((x) => x.glow.lamp_living === 0 && x.near.lamp_living.length === 0));
  await page.evaluate(`${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_living' })`);
  await sleep(150);
  // group controller off: the fixtures go dark, the popup says why
  await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
  await sleep(200);
  L = await look();
  check('group controller off: facade fixtures dark, no pool light (own light still on)',
    ['facade_1', 'facade_2', 'facade_3'].every((id) => L.glow[id] === 0) && L.facadeLit === 0 && (await page.evaluate(`${card}._hass.states['light.demo_facade'].state`)) === 'on', JSON.stringify(L.glow));
  await page.evaluate(`${card}._runObjectAction('facade_2', 'hold')`);
  await sleep(150);
  const popText = await page.evaluate(`(${card}.shadowRoot.querySelector('.fp-popup') || {}).textContent || ''`);
  check('popup of a dark facade lamp says the group switch is off', popText.includes('Facade switch is off'), popText.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: path.join(root, 'screenshots', 'object-group-popup.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
  await sleep(200);
  check('group controller on again: the facade lights up', (await look()).facadeLit === 1);
  // ten state updates that touch no object: no budget recompute, no object re-evaluation, no shadow redraw
  await sleep(300);
  const counters = () => page.evaluate(`({ ...${card}._objects.stats, shadow: ${card}._view.stats.shadow, frames: ${card}._view.stats.frames, shadowLights: ${card}._view.stats.shadowLights })`);
  const c0 = await counters();
  for (let i = 0; i < 10; i++) {
    await page.evaluate(`(() => { const c = ${card}, st = c._hass.states, t = st['sensor.kitchen_temperature'];
      c.hass = { ...c._hass, states: { ...st, 'sensor.kitchen_temperature': { ...t, state: String(18 + ${i}) } } }; })()`);
    await sleep(40);
  }
  await sleep(300);
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
  await sleep(200);
  await page.evaluate(`${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`);
  await sleep(200);
  let sf1 = await shadowFlags();
  check('facade group (no shadow slot) off and on: no shadow map redrawn', sf1.n === sf0.n, JSON.stringify({ sf0: sf0.n, sf1: sf1.n }));
  await page.evaluate(`${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_hall' })`);
  await sleep(200);
  sf1 = await shadowFlags();
  check('hall lamp on: at most its own shadow map (lit ones keep their slots)', sf1.n - sf0.n <= 1, JSON.stringify({ sf0: sf0.n, sf1: sf1.n }));
  await page.evaluate(`${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_hall' })`);
  await sleep(200);
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
  await sleep(200);
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
  await sleep(300);
  await page.screenshot({ path: path.join(root, 'screenshots', 'objects-night.png') });
  sf0 = await shadowFlags();
  await page.evaluate('window.__setDemoSun(-25, 230)');
  await sleep(300);
  sf1 = await shadowFlags();
  check('sun below the horizon moving 30 deg: its shadow map is not redrawn', sf1.n === sf0.n, JSON.stringify({ sf0: sf0.n, sf1: sf1.n }));
  await page.evaluate('window.__setDemoSun(20, 230)');
  await sleep(300);
  check('sunrise: the sun shadow map is redrawn', (await shadowFlags()).n > sf1.n);
  await page.evaluate('window.__setDemoSun(-20, 200)');
  await sleep(300);
  // lights: off -> emissive only
  await page.evaluate(`${card}.setConfig({ ...${card}._config, lights: 'off' })`);
  await page.waitForFunction(`!!${card}._view.model && ${card}._objects.parts.size > 0`, { timeout: 10000 });
  await sleep(400);
  L = await look();
  check('lights: off -> every pool light at intensity 0, lamps still glow', L.lit === 0 && L.glow.lamp_living > 0, JSON.stringify({ lit: L.lit, g: L.glow.lamp_living }));
  const sceneLights = () => page.evaluate(`(() => { const c = ${card}, pool = new Set([...c._objects.pool.points, ...c._objects.pool.spots]); let n = 0, labels = 0;
    c._view.scene.traverseVisible((o) => { if (pool.has(o)) n++; });
    c._view.objectsGroup.traverseVisible((o) => { if (o.isCSS2DObject) labels++; });
    return { pool: n, labels }; })()`);
  const SL = await sceneLights();
  check('lights: off -> no pool light in the scene (sub-group hidden), object labels still shown', SL.pool === 0 && SL.labels > 0, JSON.stringify(SL));
  await page.evaluate(`${card}.setConfig({ ...${card}._config, lights: 'auto' })`);
  await sleep(400);
  check('lights: auto again -> pool lights back', (await look()).lit > 0 && (await sceneLights()).pool === 12);
  // Objects tab: every row bound (no "entity not found"); the group controller field
  await page.evaluate('window.__setDemoSun(30, 180)');
  const sr = `${card}.shadowRoot`;
  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await sleep(300);
  await page.evaluate(`[...${sr}.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Objects').click()`);
  await sleep(200);
  for (let i = 0; i < 20; i++) {
    const opened = await page.evaluate(`(() => { const b = [...${sr}.querySelectorAll('[data-act=obj-expand]')].find((x) => x.textContent.trim() === '▸'); if (b) b.click(); return !!b; })()`);
    if (!opened) break;
    await sleep(80);
  }
  const rows = await page.evaluate(`[...${sr}.querySelectorAll('li.obj')].map((li) => ({ id: li.dataset.obj, badge: (li.querySelector('.badge') || {}).textContent || '', test: !!li.querySelector('[data-act=obj-test]') }))`);
  check('Objects tab: 12 rows, all "auto", none "entity not found"', rows.length === 12 && rows.every((r) => r.badge === 'auto'), JSON.stringify(rows));
  check('Objects tab: lamps have a Test button', ['lamp_living', 'facade_1', 'terrace_spot'].every((id) => (rows.find((r) => r.id === id) || {}).test));
  const grp = () => page.evaluate(`(() => { const g = ${sr}.querySelector('label.grp[data-grp=facade]'); return g && { warn: !!g.querySelector('.badge.warn'), val: g.querySelector('input').value,
    saved: JSON.stringify((${card}._layout.groups || {}).facade || null), eff: JSON.stringify(${card}._groups.facade || null) }; })()`);
  const setGrp = async (v) => { await page.evaluate(`(() => { const i = ${sr}.querySelector('[data-field=grp-entity][data-id=facade]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(250); };
  let g = await grp();
  check('Groups: facade controller switch.demo_facade, found', !!g && !g.warn && g.val === 'switch.demo_facade', JSON.stringify(g));
  await page.evaluate(`${card}._hass.callService('switch', 'turn_off', { entity_id: 'switch.demo_facade' })`);
  await sleep(200);
  await setGrp('switch.demo_typo');
  g = await grp();
  check('Groups: a controller HA does not know shows "entity not found" and is ignored by the chain',
    !!g && g.warn && g.eff === 'null' && (await look()).facadeLit === 1, JSON.stringify(g));
  await setGrp('none');
  g = await grp();
  check('Groups: "none" removes the controller (nothing stored)', !!g && g.saved === 'null' && g.val === '' && !g.warn, JSON.stringify(g));
  await setGrp('switch.demo_facade');
  g = await grp();
  check('Groups: controller back, the switch is off -> facade dark', !!g && !g.warn && (await look()).facadeLit === 0, JSON.stringify(g));
  await page.screenshot({ path: path.join(root, 'screenshots', 'objects-tab-demo.png') });
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 2. missing model
s = await openDemo({ model: '/demo/missing.glb' });
try {
  await s.page.waitForFunction(`!${card}.shadowRoot.querySelector('.notice').hidden`, { timeout: 10000 });
  const text = await s.page.evaluate(`${card}.shadowRoot.querySelector('.notice').textContent`);
  check('missing model shows a notice', text.includes('missing.glb'), text);
  check('card still renders markers', (await s.page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-marker').length`)) > 0);
  allErrors.push(...s.errors.filter((e) => !e.includes('missing.glb') && !e.includes('404')));
} finally {
  await s.close();
}

// 2b. upload a model in edit mode (Model tab), align it, remove it
s = await openDemo({ view: '3d', height: '560px' }, { width: 1500, height: 680 });
try {
  const { page } = s;
  const panel = (sel) => `${card}.shadowRoot.querySelector(".panel ${sel}")`;
  const clickText = (t) => page.evaluate((t) => {
    const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === t);
    if (b) b.click();
    return !!b;
  }, t);
  await page.evaluate(`${card}.shadowRoot.querySelector("button.edit").click()`);
  await sleep(200);
  await clickText('Model');
  await sleep(150);
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
  await page.waitForFunction(`!!${card}._view.model`, { timeout: 10000 });
  await sleep(300);
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
  await sleep(150);
  check('rotation slider turns the model', Math.round(await page.evaluate(`${card}._view.modelGroup.rotation.y * 180 / Math.PI`)) === 90);
  check('opacity applied', await page.evaluate(`(() => { let o; ${card}._view.model.root.traverse((m) => { if (m.isMesh && o === undefined) o = m.material.opacity; }); return o === 0.5; })()`));
  check('slider kept (no re-render)', await page.evaluate(`${panel('[data-field=md-rotation]')}.value === "90"`));
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = "0"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(200);
  await page.screenshot({ path: path.join(root, 'screenshots/model-upload.png') });
  // rotation moves the rooms with the model
  const k0 = await page.evaluate(`JSON.stringify(${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon[1])`);
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = '90'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  check('rotation moves rooms', (await page.evaluate(`JSON.stringify(${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon[1])`)) !== k0);
  await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  // a marker dropped on the model follows the model's alignment
  {
    await page.evaluate(`${card}._setMode('3d'); ${card}._setFloor('ground'); ${card}._view.fit({ model: true, instant: true })`);
    await clickText('Devices'); // markers are draggable here (the Model tab picks the model instead)
    await sleep(400);
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
    await sleep(300);
    const pin0 = await page.evaluate(`${card}._layout.pins[${JSON.stringify(pick.id)}]`);
    await clickText('Model'); // alignment sliders
    await sleep(200);
    check('pin dropped on the model has on_model', !!(pin0 && pin0.on_model), JSON.stringify(pin0));
    const align = () => page.evaluate(`(() => { const m = ${card}._layout.model; return { position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1 }; })()`);
    const a0 = await align();
    await page.evaluate(`(() => { const s = ${panel('[data-field=md-rotation]')}; s.value = "30"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(300);
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
    await sleep(200);
    const pin2 = await page.evaluate(`${card}._layout.pins[${JSON.stringify(pick.id)}]`);
    check('rotating back restores the pin', Math.hypot(pin2.x - pin0.x, pin2.y - pin0.y) <= 0.001, JSON.stringify(pin2));
    await page.evaluate(`(() => { const c = ${card}; const pins = { ...c._layout.pins }; delete pins[${JSON.stringify(pick.id)}]; c._commit({ ...c._layout, pins }); })()`);
  }
  // assign a room to no area
  await page.evaluate(`(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-room][data-id=kitchen]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  check('room binding saved', JSON.stringify(await page.evaluate(`${card}._layout.model.rooms`)) === '{"kitchen":{"area":null}}', JSON.stringify(await page.evaluate(`${card}._layout.model.rooms`)));
  // click to pick: the kitchen floor in top view
  await page.evaluate(`${card}._setMode('top')`);
  await page.evaluate(`${card}._view.fit({ model: true })`);
  await sleep(300);
  const pt = await page.evaluate(`${card}._view.screenPoint(9.5, 2, 0, 'ground')`);
  await page.mouse.click(pt[0], pt[1]);
  await sleep(200);
  check('click picks the room', JSON.stringify(await page.evaluate(`${card}._edit.modelPick`)) === '{"kind":"room","id":"kitchen"}'
    && await page.evaluate(`!!${card}.shadowRoot.querySelector('tr.sel[data-pick="room:kitchen"]')`), JSON.stringify(await page.evaluate(`${card}._edit.modelPick`)));
  await page.evaluate(`${card}._setMode('3d')`);
  await sleep(200);
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
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.some((l) => l.id === 'lvl_a0')`, { timeout: 10000 });
  await sleep(300);
  fs.unlinkSync(renamed);
  check('renamed levels still map by order', (await lv()) === JSON.stringify({ lvl_a0: 'with:ground', lvl_a1: 'with:first', exterior: 'always:ground', roof: 'all-only:null' }), await lv());
  const vis = () => page.evaluate(`(() => { const l = ${card}._view.modelManifest().levels; return [l[0].node.visible, l[1].node.visible]; })()`);
  check('ground shows its own storey only', JSON.stringify(await vis()) === '[true,false]');
  // legacy show modes (written before levels became "belongs to HA floor") stay readable
  const setLevel = (id, b) => page.evaluate(`${card}._edit.setModelProps({ levels: { ...(${card}._layout.model.levels || {}), ${JSON.stringify(id)}: ${JSON.stringify(b)} } })`);
  const selectLevel = (id, value) => page.evaluate(`(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-level][data-id=${id}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setLevel('exterior', { show: 'always', floor: 'ground' });
  await sleep(300);
  check('exterior "always" keeps its zones', await page.evaluate(`${card}._modelRooms.some((r) => r.id === 'm:garden')`)
    && JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)) === '{"show":"always","floor":"ground"}', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)));
  check('exterior "always" does not remap storeys', (await lv()) === JSON.stringify({ exterior: 'always:ground', lvl_a0: 'with:ground', lvl_a1: 'with:first', roof: 'all-only:null' }), await lv());
  check('legacy show mode reads as its floor in the dropdown', await page.evaluate(`${card}.shadowRoot.querySelector('[data-field=md-level][data-id=exterior]').value === 'floor:ground'`));
  await setLevel('exterior', { show: 'hidden', floor: 'ground' });
  await sleep(300);
  check('exterior "hidden" does not remap storeys', (await lv()) === JSON.stringify({ exterior: 'hidden:ground', lvl_a0: 'with:ground', lvl_a1: 'with:first', roof: 'all-only:null' }), await lv());
  await selectLevel('exterior', 'auto');
  await sleep(200);
  check('mapped level visible on its floor', JSON.stringify(await vis()) === '[true,false]');
  check('level rows marked auto', (await page.evaluate(`${panel('table.floors')}.textContent`)).includes('auto'));
  check('level dropdown: auto, HA floors, no floor', (await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('[data-field=md-level][data-id=exterior] option')].map((o) => o.value).join()`)) === 'auto,floor:ground,floor:first,none',
    await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('[data-field=md-level][data-id=exterior] option')].map((o) => o.value).join()`));
  await selectLevel('exterior', 'none');
  await sleep(200);
  check('"no floor" writes { floor: null }', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)) === '{"floor":null}'
    && JSON.parse(await lv()).exterior === 'always:null' && await page.evaluate(`${card}.shadowRoot.querySelector('[data-field=md-level][data-id=exterior]').value === 'none'`), await lv());
  await selectLevel('exterior', 'floor:first');
  await sleep(200);
  check('choosing a floor writes { floor }', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.exterior`)) === '{"floor":"first"}');
  await selectLevel('exterior', 'auto');
  await setLevel('lvl_a1', { show: 'always', floor: 'first' });
  await sleep(200);
  check('legacy "always shown"', JSON.stringify(await page.evaluate(`${card}._layout.model.levels.lvl_a1`)).includes('"always"') && JSON.stringify(await vis()) === '[true,true]', JSON.stringify(await page.evaluate(`${card}._layout.model.levels`)));
  await setLevel('lvl_a0', { show: 'hidden', floor: 'ground' });
  await sleep(200);
  check('legacy "hidden"', JSON.stringify(await vis()) === '[false,true]');
  await selectLevel('lvl_a0', 'auto');
  await sleep(200);
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
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 0`, { timeout: 10000 });
  fs.unlinkSync(untagged);
  check('untagged model loads whole', await page.evaluate(`${card}._view.model.root.visible && ${card}._modelRooms.length === 0`));
  await sleep(200);
  check('stale bindings offered for forgetting', await page.evaluate(`!!${card}.shadowRoot.querySelector('[data-act=md-forget]')`));
  await page.evaluate(`${card}.shadowRoot.querySelector('[data-act=md-forget]').click()`);
  await sleep(200);
  await upload(path.join(root, 'demo', 'house.glb'));
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.length === 4`, { timeout: 10000 });
  await sleep(300);
  const cam0 = await page.evaluate(`${card}._view.camera.position.toArray().join()`);
  await clickText('Frame model');
  await sleep(200);
  check('frame model moves the camera', (await page.evaluate(`${card}._view.camera.position.toArray().join()`)) !== cam0);
  // day/night survives a model reload
  const dn = `${card}.shadowRoot.querySelector('button.daynight')`;
  const skyTo = async (m) => { for (let i = 0; i < 3 && (await page.evaluate(`${card}._skyMode`)) !== m; i++) await page.evaluate(`${dn}.click()`); };
  await skyTo('night');
  await upload(path.join(root, 'demo', 'house.glb'));
  await sleep(1500);
  check('night kept after re-upload', (await page.evaluate(`${card}._skyMode`)) === 'night' && (await page.evaluate(`${card}._view.sun.intensity`)) === 0);
  await skyTo('day');
  await sleep(200);
  check('back to day', (await page.evaluate(`${card}._view.sun.intensity`)) > 1 && (await page.evaluate(`${card}._view.sun.castShadow`)) === true);

  // legacy model (no fp tags, floor:<id> / site / roof names): auto mapping, per-chip visibility, no regeneration notice
  const legacy = path.join(root, 'screenshots', 'legacy.glb');
  const legacyNames = { level0: 'floor:ground', level1: 'floor:first', exterior: 'site' };
  fs.writeFileSync(legacy, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) { delete n.extras; if (legacyNames[n.name]) n.name = legacyNames[n.name]; }
    return json;
  }));
  await upload(legacy);
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.some((l) => l.id === 'site')`, { timeout: 10000 });
  await sleep(400);
  fs.unlinkSync(legacy);
  check('legacy names read as levels', (await page.evaluate(`${card}._view.modelManifest().levels.map((l) => l.id).join()`)) === 'ground,first,site,roof',
    await page.evaluate(`${card}._view.modelManifest().levels.map((l) => l.id).join()`));
  check('legacy levels map automatically', (await lv()) === JSON.stringify({ ground: 'with:ground', first: 'with:first', site: 'always:ground', roof: 'all-only:null' }), await lv());
  const legacyVis = () => page.evaluate(`(() => { const l = ${card}._view.modelManifest().levels; return [l[0].node.visible, l[1].node.visible]; })()`);
  await page.evaluate(`${card}._setFloor('ground')`);
  await sleep(300);
  check('legacy: ground chip shows ground only', JSON.stringify(await legacyVis()) === '[true,false]');
  const storeyTop = (id) => page.evaluate(`(() => { const f = ${card}._floors.find((x) => x.id === ${JSON.stringify(id)}); return f.elevation + (f.height || 2.7); })()`);
  check('legacy: cut at the top of the ground storey (not the 1 m wall height)', Math.abs((await page.evaluate(`${card}._view.modelClip.constant`)) - (await storeyTop('ground'))) < 1e-6 && (await storeyTop('ground')) > 2,
    `${await page.evaluate(`${card}._view.modelClip.constant`)} vs ${await storeyTop('ground')}`);
  await page.evaluate(`${card}._setFloor('first')`);
  await sleep(300);
  check('legacy: first chip stacks the storeys', JSON.stringify(await legacyVis()) === '[true,true]');
  await clickText('Data');
  await clickText('Model');
  await sleep(200);
  check('no "Since the last setup" notice after upload', !(await page.evaluate(`${panel('')}.textContent`)).includes('Since the last setup'));

  // importing a plan export keeps the uploaded model and the view settings, and maps foreign floor ids onto HA floors
  await page.evaluate(`${card}.saveViewPatch(${card}._viewId, { label: 'Kept view' })`);
  await sleep(200);
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
  await sleep(150);
  await clickText('Model');
  await sleep(150);
  await clickText('Remove model');
  await clickText('Really remove?');
  await sleep(300);
  check('remove clears model', (await page.evaluate(`${card}._layout.model`)) === null && !(await page.evaluate(`${card}._view.model`)));
  check('removal resets the look', await page.evaluate(`(() => { const c = ${card}; return !c._stage.classList.contains('has-model')
    && c.shadowRoot.querySelector('button.daynight').hidden && c._view.renderer.toneMapping === 0 && c._view.renderer.shadowMap.enabled === false; })()`));
  const dayLook = await page.evaluate(`(() => { const v = ${card}._view; return { hemi: v.hemi.intensity, sun: v.sun.intensity, tm: v.renderer.toneMapping }; })()`);
  check('removing the model at night restores the day look', dayLook.hemi === 2.2 && dayLook.sun === 1.4 && dayLook.tm === 0, JSON.stringify(dayLook));
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 2d. model views and layers in edit mode (demo/house.glb uploaded): views from the model, per-view
// layer rules, click-in-3D menu, saved camera, linked floors, pick a room outline, untagged copies
s = await openDemo({ view: '3d', height: '560px' }, { width: 1500, height: 680 });
try {
  const { page } = s;
  const sr = `${card}.shadowRoot`;
  const clickText = async (t) => {
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === t);
      if (b) b.click();
      return !!b;
    }, t);
    await sleep(200);
    return ok;
  };
  const upload = async (file) => {
    await clickText('Model');
    const input = await page.evaluateHandle(`${sr}.querySelector('.panel [data-field=model-file]')`);
    await input.uploadFile(file);
  };
  const chip = async (id) => { await page.evaluate(`${sr}.querySelector('.chip[data-view=${id}]').click()`); await sleep(400); };
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
  await sleep(300);
  await upload(path.join(root, 'demo', 'house.glb'));
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 4`, { timeout: 10000 });
  await sleep(400);
  check('uploaded model: chips are its views in order', JSON.stringify(await chipIds()) === '["exterior","ground","first"]'
    && JSON.stringify(await page.evaluate(`[...${sr}.querySelectorAll('.chip')].map((b) => b.textContent)`)) === '["Exterior","Ground floor","First floor"]', JSON.stringify(await chipIds()));
  await chip('ground');
  await clickText('Views');
  check('room labels in edit mode show sizes', await page.evaluate(`(() => { const l = [...${sr}.querySelectorAll('.fp-room-label:not(.fp-obj-label)')].map((x) => x.textContent); return l.length > 0 && l.every((t) => t.includes('×') || t.includes('m²')); })()`));

  // layer eye: furniture hidden in this view only
  const furniture = ['sofa', 'coffee_table', 'kitchen_table', 'bed'];
  const eye = () => page.evaluate(`${sr}.querySelector('.panel li[data-sel="layer:furniture"] .eye').click()`);
  check('Views tab lists the furniture and ceiling layers', await page.evaluate(`!!${sr}.querySelector('.panel li[data-sel="layer:furniture"]') && !!${sr}.querySelector('.panel li[data-sel="layer:ceiling"]')`));
  await eye(); await sleep(200);
  await eye(); await sleep(300);
  const rulesOf = (id) => page.evaluate(`JSON.stringify(((${card}._layout.views || {})[${JSON.stringify(id)}] || {}).rules || [])`);
  check('eye on layer:furniture stores a hide rule for this view', (await rulesOf('ground')) === '[{"hide":"layer:furniture"}]', await rulesOf('ground'));
  const furnVis = async () => { const out = []; for (const n of furniture) out.push(await nodeVis(n)); return out; };
  check('furniture hidden in the Ground floor view', (await furnVis()).every((x) => x === false), JSON.stringify(await furnVis()));
  check('room floors stay visible', await nodeVis('kitchen'));
  await chip('first');
  check('furniture visible again in the First floor view', (await furnVis()).every((x) => x === true) && (await nodeVis('desk')), JSON.stringify(await furnVis()));
  check('other view has no rule', (await rulesOf('first')) === '[]');
  await chip('ground');
  await eye(); await sleep(300);
  check('third eye click: back to default', (await rulesOf('ground')) === '[]' && (await furnVis()).every((x) => x === true), await rulesOf('ground'));

  // click in 3D -> menu -> Hide in this view; Reveal in tree
  await page.evaluate(`${card}._setMode('top')`);
  await page.evaluate(`${card}._view.fit({ instant: true })`);
  await sleep(400);
  let pt = await freePoint(grid(0.3, 2.1, 2.65, 3.35), 0.45, 'ground');
  check('a free spot over the sofa', !!pt);
  if (pt) {
    await page.mouse.click(pt[0], pt[1]);
    await sleep(300);
    const menu = await page.evaluate(`(() => { const m = ${sr}.querySelector('.fp-pickmenu'); return m ? [...m.querySelectorAll('button')].map((b) => b.textContent) : null; })()`);
    check('click on furniture opens the menu', JSON.stringify(menu) === '["Hide in this view","Show in this view","Hide in all views","Reveal in tree"]', JSON.stringify(menu));
    check('the pick is the sofa group', (await page.evaluate(`${card}._edit.vwPick && ${card}._edit.vwPick.sel`)) === 'node:house/level0/sofa', await page.evaluate(`${card}._edit.vwPick && ${card}._edit.vwPick.sel`));
    await page.evaluate(`${sr}.querySelector('.fp-pickmenu [data-act=vw-hide-here]').click()`);
    await sleep(300);
    check('"Hide in this view" hides the sofa only', !(await nodeVis('sofa')) && (await nodeVis('coffee_table')) && (await rulesOf('ground')) === '[{"hide":"node:house/level0/sofa"}]', await rulesOf('ground'));
    check('menu closed', await page.evaluate(`!${sr}.querySelector('.fp-pickmenu')`));
  }
  pt = await freePoint(grid(2.1, 3.1, 1.35, 1.85), 0.45, 'ground');
  if (pt) {
    await page.mouse.click(pt[0], pt[1]);
    await sleep(300);
    await page.evaluate(`(() => { const b = ${sr}.querySelector('.panel .tab-body'); b.scrollTop = 0; })()`);
    await page.evaluate(`${sr}.querySelector('.fp-pickmenu [data-act=vw-reveal]').click()`);
    await sleep(300);
    const rev = await page.evaluate(`(() => { const li = ${sr}.querySelector('.panel li[data-sel="node:house/level0/coffee_table"]'); if (!li) return null;
      const b = ${sr}.querySelector('.panel .tab-body').getBoundingClientRect(), r = li.getBoundingClientRect();
      return { flash: li.classList.contains('flash'), inView: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 }; })()`);
    check('"Reveal in tree" scrolls to the coffee table row and flashes it', !!rev && rev.flash && rev.inView, JSON.stringify(rev));
  } else check('a free spot over the coffee table', false);
  await page.evaluate(`${card}.saveViewPatch('ground', { rules: [] })`);
  await sleep(200);
  await page.evaluate(`${card}._setMode('3d')`);
  await sleep(200);

  // saved camera: save, move, switch away and back
  await page.evaluate(`${card}._view.setCamera({ position: [18, 22, 16], target: [6, 0, -4] }, { instant: true })`);
  await sleep(100);
  await page.evaluate(`${sr}.querySelector('.panel [data-act=vw-save-cam]').click()`);
  await sleep(200);
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
  await sleep(200);
  check('Reset camera clears it', !(await page.evaluate(`(${card}._layout.views.ground || {}).camera`)));

  // linked floors: unchecking the Ground floor link hides its roomless devices outside every room / zone
  // (a pin far off the plan), not the room devices, pins inside a room or the mower (outdoors)
  await page.evaluate(`(() => { const c = ${card}; c._edit.commit({ ...c._layout, pins: { ...c._layout.pins, 'device:tv': { x: -30, y: -30, z: 1, floor_id: 'ground' } } }); })()`);
  await sleep(300);
  let d = await devs();
  const roomless0 = d['outside:ground'] ? d['outside:ground'].shown : 0;
  const setLink = (id, on) => page.evaluate(`(() => { const el = ${sr}.querySelector('.panel [data-field=vw-floor][data-id=${id}]'); el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setLink('ground', false);
  await sleep(300);
  d = await devs();
  check('unlinking the floor hides its devices outside rooms; pins in rooms and the mower stay', roomless0 > 0 && d['outside:ground'].shown === 0 && d.level0.shown > 0
    && d['pin:ground'].shown > 0 && (!d.mower || d.mower.shown === 1)
    && JSON.stringify((await page.evaluate(`${card}._layout.views.ground.floors`))) === '[]', JSON.stringify(d));
  await setLink('ground', true);
  await sleep(300);
  d = await devs();
  check('linking it again shows them', d['outside:ground'].shown === roomless0, JSON.stringify(d));
  await page.evaluate(`(() => { const c = ${card}; const pins = { ...c._layout.pins }; delete pins['device:tv']; c._edit.commit({ ...c._layout, pins }); })()`);
  await sleep(200);

  // pick on a tagged room floor links the model room
  await page.evaluate(`(() => { const c = ${card}; c._edit.commit({ ...c._layout, rooms: c._layout.rooms.filter((r) => r.area_id !== 'kitchen') }); })()`);
  await page.evaluate(`${card}._edit.setModelProps({ rooms: { kitchen: { area: null } } })`);
  await sleep(300);
  await clickText('Rooms');
  const pickBtn = () => page.evaluate(() => {
    const li = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel li')].find((x) => x.querySelector('.name') && x.querySelector('.name').textContent.trim() === 'Kitchen');
    const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Pick');
    if (b) b.click();
    return !!b;
  });
  check('Rooms tab offers Pick for the unlinked kitchen', await pickBtn());
  await sleep(200);
  await page.evaluate(`${card}._setMode('top')`);
  await page.evaluate(`${card}._view.fit({ instant: true })`);
  await sleep(400);
  const kitchenSpots = [[8, 1], [8.2, 4.2], [11.5, 0.5], [11.5, 4.5], [8.5, 6], [9, 0.5], [10, 4.5]];
  pt = await freePoint(kitchenSpots, 0, 'ground');
  if (pt) await page.mouse.click(pt[0], pt[1]);
  await sleep(400);
  check('pick on a tagged room floor links the model room', (await page.evaluate(`${card}._layout.model.rooms.kitchen.area`)) === 'kitchen' && !(await page.evaluate(`${card}._edit.picking`)),
    JSON.stringify(await page.evaluate(`${card}._layout.model.rooms`)));
  await page.evaluate(`${card}._setMode('3d')`);
  await sleep(200);

  // legacy copy (no extras, legacy level names): generated views, cut on, no elevation inputs, picking traces the floor
  const legacy = path.join(root, 'screenshots', 'legacy-views.glb');
  const legacyNames = { level0: 'floor:ground', level1: 'floor:first', exterior: 'site' };
  fs.writeFileSync(legacy, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) { delete n.extras; if (legacyNames[n.name]) n.name = legacyNames[n.name]; }
    return json;
  }));
  await upload(legacy);
  await page.waitForFunction(`${card}._view.modelManifest()?.levels.some((l) => l.id === 'site')`, { timeout: 10000 });
  await sleep(400);
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
  await sleep(300);
  const kitchenArea = await page.evaluate(`(() => { const p = ${JSON.stringify([[7.5, 0], [12, 0], [12, 5], [9.5, 5], [9.5, 6.5], [7.5, 6.5]])}; let a = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); })()`);
  const pickAndTrace = async () => {
    await pickBtn();
    await sleep(200);
    await page.evaluate(`${card}._setMode('top')`);
    await page.evaluate(`${card}._view.fit({ instant: true })`);
    await sleep(400);
    const p = await freePoint(kitchenSpots, 0, 'ground');
    if (p) await page.mouse.click(p[0], p[1]);
    await page.waitForFunction(`${card}._edit.picking && ${card}._edit.picking.poly`, { timeout: 5000 }).catch(() => {});
    await sleep(200);
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
  await sleep(400);
  const minX1 = await traceAt(8.5);
  check('outline traced again after realigning the model (moved 0.5 m)', minX0 !== null && minX1 !== null && Math.abs(minX1 - minX0 - 0.5) < 0.06, `${minX0} -> ${minX1}`);
  await page.evaluate(`${card}._edit.setModelProps({ position: [0, 0, 0] }, false)`);
  await sleep(300);
  await sleep(300);
  area = await pickAndTrace();
  await clickText('Draw instead');
  check('"Draw instead" starts drawing the area', (await page.evaluate(`${card}._edit.drawing && ${card}._edit.drawing.areaId`)) === 'kitchen' && !(await page.evaluate(`${card}._edit.picking`)));
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc cancels drawing', !(await page.evaluate(`${card}._edit.drawing`)));
  await pickBtn();
  await sleep(150);
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc cancels picking', !(await page.evaluate(`${card}._edit.picking`)));
  await page.evaluate(`${card}._setMode('3d')`);

  // Views tab: side section position slider (live while dragging, saved on release)
  await clickText('Views');
  await sleep(300);
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
  await sleep(200);
  check('Section button off clears the cut', await page.evaluate(`${card}._view.renderer.clippingPlanes.length === 0`));
  check('Reset section clears the saved cut', await clickText('Reset section'));
  await sleep(300);
  check('Reset section: nothing saved', await page.evaluate(`(() => { const c = ${card}; return !((c._layout.views || {})[c._viewId] || {}).section; })()`));

  // Camera: rotation centre per view, zoom pivot, separate top-view camera
  await page.evaluate(`${card}._setView('ground', { instant: true })`);
  await sleep(300);
  check('zoom_to default center: controls.zoomToCursor false', await page.evaluate(`${card}._view.controls.zoomToCursor === false`));
  await page.waitForFunction(`!!${card}._view.pivotMarker && ${card}._view.pivotMarker.visible`, { timeout: 3000 }).catch(() => {});
  check('Views tab shows the rotation centre cross', await page.evaluate(`!!${card}._view.pivotMarker && ${card}._view.pivotMarker.visible`));
  check('Set rotation centre button', await clickText('Set rotation centre'));
  check('Set rotation centre arms a click', await page.evaluate(`${card}._edit.pivoting === true`));
  await page.keyboard.press('Escape');
  await sleep(150);
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
  await sleep(300);
  check('per-view zoom_to cursor: saved and applied', await page.evaluate(`${card}._layout.views.ground.zoom_to === 'cursor' && ${card}._view.controls.zoomToCursor === true`));
  await page.evaluate(`${card}._setView('first')`);
  await sleep(200);
  check('other view keeps the default centre pivot', await page.evaluate(`${card}._view.controls.zoomToCursor === false`));
  await page.evaluate(`${card}._setView('ground')`);
  await sleep(200);
  await page.evaluate(`(() => { const el = ${sr}.querySelector('.panel [data-field=vw-zoom-to]'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  check('zoom_to back to the card default', await page.evaluate(`!${card}._layout.views.ground.zoom_to && ${card}._view.controls.zoomToCursor === false`));
  // top view: its own camera
  await page.evaluate(`${card}._setMode('top')`);
  await sleep(300);
  check('top mode: zoom pivot kept on the rebuilt controls', await page.evaluate(`${card}._view.controls.zoomToCursor === false`));
  await page.evaluate(`${card}._view.setTopCamera({ center: [3, 2], zoom: 1.6 }, { instant: true })`);
  await clickText('Save current view as start');
  await sleep(300);
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
  await sleep(300);
  const cam3 = await page.evaluate(`(() => { const v = ${card}._view; return { target: v.controls.target.toArray(), pos: v.persp.position.toArray() }; })()`);
  check('Top -> 3D restores the view camera (±0.1 m)', near(cam3.target, piv.saved.target, 0.1) && near(cam3.pos, piv.saved.position, 0.1), JSON.stringify({ cam3, saved: piv.saved }));
  // no saved camera: back to the camera before Top
  await page.evaluate(`${card}._setView('first', { instant: true })`);
  await page.evaluate(`${card}._view.setCamera({ position: [21, 19, 23], target: [4, 0, -3] }, { instant: true })`);
  await page.evaluate(`${card}._setMode('top')`);
  await sleep(200);
  await page.evaluate(`${card}._setMode('3d')`);
  await sleep(300);
  check('Top -> 3D without a saved camera returns to the previous 3D camera', near(await page.evaluate(`${card}._view.persp.position.toArray()`), [21, 19, 23], 0.1));
  await page.evaluate(`${card}._setView('ground', { instant: true })`);
  await sleep(300);
  // section on: Save / Set rotation centre leave the section first
  await page.evaluate(`${card}.setSection(true)`);
  await sleep(500);
  check('section on before save', await page.evaluate(`${card}._section === true`));
  await clickText('Save current view as start');
  await sleep(300);
  const secCam = await page.evaluate(`(() => { const c = ${card}; return { on: c._section, planes: c._view.renderer.clippingPlanes.length, cam: c._layout.views.ground.camera }; })()`);
  check('Save current view with the section on: section off first, the view camera saved', !secCam.on && secCam.planes === 0
    && near(secCam.cam.target, piv.saved.target, 0.1) && near(secCam.cam.position, piv.saved.position, 0.1), JSON.stringify(secCam));
  await page.evaluate(`${card}.setSection(true)`);
  await sleep(500);
  await clickText('Set rotation centre');
  check('Set rotation centre with the section on: section off first', await page.evaluate(`!${card}._section && ${card}._view.renderer.clippingPlanes.length === 0 && ${card}._edit.pivoting === true`));
  await page.keyboard.press('Escape');
  await sleep(150);
  await clickText('Reset this view');
  await sleep(300);
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
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 0`, { timeout: 10000 });
  await sleep(400);
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
} finally {
  await s.close();
}

// 2g. magnetic drag (demo/house.glb uploaded): a marker sticks to a wall, attaches to a model object
// (the living-room ceiling lamp), follows it when the model is realigned, Alt-drag never attaches, Detach keeps the spot
s = await openDemo({ view: '3d', height: '560px' }, { width: 1500, height: 680 });
try {
  const { page } = s;
  const sr = `${card}.shadowRoot`;
  const clickText = async (t) => {
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === t);
      if (b) b.click();
      return !!b;
    }, t);
    await sleep(200);
    return ok;
  };
  await page.evaluate(`${sr}.querySelector('button.edit').click()`);
  await sleep(300);
  await clickText('Model');
  const input = await page.evaluateHandle(`${sr}.querySelector('.panel [data-field=model-file]')`);
  await input.uploadFile(path.join(root, 'demo', 'house.glb'));
  await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 4`, { timeout: 10000 });
  await sleep(400);
  await page.evaluate(`${sr}.querySelector('.chip[data-view=ground]').click()`);
  await settle(page, card);
  await clickText('Devices');
  // closer to the living room: the ceiling lamp is a small disc, too small to hit from the default distance
  await page.evaluate(`${card}._view.setCamera({ position: [8, 8.5, 8], target: [3, 1, -2.5] }, { instant: true })`);
  await settle(page, card);
  // the demo model's living-room ceiling lamp (a real object, bound to light.demo_living)
  const injected = await page.evaluate(`(() => { const o = ${card}._objects.objectAt('lamp_living'); return o ? o.obj.node.name : null; })()`);
  check('magnetic: the demo model has the living-room lamp object', !!injected, String(injected));
  await sleep(200);
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
    await sleep(50);
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
      await sleep(50);
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
    await sleep(400);
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
    await sleep(150);
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
} finally {
  await s.close();
}

// 2c. no model: today's look
s = await openDemo({ view: '3d' });
try {
  const { page } = s;
  const r = await page.evaluate(`(() => { const v = ${card}._view; return { tm: v.renderer.toneMapping, sm: v.renderer.shadowMap.enabled, pr: v.renderer.getPixelRatio(),
    labels: ${card}.shadowRoot.querySelectorAll('.fp-room-label:not(.fp-obj-label)').length, dayHidden: ${card}.shadowRoot.querySelector('button.daynight').hidden }; })()`);
  check('no model: NoToneMapping, no shadows', r.tm === 0 && r.sm === false, JSON.stringify(r));
  check('no model: room labels present, day/night hidden, pixel ratio capped', r.labels > 0 && r.dayHidden && r.pr <= 1.5, JSON.stringify(r));
  await page.evaluate(`${card}._setFloor('all')`);
  await sleep(300);
  check('no model: "All" does not fade markers', (await page.evaluate(`${card}.shadowRoot.querySelectorAll('.fp-marker.fp-faded').length`)) === 0);
  allErrors.push(...s.errors);
} finally {
  await s.close();
}

// 2e. edit panel keeps its scroll position and the slider being dragged
s = await openDemo({ view: '3d', height: '560px' }, { width: 1500, height: 680 });
try {
  const { page } = s;
  await page.evaluate(`${card}.shadowRoot.querySelector("button.edit").click()`);
  await sleep(300);
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
} finally {
  await s.close();
}

// 3. export snippet round trip
s = await openDemo({});
try {
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
} finally {
  await s.close();
}

// 5. final review fixes: no occlusion / shadow work for irrelevant state updates (I1), mower and
// pins in an exterior-only view (I2), model view cameras follow the model alignment (I3)
{
  const cams = path.join(root, 'screenshots', 'house-cams.glb');
  const modelCam = { position: [14, 12, 10], target: [6, 0, -4] };
  const modelTop = { center: [6, 4], zoom: 1.2 };
  fs.writeFileSync(cams, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
    for (const n of json.nodes || []) {
      const fp = n.extras && n.extras.fp;
      if (fp && fp.views) fp.views = fp.views.map((v) => (v.id === 'ground' ? { ...v, camera: modelCam, camera_top: modelTop } : v));
    }
    return json;
  }));
  s = await openDemo({ model: '/screenshots/house-cams.glb', view: '3d' }, { width: 1400, height: 560 });
  try {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 10000 });
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
      await sleep(60);
    }
    await sleep(800);
    let stats = await page.evaluate(`${card}._view.stats`);
    check('10 state updates, nothing relevant changed: 0 occlusion passes, 0 shadow map renders', stats.occPasses === 0 && stats.occPartial === 0 && stats.shadow === 0, JSON.stringify(stats));
    check('the state updates still reached the markers', await page.evaluate(`[...${card}.shadowRoot.querySelectorAll('.fp-val')].some((e) => e.textContent.startsWith('29'))`));
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
    await sleep(400);
    await page.evaluate(`${card}._setView('garden')`);
    await sleep(400);
    const vis = (id) => page.evaluate(`(() => { const c = ${card}; const o = c._view.markerObjects.get(${id}); return o ? o.obj.visible : null; })()`);
    const gv = { mower: await vis(`c._mowerMarkerId`), gardenPin: await vis(`'device:kettle_plug'`), kitchenPin: await vis(`'device:tv'`),
      chip: await page.evaluate(`!!${card}.shadowRoot.querySelector('.chip.on[data-view=garden]')`) };
    check('Garden view: mower and the pin in the garden zone shown, a pin in the (hidden) kitchen not', gv.mower === true && gv.gardenPin === true && gv.kitchenPin === false && gv.chip, JSON.stringify(gv));

    // I3: model view cameras (3D and top centre) follow the model alignment; identity first
    const near = (a, b, tol = 0.02) => a.every((x, i) => Math.abs(x - b[i]) < tol);
    const camNow = () => page.evaluate(`${card}._view.getCamera()`);
    await page.evaluate(`${card}._setView('ground', { instant: true })`);
    await sleep(300);
    let cam = await camNow();
    check('model view camera at identity alignment', near(cam.position, modelCam.position) && near(cam.target, modelCam.target), JSON.stringify(cam));
    const align = { position: [2, 1, 0.5], rotation: 90, scale: 1.5 };
    await page.evaluate(`${card}.setConfig({ ...${card}._config, model_position: ${JSON.stringify(align.position)}, model_rotation: ${align.rotation}, model_scale: ${align.scale} })`);
    await sleep(500);
    await page.evaluate(`${card}._setView('exterior', { instant: true })`);
    await page.evaluate(`${card}._setView('ground', { instant: true })`);
    await sleep(300);
    cam = await camNow();
    const want = { position: alignModelPoint(modelCam.position, align), target: alignModelPoint(modelCam.target, align) };
    check('model view camera follows the model alignment', near(cam.position, want.position) && near(cam.target, want.target), JSON.stringify({ cam, want }));
    await page.evaluate(`${card}._setMode('top')`);
    await sleep(300);
    await page.evaluate(`${card}._setView('ground', { instant: true })`);
    await sleep(300);
    const top = await page.evaluate(`${card}._view.getTopCamera()`);
    const wantC = transformPoint(modelTop.center, align);
    check('model camera_top centre (and zoom / scale) follows the alignment', near(top.center, wantC) && Math.abs(top.zoom - modelTop.zoom / align.scale) < 0.01, JSON.stringify({ top, wantC }));
    await page.evaluate(`${card}._setMode('3d')`);
    await sleep(300);

    // edit mode on / off keeps the camera exactly (no re-framing)
    await page.evaluate(`${card}._view.setCamera({ position: [30, 20, 25], target: [4, 0, -3] }, { instant: true })`);
    await sleep(200);
    const before = await camNow();
    await page.evaluate(`${card}._toggleEdit()`);
    await sleep(400);
    const inEdit = await camNow();
    // one floor on its own in edit mode (no view linked to just it), then Done: the view's chip is lit again
    await page.evaluate(`${card}.saveViewPatch('ground', { floors: [] })`);
    await sleep(200);
    await page.evaluate(`${card}._setFloor('ground')`);
    const floorOnly = await page.evaluate(`${card}._floorOnly`);
    await page.evaluate(`${card}._view.setCamera(${JSON.stringify(before)}, { instant: true })`);
    await page.evaluate(`${card}._toggleEdit()`);
    await sleep(400);
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
    await s.close();
    fs.unlinkSync(cams);
  }
}

// 4. optional: a real model, screenshots only (REAL_MODEL=/path/to/house.glb)
if (process.env.REAL_MODEL) {
  s = await openDemo({ view: '3d', height: '700px' }, { width: 1500, height: 820 });
  try {
    const { page } = s;
    await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
    await sleep(200);
    await page.evaluate(() => {
      const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model');
      if (b) b.click();
    });
    await sleep(150);
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
if (process.env.USER_MODEL) {
  for (const merge of [true, false]) {
    let u;
    try {
      u = await openDemo({ view: '3d', height: '700px', ...(merge ? {} : { merge: '0' }) }, { width: 1500, height: 820 });
      const { page } = u;
      await page.evaluate(`${card}.shadowRoot.querySelector('button.edit').click()`);
      await sleep(200);
      await page.evaluate(() => {
        const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Model');
        if (b) b.click();
      });
      await sleep(150);
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
