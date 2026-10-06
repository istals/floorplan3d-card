import { describe, it, expect } from 'vitest';
import { setupChecklist, overlayAligned } from '../src/mower-setup.js';

const states = { 'lawn_mower.m': { state: 'docked' }, 'image.map': { state: 'x' } };
const ok = (r) => Object.fromEntries(r.rows.map((x) => [x.id, x.ok]));

describe('mower setup checklist', () => {
  it('empty layout: nothing done', () => {
    const r = setupChecklist(null, states, false);
    expect(r.complete).toBe(false);
    expect(r.rows.map((x) => x.id)).toEqual(['entity', 'map', 'aligned', 'found', 'mowed']);
    expect(r.rows.find((x) => x.id === 'mowed').optional).toBe(true);
  });
  it('image source adds the mower colour row', () => {
    const r = setupChecklist({ source: 'image', entity: 'lawn_mower.m' }, states, false);
    expect(r.rows.map((x) => x.id)).toContain('color');
  });
  it('complete without the optional mowed colour', () => {
    const m = { source: 'image', entity: 'lawn_mower.m', image: { color: [1, 2, 3] }, overlay: { entity: 'image.map', x: 3, y: 0, width: 20 } };
    const r = setupChecklist(m, states, true);
    expect(ok(r)).toEqual({ entity: true, map: true, aligned: true, color: true, found: true, mowed: false });
    expect(r.complete).toBe(true);
    expect(setupChecklist(m, states, false).complete).toBe(false);
  });
  it('auto mode: static map and mower picture rows, no colour rows', () => {
    const m = { source: 'image', entity: 'lawn_mower.m', overlay: { entity: 'image.map', x: 3 } };
    const r = setupChecklist(m, states, true, { static: 'image.static', picture: null });
    expect(r.rows.map((x) => x.id)).toEqual(['entity', 'map', 'aligned', 'static', 'picture', 'found']);
    expect(r.complete).toBe(true);
    const mm = setupChecklist(m, states, true, { static: 'image.static', picture: null, mismatch: true });
    expect(mm.rows.find((x) => x.id === 'static')).toMatchObject({ ok: false, label: "Static map doesn't match the live map" });
    expect(mm.complete).toBe(false);
  });
  it('missing entities are not ok', () => {
    expect(ok(setupChecklist({ entity: 'lawn_mower.x', overlay: { entity: 'image.y' } }, states))).toMatchObject({ entity: false, map: false });
  });
  it('aligned: width > 0 and points done or non-default placement', () => {
    expect(overlayAligned(null)).toBe(false);
    expect(overlayAligned({ entity: 'image.map', x: 0, y: 0, width: 20 })).toBe(false);
    expect(overlayAligned({ entity: 'image.map', x: 0, y: 0, width: 20, aligned: true })).toBe(true);
    expect(overlayAligned({ entity: 'image.map', x: 0, y: 0, width: 31 })).toBe(true);
    expect(overlayAligned({ entity: 'image.map', x: 0, y: 2 })).toBe(true);
    expect(overlayAligned({ entity: 'image.map', x: 5, width: 0, aligned: true })).toBe(false);
  });
});
