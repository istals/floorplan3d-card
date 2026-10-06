// `debug: true`: a small performance overlay (bottom-left, monospace, theme colours). Updated once a
// second: FPS, frame ms (avg / max over 1 s), the longest main-thread task of the last 60 s (long task
// API, else measured frame gaps), the last map refresh's stages, shadow-map updates and renders a minute,
// and the map refresh interval (doubled by the adaptive throttle).
import { effectiveRefresh } from './mower-track.js';

const fmt = (v) => (Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : '–');

export class DebugOverlay {
  // card: { _perf, _throttle, _mapRefreshSec(), longTasks() }
  constructor(stage, view, card) {
    this.view = view;
    this.card = card;
    this.el = document.createElement('div');
    this.el.className = 'fp-debug';
    stage.appendChild(this.el);
    this.frameMs = [];
    this.gaps = []; // [at, ms] frame gaps over 60 s (no long task API)
    this.minute = []; // [at, frames, shadowLights] samples, 1 s apart
    this.last = { frames: view.stats.frames };
    this._lastTick = 0;
    view.onFrameTime = (ms) => this.frameMs.push(ms);
    view.onTick = (ts) => {
      if (this._lastTick && ts - this._lastTick > 50) this.gaps.push([performance.now(), ts - this._lastTick]);
      this._lastTick = ts;
    };
    this.timer = setInterval(() => this.update(), 1000);
    this.update();
  }

  update() {
    const v = this.view, now = performance.now();
    const frames = v.stats.frames - this.last.frames;
    this.last.frames = v.stats.frames;
    const fm = this.frameMs;
    this.frameMs = [];
    const avg = fm.length ? fm.reduce((a, b) => a + b, 0) / fm.length : null, max = fm.length ? Math.max(...fm) : null;
    this.minute.push([now, v.stats.frames, v.stats.shadowLights]);
    while (this.minute.length && now - this.minute[0][0] > 60000) this.minute.shift();
    const first = this.minute[0];
    const span = Math.max(1, (now - first[0]) / 60000);
    const rendersMin = (v.stats.frames - first[1]) / span, shadowsMin = (v.stats.shadowLights - first[2]) / span;
    this.gaps = this.gaps.filter(([at]) => now - at < 60000);
    const lt = this.card.longTasks ? this.card.longTasks() : null;
    const longest = lt ? Math.max(0, ...lt.filter((e) => now - e.start < 60000).map((e) => e.ms)) : Math.max(0, ...this.gaps.map(([, ms]) => ms - 16.7));
    const p = this.card._perf && this.card._perf.last;
    const t = this.card._throttle;
    const base = this.card._mapRefreshSec ? this.card._mapRefreshSec() : null;
    const lines = [
      `fps ${frames} · frame ${fmt(avg)} / ${fmt(max)} ms`,
      `longest task (60 s) ${fmt(longest)} ms ${lt ? '' : '(gaps)'}`.trim(),
      p ? `map: decode ${fmt(p.decode)} · worker ${fmt(p.worker)} · apply ${fmt(p.apply)} ms (main ${fmt(p.main)})` : 'map: decode – · worker – · apply –',
      `shadows ${fmt(shadowsMin)}/min · renders ${fmt(rendersMin)}/min`,
    ];
    if (base) lines.push(`map refresh ${effectiveRefresh(base, t)} s${t && t.factor > 1 ? ' (throttled)' : ''}`);
    this.el.textContent = lines.join('\n');
  }

  dispose() {
    clearInterval(this.timer);
    if (this.view.onFrameTime) this.view.onFrameTime = null;
    if (this.view.onTick) this.view.onTick = null;
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
