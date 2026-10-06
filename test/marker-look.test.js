import { describe, it, expect } from 'vitest';
import { markerLook, iconFor } from '../src/registry.js';

const hass = (states) => ({ states, entities: {}, hassUrl: (p) => 'http://ha' + p });
const m = (eid, extra = {}) => ({ id: 'entity:' + eid, entityId: eid, domain: eid.split('.')[0], ...extra });
const st = (state, attributes = {}) => ({ state, attributes });

describe('markerLook', () => {
  it('controllable domains: circle', () => {
    const h = hass({ 'light.a': st('on'), 'cover.c': st('open'), 'switch.s': st('off') });
    for (const e of ['light.a', 'cover.c', 'switch.s']) expect(markerLook(h, m(e))).toMatchObject({ shape: 'circle', kind: 'control', alert: null });
  });
  it('sensor with a value: rounded square showing the value', () => {
    const h = hass({ 'sensor.t': st('21.46', { unit_of_measurement: '°C', device_class: 'temperature' }), 'sensor.x': st('unknown') });
    expect(markerLook(h, m('sensor.t'))).toMatchObject({ shape: 'square', kind: 'value', value: '21.5°C' });
    expect(markerLook(h, m('sensor.x'))).toMatchObject({ shape: 'square', kind: 'info' });
  });
  it('binary_sensor: rounded square, icon by state', () => {
    const h = hass({ 'binary_sensor.d': st('on', { device_class: 'door' }) });
    expect(markerLook(h, m('binary_sensor.d'))).toMatchObject({ shape: 'square', kind: 'binary' });
    expect(iconFor(h, 'binary_sensor.d')).toBe('mdi:door-open');
    expect(iconFor(hass({ 'binary_sensor.d': st('off', { device_class: 'door' }) }), 'binary_sensor.d')).toBe('mdi:door-closed');
    expect(iconFor(hass({ 'binary_sensor.d': st('off', { device_class: 'door', icon: 'mdi:x' }) }), 'binary_sensor.d')).toBe('mdi:x');
  });
  it('alert classes: diamond, red / yellow only while active', () => {
    const h = hass({ 'binary_sensor.smoke': st('on', { device_class: 'smoke' }), 'binary_sensor.p': st('on', { device_class: 'problem' }),
      'binary_sensor.leak': st('off', { device_class: 'moisture' }) });
    expect(markerLook(h, m('binary_sensor.smoke'))).toMatchObject({ shape: 'diamond', kind: 'alert', alert: 'red' });
    expect(markerLook(h, m('binary_sensor.p'))).toMatchObject({ shape: 'diamond', alert: 'yellow' });
    expect(markerLook(h, m('binary_sensor.leak'))).toMatchObject({ shape: 'diamond', alert: null });
  });
  it('info only (no tap toggle, no value): rounded square with the info corner', () => {
    const h = hass({ 'camera.c': st('idle'), 'weather.w': st('sunny') });
    expect(markerLook(h, m('camera.c'))).toMatchObject({ shape: 'square', kind: 'info', info: true });
  });
  it('entity_picture (person, media_player, image, lawn_mower): circle with the picture', () => {
    const h = hass({ 'person.a': st('home', { entity_picture: '/api/image/a.png' }), 'lawn_mower.m': st('docked', { entity_picture: 'data:image/png;base64,x' }),
      'person.b': st('home'), 'light.p': st('on', { entity_picture: '/x.png' }) });
    expect(markerLook(h, m('person.a'))).toMatchObject({ shape: 'circle', kind: 'picture', picture: 'http://ha/api/image/a.png' });
    expect(markerLook(h, m('lawn_mower.m')).picture).toBe('data:image/png;base64,x');
    expect(markerLook(h, m('person.b'))).toMatchObject({ kind: 'info', picture: null });
    expect(markerLook(h, m('light.p'))).toMatchObject({ kind: 'control', picture: null });
  });
  it('missing state: info square', () => {
    expect(markerLook(hass({}), m('sensor.gone'))).toMatchObject({ shape: 'square', kind: 'info' });
  });
});
