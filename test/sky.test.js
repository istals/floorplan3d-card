import { describe, it, expect } from 'vitest';
import { moonPosition, moonLight, moonLitRight, domeRadius, SUN_MIN_Y, sunPosition, sliderDate, snapMinutes, hhmm } from '../src/sky.js';

// Reference: suncalc's published test values (2013-03-05 UTC, 50.5 N, 30.5 E):
// getMoonPosition azimuth -0.9783999522438226 rad (from south), altitude 0.014551482243892251 rad;
// getMoonIllumination fraction 0.4848068202456373, phase 0.7548368838538762.
const REF = new Date('2013-03-05UTC');

describe('moonPosition', () => {
  it('matches the suncalc reference (azimuth from north, clockwise)', () => {
    const m = moonPosition(REF, 50.5, 30.5);
    expect(m.azimuth).toBeCloseTo(-0.9783999522438226 * 180 / Math.PI + 180, 4);
    expect(m.elevation).toBeCloseTo(0.014551482243892251 * 180 / Math.PI, 4);
    expect(m.illumination).toBeCloseTo(0.4848068202456373, 6);
    expect(m.phase).toBeCloseTo(0.7548368838538762, 6);
  });

  it('azimuth is in 0..360', () => {
    for (let h = 0; h < 24; h += 3) {
      const m = moonPosition(new Date(Date.UTC(2024, 5, 1, h)), 52, 5);
      expect(m.azimuth).toBeGreaterThanOrEqual(0);
      expect(m.azimuth).toBeLessThan(360);
    }
  });

  it('is full around 2024-04-23 and new around 2024-04-08', () => {
    const full = moonPosition(new Date('2024-04-23T23:49:00Z'), 52, 5);
    expect(full.illumination).toBeGreaterThan(0.98);
    expect(Math.abs(full.phase - 0.5)).toBeLessThan(0.03);
    const nu = moonPosition(new Date('2024-04-08T18:21:00Z'), 52, 5);
    expect(nu.illumination).toBeLessThan(0.02);
    expect(Math.min(nu.phase, 1 - nu.phase)).toBeLessThan(0.03);
  });

  it('waxes before full (phase < 0.5) and wanes after', () => {
    expect(moonPosition(new Date('2024-04-16T12:00:00Z'), 52, 5).phase).toBeLessThan(0.5);
    expect(moonPosition(new Date('2024-04-30T12:00:00Z'), 52, 5).phase).toBeGreaterThan(0.5);
  });

  it('rises and sets within a day', () => {
    let pos = 0, neg = 0;
    for (let h = 0; h < 25; h++) {
      const e = moonPosition(new Date(Date.UTC(2024, 3, 23, h)), 52, 5).elevation;
      if (e > 0) pos++; else neg++;
    }
    expect(pos).toBeGreaterThan(0);
    expect(neg).toBeGreaterThan(0);
  });

  it('full moon at local midnight is high in the south', () => {
    // 2024-04-23 full moon, 52 N 5 E: around 23:40 UTC the moon transits (south, low in spring)
    const m = moonPosition(new Date('2024-04-24T00:30:00Z'), 52, 5);
    expect(m.azimuth).toBeGreaterThan(150);
    expect(m.azimuth).toBeLessThan(230);
    expect(m.elevation).toBeGreaterThan(5);
  });

  it('accepts ms timestamps and rejects bad input', () => {
    const t = REF.getTime();
    expect(moonPosition(t, 50.5, 30.5)).toEqual(moonPosition(REF, 50.5, 30.5));
    expect(moonPosition(NaN, 50, 5)).toBeNull();
    expect(moonPosition(REF, undefined, 5)).toBeNull();
  });
});

describe('moonLight', () => {
  it('is off by day, without a moon or with the moon down', () => {
    expect(moonLight(0.3, { dir: [0, 0.5, 0.8], illumination: 1 })).toBe(0);
    expect(moonLight(1, null)).toBe(0);
    expect(moonLight(1, { dir: [0, -0.1, 1], illumination: 1 })).toBe(0);
  });
  it('is 0.05 + 0.15 x illumination x night', () => {
    expect(moonLight(1, { dir: [0, 0.5, 0.8], illumination: 1 })).toBeCloseTo(0.2);
    expect(moonLight(0.8, { dir: [0, 0.5, 0.8], illumination: 0.5 })).toBeCloseTo(0.05 + 0.15 * 0.5 * 0.8);
  });
});

describe('dome', () => {
  it('radius is 1.4 x the house radius, at least 12 m', () => {
    expect(domeRadius(20)).toBeCloseTo(28);
    expect(domeRadius(3)).toBe(12);
    expect(domeRadius(undefined)).toBe(12);
  });
  it('sun shows down to -2 deg', () => {
    expect(SUN_MIN_Y).toBeCloseTo(-0.0349, 4);
  });
});

describe('moonLitRight', () => {
  it('waxing is lit on the right in the north, on the left in the south', () => {
    expect(moonLitRight(0.2, 52)).toBe(true);
    expect(moonLitRight(0.8, 52)).toBe(false);
    expect(moonLitRight(0.2, -34)).toBe(false);
    expect(moonLitRight(0.8, -34)).toBe(true);
    expect(moonLitRight(0.2)).toBe(true); // no latitude: northern view
  });
});

// Reference: suncalc's published test value (2013-03-05 UTC, 50.5 N, 30.5 E):
// getPosition azimuth -2.5003175907168385 rad (from south), altitude -0.7000406838781611 rad.
describe('sunPosition', () => {
  const deg = (r) => (r * 180) / Math.PI;
  it('matches the suncalc reference within 0.5 degrees', () => {
    const p = sunPosition(REF, 50.5, 30.5);
    expect(Math.abs(p.azimuth - (deg(-2.5003175907168385) + 180))).toBeLessThan(0.5);
    expect(Math.abs(p.elevation - deg(-0.7000406838781611))).toBeLessThan(0.5);
  });
  it('is near the zenith at equinox noon on the equator', () => {
    const p = sunPosition(new Date('2024-03-20T12:07:00Z'), 0, 0);
    expect(p.elevation).toBeGreaterThan(88);
  });
  it('summer at 52 N: low in the east at 06:00 local solar, high in the south at noon, down at midnight', () => {
    const six = sunPosition(new Date('2024-06-21T05:40:00Z'), 52, 5); // ~06:00 local solar time at 5 E
    const noon = sunPosition(new Date('2024-06-21T11:40:00Z'), 52, 5);
    const midnight = sunPosition(new Date('2024-06-21T23:40:00Z'), 52, 5);
    expect(six.elevation).toBeGreaterThan(5);
    expect(six.elevation).toBeLessThan(20);
    expect(six.azimuth).toBeGreaterThan(70);
    expect(six.azimuth).toBeLessThan(110);
    expect(Math.abs(noon.elevation - (90 - 52 + 23.44))).toBeLessThan(0.5);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(3);
    expect(midnight.elevation).toBeLessThan(0);
  });
  it('null without a valid time / location', () => {
    expect(sunPosition(NaN, 1, 2)).toBeNull();
    expect(sunPosition(REF, undefined, 2)).toBeNull();
  });
});

describe('time scrubber helpers', () => {
  it('sliderDate: today (local) at the given minutes', () => {
    const now = new Date(2024, 5, 21, 17, 33, 12);
    const d = sliderDate(now, 6 * 60 + 15);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2024, 5, 21, 6, 15, 0]);
  });
  it('snapMinutes: 15 min steps within 0..1440', () => {
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(-30)).toBe(0);
    expect(snapMinutes(2000)).toBe(1440);
  });
  it('hhmm', () => {
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(375)).toBe('06:15');
    expect(hhmm(1440)).toBe('24:00');
  });
});
