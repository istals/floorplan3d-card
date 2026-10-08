// Model loading UI of the card: the slim progress bar at the bottom of the stage and the plan drawing
// shown over the empty stage while the model loads (room outlines traced in step with the download).
import { progressText } from './model-cache.js';
import { idbAll, idbDelete } from './idb.js';
import { fitOutline, HOUSE_OUTLINE } from './load-outline.js';

export const LOAD_STYLE = `
  .stage { isolation: isolate; }
  .fp-progress[hidden], .fp-loadplan[hidden] { display: none; }
  .fp-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; pointer-events: none; }
  .fp-progress .bar { height: 3px; background: var(--primary-color, #03a9f4); width: 0; transition: width .2s linear; }
  .fp-progress.busy .bar { width: 100%; opacity: .45; }
  .fp-progress span { position: absolute; right: 8px; bottom: 6px; font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: var(--card-background-color, #fff); color: var(--secondary-text-color, #727272);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  .fp-progress.plan span { display: none; }
  .fp-progress.error span { color: var(--error-color, #db4437); }
  .fp-loadplan { position: absolute; inset: 0; z-index: 1; pointer-events: none; background: var(--card-background-color, #fff); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 10px; opacity: 1; transition: opacity .3s ease; }
  .fp-loadplan.fading { opacity: 0; }
  .fp-loadplan svg { width: 60%; height: 60%; min-height: 0; overflow: visible; fill: none; stroke-linejoin: round; stroke-linecap: round; }
  .fp-loadplan .fill { stroke: none; fill: var(--primary-color, #03a9f4); opacity: 0; transition: opacity .3s ease; }
  .fp-loadplan .fill.on { opacity: .08; }
  .fp-loadplan .base { stroke: var(--divider-color, rgba(0,0,0,.12)); stroke-width: .8; }
  .fp-loadplan .draw { stroke: var(--primary-color, #03a9f4); stroke-width: 1; transition: stroke-dashoffset .2s linear; }
  .fp-loadplan.busy .draw { animation: fp-trace 2.4s ease-in-out infinite; }
  .fp-loadplan .txt { font-size: 12px; color: var(--secondary-text-color, #727272); min-height: 1.2em; }
  @keyframes fp-trace { from { stroke-dashoffset: var(--start); } to { stroke-dashoffset: var(--end); } }
  @media (prefers-reduced-motion: reduce) {
    .fp-loadplan.busy .draw { animation: none; stroke-dasharray: none; opacity: .5; }
    .fp-loadplan, .fp-loadplan .draw { transition: none; }
  }
`;

let purged = false; // snapshots of earlier versions: removed once per page load

export class ModelLoadUI {
  // host: { stage, outline(): [polygon] | null (remembered or drawn rooms, plan metres) }
  constructor(host) {
    this.host = host;
    this.bar = document.createElement('div');
    this.bar.className = 'fp-progress';
    this.bar.hidden = true;
    this.bar.innerHTML = '<div class="bar"></div><span></span>';
    host.stage.append(this.bar);
    this.plan = null; // the drawing overlay while a model loads
    this.log = []; // the texts shown (headless checks)
    this.readyAt = null;
    if (!purged) {
      purged = true;
      idbAll('snapshots').then((all) => (all.length ? idbDelete('snapshots', all.map((r) => r.key)) : null));
    }
  }

  // progress: text, frac (0..1, null: busy without a known share), error
  progress(text, frac = null, error = false) {
    clearTimeout(this._errTimer);
    if (!text) { this.bar.hidden = true; return; }
    this.bar.hidden = false;
    this.bar.classList.toggle('busy', frac === null && !error);
    this.bar.classList.toggle('error', !!error);
    this.bar.classList.toggle('plan', !!this.plan && !error);
    this.bar.firstChild.style.width = frac === null ? '' : `${Math.round(frac * 100)}%`;
    if (this.bar.lastChild.textContent !== text) {
      this.bar.lastChild.textContent = text;
      this.log.push(text);
      if (this.log.length > 20) this.log.shift();
    }
    if (!error) this._drawProgress(text, frac);
    if (error) this._errTimer = setTimeout(() => { this.bar.hidden = true; }, 8000);
  }

  download(loaded, total) {
    this.progress(progressText(loaded, total), total ? Math.min(1, loaded / total) : null);
  }

  // A model starts loading: the plan drawing over the stage.
  loading() {
    this.readyAt = null;
    this._removePlan();
    const polys = (this.host.outline && this.host.outline()) || HOUSE_OUTLINE;
    const fit = fitOutline(polys.length ? polys : HOUSE_OUTLINE);
    const el = document.createElement('div');
    el.className = 'fp-loadplan busy';
    el.innerHTML = `<svg viewBox="${fit.viewBox}" aria-hidden="true">${fit.parts.map((q) => `<path class="fill" d="${q.d}"/>`).join('')}<path class="base" d="${fit.d}"/><path class="draw" d="${fit.d}"/></svg><div class="txt"></div>`;
    this.plan = el;
    this.fit = fit;
    this.path = el.querySelector('.draw');
    this.path.style.setProperty('--start', `${fit.length * 0.4}`);
    this.path.style.setProperty('--end', `${-fit.length}`);
    this.path.style.strokeDasharray = `${fit.length * 0.4} ${fit.length}`;
    this.host.stage.prepend(el);
    this.bar.classList.add('plan');
  }

  _drawProgress(text, frac) {
    const el = this.plan;
    if (!el) return;
    el.querySelector('.txt').textContent = text;
    const busy = frac === null;
    el.classList.toggle('busy', busy);
    const L = this.fit.length;
    this.path.style.strokeDasharray = busy ? `${L * 0.4} ${L}` : `${L}`;
    this.path.style.strokeDashoffset = busy ? '' : `${L * (1 - frac)}`;
    el.querySelectorAll('.fill').forEach((q, i) => q.classList.toggle('on', !busy && this.fit.parts[i].end <= L * frac + 0.01));
  }

  _removePlan() {
    clearTimeout(this._fadeTimer);
    if (this.plan) this.plan.remove();
    this.plan = null;
    this.bar.classList.remove('plan');
  }

  // The model is ready (ok) or failed: fade the drawing out (then remove it), hide the bar (or show the error).
  done(ok, error = '') {
    if (ok) {
      this.readyAt = performance.now();
      this.progress(null);
    } else if (error) {
      this._removePlan();
      this.progress(error, null, true);
    } else this.progress(null);
    const el = this.plan;
    if (!el) return;
    el.classList.add('fading');
    clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => { if (this.plan === el) this._removePlan(); }, 320);
  }

  dispose() {
    clearTimeout(this._fadeTimer);
    clearTimeout(this._errTimer);
  }
}
