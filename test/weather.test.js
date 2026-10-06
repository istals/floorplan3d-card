import { describe, it, expect } from 'vitest';
import {
  cloudCoverage, weatherEntity, cloudLight, cloudCount, coverageChanged, CLOUD_MAX,
  cloudSlots, cloudAzEl, dirFromAzEl, azElFromDir, CLOUD_DRIFT_DEG, CLOUD_DRIFT_RATE, cloudFade, cloudNear,
} from '../src/weather.js';

const w = (state, attributes = {}) => ({ entity_id: 'weather.x', state, attributes });

describe('cloudCoverage', () => {
  it('uses a numeric cloud_coverage attribute, clamped 0..100', () => {
    expect(cloudCoverage(w('sunny', { cloud_coverage: 62 }))).toBe(62);
    expect(cloudCoverage(w('sunny', { cloud_coverage: '35' }))).toBe(35);
    expect(cloudCoverage(w('sunny', { cloud_coverage: 140 }))).toBe(100);
    expect(cloudCoverage(w('sunny', { cloud_coverage: -3 }))).toBe(0);
  });

  it('falls back to the condition', () => {
    const map = { sunny: 0, 'clear-night': 0, partlycloudy: 40, cloudy: 85, fog: 100, rainy: 100, pouring: 100,
      snowy: 100, 'snowy-rainy': 100, lightning: 100, 'lightning-rainy': 100, hail: 100, 'windy-variant': 100,
      windy: 30, exceptional: 50, unknown: 0, unavailable: 0, weird: 0 };
    for (const [s, c] of Object.entries(map)) expect(cloudCoverage(w(s)), s).toBe(c);
    expect(cloudCoverage(w('cloudy', { cloud_coverage: null }))).toBe(85);
    expect(cloudCoverage(w('cloudy', { cloud_coverage: '' }))).toBe(85);
    expect(cloudCoverage(w('cloudy', { cloud_coverage: 'n/a' }))).toBe(85);
  });

  it('no entity -> 0', () => {
    expect(cloudCoverage(null)).toBe(0);
    expect(cloudCoverage(undefined)).toBe(0);
  });
});

describe('weatherEntity', () => {
  const states = { 'sun.sun': {}, 'weather.home': w('sunny'), 'weather.other': w('cloudy') };
  it('none -> null', () => expect(weatherEntity({ weather: 'none' }, states)).toBe(null));
  it('configured entity wins', () => expect(weatherEntity({ weather: 'weather.other' }, states)).toBe('weather.other'));
  it('default: the first weather.* entity', () => expect(weatherEntity({}, states)).toBe('weather.home'));
  it('default without weather entities -> null', () => expect(weatherEntity({}, { 'sun.sun': {} })).toBe(null));
  it('false also disables', () => expect(weatherEntity({ weather: false }, states)).toBe(null));
});

describe('cloudLight', () => {
  it('clear sky changes nothing', () => {
    expect(cloudLight(0, 0)).toEqual({ sun: 1, shadowRadius: 1, shadowIntensity: 1, hemi: 1, sunDisc: 1, moon: 1 });
  });
  it('overcast: sun x0.25, softer and fainter shadow, more fill by day', () => {
    const l = cloudLight(100, 0);
    expect(l.sun).toBeCloseTo(0.25);
    expect(l.shadowRadius).toBeCloseTo(4);
    expect(l.shadowIntensity).toBeCloseTo(0.35);
    expect(l.hemi).toBeCloseTo(1.35);
    expect(l.sunDisc).toBeCloseTo(0.2);
    expect(l.moon).toBeCloseTo(0.3);
  });
  it('night: hemisphere unchanged', () => {
    expect(cloudLight(100, 1).hemi).toBe(1);
    expect(cloudLight(60, 0).hemi).toBeCloseTo(1.21);
  });
});

describe('cloudCount / coverageChanged', () => {
  it('count = round(coverage / 100 x max)', () => {
    expect(CLOUD_MAX).toBeGreaterThanOrEqual(6);
    expect(CLOUD_MAX).toBeLessThanOrEqual(14);
    expect(cloudCount(0)).toBe(0);
    expect(cloudCount(100)).toBe(CLOUD_MAX);
    expect(cloudCount(60, 12)).toBe(7);
    expect(cloudCount(40, 12)).toBe(5);
  });
  it('applies only on a change of 5 or more (and on reaching 0 / 100)', () => {
    expect(coverageChanged(null, 0)).toBe(true);
    expect(coverageChanged(40, 44)).toBe(false);
    expect(coverageChanged(40, 45)).toBe(true);
    expect(coverageChanged(40, 35)).toBe(true);
    expect(coverageChanged(3, 0)).toBe(true);
    expect(coverageChanged(97, 100)).toBe(true);
    expect(coverageChanged(0, 0)).toBe(false);
  });
});

describe('cloud placement', () => {
  it('az / el round trip, world up = +y', () => {
    const d = dirFromAzEl(30, 20);
    expect(Math.hypot(...d)).toBeCloseTo(1);
    expect(d[1]).toBeCloseTo(Math.sin(20 * Math.PI / 180));
    const a = azElFromDir(d);
    expect(a.az).toBeCloseTo(30);
    expect(a.el).toBeCloseTo(20);
  });
  it('slots are fixed, the first ones near the anchor (the sun)', () => {
    const s = cloudSlots();
    expect(s.length).toBe(CLOUD_MAX);
    expect(cloudSlots()).toEqual(s); // deterministic
    const anchor = { az: 200, el: 30 };
    const near = s.filter((x) => x.near);
    expect(near.length).toBeGreaterThanOrEqual(2);
    expect(s.indexOf(near[0])).toBe(0); // a partly cloudy sky covers the sun first
    for (const x of near) {
      const p = cloudAzEl(x, anchor, 0);
      const dAz = ((p.az - anchor.az + 540) % 360) - 180;
      expect(Math.abs(dAz)).toBeLessThan(15);
      expect(Math.abs(p.el - anchor.el)).toBeLessThan(8);
    }
    const all = s.map((x) => cloudAzEl(x, anchor, 0));
    for (const p of all) { expect(p.el).toBeGreaterThan(5); expect(p.el).toBeLessThan(80); }
    // the others spread around the sky
    const far = s.filter((x) => !x.near).map((x) => cloudAzEl(x, anchor, 0).az);
    expect(Math.max(...far) - Math.min(...far)).toBeGreaterThan(180);
  });
  it('clouds stay above the horizon with a low anchor', () => {
    for (const x of cloudSlots()) expect(cloudAzEl(x, { az: 90, el: -10 }, 0).el).toBeGreaterThan(5);
  });
  it('drift is slow (<= 1 deg/s) and bounded', () => {
    expect(CLOUD_DRIFT_DEG * CLOUD_DRIFT_RATE).toBeLessThanOrEqual(1);
    const slot = cloudSlots()[3], anchor = { az: 10, el: 30 };
    let prev = cloudAzEl(slot, anchor, 0);
    for (let t = 0.1; t < 120; t += 0.1) {
      const p = cloudAzEl(slot, anchor, t);
      const dAz = ((p.az - prev.az + 540) % 360) - 180;
      expect(Math.abs(dAz) / 0.1).toBeLessThanOrEqual(1.0001);
      prev = p;
    }
  });
});

describe('cloudFade / cloudNear', () => {
  const c = [0, 0, 0];
  it('full up to 50 deg camera elevation, gone from 65 deg', () => {
    expect(cloudFade([30, 20, 0], c)).toBe(1); // ~34 deg
    expect(cloudFade([10, Math.tan(57.5 * Math.PI / 180) * 10, 0], c)).toBeCloseTo(0.5);
    expect(cloudFade([1, 40, 1], c)).toBe(0); // high orbit
    expect(cloudFade([0, 0, 0], c)).toBe(0);
  });
  it('near: closer than the cloud size', () => {
    expect(cloudNear([0, 0, 0], [3, 0, 0], 5)).toBe(true);
    expect(cloudNear([0, 0, 0], [30, 0, 0], 5)).toBe(false);
  });
});
