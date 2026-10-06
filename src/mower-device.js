// The mower's device entities (pure): static map / mower picture / error code auto-detection,
// progress, connectivity, rain, and the automatic popup rows. hass: { states, entities }.

const lc = (s) => String(s || '').toLowerCase();
// "Zone A Area" / zone_a_area -> "zone a area" (spaces for _ and repeated blanks)
export const words = (s) => lc(s).replace(/[_\s]+/g, ' ').trim();

export function deviceOf(hass, eid) {
  const e = hass && hass.entities && hass.entities[eid];
  return (e && e.device_id) || null;
}

export function deviceEntities(hass, deviceId) {
  if (!deviceId || !hass || !hass.entities) return [];
  return Object.keys(hass.entities).filter((eid) => hass.entities[eid] && hass.entities[eid].device_id === deviceId && (!hass.states || hass.states[eid]));
}

// id + friendly name, normalised: what keyword matching looks at
export function label(hass, eid) {
  const st = hass.states && hass.states[eid];
  const reg = hass.entities && hass.entities[eid];
  return words(`${eid.split('.')[1] || eid} ${(reg && (reg.name || reg.original_name)) || ''} ${(st && st.attributes && st.attributes.friendly_name) || ''}`);
}

// Entities of the device of any of `from` (first one with a device), in id order.
export function mowerDevice(hass, ...from) {
  for (const e of from) {
    const d = e && deviceOf(hass, e);
    if (d) return { deviceId: d, entities: deviceEntities(hass, d).sort() };
  }
  return { deviceId: null, entities: [] };
}

const firstMatch = (hass, list, re, domain) => list.find((eid) => (!domain || eid.startsWith(domain + '.')) && re.test(label(hass, eid))) || null;

// The static lawn map: an image.* of the live map's (else the mower's) device whose id / name ends in
// "map" and is not the live map, the mower picture or a wifi map.
export function findStaticMap(hass, liveEntity, mowerEntity) {
  const { entities } = mowerDevice(hass, liveEntity, mowerEntity);
  return entities.find((eid) => {
    if (!eid.startsWith('image.') || eid === liveEntity) return false; // the live map by its id
    const id = lc(eid.split('.')[1]);
    if (/mower_image|wifi/.test(id) || /wifi|mower image/.test(label(hass, eid))) return false;
    return /map$/.test(id);
  }) || null;
}

export function findMowerPicture(hass, liveEntity, mowerEntity) {
  const { entities } = mowerDevice(hass, mowerEntity, liveEntity);
  return firstMatch(hass, entities, /mower image/, 'image');
}

export function findErrorEntity(hass, mowerEntity) {
  const { entities } = mowerDevice(hass, mowerEntity);
  return firstMatch(hass, entities, /error ?code/, 'sensor');
}

// The "Mower status" sensor (Docked / Charging / Working ...) of the mower's device.
export function findStatusEntity(hass, mowerEntity) {
  const { entities } = mowerDevice(hass, mowerEntity);
  return firstMatch(hass, entities, /mower status|robot status/, 'sensor');
}

export function findProgress(hass, mowerEntity) {
  const { entities } = mowerDevice(hass, mowerEntity);
  return entities.find((eid) => {
    if (!eid.startsWith('sensor.') || !/progress/.test(label(hass, eid))) return false;
    const st = hass.states[eid];
    const unit = st && st.attributes && st.attributes.unit_of_measurement;
    return !unit || unit === '%';
  }) || null;
}

// Mowing progress 0..1 from the progress sensor, or null.
export function progressValue(hass, eid) {
  const st = eid && hass.states[eid];
  const n = st ? Number(st.state) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : null;
}

const isNum = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));
const unitOf = (st) => (st && st.attributes && st.attributes.unit_of_measurement) || '';
const fmtState = (st) => {
  if (!st) return '';
  if (isNum(st.state)) { const n = Number(st.state), u = unitOf(st); return `${Math.round(n * 10) / 10}${u ? (u === '%' ? ' %' : ' ' + u) : ''}`; }
  return String(st.state);
};

// Connectivity binary sensor of the device: { entity, online, since (last_changed) } or null.
export function connectivity(hass, mowerEntity) {
  const { entities } = mowerDevice(hass, mowerEntity);
  const eid = entities.find((e) => e.startsWith('binary_sensor.') && ((hass.states[e].attributes || {}).device_class === 'connectivity' || /online|connect/.test(label(hass, e))));
  if (!eid) return null;
  const st = hass.states[eid];
  if (st.state !== 'on' && st.state !== 'off') return { entity: eid, online: null, since: null };
  return { entity: eid, online: st.state === 'on', since: st.last_changed || null };
}

// Rain sensor of the device: { entity, wet, drying (minutes left or null), state } or null.
export function rain(hass, mowerEntity) {
  const { entities } = mowerDevice(hass, mowerEntity);
  const eid = entities.find((e) => /^(sensor|binary_sensor)\./.test(e) && /rain/.test(label(hass, e)) && !/countdown/.test(label(hass, e)));
  if (!eid) return null;
  const st = hass.states[eid], s = lc(st.state);
  const cd = entities.find((e) => e.startsWith('sensor.') && /rain/.test(label(hass, e)) && /countdown/.test(label(hass, e)));
  const mins = cd && isNum(hass.states[cd].state) ? Number(hass.states[cd].state) : null;
  const wet = eid.startsWith('binary_sensor.') ? s === 'on' : /wet|rain/.test(s) && !/dry/.test(s);
  const drying = !wet && /countdown|drying/.test(s) ? mins ?? 0 : null;
  return { entity: eid, wet, drying, state: st.state };
}

// Zone entities of the current work region: "Zone A Area", "Zone A Estimated time", "Zone A Started" ...
export function zoneEntities(hass, entities, region) {
  const r = words(region);
  if (!r || r === 'unknown' || r === 'unavailable') return {};
  // whole words: "zone 1" is not "zone 10", "zone a" is not "zone area"
  const mine = entities.filter((e) => ` ${label(hass, e)} `.includes(` ${r} `));
  const pick = (re, domain) => mine.find((e) => (!domain || e.startsWith(domain + '.')) && re.test(label(hass, e))) || null;
  return {
    area: pick(/area/, 'sensor'), estimated: pick(/estimat/, 'sensor'),
    started: pick(/start/), finished: pick(/finish/),
  };
}

const ROWS = [
  ['status', 'Mower status', (h, e) => e.startsWith('sensor.') && /(mower|robot) status/.test(label(h, e))],
  ['progress', 'Progress', (h, e) => e.startsWith('sensor.') && /progress/.test(label(h, e))],
  ['battery', 'Battery', (h, e) => e.startsWith('sensor.') && ((h.states[e].attributes || {}).device_class === 'battery' || /battery/.test(label(h, e)))],
  ['region', 'Work region', (h, e) => e.startsWith('sensor.') && /work region|region/.test(label(h, e))],
  ['wifi', 'Wifi', (h, e) => e.startsWith('sensor.') && /wifi|rssi/.test(label(h, e)) && !/map/.test(label(h, e))],
  ['signal', 'Robot signal', (h, e) => e.startsWith('sensor.') && /signal/.test(label(h, e)) && !/wifi|rssi/.test(label(h, e))],
  ['cutter', 'Cutter time left', (h, e) => e.startsWith('sensor.') && /cutter|blade/.test(label(h, e))],
  ['area', 'Total area', (h, e) => e.startsWith('sensor.') && /total area/.test(label(h, e))],
  ['records', 'Work records', (h, e) => e.startsWith('sensor.') && /work record/.test(label(h, e))],
  ['error', 'Error code', (h, e) => e.startsWith('sensor.') && /error ?code/.test(label(h, e))],
];

// Automatic popup rows from the mower's device: [{ key, label, value, entity }], each only when present.
export function deviceRows(hass, mowerEntity, now = Date.now()) {
  const { entities } = mowerDevice(hass, mowerEntity);
  if (!entities.length) return [];
  const used = new Set([mowerEntity]);
  const out = [];
  const found = {};
  for (const [key, lab, test] of ROWS) {
    const eid = entities.find((e) => !used.has(e) && !(hass.entities[e] || {}).hidden && test(hass, e));
    if (!eid) continue;
    used.add(eid);
    found[key] = eid;
    const st = hass.states[eid];
    if (key === 'error' && isNum(st.state) && Number(st.state) === 0) { out.push({ key, label: lab, value: '0 (OK)', entity: eid }); continue; }
    out.push({ key, label: lab, value: fmtState(st), entity: eid });
  }
  const r = rain(hass, mowerEntity);
  if (r) {
    const value = r.wet ? 'Wet' : r.drying !== null ? `Drying, ${r.drying} min left` : String(r.state);
    out.splice(Math.min(out.length, 3), 0, { key: 'rain', label: 'Rain', value, entity: r.entity });
  }
  const c = connectivity(hass, mowerEntity);
  if (c && c.online === false) {
    out.unshift({ key: 'offline', label: 'Offline', value: c.since ? `since ${sinceText(c.since, now)}` : 'yes', entity: c.entity });
  } else if (c && c.online) out.push({ key: 'online', label: 'Online', value: 'Connected', entity: c.entity });
  // the current work region: its area, estimated time, time left, started / finished
  if (found.region) {
    const region = hass.states[found.region].state;
    const z = zoneEntities(hass, entities.filter((e) => !used.has(e)), region);
    const at = out.findIndex((x) => x.key === 'region') + 1;
    const extra = [];
    if (z.area) extra.push({ key: 'zone_area', label: `${region} area`, value: fmtState(hass.states[z.area]), entity: z.area });
    if (z.estimated) {
      const est = hass.states[z.estimated];
      extra.push({ key: 'zone_est', label: `${region} estimated`, value: fmtState(est), entity: z.estimated });
      const p = found.progress ? progressValue(hass, found.progress) : null;
      if (p !== null && isNum(est.state)) extra.push({ key: 'zone_left', label: 'Time left', value: `≈ ${Math.max(0, Math.round(Number(est.state) * (1 - p)))} min`, entity: z.estimated });
    }
    if (z.finished && hass.states[z.finished].state === 'on') extra.push({ key: 'zone_done', label: region, value: 'Finished', entity: z.finished });
    else if (z.started && hass.states[z.started].state === 'on') extra.push({ key: 'zone_started', label: region, value: 'Started', entity: z.started });
    out.splice(at, 0, ...extra);
  }
  return out;
}

export function sinceText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return new Date(t).toLocaleString();
}
