import { describe, it, expect } from 'vitest';
import { RENDER_DEFAULTS, normRender, mergeRender, deviceShadowCap, lampShadowSlots, lampMapSize, recipeFar, skyLights } from '../src/render-recipe.js';
import { buildManifest } from '../src/manifest.js';

const tree = (roots) => ({
  roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '',
  extras: (n) => n.extras || {}, parent: () => null,
});

describe('normRender', () => {
  it('returns null without a recipe', () => {
    expect(normRender(undefined)).toEqual({ recipe: null, warnings: [], keys: 0 });
  });
  it('warns on a non-object recipe', () => {
    const r = normRender(5);
    expect(r.recipe).toBeNull();
    expect(r.warnings[0]).toMatch(/render/);
  });
  it('keeps valid keys and counts them', () => {
    const r = normRender({
      toneMapping: 'ACESFilmic', exposure: 1.1, outputColorSpace: 'srgb', pixelRatioMax: 2, anisotropy: 4,
      camera: { fov: 40, near: 0.2, far: 300 }, sun: { shadowMapSize: 4096, bias: -0.0003, normalBias: 0.03 },
      lampShadows: { max: 6, mapSize: 1024, bias: -0.0008, normalBias: 0.04, radius: 3 },
      day: { hemi: ['#c4d6ff', 0x2a2520, 1], sun: [0xffeedd, 3] }, night: { hemi: [0x223344, '#000000', 0.1], sun: [0, 0] },
      glowIntensityPerBrightness: 2,
    });
    expect(r.warnings).toEqual([]);
    expect(r.keys).toBe(11);
    expect(r.recipe.toneMapping).toBe('ACESFilmic');
    expect(r.recipe.camera).toEqual({ fov: 40, near: 0.2, far: 300 });
    expect(r.recipe.day.hemi).toEqual([0xc4d6ff, 0x2a2520, 1]);
    expect(r.recipe.night.hemi).toEqual([0x223344, 0, 0.1]);
    expect(r.recipe.lampShadows.max).toBe(6);
  });
  it('ignores unknown keys silently and warns on invalid values', () => {
    const r = normRender({ foo: 1, exposure: 'bright', toneMapping: 'Weird', camera: { fov: NaN, far: 100 }, day: { hemi: [1, 2] } });
    expect(r.recipe).toEqual({ camera: { far: 100 } });
    expect(r.keys).toBe(1);
    expect(r.warnings.length).toBe(4);
    expect(r.warnings.join('\n')).toMatch(/exposure/);
    expect(r.warnings.join('\n')).toMatch(/toneMapping/);
    expect(r.warnings.join('\n')).toMatch(/camera.fov/);
    expect(r.warnings.join('\n')).toMatch(/day.hemi/);
  });
  it('clamps ranges with a warning', () => {
    const r = normRender({ exposure: 50, pixelRatioMax: 0.1, anisotropy: 64, camera: { fov: 170 }, sun: { shadowMapSize: 100000 }, lampShadows: { max: 99, mapSize: 3 } });
    expect(r.recipe.exposure).toBe(4);
    expect(r.recipe.pixelRatioMax).toBe(0.5);
    expect(r.recipe.anisotropy).toBe(16);
    expect(r.recipe.camera.fov).toBe(100);
    expect(r.recipe.sun.shadowMapSize).toBe(4096);
    expect(r.recipe.lampShadows.max).toBe(8);
    expect(r.recipe.lampShadows.mapSize).toBe(128);
    expect(normRender({ lampShadows: { mapSize: 2048 } }).recipe.lampShadows.mapSize).toBe(1024);
    expect(r.warnings.length).toBe(7);
  });
  it('rounds shadow map sizes to a power of two', () => {
    expect(normRender({ sun: { shadowMapSize: 1500 } }).recipe.sun.shadowMapSize).toBe(1024);
    expect(normRender({ lampShadows: { max: 2.6 } }).recipe.lampShadows.max).toBe(3);
  });
});

describe('mergeRender', () => {
  it('is the defaults without a recipe', () => {
    expect(mergeRender(null)).toEqual(RENDER_DEFAULTS);
    expect(RENDER_DEFAULTS.exposure).toBe(1.25);
    expect(RENDER_DEFAULTS.lampShadows.max).toBe(4);
    expect(RENDER_DEFAULTS.glowIntensityPerBrightness).toBe(3);
  });
  it('overrides key by key, nested objects merged', () => {
    const m = mergeRender({ exposure: 1, sun: { bias: -0.001 }, day: { sun: [0xffffff, 3] } });
    expect(m.exposure).toBe(1);
    expect(m.sun).toEqual({ ...RENDER_DEFAULTS.sun, bias: -0.001 });
    expect(m.day.sun).toEqual([0xffffff, 3]);
    expect(m.day.hemi).toEqual(RENDER_DEFAULTS.day.hemi);
    expect(RENDER_DEFAULTS.sun.bias).toBe(-0.0005); // defaults untouched
  });
});

describe('lamp shadow pool', () => {
  it('device cap: desktop 6 at <= 1024; touch, dense screens or few cores 4 at 512', () => {
    expect(deviceShadowCap({ touch: false, dpr: 1, cores: 8 })).toEqual({ max: 6, mapSize: 1024 });
    expect(deviceShadowCap({ touch: true, dpr: 1, cores: 8 })).toEqual({ max: 4, mapSize: 512 });
    expect(deviceShadowCap({ touch: false, dpr: 3, cores: 8 })).toEqual({ max: 4, mapSize: 512 });
    expect(deviceShadowCap({ touch: false, dpr: 1, cores: 4 })).toEqual({ max: 4, mapSize: 512 });
    expect(deviceShadowCap({})).toEqual({ max: 6, mapSize: 1024 });
  });
  it('slots = min(recipe max, device max, texture units - 9)', () => {
    const desk = { max: 6, mapSize: 1024 }, touch = { max: 4, mapSize: 512 };
    expect(lampShadowSlots(8, desk, 32)).toBe(6);
    expect(lampShadowSlots(8, touch, 32)).toBe(4);
    expect(lampShadowSlots(2, desk, 32)).toBe(2);
    expect(lampShadowSlots(0, desk, 32)).toBe(0);
    expect(lampShadowSlots(6, desk, 16)).toBe(6); // 16 - 9 = 7 texture units left
    expect(lampShadowSlots(6, desk, 12)).toBe(3);
    expect(lampShadowSlots(6, desk, 8)).toBe(0);
    expect(lampShadowSlots(6, desk, undefined)).toBe(6);
  });
  it('lamp map size: the recipe\'s, at most 1024 and the device cap', () => {
    expect(lampMapSize(2048, { mapSize: 1024 })).toBe(1024);
    expect(lampMapSize(1024, { mapSize: 512 })).toBe(512);
    expect(lampMapSize(256, { mapSize: 1024 })).toBe(256);
  });
});

describe('recipeFar', () => {
  it('caps far only down to what the scene needs', () => {
    expect(recipeFar(500, 120, null)).toBe(500);
    expect(recipeFar(500, 120, 260)).toBe(260);
    expect(recipeFar(500, 120, 80)).toBe(120);
    expect(recipeFar(100, 120, 260)).toBe(120);
  });
});

describe('skyLights', () => {
  it('blends day and night by the night factor', () => {
    const r = mergeRender(null);
    const d = skyLights(r, 0), n = skyLights(r, 1), h = skyLights(r, 0.5);
    expect(d.hemiIntensity).toBeCloseTo(0.9);
    expect(n.hemiIntensity).toBeCloseTo(0.14);
    expect(d.sunIntensity).toBeCloseTo(2.6);
    expect(n.sunIntensity).toBe(0);
    expect(h.hemiIntensity).toBeCloseTo(0.52);
    expect(d.hemiSky).toBe(0xc4d6ff);
    expect(d.sunColor).toBe(0xfff0dc);
  });
  it('mixes colours', () => {
    const r = mergeRender({ day: { sun: [0xff0000, 2] }, night: { sun: [0x0000ff, 0] } });
    expect(skyLights(r, 0.5).sunColor).toBe(0x800080);
  });
});

describe('manifest render', () => {
  it('reads fp.render from a root and adds warnings', () => {
    const m = buildManifest(tree([{ name: 'house', extras: { fp: { render: { exposure: 1.1, toneMapping: 'x' } } } }]));
    expect(m.render).toEqual({ exposure: 1.1 });
    expect(m.renderKeys).toBe(1);
    expect(m.warnings.some((w) => /render/.test(w) && /toneMapping/.test(w))).toBe(true);
  });
  it('is null without one', () => {
    expect(buildManifest(tree([{ name: 'a' }])).render).toBeNull();
  });
});
