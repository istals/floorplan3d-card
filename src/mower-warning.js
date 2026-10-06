// Mower warning: error classification and the "stuck?" detector (pure, no DOM / Three.js).

export const OK_WORDS = ['ok', 'none', 'no error', 'no_error', 'normal', 'working', 'mowing', 'charging', 'docked',
  'idle', 'returning', 'paused', 'standby', 'sleeping', 'ready', 'home', 'off'];
const OK_STATES = new Set(OK_WORDS);
const NO_READING = new Set(['', 'unknown', 'unavailable']);
export const STUCK_MOVE_M = 0.3;
export const STUCK_DEFAULT_MIN = 5;

// "a, b ,c" or ['a', 'b'] -> lower-case trimmed words.
export function parseOkValues(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

const numeric = (s) => /^[-+]?\d+(\.\d+)?$/.test(s);

// An error entity reports a problem: binary_sensor on; a numeric code other than 0; or a text state
// that is not one of the OK words (plus the user's extra okValues). No reading is never a problem.
export function isProblem(st, okValues) {
  if (!st || st.state === undefined || st.state === null) return false;
  const s = String(st.state).trim().toLowerCase();
  if (NO_READING.has(s)) return false;
  if (String(st.entity_id || '').startsWith('binary_sensor.')) return s === 'on';
  const extra = parseOkValues(okValues);
  if (extra.includes(s)) return false;
  if (numeric(s)) return Number(s) !== 0;
  return !OK_STATES.has(s);
}

// 'error' when the mower reports error (state) or the error entity reports a problem, else null.
export function errorKind(mowerState, errorState, okValues) {
  if (mowerState && String(mowerState.state).toLowerCase() === 'error') return 'error';
  return isProblem(errorState, okValues) ? 'error' : null;
}

// Text for the popup: the error entity's state ("Error code N" for numbers) and its description / message attributes.
export function errorText(mowerState, errorState, okValues) {
  if (isProblem(errorState, okValues)) {
    const a = errorState.attributes || {};
    const extra = [a.description, a.message].filter((v) => typeof v === 'string' && v.trim());
    const raw = String(errorState.state).trim();
    const base = raw.toLowerCase() === 'on' && String(errorState.entity_id || '').startsWith('binary_sensor.')
      ? (a.friendly_name || 'Problem') : numeric(raw) ? `Error code ${Number(raw)}` : raw;
    return [base, ...extra].join(': ');
  }
  if (mowerState && String(mowerState.state).toLowerCase() === 'error') return 'Mower reports an error';
  return null;
}

// One step of the stuck detector. st = { anchor: [x, y] | null, since: ms | null, stuck }.
// Only a mowing mower with a known position can be stuck: docked / paused / returning / error reset it.
// No position this step (image detection missed): nothing changes. minutes <= 0: off.
export function stuckStep(st, { now, pos, state, minutes }) {
  const prev = st || { anchor: null, since: null, stuck: false };
  if (!(minutes > 0) || String(state).toLowerCase() !== 'mowing') return { anchor: null, since: null, stuck: false };
  // No reading: the clock pauses (lostAt); the time without readings is not added when they return.
  if (!pos) return prev.anchor ? { ...prev, lostAt: prev.lostAt ?? now, stuck: false } : prev;
  if (!prev.anchor || Math.hypot(pos[0] - prev.anchor[0], pos[1] - prev.anchor[1]) >= STUCK_MOVE_M) {
    return { anchor: [pos[0], pos[1]], since: now, stuck: false };
  }
  const since = prev.lostAt === undefined || prev.lostAt === null ? prev.since : prev.since + (now - prev.lostAt);
  return { anchor: prev.anchor, since, stuck: now - since >= minutes * 60000 };
}

// ms until the detector would flag (null when it cannot).
export function stuckDueIn(st, now, minutes) {
  if (!st || !st.anchor || st.stuck || st.lostAt !== undefined && st.lostAt !== null || !(minutes > 0)) return null;
  return Math.max(0, st.since + minutes * 60000 - now);
}
