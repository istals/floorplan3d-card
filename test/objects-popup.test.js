import { describe, it, expect } from 'vitest';
import { popupRows, actionTarget } from '../src/objects/popup.js';
import { resolveActions } from '../src/actions.js';
import { typeOf } from '../src/objects/types.js';
import { chainState } from '../src/objects/logic.js';

const st = (state, attributes = {}) => ({ state, attributes });
const kinds = (rows) => rows.map((r) => r.kind);

describe('popupRows', () => {
  it('light defaults: toggle, brightness, colour on a colour light', () => {
    const states = { 'light.a': st('on', { brightness: 128, supported_color_modes: ['hs', 'color_temp'], friendly_name: 'Lamp A' }) };
    const obj = { id: 'l1', type: 'light' };
    const chain = chainState(obj, { entity: 'light.a' }, {}, states);
    const rows = popupRows(obj, chain, states);
    expect(kinds(rows)).toEqual(['toggle', 'brightness', 'color']);
    expect(rows[0]).toMatchObject({ entity: 'light.a', value: true });
    expect(rows[1]).toMatchObject({ entity: 'light.a', value: 128 });
    expect(rows[2].entity).toBe('light.a');
  });

  it('hides colour on a brightness-only light and brightness/colour on a relay', () => {
    const states = {
      'light.d': st('off', { supported_color_modes: ['brightness'] }),
      'switch.r': st('on'),
    };
    const obj = { id: 'l1', type: 'light' };
    expect(kinds(popupRows(obj, chainState(obj, { entity: 'light.d' }, {}, states), states))).toEqual(['toggle', 'brightness']);
    const rows = popupRows(obj, chainState(obj, { entity: 'switch.r' }, {}, states), states);
    expect(kinds(rows)).toEqual(['toggle']);
    expect(rows[0]).toMatchObject({ entity: 'switch.r', value: true });
  });

  it('off light: brightness value 0', () => {
    const states = { 'light.a': st('off', { supported_color_modes: ['brightness'] }) };
    const obj = { id: 'l1', type: 'light' };
    const rows = popupRows(obj, chainState(obj, { entity: 'light.a' }, {}, states), states);
    expect(rows[1].value).toBe(0);
  });

  it('generic default: state row with unit', () => {
    const states = { 'sensor.t': st('21.5', { unit_of_measurement: '°C' }) };
    const obj = { id: 'x', type: 'something' };
    const rows = popupRows(obj, chainState(obj, { entity: 'sensor.t' }, {}, states), states);
    expect(rows).toEqual([{ kind: 'state', entity: 'sensor.t', label: 'State', value: '21.5 °C' }]);
  });

  it('fp.ui.popup overrides the type default; unknown kinds dropped', () => {
    const states = { 'light.a': st('on', { brightness: 255, supported_color_modes: ['rgb'] }) };
    const obj = { id: 'l1', type: 'light', ui: { popup: ['brightness', 'bogus', 'state'] } };
    const rows = popupRows(obj, chainState(obj, { entity: 'light.a' }, {}, states), states);
    expect(kinds(rows)).toEqual(['brightness', 'state']);
  });

  it('link rows (history / logbook / statistics / custom) at the bottom; a resolved list wins over fp.ui', () => {
    const states = { 'sensor.t': st('21', {}) };
    const obj = { id: 'x', type: 'something', ui: { popup: ['state'] } };
    const chain = chainState(obj, { entity: 'sensor.t' }, {}, states);
    const rows = popupRows(obj, chain, states, {}, ['history', 'state', { label: 'Plan', navigate: '/lovelace/plan' }]);
    expect(kinds(rows)).toEqual(['state', 'link', 'link']);
    expect(rows[1]).toMatchObject({ label: 'History', action: { action: 'navigate', navigation_path: '/history?entity_id=sensor.t' } });
    expect(rows[2].label).toBe('Plan');
    // unavailable: the state row and the links
    const un = popupRows(obj, chain, { 'sensor.t': st('unavailable') }, {}, ['state', 'logbook']);
    expect(kinds(un)).toEqual(['state', 'link']);
  });

  it('grouped fixture: one chain row per controller and a reason row when dark', () => {
    const states = {
      'light.a': st('on', { brightness: 200, supported_color_modes: ['brightness'] }),
      'switch.g': st('off', { friendly_name: 'Group switch' }),
    };
    const groups = { hall: { entity: 'switch.g' } };
    const obj = { id: 'l1', type: 'light', group: 'hall' };
    const chain = chainState(obj, { entity: 'light.a' }, groups, states);
    const rows = popupRows(obj, chain, states, groups);
    expect(kinds(rows)).toEqual(['toggle', 'brightness', 'chain', 'reason']);
    expect(rows[0].entity).toBe('light.a');
    expect(rows[2]).toMatchObject({ entity: 'switch.g', label: 'Group switch', value: false });
    expect(rows[3].label).toBe('Group switch is off');
  });

  it('grouped fixture lit: chain row, no reason', () => {
    const states = { 'light.a': st('on', { supported_color_modes: ['onoff'] }), 'switch.g': st('on') };
    const groups = { hall: { entity: 'switch.g' } };
    const obj = { id: 'l1', type: 'light', group: 'hall' };
    const rows = popupRows(obj, chainState(obj, { entity: 'light.a' }, groups, states), states, groups);
    expect(kinds(rows)).toEqual(['toggle', 'chain']); // on/off-only light: no brightness
    expect(rows[1]).toMatchObject({ entity: 'switch.g', label: 'switch.g', value: true });
  });

  it('fixture without own entity: toggle targets the controller, no duplicate chain row', () => {
    const states = { 'switch.g': st('off') };
    const groups = { hall: { entity: 'switch.g' } };
    const obj = { id: 'l1', type: 'light', group: 'hall' };
    const rows = popupRows(obj, chainState(obj, { entity: null }, groups, states), states, groups);
    expect(kinds(rows)).toEqual(['toggle', 'reason']);
    expect(rows[0].entity).toBe('switch.g');
  });

  it('unavailable or missing entity: single state row "unavailable"', () => {
    const states = { 'light.a': st('unavailable') };
    const obj = { id: 'l1', type: 'light' };
    const one = [{ kind: 'state', label: 'State', value: 'unavailable' }];
    expect(popupRows(obj, chainState(obj, { entity: 'light.a' }, {}, states), states)).toEqual(one);
    expect(popupRows(obj, chainState(obj, { entity: null }, {}, {}), {})).toEqual(one);
    expect(popupRows(obj, null, {})).toEqual(one);
  });

  it('grouped fixture with an unavailable own entity: controller row and reason stay', () => {
    const groups = { hall: { entity: 'switch.g' } };
    const obj = { id: 'l1', type: 'light', group: 'hall' };
    let states = { 'light.a': st('unavailable', { friendly_name: 'Bulb' }), 'switch.g': st('off', { friendly_name: 'Relay' }) };
    let rows = popupRows(obj, chainState(obj, { entity: 'light.a' }, groups, states), states, groups);
    expect(rows).toEqual([
      { kind: 'chain', entity: 'switch.g', label: 'Relay', value: false },
      { kind: 'reason', label: 'Relay is off' },
    ]);
    states = { ...states, 'switch.g': st('on', { friendly_name: 'Relay' }) };
    rows = popupRows(obj, chainState(obj, { entity: 'light.a' }, groups, states), states, groups);
    expect(rows).toEqual([
      { kind: 'chain', entity: 'switch.g', label: 'Relay', value: true },
      { kind: 'reason', label: 'Bulb is unavailable' },
    ]);
  });

  it('nothing in the chain usable: single unavailable row', () => {
    const groups = { hall: { entity: 'switch.g' } };
    const obj = { id: 'l1', type: 'light', group: 'hall' };
    const states = { 'light.a': st('unavailable'), 'switch.g': st('unknown') };
    expect(popupRows(obj, chainState(obj, { entity: 'light.a' }, groups, states), states, groups))
      .toEqual([{ kind: 'state', label: 'State', value: 'unavailable' }]);
  });

  it('toggle row is labelled On / off', () => {
    const states = { 'switch.r': st('on') };
    const obj = { id: 'l1', type: 'light' };
    expect(popupRows(obj, chainState(obj, { entity: 'switch.r' }, {}, states), states)[0].label).toBe('On / off');
  });

  it('mower: state, battery and one start/dock row', () => {
    const states = { 'lawn_mower.m': st('docked', { battery_level: 87 }) };
    const obj = { id: 'm', type: 'mower' };
    const rows = popupRows(obj, chainState(obj, { entity: 'lawn_mower.m' }, {}, states), states);
    expect(kinds(rows)).toEqual(['state', 'battery', 'start_dock']);
    expect(rows[1].value).toBe('87 %');
  });

  it('climate: temperature and mode', () => {
    const states = { 'climate.c': st('heat', { current_temperature: 20.5, temperature_unit: '°C' }) };
    const obj = { id: 'c', type: 'climate' };
    const rows = popupRows(obj, chainState(obj, { entity: 'climate.c' }, {}, states), states);
    expect(rows).toEqual([
      { kind: 'temperature', entity: 'climate.c', label: 'Temperature', value: '20.5 °C' },
      { kind: 'mode', entity: 'climate.c', label: 'Mode', value: 'heat' },
    ]);
  });
});

describe('object actions / actionTarget', () => {
  const act = (obj, which) => resolveActions({ modelUi: obj.ui, kind: 'object', id: 'x', typeDefaults: typeOf(obj.type).defaults })[which].action;
  it('type defaults and fp.ui overrides (legacy keys), invalid falls back', () => {
    expect(act({ type: 'light' }, 'tap')).toBe('toggle');
    expect(act({ type: 'light' }, 'hold')).toBe('popup');
    expect(act({ type: 'zzz' }, 'tap')).toBe('more-info');
    expect(act({ type: 'light', ui: { tap: 'none' } }, 'tap')).toBe('none');
    expect(act({ type: 'light', ui: { hold: 'bogus' } }, 'hold')).toBe('popup');
    expect(act({ type: 'light', ui: { tap_action: { action: 'more-info' } } }, 'tap')).toBe('more-info');
  });

  it('own entity first, else the group controller', () => {
    const groups = { g: { entity: 'switch.g' } };
    expect(actionTarget({ group: 'g' }, { entity: 'light.a' }, groups)).toBe('light.a');
    expect(actionTarget({ group: 'g' }, { entity: null }, groups)).toBe('switch.g');
    expect(actionTarget({}, null, groups)).toBe(null);
    expect(actionTarget({ group: 'g' }, { entity: 'light.a', hidden: true }, groups)).toBe(null);
  });

  it('unavailable own entity falls back to a usable group controller', () => {
    const groups = { g: { entity: 'switch.g' } };
    const states = { 'light.a': st('unavailable'), 'switch.g': st('off') };
    expect(actionTarget({ group: 'g' }, { entity: 'light.a' }, groups, states)).toBe('switch.g');
    expect(actionTarget({ group: 'g' }, { entity: 'light.a' }, groups, { ...states, 'light.a': st('on') })).toBe('light.a');
    // controller not usable either: the own entity (the caller shows the popup)
    expect(actionTarget({ group: 'g' }, { entity: 'light.a' }, groups, { ...states, 'switch.g': st('unknown') })).toBe('light.a');
    expect(actionTarget({}, { entity: 'light.a' }, {}, states)).toBe('light.a');
  });
});
