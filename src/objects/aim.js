// Spot aiming: a spot's hints.target is trusted only when it is plausible. Pure (plain [x, y, z] arrays).

export const TARGET_MAX_M = 8; // without hints.distance: a target farther than this is ignored
export const UP_RE = /uplight|up_light|uplighter/i;
export const UP_M = 2; // fallback aim straight up, this far over the lamp
export const DOWN_M = 1; // fallback aim straight down

const key = (t) => t.map((v) => Math.round(v * 1e6) / 1e6).join(',');

// True for an object aimed up: hints beam "up", or an id / label naming an uplight.
export function aimsUp(obj) {
  if (!obj) return false;
  if (obj.hints && obj.hints.beam === 'up') return true;
  return UP_RE.test(String(obj.id || '')) || UP_RE.test(String(obj.label || ''));
}

// spots: [{ id, group, pos: [x, y, z], target: [x, y, z] | null, distance }] (one frame for pos and
// target). -> Map id -> 'shared' | 'far' for each target that is ignored: farther than distance
// (8 m when 0 / unset) from the lamp, or shared by 2+ spots of the same group.
export function badTargets(spots) {
  const bad = new Map(), byGroup = new Map();
  for (const s of spots || []) {
    if (!s || !Array.isArray(s.target)) continue;
    if (s.group) {
      const k = s.group + '|' + key(s.target);
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(s.id);
    }
    const max = Number(s.distance) > 0 ? Number(s.distance) : TARGET_MAX_M;
    const p = s.pos || [0, 0, 0];
    if (Math.hypot(s.target[0] - p[0], s.target[1] - p[1], s.target[2] - p[2]) > max) bad.set(s.id, 'far');
  }
  for (const ids of byGroup.values()) if (ids.length >= 2) for (const id of ids) bad.set(id, 'shared');
  return bad;
}

// Where a spot points (same frame as pos): its target when trusted, else straight up (uplights) or down.
export function aimPoint(pos, target, { bad = false, up = false } = {}) {
  if (Array.isArray(target) && !bad) return target.slice();
  return [pos[0], pos[1] + (up ? UP_M : -DOWN_M), pos[2]];
}

// The model check / Model tab warning, or null.
export function aimWarning(bad) {
  const ids = [...(bad ? bad.keys() : [])].sort();
  return ids.length ? `spot target looks wrong (shared / too far): ${ids.join(', ')}` : null;
}
