// Headless benchmark of the mower map: a 1600 x 1600 live map (camera) refreshing every 2 s with a
// moving mower for 30 s, then 16 s of refreshes where nothing changed.
// - no main-thread task of the card's own > 50 ms (its own timing: map refresh sections and renders)
// - renders while idle <= refresh-driven ones; no shadow-map updates from the mower moving
// Prints the numbers (main-thread ms per refresh, long tasks) for the release notes.
import { openDemo } from './lib/demo-browser.mjs';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' – ' + detail : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = 'document.querySelector("floorplan3d-card")';
const MOVE_S = 30, IDLE_S = 16, REFRESH_MS = 2000;

const s = await openDemo({ model: '1', view: '3d', cards: '1', robotmap: '1600', debug: '1' }, { width: 1200, height: 700 });
try {
  const { page } = s;
  const ev = (expr) => page.evaluate(expr);
  const until = (expr, label, timeout = 20000) => page.waitForFunction(expr, { timeout }).then(() => true, () => { console.log(`     (timed out waiting for ${label})`); return false; });
  await until(`!!${card}._view.model`, 'the model', 60000);
  await ev('window.__demoMowerPaused = true');
  const n = await ev(`window.__robotFrames(${(MOVE_S * 1000) / REFRESH_MS + 2}, 0.3, 0.08)`);
  check('benchmark frames rendered ahead', n > 10, String(n));
  await ev('window.__setRobotFrame(0)');
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, objects: { ...(l.objects || {}), mower: { entity: 'lawn_mower.robo' }, dock: { entity: 'lawn_mower.robo' } },
    mower: { entity: 'lawn_mower.robo', source: 'image', floor_id: l.mower.floor_id, calibration: [], trail: true,
    overlay: { entity: 'camera.robo_live_map', x: 16.5, y: 1.5, rotation: 0, width: 17, opacity: 0.6, refresh: 2 } } }); })()`);
  check('mower found on the 1600 px map', await until(`(() => { const r = ${card}._imageResult; return !!${card}._imageBlob && !!r && !r.missing && !r.error; })()`, 'the first detection', 60000),
    JSON.stringify(await ev(`${card}._imageResult`)));
  await sleep(3000); // warm-up: the worker, the static map, the template
  // instrumentation: every render timed, long tasks observed, the card's per-refresh timing collected
  await ev(`(() => {
    const c = ${card}, v = c._view, r = v.renderer;
    window.__bench = { renders: [], long: [], refresh: [], t0: performance.now() };
    if (!r.__timed) { const orig = r.render.bind(r); r.render = (a, b) => { const t = performance.now(); orig(a, b); window.__bench.renders.push(performance.now() - t); }; r.__timed = true; }
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__bench.long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask' }); } catch (e) { window.__bench.noLongtask = true; }
    // the card's own timing per map refresh (v0.4.5: _perf.last; v0.4.4: _autoMainMs + the processor's)
    let last = null;
    window.__benchPoll = setInterval(() => {
      const p = c._perf && c._perf.last;
      if (p) { if (p !== last) { last = p; window.__bench.refresh.push({ main: p.main, max: p.max, decode: p.decode, worker: p.worker, apply: p.apply }); } return; }
      const m = (c._autoMainMs || 0) + ((c._mapProc && c._mapProc.lastMainMs) || 0), k = c._mapDetect && c._mapDetect.image;
      if (k && k !== last) { last = k; window.__bench.refresh.push({ main: m, max: m }); }
    }, 50);
  })()`);
  const metric = async () => { const m = await page.metrics(); return m.TaskDuration * 1000; };
  // the page's own baseline (render loop ticks, timers) without any refresh, for comparison
  const q0 = await metric();
  await sleep(10000);
  const quiet = ((await metric()) - q0) / (10000 / REFRESH_MS);
  const task0 = await metric();
  const stats0 = await ev(`(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`);
  for (let i = 1; i <= (MOVE_S * 1000) / REFRESH_MS; i++) {
    await ev(`window.__setRobotFrame(${i})`);
    await sleep(REFRESH_MS);
  }
  const stats1 = await ev(`(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`);
  const moving = await ev('JSON.parse(JSON.stringify(window.__bench))');
  const task1 = await metric();
  for (let i = 0; i < (IDLE_S * 1000) / REFRESH_MS; i++) {
    await ev(`window.__setRobotSame(${(MOVE_S * 1000) / REFRESH_MS})`);
    await sleep(REFRESH_MS);
  }
  const stats2 = await ev(`(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`);
  const all = await ev('JSON.parse(JSON.stringify(window.__bench))');
  const task2 = await metric();
  await ev('clearInterval(window.__benchPoll)');

  const ref = moving.refresh;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const mainAvg = avg(ref.map((r) => r.main)), mainMax = Math.max(0, ...ref.map((r) => r.max));
  const rMax = Math.max(0, ...moving.renders), rAvg = avg(moving.renders);
  const longs = moving.long.filter((l) => l.ms > 50);
  console.log(`     refreshes measured: ${ref.length}; main-thread ms per refresh avg ${mainAvg.toFixed(1)}, longest card section ${mainMax.toFixed(1)} ms`);
  if (ref.length && ref[0].decode !== undefined) console.log(`     stages (avg): decode ${avg(ref.map((r) => r.decode)).toFixed(1)} ms, worker ${avg(ref.map((r) => r.worker)).toFixed(1)} ms, apply ${avg(ref.map((r) => r.apply)).toFixed(1)} ms`);
  const perRefresh = (task1 - task0) / ((MOVE_S * 1000) / REFRESH_MS), perIdle = (task2 - task1) / ((IDLE_S * 1000) / REFRESH_MS);
  console.log(`     whole page main-thread busy per 2 s (CDP TaskDuration): ${perRefresh.toFixed(1)} ms moving, ${perIdle.toFixed(1)} ms unchanged picture, ${quiet.toFixed(1)} ms no refresh at all`);
  console.log(`     last detection: ${JSON.stringify(await ev(`${card}._imageResult`))}`);
  console.log(`     renders: ${moving.renders.length} in ${MOVE_S} s, avg ${rAvg.toFixed(1)} ms, max ${rMax.toFixed(1)} ms`);
  console.log(`     page long tasks > 50 ms while moving: ${longs.length}${longs.length ? ` (max ${Math.max(...longs.map((l) => l.ms)).toFixed(0)} ms)` : ''}${moving.noLongtask ? ' (no longtask API)' : ''}`);
  const movingFrames = stats1.frames - stats0.frames, idleFrames = stats2.frames - stats1.frames;
  console.log(`     frames: ${movingFrames} while moving (${MOVE_S} s), ${idleFrames} while idle (${IDLE_S} s); shadow requests ${stats1.shadow - stats0.shadow}`);
  check('refreshes measured', ref.length >= 10, String(ref.length));
  check('no main-thread map section of the card > 50 ms', mainMax <= 50, mainMax.toFixed(1));
  check('renders while idle <= refresh-driven ones', idleFrames * (MOVE_S / IDLE_S) <= movingFrames, `${idleFrames} idle vs ${movingFrames} moving`);
  check('the moving mower requests no shadow-map updates', stats1.shadow - stats0.shadow === 0, String(stats1.shadow - stats0.shadow));
  const dbg = await ev(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-debug'); return el ? el.textContent : null; })()`);
  check('debug overlay shows fps, frame ms, long task, map stages', !!dbg && /fps/i.test(dbg) && /frame/i.test(dbg) && /decode/.test(dbg) && /worker/.test(dbg), String(dbg).slice(0, 300));
  if (process.env.BENCH_JSON) console.log(JSON.stringify({ mainAvg, mainMax, rAvg, rMax, longs: longs.length, movingFrames, idleFrames, all: all.refresh.length }));
  if (s.errors.length) console.log('page errors:', s.errors.slice(0, 5).join(' | '));
} finally {
  await s.close();
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nperf check passed');
