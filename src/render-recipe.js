// Render recipe of a model (extras.fp.render on a root node): renderer, camera, sun / lamp shadow and
// day / night light settings the model was designed with. normRender validates (numbers finite, ranges
// clamped, unknown keys ignored, warnings for invalid values); mergeRender fills the rest from the
// card's defaults (the values used before recipes existed).

export const RENDER_DEFAULTS = Object.freeze({
  toneMapping: 'ACESFilmic',
  exposure: 1.25,
  outputColorSpace: 'srgb',
  pixelRatioMax: 1.5,
  anisotropy: 8,
  camera: Object.freeze({ fov: 35, near: 0.3, far: 500 }),
  sun: Object.freeze({ shadowMapSize: 2048, bias: -0.0005, normalBias: 0.02 }),
  lampShadows: Object.freeze({ max: 4, mapSize: 512, bias: -0.004, normalBias: 0, radius: 1 }),
  day: Object.freeze({ hemi: Object.freeze([0xc4d6ff, 0x2a2520, 0.9]), sun: Object.freeze([0xfff0dc, 2.6]) }),
  night: Object.freeze({ hemi: Object.freeze([0xc4d6ff, 0x2a2520, 0.14]), sun: Object.freeze([0xfff0dc, 0]) }),
  glowIntensityPerBrightness: 3,
});

export const TONE_MAPPINGS = ['None', 'Linear', 'Reinhard', 'Cineon', 'ACESFilmic', 'AgX', 'Neutral'];
const COLOR_SPACES = ['srgb', 'srgb-linear'];

// [min, max, kind] per numeric key; kind 'pow2' rounds down to a power of two, 'int' rounds
const NUM = {
  exposure: [0.05, 4], pixelRatioMax: [0.5, 3], anisotropy: [1, 16, 'int'], glowIntensityPerBrightness: [0, 20],
  'camera.fov': [10, 100], 'camera.near': [0.01, 10], 'camera.far': [10, 10000],
  'sun.shadowMapSize': [256, 4096, 'pow2'], 'sun.bias': [-0.01, 0.01], 'sun.normalBias': [0, 0.5],
  'lampShadows.max': [0, 8, 'int'], 'lampShadows.mapSize': [128, 1024, 'pow2'], 'lampShadows.bias': [-0.05, 0.05],
  'lampShadows.normalBias': [0, 0.5], 'lampShadows.radius': [0, 10],
};
const GROUPS = { camera: ['fov', 'near', 'far'], sun: ['shadowMapSize', 'bias', 'normalBias'], lampShadows: ['max', 'mapSize', 'bias', 'normalBias', 'radius'] };
const SKY_MAX = { hemi: 10, sun: 20 };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// '#rrggbb' / 'rrggbb' / 0xrrggbb -> number or null
export function hexColor(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 0xffffff) return v;
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim())) return parseInt(v.trim().replace('#', ''), 16);
  return null;
}

// raw extras.fp.render -> { recipe (valid keys only) | null, warnings, keys (top-level keys kept) }
export function normRender(raw) {
  const warnings = [];
  if (raw === undefined || raw === null) return { recipe: null, warnings, keys: 0 };
  if (!isObj(raw)) return { recipe: null, warnings: ['render: needs an object'], keys: 0 };
  const out = {};
  const num = (path, v) => {
    const [lo, hi, kind] = NUM[path];
    if (typeof v !== 'number' || !Number.isFinite(v)) { warnings.push(`render.${path}: needs a number`); return undefined; }
    let x = v;
    if (kind === 'int') x = Math.round(x);
    if (x < lo || x > hi) { warnings.push(`render.${path}: ${v} out of range ${lo}..${hi}, clamped`); x = Math.min(hi, Math.max(lo, x)); }
    if (kind === 'pow2') x = 2 ** Math.floor(Math.log2(x));
    return x;
  };
  for (const k of ['exposure', 'pixelRatioMax', 'anisotropy', 'glowIntensityPerBrightness']) {
    if (raw[k] === undefined) continue;
    const v = num(k, raw[k]);
    if (v !== undefined) out[k] = v;
  }
  if (raw.toneMapping !== undefined) {
    if (TONE_MAPPINGS.includes(raw.toneMapping)) out.toneMapping = raw.toneMapping;
    else warnings.push(`render.toneMapping: "${raw.toneMapping}" is not one of ${TONE_MAPPINGS.join(', ')}`);
  }
  if (raw.outputColorSpace !== undefined) {
    if (COLOR_SPACES.includes(raw.outputColorSpace)) out.outputColorSpace = raw.outputColorSpace;
    else warnings.push(`render.outputColorSpace: "${raw.outputColorSpace}" is not one of ${COLOR_SPACES.join(', ')}`);
  }
  for (const [g, keys] of Object.entries(GROUPS)) {
    if (raw[g] === undefined) continue;
    if (!isObj(raw[g])) { warnings.push(`render.${g}: needs an object`); continue; }
    const o = {};
    for (const k of keys) {
      if (raw[g][k] === undefined) continue;
      const v = num(`${g}.${k}`, raw[g][k]);
      if (v !== undefined) o[k] = v;
    }
    if (Object.keys(o).length) out[g] = o;
  }
  for (const part of ['day', 'night']) {
    if (raw[part] === undefined) continue;
    if (!isObj(raw[part])) { warnings.push(`render.${part}: needs an object`); continue; }
    const o = {};
    const h = raw[part].hemi, s = raw[part].sun;
    if (h !== undefined) {
      const ok = Array.isArray(h) && h.length === 3 && hexColor(h[0]) !== null && hexColor(h[1]) !== null && Number.isFinite(h[2]);
      if (ok) o.hemi = [hexColor(h[0]), hexColor(h[1]), Math.min(SKY_MAX.hemi, Math.max(0, h[2]))];
      else warnings.push(`render.${part}.hemi: needs [skyColour, groundColour, intensity]`);
    }
    if (s !== undefined) {
      const ok = Array.isArray(s) && s.length === 2 && hexColor(s[0]) !== null && Number.isFinite(s[1]);
      if (ok) o.sun = [hexColor(s[0]), Math.min(SKY_MAX.sun, Math.max(0, s[1]))];
      else warnings.push(`render.${part}.sun: needs [colour, intensity]`);
    }
    if (Object.keys(o).length) out[part] = o;
  }
  const keys = Object.keys(out).length;
  return { recipe: keys ? out : null, warnings, keys };
}

// recipe (normalized) or null -> full settings (defaults for every missing key)
export function mergeRender(recipe) {
  const d = RENDER_DEFAULTS, r = recipe || {};
  const sky = (part) => ({ hemi: [...((r[part] && r[part].hemi) || d[part].hemi)], sun: [...((r[part] && r[part].sun) || d[part].sun)] });
  return {
    toneMapping: r.toneMapping ?? d.toneMapping,
    exposure: r.exposure ?? d.exposure,
    outputColorSpace: r.outputColorSpace ?? d.outputColorSpace,
    pixelRatioMax: r.pixelRatioMax ?? d.pixelRatioMax,
    anisotropy: r.anisotropy ?? d.anisotropy,
    camera: { ...d.camera, ...(r.camera || {}) },
    sun: { ...d.sun, ...(r.sun || {}) },
    lampShadows: { ...d.lampShadows, ...(r.lampShadows || {}) },
    day: sky('day'),
    night: sky('night'),
    glowIntensityPerBrightness: r.glowIntensityPerBrightness ?? d.glowIntensityPerBrightness,
  };
}

// Lamp shadow maps this device affords -> { max, mapSize }: 4 at 512 on touch devices, dense screens
// (dpr > 2) or <= 4 cores, else 6 at up to 1024.
export function deviceShadowCap({ touch = false, dpr = 1, cores = 8 } = {}) {
  return touch || dpr > 2 || (Number.isFinite(cores) && cores <= 4) ? { max: 4, mapSize: 512 } : { max: 6, mapSize: 1024 };
}

// Shadow-casting lamps: min(recipe max, device max, texture units left: maxTextures - 9 for the
// material's own maps, the sun's shadow map and the rest).
export function lampShadowSlots(max, cap, maxTextures) {
  const units = Number.isFinite(maxTextures) ? Math.max(0, maxTextures - 9) : Infinity;
  return Math.max(0, Math.min(max, cap.max, units));
}

// Lamp shadow map size: the recipe's, at most 1024 and the device cap.
export const lampMapSize = (size, cap) => Math.min(size, 1024, cap.mapSize);

// Camera far with the recipe's far as an upper bound that never cuts what the scene needs.
export function recipeFar(dynamicFar, neededFar, cap) {
  if (!Number.isFinite(cap)) return dynamicFar;
  return Math.max(neededFar, Math.min(dynamicFar, cap));
}

const mixHex = (a, b, t) => {
  const c = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return (c(16) << 16) | (c(8) << 8) | c(0);
};

// Day / night blend (night 0..1) of the merged settings -> colours (hex) and intensities before weather.
export function skyLights(render, night) {
  const t = Math.max(0, Math.min(1, Number(night) || 0)), d = render.day, n = render.night;
  return {
    hemiSky: mixHex(d.hemi[0], n.hemi[0], t),
    hemiGround: mixHex(d.hemi[1], n.hemi[1], t),
    hemiIntensity: d.hemi[2] + (n.hemi[2] - d.hemi[2]) * t,
    sunColor: mixHex(d.sun[0], n.sun[0], t),
    sunIntensity: d.sun[1] + (n.sun[1] - d.sun[1]) * t,
  };
}
