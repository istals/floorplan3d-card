// Mower warning: error classification and the "stuck?" detector (pure, no DOM / Three.js).

const OK_STATES = new Set(['', 'none', 'ok', 'no error', 'unknown', 'unavailable']);
export const STUCK_MOVE_M = 0.3;
export const STUCK_DEFAULT_MIN = 5;

// An error entity reports a problem: binary_sensor on, or a sensor whose state is not one of the "fine" words.
export function isProblem(st) {
  if (!st || st.state === undefined || st.state === null) return false;
  const s = String(st.state).trim().toLowerCase();
  if (String(st.entity_id || '').startsWith('binary_sensor.')) return s === 'on';
  return !OK_STATES.has(s);
}

// 'error' when the mower reports error (state) or the error entity reports a problem, else null.
export function errorKind(mowerState, errorState) {
  if (mowerState && String(mowerState.state).toLowerCase() === 'error') return 'error';
  return isProblem(errorState) ? 'error' : null;
}

// Text for the popup: the error entity's state and its description / message attributes.
export function errorText(mowerState, errorState) {
  if (isProblem(errorState)) {
    const a = errorState.attributes || {};
    const extra = [a.description, a.message].filter((v) => typeof v === 'string' && v.trim());
    const base = String(errorState.state).toLowerCase() === 'on' && String(errorState.entity_id || '').startsWith('binary_sensor.')
      ? (a.friendly_name || 'Problem') : String(errorState.state);
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
  if (!pos) return prev.anchor ? { ...prev, stuck: now - prev.since >= minutes * 60000 } : prev;
  if (!prev.anchor || Math.hypot(pos[0] - prev.anchor[0], pos[1] - prev.anchor[1]) >= STUCK_MOVE_M) {
    return { anchor: [pos[0], pos[1]], since: now, stuck: false };
  }
  return { ...prev, stuck: now - prev.since >= minutes * 60000 };
}

// ms until the detector would flag (null when it cannot).
export function stuckDueIn(st, now, minutes) {
  if (!st || !st.anchor || st.stuck || !(minutes > 0)) return null;
  return Math.max(0, st.since + minutes * 60000 - now);
}
