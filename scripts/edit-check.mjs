// Headless end-to-end check of edit mode on the demo page (first card, light theme).
// Draws a room, reshapes it, adds a door, pins/unpins/hides a marker, imports a layout.
// Writes screenshots/edit-*.png and exits non-zero on any failed step or page error.
import fs from 'node:fs';
import path from 'node:path';
import { openDemo, root, brandRequests } from './lib/demo-browser.mjs';
import { planToPixel } from '../src/mower-image.js';

const shots = path.join(root, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const { page, errors, close } = await openDemo({ height: '560px' }, { width: 1500, height: 680 }, { brands: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' – ' + detail : ''}`);
  if (!ok) failures.push(name);
};
const card = 'document.querySelector("floorplan3d-card")';
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const layout = () => ev(`${card}._layout`);
const saved = () => ev('window.__savedLayout || null');
const panelClick = async (text) => {
  const ok = await ev((t) => {
    const b = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel button')]
      .find((x) => x.textContent.trim() === t);
    if (b) b.click();
    return !!b;
  }, text);
  await sleep(150);
  return ok;
};
const rowButton = async (name, text) => {
  const ok = await ev((n, t) => {
    const li = [...document.querySelector('floorplan3d-card').shadowRoot.querySelectorAll('.panel li')]
      .find((x) => x.querySelector('.name') && x.querySelector('.name').textContent.trim().startsWith(n));
    const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === t);
    if (b) b.click();
    return !!b;
  }, name, text);
  await sleep(200);
  return ok;
};
// client px of a plan point on the active floor
const at = (x, y, z = 0) => ev((x, y, z) => {
  const c = document.querySelector('floorplan3d-card');
  return c._view.screenPoint(x, y, z, c._floor);
}, x, y, z);
const click = async (x, y) => {
  const [cx, cy] = await at(x, y);
  await page.mouse.click(cx, cy);
  await sleep(120);
};
const drag = async (from, to) => {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
  await sleep(250);
};

// |dot centre - projected 3D point| in px for a marker that shows a value line (worst over all such markers)
const dotOffset = () => ev(`(() => { const c = ${card}, v = c._view; const r = v.renderer.domElement.getBoundingClientRect();
  let worst = -1, n = 0;
  for (const [, m] of v.markerObjects) {
    const val = m.obj.element.querySelector('.fp-val');
    if (!m.obj.visible || !val || !val.textContent) continue;
    const p = m.obj.position.clone().project(v.camera);
    if (Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95 || Math.abs(p.z) > 1) continue; // off screen or behind the camera
    const sx = r.left + ((p.x + 1) / 2) * r.width, sy = r.top + ((1 - p.y) / 2) * r.height;
    const d = m.obj.element.querySelector('.fp-dot').getBoundingClientRect();
    worst = Math.max(worst, Math.hypot(d.x + d.width / 2 - sx, d.y + d.height / 2 - sy)); n++;
  }
  return { worst, n }; })()`);
// camera at rest (no tween, no damping) and rendered: two frames in a row with the same camera
const settle = async () => {
  await page.waitForFunction(`!${card}._view._tween`, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(`(async () => { const v = ${card}._view, frame = () => new Promise((r) => requestAnimationFrame(r));
    const sig = () => v.camera.matrixWorld.elements.map((x) => x.toFixed(6)).join();
    await frame(); const a = sig(); await frame(); await frame(); return a === sig(); })()`, { timeout: 5000, polling: 50 }).catch(() => {});
};
// stems: [stem count, visible stem discs, visible markers]
const stems = () => ev(`(() => { const v = ${card}._view; return [v.stems.size, [...v.stems.values()].filter((s) => s.disc.visible).length,
  [...v.markerObjects.values()].filter((m) => m.obj.visible).length, v.stemGroup.children.length]; })()`);

try {
  await ev(`window.__demoMower = ${card}._layout.mower`);
  await ev(`window.__demoLayout = ${card}._layout`);
  // markers are anchored at their dot (the value line hangs below it), also after orbit and zoom
  await settle();
  let off = await dotOffset();
  check('value marker dot on its 3D point', off.n > 0 && off.worst <= 1, JSON.stringify(off));
  await ev(`(() => { const v = ${card}._view; const t = v.controls.target; v.setCamera({ position: [t.x + 9, 7, t.z + 4], target: t.toArray() }, { instant: true }); })()`);
  await settle();
  off = await dotOffset();
  check('dot anchored after orbit', off.n > 0 && off.worst <= 1, JSON.stringify(off));
  await ev(`(() => { const v = ${card}._view; // zoom in on a value marker
    const m = [...v.markerObjects.values()].find((x) => x.obj.visible && x.obj.element.querySelector('.fp-val').textContent);
    const t = m.obj.position; v.setCamera({ position: [t.x + 2.5, t.y + 2.5, t.z + 2], target: t.toArray() }, { instant: true }); })()`);
  await settle();
  off = await dotOffset();
  check('dot anchored after zoom', off.n > 0 && off.worst <= 1, JSON.stringify(off));
  check('no stems in view mode', (await stems())[0] === 0);
  // enter edit mode
  await ev(`${card}.shadowRoot.querySelector("button.edit").click()`);
  await sleep(300);
  const st = await stems();
  check('edit mode: one stem per shown marker', st[0] > 0 && st[1] === st[2] && st[3] === st[0] * 2, JSON.stringify(st));
  check('panel shown', await ev(`getComputedStyle(${card}.shadowRoot.querySelector(".panel")).display !== "none"`));
  check('"All" chip hidden while editing', !(await ev(`[...${card}.shadowRoot.querySelectorAll(".chip")].some(b => b.textContent === "All")`)));
  check('garage listed as missing', await ev(`[...${card}.shadowRoot.querySelectorAll(".panel li")].some(li => li.textContent.includes("Garage") && li.textContent.includes("missing"))`));

  // draw the garage west of the bedroom, sharing its wall (x = 0)
  check('start drawing', await rowButton('Garage', 'Draw'));
  await ev(`(() => { const v = ${card}._view; v.ortho.zoom = 0.75; v.ortho.updateProjectionMatrix(); v.dirty = true; })()`);
  await sleep(200);
  check('switched to top view', (await ev(`${card}._mode`)) === 'top');
  await click(-4.02, 5.03);
  await click(0.08, 5.06); // within 25 cm of the bedroom corner (0, 5): snaps onto it
  await click(0.05, 9.1); // snaps to (0, 9)
  await page.mouse.move(...(await at(-3.0, 8.0)));
  await click(-3.98, 8.97);
  await page.screenshot({ path: path.join(shots, 'edit-drawing.png') });
  await click(-4.0, 5.02); // first point closes the room
  await sleep(200);
  let l = await layout();
  const garage = l.rooms.find((r) => r.area_id === 'garage');
  check('garage room created', !!garage, garage && JSON.stringify(garage.polygon));
  check('corners snapped to shared wall', garage && JSON.stringify(garage.polygon) === JSON.stringify([[-4, 5], [0, 5], [0, 9], [-4, 9]]));
  check('garage stored without floor_id (area floor)', garage && garage.floor_id === undefined);
  check('room selected after drawing', (await ev(`${card}._edit.selectedRoom`)) === garage?.id);
  await sleep(800);
  check('layout saved through storage', JSON.stringify((await saved())?.rooms) === JSON.stringify(l.rooms));

  // drag the north-west corner 1 m further west
  const handle = await ev(`(() => { const h = [...${card}.shadowRoot.querySelectorAll(".fp-handle.vertex")][3]; const r = h.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await drag(handle, await at(-5.0, 9.0));
  l = await layout();
  check('corner moved and snapped', JSON.stringify(l.rooms.find((r) => r.area_id === 'garage').polygon[3]) === '[-5,9]', JSON.stringify(l.rooms.find((r) => r.area_id === 'garage').polygon));

  // drag the middle of the south edge to add a corner
  const mid = await ev(`(() => { const h = ${card}.shadowRoot.querySelectorAll(".fp-handle.mid")[0]; const r = h.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await drag(mid, await at(-2.0, 4.5));
  l = await layout();
  check('midpoint drag inserts a corner', l.rooms.find((r) => r.area_id === 'garage').polygon.length === 5);

  // add a door on the shared wall
  check('door mode', await panelClick('Add door'));
  await click(0.2, 7.0);
  l = await layout();
  check('door added on the wall', JSON.stringify(l.rooms.find((r) => r.area_id === 'garage').doors) === '[[0,7]]');
  await page.screenshot({ path: path.join(shots, 'edit-room.png') });

  // outdoor toggle
  await ev(`(() => { const i = ${card}.shadowRoot.querySelector("[data-field=room-outdoor]"); i.checked = true; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(150);
  check('outdoor toggle', (await layout()).rooms.find((r) => r.area_id === 'garage').outdoor === true);

  // Esc while drawing cancels
  await rowButton('Garden', 'Select');
  check('select room from list', (await ev(`${card}._edit.selectedRoom`)) === 'r-garden');
  await panelClick('Done');

  // marker drag pins it
  const kettle = await ev(`(() => { const m = [...${card}.shadowRoot.querySelectorAll(".fp-marker")].find(x => x.title.startsWith("Kettle plug")); const r = m.querySelector(".fp-dot").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const target = await at(10.5, 1.0, 1.1);
  await drag(kettle, target);
  l = await layout();
  const pin = l.pins['device:kettle_plug'];
  check('marker drag creates pin', !!pin && Math.abs(pin.x - 10.5) < 0.2 && Math.abs(pin.y - 1.0) < 0.2, JSON.stringify(pin));
  check('devices tab shows selection', (await ev(`${card}._edit.tab`)) === 'devices' && (await ev(`${card}._edit.selectedMarker`)) === 'device:kettle_plug');
  check('kettle switch not toggled by drag', (await ev(`${card}.hass.states["switch.kettle"].state`)) === 'off');

  await ev(`(() => { const i = ${card}.shadowRoot.querySelector("[data-field=marker-z]"); i.value = "0.4"; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(150);
  check('height input updates pin', (await layout()).pins['device:kettle_plug'].z === 0.4);
  await page.screenshot({ path: path.join(shots, 'edit-devices.png') });
  check('return to auto placement', await panelClick('Return to auto placement'));
  check('pin removed', !(await layout()).pins['device:kettle_plug']);

  // hide / unhide
  await ev(`${card}._edit.selectMarker("device:kettle_plug")`);
  await panelClick('Hide');
  check('hidden', (await layout()).hidden.includes('device:kettle_plug'));
  check('hidden marker gone from plan', !(await ev(`[...${card}.shadowRoot.querySelectorAll(".fp-marker")].some(x => x.title.startsWith("Kettle plug"))`)));
  await rowButton('Kettle plug', 'Unhide');
  check('unhidden', !(await layout()).hidden.includes('device:kettle_plug'));

  // import a layout through the file input
  await panelClick('Data');
  const tmp = path.join(root, 'screenshots', 'import-test.json');
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms: [{ id: 'x', area_id: 'kitchen', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] }] }));
  const input = await page.evaluateHandle(`${card}.shadowRoot.querySelector("[data-field=import]")`);
  await input.uploadFile(tmp);
  await sleep(400);
  l = await layout();
  check('import replaces layout', l.rooms.length === 1 && l.rooms[0].area_id === 'kitchen');
  check('import message', (await ev(`${card}.shadowRoot.querySelector(".panel .msg")?.textContent || ""`)).includes('Imported 1 rooms'));
  fs.writeFileSync(tmp, '{"rooms": [{"id": "bad", "polygon": [[0,0]]}]}');
  const input2 = await page.evaluateHandle(`${card}.shadowRoot.querySelector("[data-field=import]")`);
  await input2.uploadFile(tmp);
  await sleep(400);
  check('bad import rejected', (await layout()).rooms[0].id === 'x' && (await ev(`${card}.shadowRoot.querySelector(".panel .msg.error")?.textContent || ""`)).includes('Room bad'));
  fs.unlinkSync(tmp);

  // drawing: Esc cancels
  await panelClick('Rooms');
  await rowButton('Hall', 'Draw');
  await click(5.5, 0.5);
  await page.keyboard.press('Escape');
  await sleep(100);
  check('Esc cancels drawing', (await ev(`${card}._edit.drawing`)) === null && (await layout()).rooms.length === 1);

  // mower: start from the demo layout again (the import above replaced it)
  await ev(`${card}._edit.commit(${card}._edit.layout.mower ? ${card}._edit.layout : { ...${card}._layout, mower: window.__demoMower })`);
  await panelClick('Mower');
  await sleep(1200);
  const live = await ev(`${card}.shadowRoot.querySelector(".mower-live").textContent`);
  // the fake mower circles (45, 10) with a small radius, so a reading can be 9.999998: compare numbers
  const reading = /Reading (-?[\d.]+), (-?[\d.]+)/.exec(live);
  check('mower tab shows live reading on plan', !!reading && Math.abs(Number(reading[1]) - 45) < 0.01 && Math.abs(Number(reading[2]) - 10) < 0.01
    && live.includes('on plan'), live.trim());
  check('mower marker follows live position', await ev(`(() => { const c = ${card}; const p = c._positions.get(c._mowerMarkerId); return !!p && p.live && Math.hypot(p.x - 16.5, p.y - 1.5) < 4.5; })()`));
  check('trail drawn', await ev(`!!${card}._view.trail && ${card}._trail.length > 1`));
  check('map overlay loaded', await ev(`!!${card}._view.mapPlane && !!${card}._view.mapPlane.material.map`));
  const cal0 = (await layout()).mower.calibration.length;
  check('add calibration point', await panelClick('Add point'));
  check('calibrating', !!(await ev(`${card}._edit.calibrating`)));
  await click(17.0, 2.0);
  l = await layout();
  check('calibration point stored', l.mower.calibration.length === cal0 + 1 && JSON.stringify(l.mower.calibration[cal0].plan) === '[17,2]', JSON.stringify(l.mower.calibration[cal0]));
  await ev(`(() => { const s = ${card}.shadowRoot.querySelector("[data-field=ov-rotation]"); s.value = "30"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(150);
  check('overlay slider updates live', (await layout()).mower.overlay.rotation === 30 && (await ev(`Math.round(${card}._view.mapPlane.rotation.y * 180 / Math.PI)`)) === 30);
  check('slider kept in DOM (no re-render)', await ev(`${card}.shadowRoot.querySelector("[data-field=ov-rotation]").value === "30"`));
  // number inputs next to the sliders: follow the slider, typed values commit on Enter (clamped / rounded), arrows step
  const num = (f) => `${card}.shadowRoot.querySelector("input.slnum[data-num-for=${f}]")`;
  check('number next to the slider follows it', await ev(`${num('ov-rotation')}.value === "30"`));
  const w0 = (await layout()).mower.overlay.width;
  await ev(`(() => { const n = ${num('ov-width')}; n.focus(); n.select(); })()`);
  await page.keyboard.type('37.26');
  await page.keyboard.press('Enter');
  await sleep(200);
  let sl = await ev(`({ w: ${card}._layout.mower.overlay.width, range: ${card}.shadowRoot.querySelector("[data-field=ov-width]").value, num: ${num('ov-width')}.value, plane: ${card}._view.mapPlane.scale.x })`);
  check('typed overlay width commits on Enter (rounded to the step), slider follows', sl.w === 37.3 && sl.range === '37.3' && sl.num === '37.3', JSON.stringify(sl));
  await ev(`(() => { const n = ${num('ov-width')}; n.value = '999'; n.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  check('typed value clamped to max', (await layout()).mower.overlay.width === 200 && (await ev(`${num('ov-width')}.value`)) === '200');
  await ev(`(() => { const n = ${num('ov-width')}; n.value = ''; n.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  check('invalid value reverts to the slider', (await layout()).mower.overlay.width === 200 && (await ev(`${num('ov-width')}.value`)) === '200');
  await ev(`(() => { const n = ${num('ov-width')}; n.focus(); n.select(); })()`);
  await page.keyboard.type('12,5');
  await page.keyboard.press('Enter');
  await sleep(200);
  check('a decimal comma is accepted', (await layout()).mower.overlay.width === 12.5 && (await ev(`${num('ov-width')}.inputMode`)) === 'decimal', String((await layout()).mower.overlay.width));
  await ev(`${num('ov-rotation')}.focus()`);
  await page.keyboard.press('ArrowUp');
  await sleep(100);
  check('arrow key: not saved before 400 ms', (await layout()).mower.overlay.rotation === 30);
  await sleep(500);
  check('arrow key steps the value (and the slider)', (await layout()).mower.overlay.rotation === 30.5 && (await ev(`${card}.shadowRoot.querySelector("[data-field=ov-rotation]").value`)) === '30.5'
    && (await ev(`${card}.shadowRoot.activeElement === ${num('ov-rotation')}`)), String((await layout()).mower.overlay.rotation));
  await ev(`(() => { const n = ${num('ov-width')}; n.value = '${w0}'; n.dispatchEvent(new Event('change', { bubbles: true })); n.blur(); })()`);
  await sleep(150);
  check('width back', (await layout()).mower.overlay.width === w0);
  await panelClick('Move with mouse');
  const ov0 = (await layout()).mower.overlay;
  await drag(await at(16.5, 1.5), await at(18.5, 0.5));
  const ov1 = (await layout()).mower.overlay;
  check('overlay drag moves map', Math.abs(ov1.x - ov0.x - 2) < 0.15 && Math.abs(ov1.y - ov0.y + 1) < 0.15, `${ov0.x},${ov0.y} -> ${ov1.x},${ov1.y}`);
  await panelClick('Drag the map on the plan…');
  await page.screenshot({ path: path.join(shots, 'edit-mower.png') });

  // mower position from the live map image: the overlay alignment is the calibration
  await ev('window.__demoMowerPaused = true');
  await ev(`${card}._edit.commit({ ...${card}._edit.layout, mower: { ...${card}._edit.layout.mower, source: 'image', calibration: [],
    overlay: { entity: 'image.sunseeker_live_map', x: 16.5, y: 1.5, rotation: 0, width: 9, opacity: 0.55, refresh: 10 } } })`);
  await ev(`${card}._edit.render()`);
  await sleep(300);
  // where the fake mower is: its gps reading through the demo calibration (garden centre, north up)
  const mowerAt = () => ev(`(() => { const a = ${card}.hass.states['device_tracker.sunseeker_position'].attributes;
    return [16.5 + (a.longitude - 10) * 111320 * Math.cos(45 * Math.PI / 180), 1.5 + (a.latitude - 45) * 111320]; })()`);
  const liveNear = (q, tol = 0.3) => `(() => { const c = ${card}, l = c._mowerLive; if (!l || !l.floorId) return false;
    if (Math.hypot(l.x - ${q[0]}, l.y - ${q[1]}) > ${tol}) return false;
    const p = c._mowerMarkerId && c._positions.get(c._mowerMarkerId);
    return !c._mowerMarkerId || (!!p && Math.hypot(p.x - l.x, p.y - l.y) < 1e-9); })()`;
  check('image source hides Add point', !(await ev(`[...${card}.shadowRoot.querySelectorAll('.panel button')].some((b) => b.textContent.trim() === 'Add point')`)));
  const pickerOpen = () => page.waitForFunction(`!!${card}._edit.picker && !!${card}.shadowRoot.querySelector('.fp-picker')`, { timeout: 8000 }).then(() => true, () => false);
  check('pick mower colour opens the 2D picker', (await panelClick('Pick mower colour')) && await pickerOpen());
  await page.keyboard.press('Escape');
  await sleep(150);
  check('Esc closes the picker', !(await ev(`!!${card}._edit.picker || !!${card}.shadowRoot.querySelector('.fp-picker')`)));
  await panelClick('Pick mower colour');
  await pickerOpen();
  let q = await mowerAt();
  const ovl = (await layout()).mower.overlay;
  const pix = planToPixel(q[0], q[1], 450, 850, ovl);
  const pickPx = async (px, py) => {
    const cp = await ev(`${card}._edit.picker.clientOf(${px}, ${py})`);
    await page.mouse.move(cp[0], cp[1]);
    await page.mouse.click(cp[0], cp[1]);
    await sleep(250);
  };
  await pickPx(pix.px, pix.py);
  await page.waitForFunction(`!!(${card}._layout.mower.image && (${card}._layout.mower.image.colors || []).length)`, { timeout: 10000 }).catch(() => {});
  const col = (await layout()).mower.image && (await layout()).mower.image.colors[0];
  check('mower colour picked in the picker (the dot, not the background)', !!col && col[0] > 200 && col[1] < 120 && col[2] < 120, JSON.stringify({ col, pix }));
  check('picker stays open with the colour chip, loupe shown', await ev(`!!${card}._edit.picker && ${card}.shadowRoot.querySelectorAll('.fp-picker .fp-pk-chips .cchip').length === 1
    && getComputedStyle(${card}.shadowRoot.querySelector('.fp-pk-loupe')).display === 'block'`));
  await ev(`(() => { const c = ${card}.shadowRoot.querySelector('.fp-picker [data-pk=matches]'); c.click(); })()`);
  await sleep(200);
  const mc = await ev(`${card}._edit.picker.matchCount`);
  check('Show matches highlights the dot only', mc > 100 && mc < 600, String(mc));
  await page.screenshot({ path: path.join(shots, 'edit-picker.png') });
  await ev(`${card}.shadowRoot.querySelector('.fp-picker [data-pk=done]').click()`);
  await sleep(150);
  check('Done closes the picker', !(await ev(`!!${card}.shadowRoot.querySelector('.fp-picker')`)));
  check('mower found on the map image', await page.waitForFunction(liveNear(q), { timeout: 15000 }).then(() => true, () => false),
    JSON.stringify({ want: q, live: await ev(`${card}._mowerLive`) }));
  await ev('window.__demoMowerPaused = false');
  await sleep(2500);
  await ev('window.__demoMowerPaused = true');
  await sleep(600); // the last tick lands
  const q2 = await mowerAt();
  const moved = Math.hypot(q2[0] - q[0], q2[1] - q[1]);
  check('mower follows the dot on the map image', moved > 0.5 && await page.waitForFunction(liveNear(q2), { timeout: 15000 }).then(() => true, () => false),
    JSON.stringify({ moved, want: q2, live: await ev(`${card}._mowerLive`) }));
  check('mower tab shows the detection', /Found at [\d.-]+, [\d.-]+ \(\d+ px\)/.test(await ev(`${card}.shadowRoot.querySelector(".mower-live").textContent`)),
    await ev(`${card}.shadowRoot.querySelector(".mower-live").textContent`));
  // two background shades (lawn and the darker margin): both keyed transparent
  await panelClick('Pick background colour');
  await pickerOpen();
  const shade = (rgb) => ev(`(() => { const p = ${card}._edit.picker, d = p.data, w = p.w, h = p.h, same = (x, y) => { const k = (y * w + x) * 4; return Math.abs(d[k] - ${rgb[0]}) < 3 && Math.abs(d[k + 1] - ${rgb[1]}) < 3 && Math.abs(d[k + 2] - ${rgb[2]}) < 3; };
    for (let y = 2; y < h - 2; y += 3) for (let x = 2; x < w - 2; x += 3) { let ok = true; for (let j = -1; j <= 1 && ok; j++) for (let i = -1; i <= 1 && ok; i++) ok = same(x + i, y + j); if (ok) return [x / p.k, y / p.k]; }
    return null; })()`);
  const lawnPx = await shade([47, 93, 44]), marginPx = await shade([40, 79, 38]);
  await pickPx(lawnPx[0] + 0.5, lawnPx[1] + 0.5);
  await pickPx(marginPx[0] + 0.5, marginPx[1] + 0.5);
  const bgs = (await layout()).mower.overlay.bg_colors || [];
  check('two background picks stored', bgs.length === 2, JSON.stringify(bgs));
  await ev(`${card}.shadowRoot.querySelector('.fp-picker [data-pk=done]').click()`);
  const keyed = await page.waitForFunction(`(() => { const t = ${card}._view.mapPlane.material.map; if (!t || !t.isCanvasTexture) return false;
    const cv = t.image, g = cv.getContext('2d'), a = (p) => g.getImageData(Math.floor(p[0] * cv.width / 450), Math.floor(p[1] * cv.height / 850), 1, 1).data[3];
    return a(${JSON.stringify(lawnPx)}) === 0 && a(${JSON.stringify(marginPx)}) === 0; })()`, { timeout: 10000 }).then(() => true, () => false);
  check('both background shades transparent', keyed, JSON.stringify({ lawnPx, marginPx }));
  check('colour chips in the panel with remove buttons', await ev(`${card}.shadowRoot.querySelectorAll('.panel [data-act=color-del][data-kind=bg]').length === 2`));
  await ev(`${card}.shadowRoot.querySelector('.panel [data-act=color-del][data-kind=bg][data-i="1"]').click()`);
  await sleep(150);
  check('× removes a colour', ((await layout()).mower.overlay.bg_colors || []).length === 1);

  // setup checklist: all required rows done collapses to "Setup complete"; a row scrolls to and flashes its control
  await ev(`${card}._edit.render()`);
  await sleep(200);
  const setup = await ev(`(() => { const d = ${card}.shadowRoot.querySelector('details.mower-setup');
    return d && { complete: d.classList.contains('complete'), open: d.open, summary: d.querySelector('summary').textContent.trim(),
      rows: [...d.querySelectorAll('.setup-row')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()) }; })()`);
  check('setup checklist complete (mowed colour optional)', !!setup && setup.complete && !setup.open && setup.summary === '✓ Setup complete'
    && setup.rows.length === 6 && setup.rows.some((r) => r.startsWith('– Mowed colour optional')), JSON.stringify(setup));
  await ev(`(() => { const d = ${card}.shadowRoot.querySelector('details.mower-setup'); d.open = true;
    [...d.querySelectorAll('.setup-row')].find((b) => b.textContent.includes('Mowed colour')).click(); })()`);
  await sleep(100);
  check('setup row flashes its control', await ev(`!!${card}.shadowRoot.querySelector('[data-act="map-pick"][data-kind="mowed"].setup-flash')`));
  await ev(`(() => { const i = ${card}.shadowRoot.querySelector('[data-field=mower-ok-values]'); i.value = 'Rain delay, wait'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  check('OK values stored', JSON.stringify((await layout()).mower.ok_values) === '["Rain delay","wait"]', JSON.stringify((await layout()).mower.ok_values));
  await ev(`${card}._edit.commit({ ...${card}._edit.layout, mower: { ...${card}._edit.layout.mower, image: {} } })`);
  await ev(`${card}._edit.render()`);
  await sleep(200);
  const setup2 = await ev(`(() => { const d = ${card}.shadowRoot.querySelector('details.mower-setup');
    return { open: d.open, complete: d.classList.contains('complete'), colour: d.querySelector('[data-target*="img-pick"]').className }; })()`);
  check('setup checklist open with a missing step', setup2.open && !setup2.complete && setup2.colour.includes('todo'), JSON.stringify(setup2));
  await ev(`${card}._edit.commit({ ...${card}._edit.layout, mower: { ...${card}._edit.layout.mower, image: { color: ${JSON.stringify(col)}, tolerance: 40, min_pixels: 4 } } })`);
  await page.screenshot({ path: path.join(shots, 'edit-mower-image.png') });
  await ev('window.__demoMowerPaused = false');

  // device badges: status dots and the low battery chip by default, integration logos once switched on
  await ev(`${card}._edit.commit({ ...window.__demoLayout, mower: ${card}._edit.layout.mower })`);
  await panelClick('Devices');
  await sleep(300);
  const badgeState = () => ev(`(() => { const s = ${card}.shadowRoot, el = (id) => ${card}._markerEls.get(id);
    const q = (id, sel) => { const e = el(id); return e ? e.querySelector(':scope > ' + sel) : null; };
    const img = q('device:front_lock', '.fp-logo');
    return { logos: s.querySelectorAll('.fp-marker > .fp-logo').length, dots: s.querySelectorAll('.fp-marker > .fp-status').length,
      batt: s.querySelectorAll('.fp-marker > .fp-batt').length,
      smoke: (q('device:smoke_hall', '.fp-status') || {}).dataset?.status, lock: (q('device:front_lock', '.fp-status') || {}).dataset?.status,
      chip: (q('device:front_lock', '.fp-batt') || {}).textContent, lockLogo: !!img && img.complete && img.naturalWidth > 0,
      cover: !!q('device:living_blinds', '.fp-logo'), checks: [...s.querySelectorAll('[data-field=badge]')].map((c) => c.dataset.key + ':' + c.checked) }; })()`);
  let bs = await badgeState();
  check('badges: status dots and low battery chip by default, no logos', bs.logos === 0 && bs.dots > 10 && bs.batt === 1 && bs.chip === '12 %'
    && bs.checks.join() === 'integration:false,status:true,battery:true', JSON.stringify(bs));
  check('badges: unavailable is red, low battery is yellow', bs.smoke === 'red' && bs.lock === 'yellow', JSON.stringify(bs));
  const toggle = async (key) => { await ev(`(() => { const c = ${card}.shadowRoot.querySelector('[data-field=badge][data-key=${key}]'); c.click(); })()`); await sleep(300); };
  await toggle('integration');
  await page.waitForFunction(`(() => { const e = ${card}._markerEls.get('device:front_lock'); const i = e && e.querySelector('.fp-logo'); return !!i && i.complete && i.naturalWidth > 0; })()`, { timeout: 5000 }).catch(() => {});
  bs = await badgeState();
  check('badges: integration logos appear (stored in the layout)', bs.logos > 5 && bs.lockLogo && (await layout()).badges.integration === true, JSON.stringify(bs));
  check('badges: a platform without a logo shows no image', !bs.cover && brandRequests.includes('nobrand/icon'), JSON.stringify(brandRequests.slice(0, 12)));
  const reqs = brandRequests.length;
  await ev(`${card}._refreshStates()`);
  await sleep(100);
  check('badges: no repeated logo requests', brandRequests.length === reqs, `${reqs} -> ${brandRequests.length}`);
  await toggle('status');
  await toggle('battery');
  await toggle('integration');
  bs = await badgeState();
  check('badges: toggles hide them', bs.logos === 0 && bs.dots === 0 && bs.batt === 0, JSON.stringify(bs));
  await toggle('status');
  await toggle('battery');
  bs = await badgeState();
  check('badges: back on', bs.dots > 10 && bs.batt === 1, JSON.stringify(bs));
  await page.screenshot({ path: path.join(shots, 'edit-badges.png') });

  // leave edit mode: markers behave as in view mode again
  await ev(`${card}.shadowRoot.querySelector("button.edit").click()`);
  await sleep(200);
  check('panel hidden after Done', await ev(`getComputedStyle(${card}.shadowRoot.querySelector(".panel")).display === "none"`));
  check('no handles left', (await ev(`${card}.shadowRoot.querySelectorAll(".fp-handle").length`)) === 0);
  const st2 = await stems();
  check('stems gone after Done', st2[0] === 0 && st2[3] === 0, JSON.stringify(st2));
} catch (e) {
  failures.push(String(e && e.stack || e));
  console.error(e);
} finally {
  await close();
}
// narrow card (a sections-view column): plan on top, panel below, nothing covering the buttons
const narrow = await openDemo({ height: '520px' }, { width: 520, height: 1300 });
try {
  const p = narrow.page;
  await p.evaluate(`${card}.shadowRoot.querySelector("button.edit").click()`);
  await sleep(400);
  const box = await p.evaluate(`(() => { const s = ${card}.shadowRoot; const r = (q) => s.querySelector(q).getBoundingClientRect();
    return { card: r('ha-card').width, stage: [r('.stage').width, r('.stage').height], panel: r('.panel').width, panelTop: r('.panel').top, stageBottom: r('.stage').bottom }; })()`);
  check('narrow: plan keeps full width and height', Math.abs(box.stage[0] - box.card) < 1 && box.stage[1] === 520, JSON.stringify(box));
  check('narrow: panel below the plan, within the card', box.panelTop >= box.stageBottom - 1 && box.panel <= box.card + 1);
  const hit = await p.evaluate(`(() => { const s = ${card}.shadowRoot;
    const b = [...s.querySelectorAll('.panel button')].find((x) => x.textContent.trim() === 'Draw');
    const r = b.getBoundingClientRect(); return s.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; })()`);
  check('narrow: Draw button is clickable (not covered)', hit);
  errors.push(...narrow.errors);
} finally {
  await narrow.close();
}

if (errors.length) console.error('page errors:\n' + errors.join('\n'));
if (failures.length || errors.length) process.exit(1);
console.log('all edit checks passed');
