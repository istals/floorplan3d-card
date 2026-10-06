import { describe, it, expect } from 'vitest';
import { tapHintsMode, reachability, hintAlpha, HINT_RADIUS } from '../src/objects/hints.js';
import { chainState } from '../src/objects/logic.js';

const st = (state, attributes = {}) => ({ state, attributes });

describe('tapHintsMode', () => {
  it('layout.tap_hints: always / near (default) / off', () => {
    expect(tapHintsMode({ tap_hints: 'always' })).toBe('always');
    expect(tapHintsMode({ tap_hints: 'off' })).toBe('off');
    expect(tapHintsMode({})).toBe('near');
    expect(tapHintsMode({ tap_hints: 'x' })).toBe('near');
    expect(tapHintsMode(null)).toBe('near');
  });
});

describe('reachability', () => {
  const tags = { facade: { entity: 'switch.f', label: 'Facade circuit' } };
  const obj = { id: 'l', group: 'facade' };
  const run = (states, binding = { entity: 'light.l', tags: ['facade'] }) => reachability(obj, binding, chainState(obj, binding, tags, states), states, tags);
  it('own entity and controllers fine: reachable', () => {
    expect(run({ 'light.l': st('off'), 'switch.f': st('on') })).toEqual({ ok: true, reason: null });
  });
  it('a controller off: "Turn on first: <label>"', () => {
    expect(run({ 'light.l': st('off'), 'switch.f': st('off') })).toEqual({ ok: false, reason: 'Turn on first: Facade circuit' });
    expect(run({ 'light.l': st('unavailable'), 'switch.f': st('off') })).toEqual({ ok: false, reason: 'Turn on first: Facade circuit' });
    const noLabel = reachability(obj, { entity: 'light.l', tags: ['facade'] }, null, { 'light.l': st('on'), 'switch.f': st('off', { friendly_name: 'Relay' }) }, { facade: { entity: 'switch.f' } });
    expect(noLabel.reason).toBe('Turn on first: Relay');
  });
  it('own entity or a controller unavailable: offline', () => {
    expect(run({ 'light.l': st('unavailable'), 'switch.f': st('on') })).toEqual({ ok: false, reason: 'Not reachable (offline)' });
    expect(run({ 'light.l': st('on'), 'switch.f': st('unavailable') })).toEqual({ ok: false, reason: 'Not reachable (offline)' });
    expect(run({ 'switch.f': st('on') })).toEqual({ ok: false, reason: 'Not reachable (offline)' });
  });
  it('no entity at all: not reachable; hidden: not reachable', () => {
    expect(reachability(obj, { entity: null, tags: [] }, null, {}, tags).ok).toBe(false);
    expect(reachability(obj, { entity: 'light.l', hidden: true }, null, { 'light.l': st('on') }, tags).ok).toBe(false);
  });
});

describe('hintAlpha', () => {
  it('full within half the radius, fading to 0 at the radius, quantised to 0.1', () => {
    expect(HINT_RADIUS).toBe(120);
    expect(hintAlpha(0)).toBe(1);
    expect(hintAlpha(60)).toBe(1);
    expect(hintAlpha(120)).toBe(0);
    expect(hintAlpha(500)).toBe(0);
    const mid = hintAlpha(90);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    expect(Math.round(mid * 10) / 10).toBe(mid);
  });
});
