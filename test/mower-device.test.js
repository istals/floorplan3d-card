import { describe, it, expect } from 'vitest';
import { findStaticMap, findMowerPicture, findErrorEntity, findProgress, progressValue, connectivity, rain, zoneEntities, deviceRows, words, mowerDevice } from '../src/mower-device.js';

function hassOf(list) {
  const entities = {}, states = {};
  for (const [eid, state, attrs = {}, dev = 'm1', reg = {}] of list) {
    entities[eid] = { entity_id: eid, device_id: dev, ...reg };
    states[eid] = { entity_id: eid, state: String(state), attributes: attrs, last_changed: '2026-10-06T10:00:00Z' };
  }
  return { entities, states };
}
const h = hassOf([
  ['lawn_mower.robo', 'mowing'],
  ['camera.robo_live_map', 'idle'],
  ['image.robo_map', 'x'],
  ['image.robo_mower_image', 'x', { friendly_name: 'Robo Mower image' }],
  ['image.robo_wifi_map', 'x'],
  ['sensor.robo_progress', '39', { unit_of_measurement: '%' }],
  ['sensor.robo_battery', '76', { device_class: 'battery', unit_of_measurement: '%' }],
  ['sensor.robo_errorcode', '0', { friendly_name: 'Robo ErrorCode' }],
  ['sensor.robo_state_change_error', 'none'],
  ['binary_sensor.robo_online', 'off', { device_class: 'connectivity' }],
  ['sensor.robo_rain_sensor', 'Dry countdown', { friendly_name: 'Robo Rain sensor' }],
  ['sensor.robo_rain_sensor_countdown', '12', { unit_of_measurement: 'min' }],
  ['sensor.robo_wifi_strength', '-61', { unit_of_measurement: 'dBm' }],
  ['sensor.robo_robot_signal', '4'],
  ['sensor.robo_cutterplate_time_left', '120', { unit_of_measurement: 'h' }],
  ['sensor.robo_total_area', '512', { unit_of_measurement: 'm²' }],
  ['sensor.robo_work_region', 'Zone A'],
  ['sensor.robo_zone_a_area', '210', { unit_of_measurement: 'm²' }],
  ['sensor.robo_zone_a_estimated_time', '100', { unit_of_measurement: 'min' }],
  ['binary_sensor.robo_zone_a_started', 'on'],
  ['binary_sensor.robo_zone_a_finished', 'off'],
  ['sensor.robo_zone_b_area', '300', { unit_of_measurement: 'm²' }],
  ['sensor.robo_mower_status', 'Working'],
  ['sensor.robo_work_records', '57'],
  ['light.other', 'on', {}, 'x2'],
]);

describe('mower device auto-detection', () => {
  it('static map, mower picture, error code, progress', () => {
    expect(findStaticMap(h, 'camera.robo_live_map', 'lawn_mower.robo')).toBe('image.robo_map');
    expect(findStaticMap(h, 'image.robo_map', 'lawn_mower.robo')).toBe(null); // the live map itself is excluded
    expect(findMowerPicture(h, 'camera.robo_live_map', 'lawn_mower.robo')).toBe('image.robo_mower_image');
    expect(findErrorEntity(h, 'lawn_mower.robo')).toBe('sensor.robo_errorcode');
    expect(findProgress(h, 'lawn_mower.robo')).toBe('sensor.robo_progress');
    expect(progressValue(h, 'sensor.robo_progress')).toBeCloseTo(0.39, 9);
    expect(findStaticMap(h, 'camera.nope', 'lawn_mower.nope')).toBe(null);
    expect(mowerDevice(h, 'x.y').entities).toEqual([]);
  });
  it('connectivity and rain', () => {
    expect(connectivity(h, 'lawn_mower.robo')).toEqual({ entity: 'binary_sensor.robo_online', online: false, since: '2026-10-06T10:00:00Z' });
    expect(rain(h, 'lawn_mower.robo')).toMatchObject({ wet: false, drying: 12 });
    const wet = hassOf([['lawn_mower.r', 'docked'], ['sensor.r_rain_sensor', 'Wet']]);
    expect(rain(wet, 'lawn_mower.r')).toMatchObject({ wet: true, drying: null });
    const dry = hassOf([['lawn_mower.r', 'docked'], ['sensor.r_rain_sensor', 'Dry']]);
    expect(rain(dry, 'lawn_mower.r')).toMatchObject({ wet: false, drying: null });
  });
  it('zone entities by region name (spaces / underscores, case)', () => {
    const list = Object.keys(h.entities);
    expect(words('Zone_A  area')).toBe('zone a area');
    expect(zoneEntities(h, list, 'Zone A')).toEqual({ area: 'sensor.robo_zone_a_area', estimated: 'sensor.robo_zone_a_estimated_time', started: 'binary_sensor.robo_zone_a_started', finished: 'binary_sensor.robo_zone_a_finished' });
    expect(zoneEntities(h, list, 'zone b').area).toBe('sensor.robo_zone_b_area');
    expect(zoneEntities(h, list, '')).toEqual({});
  });
  it('popup rows', () => {
    const rows = deviceRows(h, 'lawn_mower.robo', Date.parse('2026-10-06T10:42:00Z'));
    const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(rows[0]).toMatchObject({ key: 'offline', value: 'since 42 min' });
    expect(by).toMatchObject({
      status: 'Working', progress: '39 %', battery: '76 %', region: 'Zone A', wifi: '-61 dBm', signal: '4', cutter: '120 h',
      area: '512 m²', records: '57', error: '0 (OK)', rain: 'Drying, 12 min left',
      zone_area: '210 m²', zone_est: '100 min', zone_left: '≈ 61 min', zone_started: 'Started',
    });
    expect(rows.findIndex((r) => r.key === 'zone_area')).toBe(rows.findIndex((r) => r.key === 'region') + 1);
    expect(deviceRows(h, 'lawn_mower.none')).toEqual([]);
  });
});
