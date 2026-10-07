// Mower tracking on the live map (pure, no DOM): docked state, the dock pose, the search window,
// changed-tile detection, the adaptive refresh throttle and the Mower tab's status line.

// ---------- docked ----------
// The lawn_mower state is docked / charging, or a "Mower status" sensor says so (not "returning to
// the dock", not "leaving the dock").
export function isDocked(mowerState, statusState = null) {
  const s = String(mowerState || '').toLowerCase().trim();
  if (s === 'docked' || s === 'charging') return true;
  const t = String(statusState || '').toLowerCase();
  if (!t || /return|going|leav|back to|to dock|to the dock/.test(t)) return false;
  return /\b(docked|charging|charged|in (the )?dock|on (the )?dock|at (the )?dock)\b/.test(t);
}

// The word for the status line: 'docked' | 'charging'.
export function dockWord(mowerState, statusState = null) {
  return /charg/.test(`${String(mowerState || '').toLowerCase()} ${String(statusState || '').toLowerCase()}`) ? 'charging' : 'docked';
}

// ---------- mower + dock as one (docked) ----------
// Docked with both a mower and a dock object: one object for taps and the popup -> { mower, dock } ids, else null.
export function mowerDockGroup({ docked, mowerId, dockId }) {
  return docked && mowerId && dockId && mowerId !== dockId ? { mower: mowerId, dock: dockId } : null;
}
// The object a tap on id stands for (the dock -> the mower while grouped).
export const groupedTapId = (id, group) => (group && id === group.dock ? group.mower : id);
// No tap target / dot of its own (the dock while grouped).
export const groupedHidden = (id, group) => !!group && id === group.dock;
// The mower popup's dock row: 'Charging' / 'Docked' with the battery (%) when known.
export function dockRows(word, battery) {
  const b = battery === null || battery === undefined || battery === '' ? null : Number(battery);
  const w = word === 'charging' ? 'Charging' : 'Docked';
  return [{ kind: 'info', label: 'Dock', value: Number.isFinite(b) ? `${w} · ${Math.round(b)} %` : w }];
}

// ---------- dock pose ----------
// hints.front of the dock node ('+x' | '-x' | '+z' | '-z'), default its +Z: the local axis it faces.
export function dockFrontAxis(hints) {
  const f = hints && hints.front;
  return { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] }[f] || [0, 0, 1];
}

// Card world anchor { x, y, z } and front direction (world, any length) -> plan pose
// { x, y, heading (radians ccw from east) | null }. World (x, h, -y) = plan (x, y).
export function dockPose(anchor, dir) {
  const len = dir ? Math.hypot(dir.x, dir.z) : 0;
  return { x: anchor.x, y: -anchor.z, heading: len > 1e-6 ? Math.atan2(-dir.z, dir.x) : null };
}

// ---------- search window ----------
export const MAX_SPEED_MS = 0.5; // m/s: the farthest the mower drives between two refreshes
export const FULL_EVERY_MS = 60000;

// Pixel rectangle around the last position: 3x the icon size plus the travel possible since the last
// refresh, both ways. track: { px, py, size (icon side, px) }; dt seconds; ppm: map pixels per metre.
// -> { x0, y0, x1, y1 } (x1 / y1 exclusive, inside the picture) or null (covers most of it: full frame).
export function trackWindow(track, { dt, ppm, w, h, speed = MAX_SPEED_MS }) {
  if (!track || !Number.isFinite(track.px) || !Number.isFinite(track.py) || !(w > 0) || !(h > 0)) return null;
  const size = Math.max(4, Number(track.size) || 0);
  const travel = Math.max(0, speed * Math.max(0, dt || 0) * Math.max(0, ppm || 0));
  const half = Math.ceil(1.5 * size + travel);
  const x0 = Math.max(0, Math.floor(track.px - half)), y0 = Math.max(0, Math.floor(track.py - half));
  const x1 = Math.min(w, Math.ceil(track.px + half)), y1 = Math.min(h, Math.ceil(track.py + half));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  if ((x1 - x0) * (y1 - y0) > 0.5 * w * h) return null;
  return { x0, y0, x1, y1 };
}

// Full-frame search: nothing tracked, the last pass missed, the dock state changed, or 60 s since the
// last full pass. -> boolean
export function fullSearch({ tracked, missed, dockChanged, now, lastFull, every = FULL_EVERY_MS }) {
  return !tracked || !!missed || !!dockChanged || !Number.isFinite(lastFull) || now - lastFull >= every;
}

// ---------- the drawn layer (mowed stripes, no-mow, background) ----------
// Recomputed every 60 s or when the progress sensor changes, whichever comes first.
export function layerDue({ now, lastAt, progress, lastProgress, every = FULL_EVERY_MS }) {
  if (!Number.isFinite(lastAt)) return true;
  if (progress !== undefined && progress !== null && progress !== lastProgress) return true;
  return now - lastAt >= every;
}

// Tiles: self-contained (no references outside it), so the map worker runs the very same code.
export function tileKernel() {
  const TILE = 64;
  const tilesOf = (w, h, tile = TILE) => ({ cols: Math.ceil(w / tile), rows: Math.ceil(h / tile) });
  // FNV-1a over every step-th pixel (rgb) of each tile, rows and columns. -> Uint32Array (row-major tiles)
  function tileHashes(rgba, w, h, tile = TILE, step = 4, out = null) {
    const { cols, rows } = tilesOf(w, h, tile);
    const hs = out && out.length === cols * rows ? out : new Uint32Array(cols * rows);
    for (let ty = 0; ty < rows; ty++) {
      const y0 = ty * tile, y1 = Math.min(h, y0 + tile);
      for (let tx = 0; tx < cols; tx++) {
        const x0 = tx * tile, x1 = Math.min(w, x0 + tile);
        let hv = 0x811c9dc5;
        for (let y = y0; y < y1; y += step) {
          for (let x = x0, k = (y * w + x0) * 4; x < x1; x += step, k += step * 4) {
            hv = Math.imul(hv ^ rgba[k], 16777619);
            hv = Math.imul(hv ^ rgba[k + 1], 16777619);
            hv = Math.imul(hv ^ rgba[k + 2], 16777619);
          }
        }
        hs[ty * cols + tx] = hv >>> 0;
      }
    }
    return hs;
  }
  // Indices of the tiles whose hash changed (all of them without a previous set of the same size).
  function changedTiles(prev, next) {
    const out = [];
    for (let i = 0; i < next.length; i++) if (!prev || prev.length !== next.length || prev[i] !== next[i]) out.push(i);
    return out;
  }
  // Tile i -> { x0, y0, x1, y1 } (exclusive) inside w x h
  function tileRect(i, w, h, tile = TILE) {
    const { cols } = tilesOf(w, h, tile);
    const tx = i % cols, ty = (i - tx) / cols;
    return { x0: tx * tile, y0: ty * tile, x1: Math.min(w, tx * tile + tile), y1: Math.min(h, ty * tile + tile) };
  }
  return { TILE, tilesOf, tileHashes, changedTiles, tileRect };
}
export const { TILE, tilesOf, tileHashes, changedTiles, tileRect } = tileKernel();

// ---------- adaptive refresh ----------
// More than 3 long tasks (> 50 ms) per minute from map processing: the refresh interval doubles (up to
// 60 s); back to normal after 5 quiet minutes. st: { times: [ms], factor, quietSince } | null;
// longTask: this refresh had one. -> new state
export const LONG_TASK_MS = 50;
export function throttleStep(st, { now, longTask, base = 10, max = 60 }) {
  const s = st ? { times: st.times.filter((t) => now - t < 60000), factor: st.factor, quietSince: st.quietSince } : { times: [], factor: 1, quietSince: now };
  if (longTask) { s.times.push(now); s.quietSince = now; }
  const cap = Math.max(1, Math.floor(max / Math.max(0.001, base)));
  if (s.times.length > 3 && s.factor < cap) {
    s.factor = Math.min(cap, s.factor * 2);
    s.times = []; // the next doubling needs another 3 within a minute
  } else if (s.factor > 1 && now - s.quietSince >= 5 * 60000) {
    s.factor = 1;
    s.quietSince = now;
  }
  return s;
}
export const effectiveRefresh = (base, st) => Math.min(Math.max(base, 60), base * (st ? st.factor : 1));

// ---------- status line ----------
export function durationText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 6) / 10} h`;
}

// { kind: 'dock' | 'tracked' | 'last' | 'mismatch' | 'searching' | 'none', word, score, lostMs } -> text
export function mowerStatusText(st) {
  if (!st) return '';
  switch (st.kind) {
    case 'dock': return `At dock (${st.word || 'docked'})`;
    case 'tracked': return Number.isFinite(st.score) ? `Tracked on map (score ${st.score.toFixed(2)})` : 'Tracked on map (icon shape)';
    case 'last': return Number.isFinite(st.lostMs) ? `Last known position (not found for ${durationText(st.lostMs)})` : 'Last known position';
    case 'mismatch': return "Static map doesn't match the live map";
    case 'searching': return 'Looking for the mower…';
    default: return 'No position yet';
  }
}

// ---------- last known position (per layout, in memory) ----------
const LAST = new Map();
export function rememberPosition(key, pos) {
  if (key == null) return;
  if (pos) LAST.set(key, { ...pos });
  else LAST.delete(key);
}
export const lastPosition = (key) => (LAST.has(key) ? { ...LAST.get(key) } : null);
