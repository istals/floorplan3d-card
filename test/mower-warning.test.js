import { describe, it, expect } from 'vitest';
import { isProblem, errorKind, errorText, stuckStep, stuckDueIn, parseOkValues } from '../src/mower-warning.js';

const S = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes });

describe('error classification', () => {
  it('binary_sensor on is a problem, off is not', () => {
    expect(isProblem(S('binary_sensor.e', 'on'))).toBe(true);
    expect(isProblem(S('binary_sensor.e', 'off'))).toBe(false);
  });
  it('sensor states', () => {
    for (const s of ['', 'none', 'OK', 'No Error', 'unknown', 'unavailable']) expect(isProblem(S('sensor.e', s))).toBe(false);
    expect(isProblem(S('sensor.e', 'Blade stuck'))).toBe(true);
    expect(isProblem(undefined)).toBe(false);
  });
  it('mower state error or error entity', () => {
    expect(errorKind(S('lawn_mower.m', 'error'), null)).toBe('error');
    expect(errorKind(S('lawn_mower.m', 'mowing'), S('sensor.e', 'lifted'))).toBe('error');
    expect(errorKind(S('lawn_mower.m', 'mowing'), S('sensor.e', 'none'))).toBe(null);
  });
  it('numeric codes: 0 is OK, anything else a problem', () => {
    expect(isProblem(S('sensor.code', '0'))).toBe(false);
    expect(isProblem(S('sensor.code', '0.0'))).toBe(false);
    expect(isProblem(S('sensor.code', '12'))).toBe(true);
    expect(isProblem(S('sensor.code', '-1'))).toBe(true);
    expect(errorText(null, S('sensor.code', '12'))).toBe('Error code 12');
    expect(errorText(null, S('sensor.code', '0'))).toBe(null);
  });
  it('status words are OK, case-insensitive', () => {
    for (const s of ['working', 'Mowing', 'CHARGING', 'docked', 'idle', 'returning', 'paused', 'standby', 'sleeping',
      'ready', 'home', 'off', 'normal', 'no_error']) expect(isProblem(S('sensor.status', s))).toBe(false);
    expect(isProblem(S('sensor.status', 'Rain delay'))).toBe(true);
  });
  it('extra OK values', () => {
    expect(parseOkValues(' Rain delay, ,Wait ')).toEqual(['rain delay', 'wait']);
    expect(parseOkValues(undefined)).toEqual([]);
    expect(isProblem(S('sensor.status', 'Rain Delay'), 'rain delay, wait')).toBe(false);
    expect(isProblem(S('sensor.status', 'Rain Delay'), ['wait'])).toBe(true);
    expect(isProblem(S('sensor.code', '7'), '7')).toBe(false);
    expect(errorKind(S('lawn_mower.m', 'mowing'), S('sensor.e', 'wait'), 'wait')).toBe(null);
  });
  it('binary_sensor unknown / unavailable is not a problem', () => {
    expect(isProblem(S('binary_sensor.e', 'unavailable'))).toBe(false);
  });
  it('text', () => {
    expect(errorText(S('lawn_mower.m', 'mowing'), S('sensor.e', 'E12', { description: 'Wheel blocked' }))).toBe('E12: Wheel blocked');
    expect(errorText(S('lawn_mower.m', 'error'), null)).toBe('Mower reports an error');
    expect(errorText(S('lawn_mower.m', 'docked'), null)).toBe(null);
  });
});

describe('stuck detector', () => {
  const min = 5, T = 60000;
  const run = (steps, state = 'mowing') => steps.reduce((st, [t, pos, s]) => stuckStep(st, { now: t * T, pos, state: s || state, minutes: min }), null);
  it('flags after N minutes without movement', () => {
    expect(run([[0, [1, 1]], [4, [1.1, 1]]]).stuck).toBe(false);
    expect(run([[0, [1, 1]], [4, [1.1, 1]], [5, [1.05, 1.02]]]).stuck).toBe(true);
  });
  it('movement of 0.3 m restarts the clock', () => {
    const st = run([[0, [0, 0]], [4, [0.4, 0]], [8, [0.4, 0.1]]]);
    expect(st.stuck).toBe(false);
    expect(stuckStep(st, { now: 9.1 * T, pos: [0.4, 0], state: 'mowing', minutes: min }).stuck).toBe(true);
  });
  it('never while docked / paused / returning / error, resets', () => {
    for (const s of ['docked', 'paused', 'returning', 'error', 'idle']) {
      expect(run([[0, [0, 0], 'mowing'], [3, [0, 0], 'mowing'], [30, [0, 0], s]])).toEqual({ anchor: null, since: null, stuck: false });
    }
  });
  it('off with 0 minutes', () => {
    const st = stuckStep(null, { now: 99 * T, pos: [0, 0], state: 'mowing', minutes: 0 });
    expect(st.stuck).toBe(false);
  });
  it('missing readings never count as stuck time', () => {
    expect(run([[0, [0, 0]], [3, null], [6, null]]).stuck).toBe(false);
    expect(run([[0, null]]).stuck).toBe(false);
    expect(run([[0, [0, 0]], [1, null], [11, [0.1, 0]]]).stuck).toBe(false); // 10 min without readings
    expect(run([[0, [0, 0]], [1, null], [11, [0.1, 0]], [14, [0.1, 0]]]).stuck).toBe(false);
    expect(run([[0, [0, 0]], [1, null], [11, [0.1, 0]], [16.5, [0.1, 0]]]).stuck).toBe(true); // 5 min of readings after
  });
  it('resumes cleanly after a dock', () => {
    const st = run([[0, [0, 0]], [9, [0, 0]], [10, [0, 0], 'docked'], [11, [0, 0], 'mowing']]);
    expect(st.stuck).toBe(false);
  });
  it('due time', () => {
    const st = stuckStep(null, { now: 2 * T, pos: [0, 0], state: 'mowing', minutes: 5 });
    expect(stuckDueIn(st, 3 * T, 5)).toBe(4 * T);
    expect(stuckDueIn(null, 0, 5)).toBe(null);
  });
});
