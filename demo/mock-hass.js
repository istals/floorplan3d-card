// A small fake Home Assistant: registries, states, services, websocket, a mower driving circles.
import { DEMO_LAYOUT } from './layout.js';

const floors = {
  ground: { floor_id: 'ground', name: 'Ground floor', level: 0 },
  first: { floor_id: 'first', name: 'First floor', level: 1 },
};
const areaFloor = {
  living_room: 'ground', hall: 'ground', kitchen: 'ground', bathroom: 'ground', bedroom: 'ground',
  utility: 'ground', terrace: 'ground', garden: 'ground', garage: 'ground',
  kids_room: 'first', landing: 'first', office: 'first', master_bedroom: 'first', bathroom_2: 'first',
};
// Live map image like a robot mower integration renders it: the 9 x 17 m lawn of mower-map.svg
// (50 px/m, centred on the garden) with the mower as a coloured dot. Aligned as the overlay at
// (16.5, 1.5), width 9, the dot sits where the fake mower is.
let liveCanvas = null;
function liveMap(t) {
  if (typeof document === 'undefined') return '';
  const c = (liveCanvas = liveCanvas || Object.assign(document.createElement('canvas'), { width: 450, height: 850 }));
  const g = c.getContext('2d');
  g.fillStyle = '#1d3b1f';
  g.fillRect(0, 0, 450, 850);
  g.fillStyle = '#3f8f3a';
  g.fillRect(25, 25, 400, 800);
  g.fillStyle = '#58a852';
  for (let y = 80; y < 825; y += 80) g.fillRect(25, y - 9, 400, 18);
  g.fillStyle = '#f0f0f0';
  g.fillRect(360, 770, 50, 40); // dock
  g.fillStyle = '#ff3b30'; // the mower
  g.beginPath();
  g.arc(225 + 200 * Math.cos(t), 425 - 200 * Math.sin(t), 9, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL('image/png');
}
const pretty = (id) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const areas = Object.fromEntries(Object.entries(areaFloor).map(([id, f]) => [id, { area_id: id, name: pretty(id), floor_id: f }]));

const devices = {};
const entities = {};
const states = {};
function device(id, name, area, list) {
  devices[id] = { id, name, area_id: area };
  for (const [eid, state, attributes = {}, reg = {}] of list) {
    entities[eid] = { entity_id: eid, device_id: id, ...reg };
    states[eid] = { entity_id: eid, state: String(state), attributes: { friendly_name: name, ...attributes } };
  }
}
const temp = (v) => ({ device_class: 'temperature', unit_of_measurement: '°C', state: v });
const sensor = (eid, v, dc, unit) => [eid, v, { device_class: dc, unit_of_measurement: unit }];
const light = (eid, on, brightness = 255, rgb) => [eid, on ? 'on' : 'off', on ? { brightness, ...(rgb ? { rgb_color: rgb } : {}) } : {}];

device('living_ceiling', 'Living ceiling', 'living_room', [light('light.living_ceiling', true, 210, [255, 190, 120])]);
device('floor_lamp', 'Floor lamp', 'living_room', [light('light.floor_lamp', true, 150, [110, 130, 255])]);
device('living_climate', 'Living climate', 'living_room', [
  sensor('sensor.living_temperature', 21.4, 'temperature', '°C'), sensor('sensor.living_humidity', 44, 'humidity', '%'),
  sensor('sensor.living_battery', 87, 'battery', '%').concat([{ entity_category: 'diagnostic' }]),
]);
device('tv', 'TV', 'living_room', [['media_player.tv', 'playing']]);
device('living_motion', 'Living motion', 'living_room', [['binary_sensor.living_motion', 'off', { device_class: 'motion' }]]);
device('living_blinds', 'Blinds', 'living_room', [['cover.living_blinds', 'open']]);
device('living_window', 'Terrace door', 'living_room', [['binary_sensor.terrace_door', 'off', { device_class: 'door' }]]);

device('hall_light', 'Hall light', 'hall', [light('light.hall', false)]);
device('front_door', 'Front door', 'hall', [['binary_sensor.front_door', 'off', { device_class: 'door' }]]);
device('front_lock', 'Front lock', 'hall', [['lock.front_door', 'locked']]);
device('smoke_hall', 'Smoke detector', 'hall', [['binary_sensor.smoke_hall', 'off', { device_class: 'smoke' }]]);

device('kitchen_main', 'Kitchen light', 'kitchen', [light('light.kitchen', true, 255)]);
device('kitchen_island', 'Island light', 'kitchen', [light('light.kitchen_island', false)]);
device('kettle_plug', 'Kettle plug', 'kitchen', [['switch.kettle', 'off'], sensor('sensor.kettle_power', 0, 'power', 'W'), ['update.kettle_fw', 'off']]);
device('kitchen_temp', 'Kitchen sensor', 'kitchen', [sensor('sensor.kitchen_temperature', 22.8, 'temperature', '°C'), sensor('sensor.kitchen_humidity', 51, 'humidity', '%')]);

device('bath_light', 'Bathroom light', 'bathroom', [light('light.bathroom', false)]);
device('bath_fan', 'Bathroom fan', 'bathroom', [['fan.bathroom', 'on']]);
device('bath_humidity', 'Bathroom humidity', 'bathroom', [sensor('sensor.bathroom_humidity', 68, 'humidity', '%')]);

device('bed_light', 'Bedroom light', 'bedroom', [light('light.bedroom', false)]);
device('bed_climate', 'Bedroom radiator', 'bedroom', [['climate.bedroom', 'heat', { current_temperature: 20.5, temperature: 21 }]]);
device('bed_window', 'Bedroom window', 'bedroom', [['binary_sensor.bedroom_window', 'on', { device_class: 'window' }]]);

device('boiler', 'Boiler', 'utility', [['water_heater.boiler', 'eco', { current_temperature: 54 }]]);
device('washer', 'Washer plug', 'utility', [['switch.washer', 'on'], sensor('sensor.washer_power', 412, 'power', 'W')]);

device('terrace_light', 'Terrace light', 'terrace', [light('light.terrace', true, 180, [255, 160, 80])]);
device('outdoor_temp', 'Outdoor sensor', 'terrace', [sensor('sensor.outdoor_temperature', 9.6, 'temperature', '°C')]);

device('mower', 'Mower', 'garden', [
  ['lawn_mower.demo', 'mowing', { battery_level: 76 }], sensor('sensor.demo_mower_battery', 76, 'battery', '%'),
  ['device_tracker.sunseeker_position', 'not_home', { latitude: 45.0, longitude: 10.0 }],
]);
device('garden_cam', 'Garden camera', 'garden', [['camera.garden', 'idle']]);
device('mower_map', 'Sunseeker map', 'garden', [['image.sunseeker_map', '2026-01-01T00:00:00+00:00', { entity_picture: '/demo/mower-map.svg' }]]);
device('mower_live_map', 'Sunseeker live map', 'garden', [['image.sunseeker_live_map', '2026-01-01T00:00:00+00:00', { entity_picture: liveMap(0) }]]);
device('garage_door', 'Garage door', 'garage', [['cover.garage', 'closed']]); // no room drawn: not shown

device('kids_light', 'Kids light', 'kids_room', [light('light.kids', true, 90, [255, 120, 200])]);
device('kids_temp', 'Kids sensor', 'kids_room', [sensor('sensor.kids_temperature', 21.9, 'temperature', '°C')]);
device('landing_light', 'Landing light', 'landing', [light('light.landing', false)]);
device('landing_motion', 'Landing motion', 'landing', [['binary_sensor.landing_motion', 'on', { device_class: 'motion' }]]);
device('office_light', 'Office light', 'office', [light('light.office', true, 255, [230, 240, 255])]);
device('office_pc', 'Office PC plug', 'office', [['switch.office_pc', 'on'], sensor('sensor.office_pc_power', 138, 'power', 'W')]);
device('office_co2', 'Office air', 'office', [sensor('sensor.office_co2', 812, 'carbon_dioxide', 'ppm'), sensor('sensor.office_temperature', 23.1, 'temperature', '°C')]);
device('master_light', 'Master light', 'master_bedroom', [light('light.master', false)]);
device('bath2_light', 'Bathroom 2 light', 'bathroom_2', [light('light.bathroom_2', false)]);
device('bath2_heater', 'Floor heating', 'bathroom_2', [['climate.bathroom_2', 'heat', { current_temperature: 24 }]]);
// bound to the demo model's objects (demo/house.glb): with ?model=1 these have no markers, the model is the control
device('demo_living_lamp', 'Living ceiling lamp', 'living_room', [light('light.demo_living', true, 200, [255, 200, 140])]);
device('demo_hall_lamp', 'Hall ceiling lamp', 'hall', [light('light.demo_hall', false)]);
device('demo_kitchen_lamp', 'Kitchen ceiling lamp', 'kitchen', [light('light.demo_kitchen', true, 255)]);
device('demo_strip', 'Kitchen strip', 'kitchen', [light('light.demo_strip', true, 150, [120, 200, 255])]);
device('demo_facade', 'Facade lamps', 'terrace', [light('light.demo_facade', true, 230)]);
device('demo_facade_switch', 'Facade switch', 'hall', [['switch.demo_facade', 'on']]); // group controller (layout.groups.facade)
device('demo_terrace_spot', 'Terrace spot', 'terrace', [light('light.demo_terrace', true, 220, [255, 170, 90])]);
device('demo_climate', 'Living climate unit', 'living_room', [['climate.demo_living', 'heat',
  { current_temperature: 21.5, temperature: 22, hvac_action: 'heating', hvac_modes: ['off', 'heat', 'cool', 'auto'] }]]);
device('demo_charger', 'EV charger', 'garden', [['sensor.demo_charger', 'charging', { power: 7.4, energy: 12.6 }]]);
void temp;

// In-memory stand-in for the integration's /api/floorplan3d/model/<key> endpoint.
const models = new Map();
async function fetchWithAuth(url, init = {}) {
  const key = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop());
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const method = (init.method || 'GET').toUpperCase();
  if (method === 'GET') return models.has(key) ? new Response(models.get(key)) : json(404, { message: 'No model uploaded' });
  if (method === 'DELETE') { models.delete(key); return json(200, { deleted: true }); }
  const file = init.body && init.body.get('file');
  if (!file) return json(400, { message: 'Missing file field' });
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  if (String.fromCharCode(...head.slice(0, 4)) !== 'glTF' || head[4] !== 2) return json(400, { message: 'Not a binary glTF 2.0 (.glb) file' });
  models.set(key, buf);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return json(200, { size: buf.byteLength, version: digest.slice(0, 12), name: file.name });
}

export function createMockHass({ onChange }) {
  let layoutStore = JSON.parse(JSON.stringify(DEMO_LAYOUT));
  let current;
  const make = (st) => ({
    states: st, entities, devices, areas, floors,
    user: { name: 'Demo', is_admin: true },
    config: { latitude: 52.0, longitude: 5.0, time_zone: 'UTC' }, // generic location (moon position)
    language: 'en',
    hassUrl: (p) => p,
    fetchWithAuth,
    callService: async (domain, service, data = {}, target) => {
      (window.__serviceCalls = window.__serviceCalls || []).push(target ? [domain, service, data, target] : [domain, service, data]); // headless checks
      (window.__serviceCallTimes = window.__serviceCallTimes || []).push(performance.now());
      const s = current.states[data.entity_id || (target && target.entity_id)];
      if (!s || !['toggle', 'turn_on', 'turn_off'].includes(service)) return;
      const on = service === 'toggle' ? s.state !== 'on' : service === 'turn_on';
      const attrs = { ...s.attributes };
      if (s.entity_id.startsWith('light.')) {
        if (on) attrs.brightness = data.brightness ?? attrs.brightness ?? 255;
        else delete attrs.brightness;
        if (on && data.rgb_color) attrs.rgb_color = data.rgb_color;
      }
      update({ [s.entity_id]: { ...s, state: on ? 'on' : 'off', attributes: attrs } });
    },
    callWS: async (msg) => {
      if (msg.type === 'floorplan3d/layout/get') return { layout: layoutStore };
      if (msg.type === 'floorplan3d/layout/set') { layoutStore = msg.layout; window.__savedLayout = msg.layout; return null; }
      throw { code: 'unknown_command', message: 'Unknown command.' };
    },
  });
  const update = (changes) => {
    current = make({ ...current.states, ...changes });
    onChange(current);
  };
  current = make({ ...states });

  // mower drives a circle in the garden (~4 m radius)
  let t = 0;
  setInterval(() => {
    if (window.__demoMowerPaused) return; // headless checks hold it still
    t += 0.06;
    const lat = 45.0 + (Math.sin(t) * 4) / 111320;
    const lon = 10.0 + (Math.cos(t) * 4) / (111320 * Math.cos((45.0 * Math.PI) / 180));
    const s = current.states['device_tracker.sunseeker_position'];
    const m = current.states['image.sunseeker_live_map'];
    update({
      'device_tracker.sunseeker_position': { ...s, attributes: { ...s.attributes, latitude: lat, longitude: lon } },
      'image.sunseeker_live_map': { ...m, state: new Date().toISOString(), last_updated: new Date().toISOString(), attributes: { ...m.attributes, entity_picture: liveMap(t) } },
    });
  }, 500);

  // headless checks: window.__setDemoSun(elevation, azimuth) adds / updates sun.sun
  window.__setDemoSun = (elevation, azimuth) => update({
    'sun.sun': { entity_id: 'sun.sun', state: elevation > 0 ? 'above_horizon' : 'below_horizon', attributes: { elevation, azimuth } },
  });

  return current;
}
