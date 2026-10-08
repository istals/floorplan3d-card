import { describe, it, expect } from 'vitest';
import { badgeOptions, deviceIndex, platformOf, brandUrl, integrationName, entityOptionLabel, batteryLevel, problemOn, statusKind, badgeInfo } from '../src/badges.js';

const S = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes });

describe('badge options', () => {
  it('defaults, layout, YAML override per key', () => {
    expect(badgeOptions()).toEqual({ integration: false, status: true, battery: true });
    expect(badgeOptions({ integration: true, status: false })).toEqual({ integration: true, status: false, battery: true });
    expect(badgeOptions({ integration: true, status: false }, { status: true, battery: 'x' })).toEqual({ integration: true, status: true, battery: true });
  });
});

describe('platform lookup', () => {
  const ents = { 'light.a': { platform: 'hue', device_id: 'd1' }, 'sensor.b': { device_id: 'd1' }, 'sensor.c': { platform: '' } };
  it('reads platform from the entity registry', () => {
    expect(platformOf(ents, 'light.a')).toBe('hue');
    expect(platformOf(ents, 'sensor.b')).toBe(null);
    expect(platformOf(ents, 'sensor.c')).toBe(null);
    expect(platformOf(undefined, 'x.y')).toBe(null);
  });
  it('brand urls', () => {
    expect(brandUrl('hue')).toBe('https://brands.home-assistant.io/_/hue/icon.png');
    expect(brandUrl('hue', true)).toBe('https://brands.home-assistant.io/_/hue/dark_icon.png');
  });
  it('device index is cached per registry object', () => {
    const i = deviceIndex(ents);
    expect(i.get('d1')).toEqual(['light.a', 'sensor.b']);
    expect(deviceIndex(ents)).toBe(i);
  });
});

describe('battery pick', () => {
  const states = {
    'sensor.b1': S('sensor.b1', '55', { device_class: 'battery' }),
    'sensor.b2': S('sensor.b2', '12.4', { device_class: 'battery' }),
    'sensor.b3': S('sensor.b3', 'unavailable', { device_class: 'battery' }),
    'sensor.t': S('sensor.t', '3', { device_class: 'temperature' }),
    'binary_sensor.lowbat': S('binary_sensor.lowbat', 'on', { device_class: 'battery' }),
  };
  it('lowest numeric battery sensor', () => {
    expect(batteryLevel(Object.keys(states), states)).toBe(12.4);
    expect(batteryLevel(['sensor.b1', 'sensor.t'], states)).toBe(55);
    expect(batteryLevel(['sensor.t', 'sensor.b3', 'binary_sensor.lowbat'], states)).toBe(null);
  });
});

describe('status classification', () => {
  it('red for unavailable / unknown / missing', () => {
    expect(statusKind(undefined)).toBe('red');
    expect(statusKind(S('light.a', 'unavailable'))).toBe('red');
    expect(statusKind(S('sensor.a', 'unknown'), { lowBattery: true })).toBe('red');
  });
  it('yellow for low battery or a problem', () => {
    expect(statusKind(S('light.a', 'on'), { lowBattery: true })).toBe('yellow');
    expect(statusKind(S('light.a', 'off'), { problem: true })).toBe('yellow');
  });
  it('green when active or a sensor with a value, grey otherwise', () => {
    expect(statusKind(S('light.a', 'on'))).toBe('green');
    expect(statusKind(S('sensor.t', '21.5'))).toBe('green');
    expect(statusKind(S('sensor.t', ''))).toBe('grey');
    expect(statusKind(S('light.a', 'off'))).toBe('grey');
    expect(statusKind(S('media_player.m', 'idle'))).toBe('grey');
    expect(statusKind(S('lawn_mower.m', 'mowing'))).toBe('green');
  });
  it('problem binary sensor', () => {
    const st = { 'binary_sensor.p': S('binary_sensor.p', 'on', { device_class: 'problem' }), 'binary_sensor.m': S('binary_sensor.m', 'on', { device_class: 'motion' }) };
    expect(problemOn(['binary_sensor.p'], st)).toBe(true);
    expect(problemOn(['binary_sensor.m'], st)).toBe(false);
  });
});

describe('badgeInfo', () => {
  const hass = {
    entities: { 'lock.f': { device_id: 'd', platform: 'zwave_js' }, 'sensor.f_bat': { device_id: 'd', platform: 'zwave_js' } },
    states: { 'lock.f': S('lock.f', 'locked'), 'sensor.f_bat': S('sensor.f_bat', '9', { device_class: 'battery' }) },
  };
  it('combines the device entities', () => {
    const b = badgeInfo(hass, { entityId: 'lock.f', deviceId: 'd' }, { integration: true, status: true, battery: true });
    expect(b).toMatchObject({ platform: 'zwave_js', status: 'yellow', battery: 9 });
    expect(b.sig).toBe('zwave_js|yellow|9');
  });
  it('options off give nothing', () => {
    const b = badgeInfo(hass, { entityId: 'lock.f', deviceId: 'd' }, { integration: false, status: false, battery: false });
    expect(b).toMatchObject({ platform: null, status: null, battery: null });
  });
  it('entity without a device', () => {
    expect(badgeInfo(hass, { entityId: 'sensor.f_bat' }).battery).toBe(9);
  });
});

describe('integration names and option labels', () => {
  it('maps common platforms, title-cases the rest', () => {
    expect(integrationName('sonoff')).toBe('Sonoff');
    expect(integrationName('smartthings')).toBe('SmartThings');
    expect(integrationName('hue')).toBe('Philips Hue');
    expect(integrationName('zha')).toBe('Zigbee (ZHA)');
    expect(integrationName('zwave_js')).toBe('Zwave Js');
    expect(integrationName('my_custom_thing')).toBe('My Custom Thing');
    expect(integrationName('')).toBe('');
    expect(integrationName(null)).toBe('');
  });
  it('option label: friendly name plus integration, name only without a platform', () => {
    const hass = {
      states: { 'light.a': S('light.a', 'on', { friendly_name: 'Lamp' }), 'sensor.b': S('sensor.b', '1') },
      entities: { 'light.a': { platform: 'sonoff' }, 'sensor.b': {} },
    };
    expect(entityOptionLabel(hass, 'light.a')).toBe('Lamp \u00b7 Sonoff');
    expect(entityOptionLabel(hass, 'sensor.b')).toBe('sensor.b');
    expect(entityOptionLabel(hass, 'nope.x')).toBe('nope.x');
    expect(entityOptionLabel({}, 'a.b')).toBe('a.b');
  });
});
