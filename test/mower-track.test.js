import { describe, it, expect } from 'vitest';
import {
  isDocked, dockWord, dockFrontAxis, dockPose, trackWindow, fullSearch, layerDue, tileHashes, changedTiles, tileRect, tilesOf,
  throttleStep, effectiveRefresh, mowerStatusText, durationText, rememberPosition, lastPosition,
} from '../src/mower-track.js';

describe('docked state', () => {
  it('lawn_mower docked / charging', () => {
    expect(isDocked('docked')).toBe(true);
    expect(isDocked('Charging')).toBe(true);
    expect(isDocked('mowing')).toBe(false);
    expect(isDocked('returning')).toBe(false);
  });
  it('a Mower status sensor saying Docked / Charging', () => {
    expect(isDocked('mowing', 'Docked')).toBe(true);
    expect(isDocked('unknown', 'Charging')).toBe(true);
    expect(isDocked('paused', 'In dock')).toBe(true);
    expect(isDocked('returning', 'Returning to dock')).toBe(false);
    expect(isDocked('mowing', 'Leaving dock')).toBe(false);
    expect(isDocked('mowing', 'Working')).toBe(false);
    expect(isDocked(null, null)).toBe(false);
  });
  it('word for the status line', () => {
    expect(dockWord('docked')).toBe('docked');
    expect(dockWord('docked', 'Charging')).toBe('charging');
  });
});

describe('dock pose', () => {
  it('front axis: +Z by default, hints.front wins', () => {
    expect(dockFrontAxis(null)).toEqual([0, 0, 1]);
    expect(dockFrontAxis({ front: '-x' })).toEqual([-1, 0, 0]);
    expect(dockFrontAxis({ front: 'up' })).toEqual([0, 0, 1]);
  });
  it('world anchor and direction -> plan point and heading', () => {
    const p = dockPose({ x: 13, y: 0.15, z: -1.5 }, { x: 0, z: 1 }); // world +z = plan south
    expect(p.x).toBe(13);
    expect(p.y).toBe(1.5);
    expect(p.heading).toBeCloseTo(-Math.PI / 2);
    expect(dockPose({ x: 0, y: 0, z: 0 }, { x: 1, z: 0 }).heading).toBeCloseTo(0); // east
    expect(dockPose({ x: 0, y: 0, z: 0 }, { x: 0, z: -2 }).heading).toBeCloseTo(Math.PI / 2); // north
    expect(dockPose({ x: 0, y: 0, z: 0 }, { x: 0, z: 0 }).heading).toBe(null);
  });
});

describe('search window', () => {
  it('3x the icon plus the travel since the last refresh', () => {
    // icon 20 px, 2 s at 0.5 m/s, 50 px/m -> 1.5 * 20 + 50 = 80 px each way
    const r = trackWindow({ px: 500, py: 400, size: 20 }, { dt: 2, ppm: 50, w: 1024, h: 1024 });
    expect(r).toEqual({ x0: 420, y0: 320, x1: 580, y1: 480 });
  });
  it('clamped to the picture', () => {
    const r = trackWindow({ px: 10, py: 1020, size: 20 }, { dt: 0, ppm: 50, w: 1024, h: 1024 });
    expect(r).toEqual({ x0: 0, y0: 990, x1: 40, y1: 1024 });
  });
  it('null when nothing is tracked or the window covers most of the picture', () => {
    expect(trackWindow(null, { dt: 2, ppm: 50, w: 100, h: 100 })).toBe(null);
    expect(trackWindow({ px: 50, py: 50, size: 20 }, { dt: 10, ppm: 50, w: 100, h: 100 })).toBe(null);
  });
  it('full search when lost, after a dock change, every 60 s', () => {
    const base = { tracked: true, missed: false, dockChanged: false, now: 100000, lastFull: 90000 };
    expect(fullSearch(base)).toBe(false);
    expect(fullSearch({ ...base, tracked: false })).toBe(true);
    expect(fullSearch({ ...base, missed: true })).toBe(true);
    expect(fullSearch({ ...base, dockChanged: true })).toBe(true);
    expect(fullSearch({ ...base, lastFull: 40000 })).toBe(true);
    expect(fullSearch({ ...base, lastFull: undefined })).toBe(true);
  });
});

describe('layer refresh', () => {
  it('every 60 s or when the progress changes', () => {
    expect(layerDue({ now: 0, lastAt: undefined })).toBe(true);
    expect(layerDue({ now: 30000, lastAt: 0, progress: 0.4, lastProgress: 0.4 })).toBe(false);
    expect(layerDue({ now: 30000, lastAt: 0, progress: 0.41, lastProgress: 0.4 })).toBe(true);
    expect(layerDue({ now: 60000, lastAt: 0, progress: null, lastProgress: null })).toBe(true);
  });
});

describe('tiles', () => {
  const img = (w, h, f) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 4; const c = f(x, y); d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255; }
    return d;
  };
  it('tile grid and rectangles (edge tiles smaller)', () => {
    expect(tilesOf(130, 70)).toEqual({ cols: 3, rows: 2 });
    expect(tileRect(2, 130, 70)).toEqual({ x0: 128, y0: 0, x1: 130, y1: 64 });
    expect(tileRect(4, 130, 70)).toEqual({ x0: 64, y0: 64, x1: 128, y1: 70 });
  });
  it('same picture, same hashes; a change marks only its tile', () => {
    const a = img(200, 150, () => [40, 120, 40]);
    const b = img(200, 150, (x, y) => (x >= 136 && x < 140 && y >= 72 && y < 76 ? [200, 0, 0] : [40, 120, 40]));
    const ha = tileHashes(a, 200, 150), hb = tileHashes(b, 200, 150);
    expect(ha.length).toBe(4 * 3);
    expect(changedTiles(ha, tileHashes(a, 200, 150))).toEqual([]);
    expect(changedTiles(ha, hb)).toEqual([1 * 4 + 2]);
  });
  it('no previous hashes (or another size): every tile', () => {
    const h = tileHashes(img(64, 64, () => [1, 2, 3]), 64, 64);
    expect(changedTiles(null, h)).toEqual([0]);
    expect(changedTiles(new Uint32Array(3), h)).toEqual([0]);
  });
});

describe('adaptive refresh', () => {
  it('more than 3 long tasks a minute double the interval, up to 60 s', () => {
    let st = null;
    for (let i = 0; i < 4; i++) st = throttleStep(st, { now: i * 1000, longTask: true, base: 10 });
    expect(st.factor).toBe(2);
    expect(effectiveRefresh(10, st)).toBe(20);
    for (let i = 0; i < 4; i++) st = throttleStep(st, { now: 10000 + i * 1000, longTask: true, base: 10 });
    expect(st.factor).toBe(4);
    for (let i = 0; i < 8; i++) st = throttleStep(st, { now: 20000 + i * 1000, longTask: true, base: 10 });
    expect(effectiveRefresh(10, st)).toBe(60);
  });
  it('3 in a minute or spread out: unchanged', () => {
    let st = null;
    for (let i = 0; i < 3; i++) st = throttleStep(st, { now: i * 1000, longTask: true, base: 10 });
    expect(st.factor).toBe(1);
    for (let i = 0; i < 6; i++) st = throttleStep(st, { now: 100000 + i * 30000, longTask: true, base: 10 });
    expect(st.factor).toBe(1);
  });
  it('recovers after 5 quiet minutes', () => {
    let st = null;
    for (let i = 0; i < 4; i++) st = throttleStep(st, { now: i * 1000, longTask: true, base: 10 });
    st = throttleStep(st, { now: 4 * 60000, longTask: false, base: 10 });
    expect(st.factor).toBe(2);
    st = throttleStep(st, { now: 3000 + 5 * 60000, longTask: false, base: 10 });
    expect(st.factor).toBe(1);
    expect(effectiveRefresh(10, st)).toBe(10);
  });
});

describe('status line', () => {
  it('texts', () => {
    expect(mowerStatusText({ kind: 'dock', word: 'docked' })).toBe('At dock (docked)');
    expect(mowerStatusText({ kind: 'tracked', score: 0.8234 })).toBe('Tracked on map (score 0.82)');
    expect(mowerStatusText({ kind: 'tracked', score: null })).toBe('Tracked on map (icon shape)');
    expect(mowerStatusText({ kind: 'last', lostMs: 125000 })).toBe('Last known position (not found for 2 min)');
    expect(mowerStatusText({ kind: 'mismatch' })).toMatch(/^Static map doesn't match/);
  });
  it('durations', () => {
    expect(durationText(4000)).toBe('4 s');
    expect(durationText(90000)).toBe('2 min');
    expect(durationText(2 * 3600000)).toBe('2 h');
  });
});

describe('last known position', () => {
  it('kept per layout key, copies out', () => {
    rememberPosition('a', { x: 1, y: 2 });
    const p = lastPosition('a');
    p.x = 9;
    expect(lastPosition('a')).toEqual({ x: 1, y: 2 });
    expect(lastPosition('b')).toBe(null);
    rememberPosition('a', null);
    expect(lastPosition('a')).toBe(null);
  });
});
