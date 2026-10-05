import { describe, it, expect, vi, afterEach } from 'vitest';
import { normAction, resolveActions, actionCall, validateAction, popupLinks, TapSequencer, DOUBLE_TAP_MS } from '../src/actions.js';

const light = { tap_action: { action: 'toggle' }, hold_action: { action: 'popup' }, popup: ['toggle'] };

describe('normAction', () => {
  it('accepts objects, strings and the legacy call-service', () => {
    expect(normAction({ action: 'toggle' })).toEqual({ action: 'toggle' });
    expect(normAction('more-info')).toEqual({ action: 'more-info' });
    expect(normAction({ action: 'call-service', service: 'light.turn_on', service_data: { brightness: 3 } }))
      .toEqual({ action: 'perform-action', perform_action: 'light.turn_on', data: { brightness: 3 } });
    expect(normAction({ action: 'bogus' })).toBe(null);
    expect(normAction(null)).toBe(null);
    expect(normAction(42)).toBe(null);
  });
});

describe('resolveActions', () => {
  it('type defaults when nothing is set; no double tap', () => {
    const r = resolveActions({ kind: 'object', id: 'lamp', typeDefaults: light });
    expect(r.tap).toEqual({ action: 'toggle' });
    expect(r.hold).toEqual({ action: 'popup' });
    expect(r.double_tap).toBe(null);
    expect(r.popup).toEqual(['toggle']);
  });

  it('merge order: model < layout < YAML', () => {
    const modelUi = { tap_action: { action: 'none' }, hold_action: { action: 'more-info' }, double_tap_action: { action: 'popup' } };
    const layoutUi = { tap_action: { action: 'navigate', navigation_path: '/a' }, hold_action: { action: 'toggle' } };
    const yaml = { 'object:lamp': { tap_action: { action: 'url', url_path: 'https://x' } } };
    const r = resolveActions({ modelUi, layoutUi, yaml, kind: 'object', id: 'lamp', typeDefaults: light });
    expect(r.tap).toEqual({ action: 'url', url_path: 'https://x' });
    expect(r.hold).toEqual({ action: 'toggle' });
    expect(r.double_tap).toEqual({ action: 'popup' });
  });

  it('legacy fp.ui tap / hold keys (string and object)', () => {
    const r = resolveActions({ modelUi: { tap: 'none', hold: { action: 'more-info' } }, kind: 'object', id: 'x', typeDefaults: light });
    expect(r.tap).toEqual({ action: 'none' });
    expect(r.hold).toEqual({ action: 'more-info' });
    // invalid legacy value: the default stays
    expect(resolveActions({ modelUi: { hold: 'bogus' }, kind: 'object', id: 'x', typeDefaults: light }).hold).toEqual({ action: 'popup' });
  });

  it('legacy type defaults ({ tap, hold } strings) still read', () => {
    const r = resolveActions({ kind: 'object', id: 'x', typeDefaults: { tap: 'more-info', hold: 'popup' } });
    expect(r.tap).toEqual({ action: 'more-info' });
    expect(r.hold).toEqual({ action: 'popup' });
  });

  it('YAML keys: device < entity < object for objects; device / entity for markers', () => {
    const yaml = {
      'device:d1': { tap_action: { action: 'none' }, hold_action: { action: 'none' } },
      'light.a': { tap_action: { action: 'more-info' } },
      'object:lamp': { tap_action: { action: 'popup' } },
    };
    const o = resolveActions({ yaml, kind: 'object', id: 'lamp', entityId: 'light.a', deviceId: 'd1', typeDefaults: light });
    expect(o.tap).toEqual({ action: 'popup' });
    expect(o.hold).toEqual({ action: 'none' });
    const m = resolveActions({ yaml, kind: 'marker', id: 'device:d1', entityId: 'light.a', deviceId: 'd1', typeDefaults: light });
    expect(m.tap).toEqual({ action: 'more-info' });
    expect(m.hold).toEqual({ action: 'none' });
    // object:<id> keys never apply to markers
    const m2 = resolveActions({ yaml: { 'object:lamp': { tap_action: { action: 'none' } } }, kind: 'marker', id: 'lamp', entityId: 'light.b', typeDefaults: light });
    expect(m2.tap).toEqual({ action: 'toggle' });
  });

  it('popup list: later source replaces', () => {
    const r = resolveActions({ modelUi: { popup: ['state'] }, yaml: { 'object:x': { popup: ['history'] } }, kind: 'object', id: 'x', typeDefaults: light });
    expect(r.popup).toEqual(['history']);
  });

  it('a double_tap_action none means no double tap', () => {
    const r = resolveActions({ layoutUi: { double_tap_action: { action: 'none' } }, kind: 'object', id: 'x', typeDefaults: light });
    expect(r.double_tap).toBe(null);
  });
});

describe('validateAction / actionCall', () => {
  const ctx = { entity: 'light.a' };

  it('toggle', () => {
    expect(actionCall({ action: 'toggle' }, ctx)).toEqual({ kind: 'service', domain: 'light', service: 'toggle', data: { entity_id: 'light.a' }, confirm: null });
    expect(actionCall({ action: 'toggle' }, { entity: 'cover.c' }).domain).toBe('homeassistant');
    expect(actionCall({ action: 'toggle', entity: 'switch.b' }, ctx).data).toEqual({ entity_id: 'switch.b' });
    expect(actionCall({ action: 'toggle' }, {})).toMatchObject({ kind: 'error' });
  });

  it('more-info', () => {
    expect(actionCall({ action: 'more-info' }, ctx)).toMatchObject({ kind: 'more-info', entityId: 'light.a' });
    expect(actionCall({ action: 'more-info', entity: 'sensor.t' }, ctx)).toMatchObject({ kind: 'more-info', entityId: 'sensor.t' });
    expect(actionCall({ action: 'more-info' }, {})).toMatchObject({ kind: 'error' });
  });

  it('navigate', () => {
    expect(actionCall({ action: 'navigate', navigation_path: '/lovelace/2' }, ctx)).toMatchObject({ kind: 'navigate', path: '/lovelace/2', replace: false });
    expect(actionCall({ action: 'navigate', navigation_path: '/x', navigation_replace: true }, ctx).replace).toBe(true);
    expect(actionCall({ action: 'navigate' }, ctx)).toMatchObject({ kind: 'error', message: expect.stringContaining('navigation_path') });
  });

  it('url: new tab unless a local path', () => {
    expect(actionCall({ action: 'url', url_path: 'https://example.com' }, ctx)).toMatchObject({ kind: 'url', url: 'https://example.com', newTab: true });
    expect(actionCall({ action: 'url', url_path: '/local/x.html' }, ctx)).toMatchObject({ kind: 'url', newTab: false });
    expect(actionCall({ action: 'url' }, ctx)).toMatchObject({ kind: 'error', message: expect.stringContaining('url_path') });
  });

  it('perform-action', () => {
    const a = { action: 'perform-action', perform_action: 'light.turn_on', data: { brightness: 10 }, target: { entity_id: 'light.b' } };
    expect(actionCall(a, ctx)).toEqual({ kind: 'service', domain: 'light', service: 'turn_on', data: { brightness: 10 }, target: { entity_id: 'light.b' }, confirm: null });
    // entity in data counts as a target
    expect(actionCall({ action: 'perform-action', perform_action: 'light.turn_on', data: { entity_id: 'light.b' } }, ctx)).toMatchObject({ kind: 'service' });
    // a script runs without a target
    expect(actionCall({ action: 'perform-action', perform_action: 'script.good_night' }, ctx)).toMatchObject({ kind: 'service', domain: 'script', service: 'good_night' });
  });

  it('perform-action: missing / malformed perform_action is a message, never a call; no target is fine', () => {
    expect(actionCall({ action: 'perform-action' }, ctx)).toMatchObject({ kind: 'error', message: expect.stringContaining('perform_action') });
    expect(actionCall({ action: 'perform-action', perform_action: 'nodot' }, ctx)).toMatchObject({ kind: 'error' });
    expect(actionCall({ action: 'perform-action', perform_action: 'light.turn_on' }, ctx)).toEqual({ kind: 'service', domain: 'light', service: 'turn_on', data: {}, confirm: null });
    expect(validateAction({ action: 'perform-action', perform_action: 'light.turn_on' })).toBe(null);
    expect(validateAction({ action: 'perform-action' })).toMatch(/perform_action/);
    expect(validateAction({ action: 'toggle' })).toBe(null);
  });

  it('perform-action: legacy service / service_data accepted as fallbacks', () => {
    expect(actionCall({ action: 'perform-action', service: 'light.turn_on', service_data: { brightness: 5 } }, ctx))
      .toMatchObject({ kind: 'service', domain: 'light', service: 'turn_on', data: { brightness: 5 } });
    // the new keys win
    expect(actionCall({ action: 'perform-action', perform_action: 'switch.turn_on', service: 'light.turn_on', data: { a: 1 }, service_data: { b: 2 } }, ctx))
      .toMatchObject({ domain: 'switch', data: { a: 1 } });
  });

  it('url: only http(s) or a local path', () => {
    expect(actionCall({ action: 'url', url_path: 'http://x' }, ctx)).toMatchObject({ kind: 'url' });
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', ' JavaScript:x', 'ftp://x', '//evil.example']) {
      expect(actionCall({ action: 'url', url_path: bad }, ctx)).toMatchObject({ kind: 'error' });
    }
  });

  it('confirmation exemptions: no dialog for a listed user', () => {
    const a = { action: 'toggle', confirmation: { text: 'Sure?', exemptions: [{ user: 'u1' }] } };
    expect(actionCall(a, { ...ctx, userId: 'u1' }).confirm).toBe(null);
    expect(actionCall(a, { ...ctx, userId: 'u2' }).confirm).toBe('Sure?');
    expect(actionCall(a, ctx).confirm).toBe('Sure?');
  });

  it('assist, popup, none, unknown', () => {
    expect(actionCall({ action: 'assist', pipeline_id: 'p' }, ctx)).toMatchObject({ kind: 'assist', action: { action: 'assist', pipeline_id: 'p' } });
    expect(actionCall({ action: 'popup' }, ctx)).toMatchObject({ kind: 'popup' });
    expect(actionCall({ action: 'none' }, ctx)).toMatchObject({ kind: 'none' });
    expect(actionCall(null, ctx)).toMatchObject({ kind: 'none' });
  });

  it('confirmation: true -> a default text, { text } -> that text', () => {
    expect(actionCall({ action: 'toggle', confirmation: true }, ctx).confirm).toMatch(/\?$/);
    expect(actionCall({ action: 'navigate', navigation_path: '/x', confirmation: { text: 'Go?' } }, ctx).confirm).toBe('Go?');
    expect(actionCall({ action: 'none', confirmation: true }, ctx).confirm).toBe(null);
  });
});

describe('popupLinks', () => {
  it('history, logbook, statistics and custom rows', () => {
    const rows = popupLinks(['state', 'history', 'logbook', 'statistics', { label: 'Plan', navigate: '/lovelace/plan' }, { label: 'Docs', url: 'https://x' }, { label: 'bad' }], 'light.a');
    expect(rows).toEqual([
      { kind: 'link', label: 'History', action: { action: 'navigate', navigation_path: '/history?entity_id=light.a' } },
      { kind: 'link', label: 'Logbook', action: { action: 'navigate', navigation_path: '/logbook?entity_id=light.a' } },
      { kind: 'link', label: 'Statistics', action: { action: 'more-info', entity: 'light.a' } },
      { kind: 'link', label: 'Plan', action: { action: 'navigate', navigation_path: '/lovelace/plan' } },
      { kind: 'link', label: 'Docs', action: { action: 'url', url_path: 'https://x' } },
    ]);
  });

  it('entity links need an entity; ids are URL-encoded', () => {
    expect(popupLinks(['history', 'statistics'], null)).toEqual([]);
    expect(popupLinks(['history'], 'sensor.a b')[0].action.navigation_path).toBe('/history?entity_id=sensor.a%20b');
  });
});

describe('TapSequencer', () => {
  afterEach(() => vi.useRealTimers());

  it('no double tap action: single tap runs at once', () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const single = vi.fn();
    s.tap('a', false, single, vi.fn());
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('with a double tap action: single waits 250 ms; two taps within it -> double only', () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const single = vi.fn(), dbl = vi.fn();
    s.tap('a', true, single, dbl);
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 1);
    expect(single).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(single).toHaveBeenCalledTimes(1);
    s.tap('a', true, single, dbl);
    vi.advanceTimersByTime(100);
    s.tap('a', true, single, dbl);
    expect(dbl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('a pending double-tap target never delays taps elsewhere', () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const singleA = vi.fn(), singleB = vi.fn();
    s.tap('a', true, singleA, vi.fn());
    s.tap('b', false, singleB, vi.fn());
    expect(singleB).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(singleA).toHaveBeenCalledTimes(1);
  });

  it('cancel drops pending taps', () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const single = vi.fn();
    s.tap('a', true, single, vi.fn());
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(single).not.toHaveBeenCalled();
  });
});
