// Sun / moon in the sky: sun position, moon position and phase (low precision, the suncalc formulas:
// https://github.com/mourner/suncalc, after "Astronomy Answers" by Aa. Kirsch), moonlight strength.

const RAD = Math.PI / 180;
const DAY_MS = 86400000, J1970 = 2440588, J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
const SUN_DIST_KM = 149598000;

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;
const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const siderealTime = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;

// Atmospheric refraction (rad) for an altitude h (rad), clamped at the horizon.
function refraction(h) {
  if (h < 0) h = 0;
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d); // ecliptic longitude
  const M = RAD * (134.963 + 13.064993 * d); // mean anomaly
  const F = RAD * (93.272 + 13.229350 * d); // mean distance
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

// date: Date or ms; lat / lon degrees. -> { azimuth (deg from north, clockwise, 0..360),
// elevation (deg, refraction included), phase 0..1 (0 new, 0.5 full, < 0.5 waxing), illumination 0..1 }
// or null without a valid time / location.
export function moonPosition(date, latDeg, lonDeg) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms) || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  const d = toDays(ms), phi = RAD * latDeg, lw = RAD * -lonDeg;
  const m = moonCoords(d);
  const H = siderealTime(d, lw) - m.ra;
  let h = Math.asin(Math.sin(phi) * Math.sin(m.dec) + Math.cos(phi) * Math.cos(m.dec) * Math.cos(H));
  h += refraction(h);
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(m.dec) * Math.cos(phi));
  const azimuth = (((azSouth / RAD + 180) % 360) + 360) % 360;
  const s = sunCoords(d);
  const dra = s.ra - m.ra;
  const elong = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(dra));
  const inc = Math.atan2(SUN_DIST_KM * Math.sin(elong), m.dist - SUN_DIST_KM * Math.cos(elong));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(dra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(dra));
  return {
    azimuth,
    elevation: h / RAD,
    phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI,
    illumination: (1 + Math.cos(inc)) / 2,
  };
}

// Sun position (suncalc formulas): date Date or ms, lat / lon degrees -> { azimuth (deg from north,
// clockwise, 0..360), elevation (deg, geometric: no refraction, so it stays smooth across the horizon) }
// or null without a valid time / location.
export function sunPosition(date, latDeg, lonDeg) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms) || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  const d = toDays(ms), phi = RAD * latDeg, lw = RAD * -lonDeg;
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  const h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
  return { azimuth: (((azSouth / RAD + 180) % 360) + 360) % 360, elevation: h / RAD };
}

// Time scrubber (session only): minutes 0..1440 in 15 min steps on today's local date.
// Today and the minutes are in HA's time zone (hass.config.time_zone), else the browser's.
export const SCRUB_STEP_MIN = 15;
export const SCRUB_IDLE_MS = 120000; // back to live after 2 minutes without slider input
export const snapMinutes = (m) => Math.min(1440, Math.max(0, Math.round((Number(m) || 0) / SCRUB_STEP_MIN) * SCRUB_STEP_MIN));

const fmts = new Map();
// wall-clock parts of ms in time zone tz -> { y, mo (0-based), d, h, mi, s } or null (unknown zone)
function tzParts(ms, tz) {
  if (!tz) return null;
  let f = fmts.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch (e) {
      f = null;
    }
    fmts.set(tz, f);
  }
  if (!f) return null;
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
// zone offset (ms) at ms: wall clock as UTC - real UTC
const tzOffset = (ms, tz) => { const p = tzParts(ms, tz); return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };

// Minutes since midnight of ms in the zone (browser's without a valid tz).
export function tzMinutes(ms, tz) {
  const p = tzParts(ms, tz);
  if (p) return p.h * 60 + p.mi;
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

// Today (in tz) at minutes since its midnight -> Date.
export function sliderDate(now, minutes, tz = null) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const p = tzParts(ms, tz);
  if (!p) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(minutes);
    return d;
  }
  const wall = Date.UTC(p.y, p.mo, p.d, 0, minutes);
  let t = wall - tzOffset(wall, tz);
  t = wall - tzOffset(t, tz); // the offset at the result (DST change days)
  return new Date(t);
}
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Moonlight intensity: night (0..1) > 0.5 and the moon above the horizon (dir[1] > 0, world up).
export function moonLight(night, moon) {
  if (!(night > 0.5) || !moon || !moon.dir || !(moon.dir[1] > 0)) return 0;
  const ill = Math.max(0, Math.min(1, Number(moon.illumination) || 0));
  return 0.05 + 0.15 * ill * Math.min(1, night);
}

// Dome around the house the sun / moon sit on: radius from the house's horizontal radius (m).
export const domeRadius = (houseRadius) => Math.max(12, 1.4 * (Number(houseRadius) || 0));
// The sun disc shows down to 2 degrees below the horizon (y of its unit vector); the moon only above it.
export const SUN_MIN_Y = Math.sin(-2 * RAD);
// World size of the discs on the dome (m).
export const SUN_DISC_M = 1.6;
export const MOON_DISC_M = 1.3;

// Lit side of the moon disc: right while waxing (phase < 0.5) seen from the northern hemisphere,
// mirrored south of the equator.
export function moonLitRight(phase, latitude) {
  const waxing = !((Number(phase) || 0) > 0.5);
  return Number(latitude) < 0 ? !waxing : waxing;
}
