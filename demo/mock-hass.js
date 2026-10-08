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
// Live map image like a robot mower integration renders it (Sunseeker live map): the 9 x 17 m lawn of
// mower-map.svg (50 px/m, centred on the garden) on a dark green background (unmowed), light mowed
// stripes at 30° (counter-clockwise from east), grey no-mow areas, a blue boundary and the mower as a
// red dot with a white ring. Aligned as the overlay at (16.5, 1.5), width 9, the dot sits where the
// fake mower is. window.__demoMapScale (headless checks) renders it larger: the size changes.
let liveCanvas = null;
function liveMap(t) {
  if (typeof document === 'undefined') return '';
  const s = (typeof window !== 'undefined' && window.__demoMapScale) || 1;
  const c = (liveCanvas = liveCanvas || document.createElement('canvas'));
  if (c.width !== 450 * s) c.width = 450 * s;
  if (c.height !== 850 * s) c.height = 850 * s;
  const g = c.getContext('2d');
  g.setTransform(s, 0, 0, s, 0, 0);
  g.fillStyle = '#284f26'; // unmowed has two shades: the margin darker
  g.fillRect(0, 0, 450, 850);
  g.fillStyle = '#2f5d2c';
  g.fillRect(25, 25, 400, 800);
  g.save();
  g.beginPath();
  g.rect(25, 25, 400, 800);
  g.clip();
  g.translate(225, 425);
  g.rotate((-30 * Math.PI) / 180); // canvas y points down: -30° turns the bands counter-clockwise
  g.fillStyle = '#7fc26f';
  for (let y = -700; y < 700; y += 60) g.fillRect(-700, y, 1400, 30);
  g.restore();
  g.fillStyle = '#8c8c8c'; // no-mow: a flower bed and a shed
  g.beginPath();
  g.arc(225, 395, 34, 0, Math.PI * 2);
  g.fill();
  g.fillRect(60, 700, 70, 50);
  g.strokeStyle = '#4a8fd6'; // boundary
  g.lineWidth = 4;
  g.strokeRect(25, 25, 400, 800);
  g.fillStyle = '#f0f0f0';
  g.fillRect(360, 770, 50, 40); // dock
  const mx = 225 + 200 * Math.cos(t), my = 425 - 200 * Math.sin(t);
  g.fillStyle = '#ffffff'; // the mower: red dot, white ring
  g.beginPath();
  g.arc(mx, my, 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ff3b30';
  g.beginPath();
  g.arc(mx, my, 9, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL('image/png');
}
// A second robot (no area, so no marker) as the Sunseeker integration exposes it: a static lawn map
// (image), a live map (camera) = the static map + light mowed stripes + the mower picture turned to
// its heading + a big grey dock icon, the mower's top-down picture (front = top), and its sensors.
// window.__robotT (headless checks) holds its position on a 150 px circle; heading = t + 90°.
const ROBOT = { canvas: null, pic: null };
function robotPicture() {
  if (typeof document === 'undefined') return null;
  if (ROBOT.pic) return ROBOT.pic;
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#5a5d63';
  g.beginPath();
  g.roundRect(4, 4, 40, 56, 10);
  g.fill();
  g.fillStyle = '#202224'; // front bumper (top)
  g.fillRect(6, 4, 36, 10);
  g.fillStyle = '#eeeeee'; // the lid's disc, at the back
  g.beginPath();
  g.arc(24, 44, 9, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#e67e22';
  g.fillRect(8, 18, 4, 18);
  return (ROBOT.pic = c);
}
// ?robotmap=1600 (benchmark): both robot maps drawn S x S pixels (the 450 x 850 lawn scaled and centred).
const ROBOT_SIZE = (() => { try { return Number(new URLSearchParams(location.search).get('robotmap')) || 0; } catch (e) { return 0; } })();
function robotCanvas() {
  const c = document.createElement('canvas');
  c.width = ROBOT_SIZE || 450;
  c.height = ROBOT_SIZE || 850;
  const g = c.getContext('2d');
  if (ROBOT_SIZE) {
    const s = ROBOT_SIZE / 850;
    g.fillStyle = '#1d1f21';
    g.fillRect(0, 0, ROBOT_SIZE, ROBOT_SIZE);
    g.setTransform(s, 0, 0, s, (ROBOT_SIZE - 450 * s) / 2, 0);
  }
  return { c, g };
}
function robotStatic(g) {
  g.fillStyle = '#1d1f21';
  g.fillRect(0, 0, 450, 850);
  g.fillStyle = '#3d7d3a';
  g.fillRect(25, 25, 400, 800);
}
function robotOverlay(g) {
  g.fillStyle = '#8c8c8c'; // no-mow
  g.beginPath();
  g.arc(225, 395, 34, 0, Math.PI * 2);
  g.fill();
  g.fillRect(60, 700, 70, 50);
  g.strokeStyle = '#d23c3c'; // boundary
  g.lineWidth = 3;
  g.strokeRect(25, 25, 400, 800);
}
// at: { x, y, t } draws the mower at that map pixel instead of on its circle (e.g. on the dock);
// mowed: how many stripes are mowed (more over time in the benchmark).
function robotDraw(live, t, at = null, mowed = 12) {
  const { c, g } = robotCanvas();
  robotStatic(g);
  if (live) {
    g.save();
    g.beginPath();
    g.rect(25, 25, 400, 800);
    g.clip();
    g.translate(225, 425);
    g.rotate((-30 * Math.PI) / 180);
    g.fillStyle = '#79c46a';
    for (let y = -700, i = 0; y < 0 && i < mowed; y += 60, i++) g.fillRect(-700, y, 1400, 30); // the north half mowed
    g.restore();
  }
  robotOverlay(g);
  if (live) {
    g.fillStyle = '#b4b4b4'; // dock
    g.fillRect(370, 765, 42, 42);
    const x = at ? at.x : 225 + 150 * Math.cos(t), y = at ? at.y : 425 - 150 * Math.sin(t);
    g.save();
    g.translate(x, y);
    g.rotate(-(at ? at.t : t)); // top of the picture along the heading t + 90° (counter-clockwise, image up)
    g.drawImage(robotPicture(), -14.4, -19.2, 28.8, 38.4);
    g.restore();
  }
  return c;
}
function robotMap(live, t, at = null) {
  if (typeof document === 'undefined') return '';
  return robotDraw(live, t, at).toDataURL('image/png');
}
const pretty = (id) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const areas = Object.fromEntries(Object.entries(areaFloor).map(([id, f]) => [id, { area_id: id, name: pretty(id), floor_id: f }]));

const devices = {};
const entities = {};
// HA labels (label registry): entities carry label ids, names come from here (default object tags)
const labels = { outdoor: { label_id: 'outdoor', name: 'Outdoor', icon: 'mdi:tree' } };
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
// album art as the TV's entity_picture (a marker with a picture)
const ART = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#6a3cff"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/><circle cx="20" cy="20" r="9" fill="#fff" opacity=".85"/><circle cx="20" cy="20" r="3" fill="#6a3cff"/></svg>');
device('tv', 'TV', 'living_room', [['media_player.tv', 'playing', { entity_picture: ART }]]);
device('living_motion', 'Living motion', 'living_room', [['binary_sensor.living_motion', 'off', { device_class: 'motion' }]]);
device('living_blinds', 'Blinds', 'living_room', [['cover.living_blinds', 'open']]);
device('living_window', 'Terrace door', 'living_room', [['binary_sensor.terrace_door', 'off', { device_class: 'door' }]]);

device('hall_light', 'Hall light', 'hall', [light('light.hall', false)]);
device('front_door', 'Front door', 'hall', [['binary_sensor.front_door', 'off', { device_class: 'door' }]]);
device('front_lock', 'Front lock', 'hall', [['lock.front_door', 'locked'],
  sensor('sensor.front_lock_battery', 12, 'battery', '%').concat([{ entity_category: 'diagnostic' }])]); // low battery badge
device('smoke_hall', 'Smoke detector', 'hall', [['binary_sensor.smoke_hall', 'unavailable', { device_class: 'smoke' }]]); // red status dot

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
  ['binary_sensor.demo_mower_error', 'off', { device_class: 'problem' }],
]);
device('garden_cam', 'Garden camera', 'garden', [['camera.garden', 'idle']]);
device('mower_map', 'Sunseeker map', 'garden', [['image.sunseeker_map', '2026-01-01T00:00:00+00:00', { entity_picture: '/demo/mower-map.svg' }]]);
device('mower_live_map', 'Sunseeker live map', 'garden', [['image.sunseeker_live_map', '2026-01-01T00:00:00+00:00', { entity_picture: liveMap(0) }]]);
device('robot', 'Robo', null, [
  ['lawn_mower.robo', 'mowing'],
  ['camera.robo_live_map', 'idle', { entity_picture: robotMap(true, 0) }],
  ['image.robo_map', '2026-01-01T00:00:00+00:00', { entity_picture: robotMap(false, 0) }],
  ['image.robo_mower_image', '2026-01-01T00:00:00+00:00', { entity_picture: typeof document === 'undefined' ? '' : robotPicture().toDataURL('image/png'), friendly_name: 'Robo Mower image' }],
  ['image.robo_wifi_map', '2026-01-01T00:00:00+00:00', {}],
  ['sensor.robo_progress', 39, { unit_of_measurement: '%' }],
  ['sensor.robo_battery', 82, { device_class: 'battery', unit_of_measurement: '%' }],
  ['sensor.robo_errorcode', 0, { friendly_name: 'Robo ErrorCode' }],
  ['binary_sensor.robo_online', 'on', { device_class: 'connectivity' }],
  ['sensor.robo_rain_sensor', 'Dry', { friendly_name: 'Robo Rain sensor' }],
  ['sensor.robo_rain_sensor_countdown', 0, { unit_of_measurement: 'min' }],
  ['sensor.robo_wifi_strength', -61, { unit_of_measurement: 'dBm' }],
  ['sensor.robo_robot_signal', 4],
  ['sensor.robo_cutterplate_time_left', 120, { unit_of_measurement: 'h' }],
  ['sensor.robo_total_area', 512, { unit_of_measurement: 'm²' }],
  ['sensor.robo_work_region', 'Zone A'],
  ['sensor.robo_zone_a_area', 210, { unit_of_measurement: 'm²' }],
  ['sensor.robo_zone_a_estimated_time', 100, { unit_of_measurement: 'min' }],
  ['binary_sensor.robo_zone_a_started', 'on'],
  ['binary_sensor.robo_zone_a_finished', 'off'],
  ['sensor.robo_mower_status', 'Working'],
  ['sensor.robo_work_records', 57],
]);
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
// a smart bulb: colour, colour temperature and effects (the popup adds those rows from the capabilities)
device('demo_kitchen_lamp', 'Kitchen ceiling lamp', 'kitchen', [['light.demo_kitchen', 'on', {
  brightness: 255, supported_color_modes: ['hs', 'color_temp'], color_mode: 'color_temp', color_temp_kelvin: 3000,
  min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6000, effect_list: ['Rainbow', 'Music pulse', 'Candle', 'Sound reactive'], effect: null,
}]]);
device('demo_strip', 'Kitchen strip', 'kitchen', [light('light.demo_strip', true, 150, [120, 200, 255])]);
device('demo_facade', 'Facade lamps', 'terrace', [[...light('light.demo_facade', true, 230), { labels: ['outdoor'] }]]);
device('demo_facade_switch', 'Facade switch', 'hall', [['switch.demo_facade', 'on']]); // tag controller (layout.tags.facade)
device('demo_terrace_spot', 'Terrace spot', 'terrace', [[...light('light.demo_terrace', true, 220, [255, 170, 90]), { labels: ['outdoor'] }]]);
device('demo_climate', 'Living climate unit', 'living_room', [['climate.demo_living', 'heat',
  { current_temperature: 21.5, temperature: 22, hvac_action: 'heating', hvac_modes: ['off', 'heat', 'cool', 'auto'] }]]);
device('demo_charger', 'EV charger', 'garden', [['sensor.demo_charger', 'charging', { power: 7.4, energy: 12.6 }]]);
void temp;
// integration (platform) per entity for the logo badges; 'nobrand' has no logo (the badge stays hidden)
const PLATFORMS = { light: 'hue', switch: 'shelly', lock: 'zwave_js', binary_sensor: 'zha', fan: 'shelly', media_player: 'cast',
  climate: 'tado', lawn_mower: 'sunseeker', cover: 'nobrand' };
for (const [eid, e] of Object.entries(entities)) {
  const p = PLATFORMS[eid.split('.')[0]];
  if (p && !e.platform) e.platform = p;
  if (e.device_id === 'front_lock') e.platform = 'zwave_js';
}
// sensors from other integrations (edit-mode entity pickers show the integration)
entities['sensor.kettle_power'].platform = 'sonoff';
entities['sensor.kitchen_temperature'].platform = 'tuya';
// weather (no device, no marker): clouds and light follow cloud_coverage; ?clouds=60 starts cloudy
const demoClouds = Number(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('clouds')) || 0;
states['weather.demo'] = { entity_id: 'weather.demo', state: demoClouds ? 'partlycloudy' : 'sunny', attributes: { friendly_name: 'Demo weather', cloud_coverage: demoClouds } };

// In-memory stand-in for the integration's /api/floorplan3d/model/<key> endpoint.
const models = new Map();
async function fetchWithAuth(url, init = {}) {
  const key = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop());
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const method = (init.method || 'GET').toUpperCase();
  if (method === 'GET') return models.has(key) ? new Response(models.get(key), { headers: { 'content-length': String(models.get(key).byteLength) } }) : json(404, { message: 'No model uploaded' });
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

// Headless checks reuse one page: stop the previous mock (its timer, uploaded models) before a new one.
let mockTimer = null;
export function resetMockHass() {
  clearInterval(mockTimer);
  mockTimer = null;
  models.clear();
}

export function createMockHass({ onChange }) {
  let layoutStore = JSON.parse(JSON.stringify(DEMO_LAYOUT));
  let current;
  const make = (st) => ({
    states: st, entities, devices, areas, floors, labels,
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
        if (on && data.hs_color) { attrs.hs_color = data.hs_color; attrs.color_mode = 'hs'; }
        if (on && data.color_temp_kelvin) { attrs.color_temp_kelvin = data.color_temp_kelvin; attrs.color_mode = 'color_temp'; }
        if (on && data.effect) attrs.effect = data.effect;
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
  clearInterval(mockTimer);
  mockTimer = setInterval(() => {
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

  // the second robot: window.__setRobot(t) puts it at angle t (radians) on its circle (heading t + 90°)
  let rt = 0;
  const setRobotPicture = (url) => {
    const c = current.states['camera.robo_live_map'];
    update({ 'camera.robo_live_map': { ...c, state: 'idle', last_updated: new Date().toISOString(), attributes: { ...c.attributes, entity_picture: url } } });
  };
  window.__setRobot = (t) => {
    rt = t;
    setRobotPicture(robotMap(true, rt));
  };
  // headless checks: the mower drawn at a map pixel (x, y of the 450 x 850 map), turned by t
  window.__setRobotAt = (x, y, t = 0) => setRobotPicture(robotMap(true, 0, { x, y, t }));
  // benchmark: frames rendered ahead as blob URLs (encoding a big PNG is not the card's time), then
  // shown one by one. -> Promise of the frame count
  const frames = [], blobs = [];
  window.__robotFrames = async (n, t0 = 0, dt = 0.02) => {
    for (let i = 0; i < n; i++) {
      const c = robotDraw(true, t0 + i * dt, null, 6 + Math.floor((i * 6) / n));
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      blobs.push(b);
      frames.push(URL.createObjectURL(b));
    }
    return frames.length;
  };
  window.__setRobotFrame = (i) => setRobotPicture(frames[i % frames.length]);
  // the same picture under a new URL (a camera refresh where nothing changed)
  window.__setRobotSame = (i) => setRobotPicture(URL.createObjectURL(blobs[i % blobs.length]));
  // headless checks: window.__setDemoStates({ entity_id: state | { state, attributes } })
  window.__setDemoStates = (changes) => update(Object.fromEntries(Object.entries(changes).map(([eid, v]) => {
    const s = current.states[eid] || { entity_id: eid, attributes: {} };
    const nv = typeof v === 'object' ? v : { state: v };
    return [eid, { ...s, state: String(nv.state ?? s.state), attributes: { ...s.attributes, ...(nv.attributes || {}) }, last_changed: nv.last_changed || new Date().toISOString() }];
  })));

  // headless checks: window.__setDemoSun(elevation, azimuth) adds / updates sun.sun
  window.__setDemoSun = (elevation, azimuth) => update({
    'sun.sun': { entity_id: 'sun.sun', state: elevation > 0 ? 'above_horizon' : 'below_horizon', attributes: { elevation, azimuth } },
  });

  // headless checks: window.__setDemoWeather(coverage, condition) sets weather.demo (coverage null: condition only)
  window.__setDemoWeather = (coverage, condition = 'partlycloudy') => update({
    'weather.demo': { entity_id: 'weather.demo', state: condition, attributes: { friendly_name: 'Demo weather', ...(coverage === null || coverage === undefined ? {} : { cloud_coverage: coverage }) } },
  });

  return current;
}
