import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkGlb } from '../tools/check-model.mjs';

// minimal GLB: JSON chunk (+ optional BIN chunk)
function glb(json, bin = null) {
  const pad = (b, c) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)]);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const chunks = [Buffer.concat([u32(j.length), Buffer.from('JSON'), j])];
  if (bin) { const b = pad(bin, 0); chunks.push(Buffer.concat([u32(b.length), Buffer.from('BIN\0'), b])); }
  const body = Buffer.concat(chunks);
  return Buffer.concat([Buffer.from('glTF'), u32(2), u32(12 + body.length), body]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
const fp = (o) => ({ fp: o });
const sq = [[0, 0], [4, 0], [4, 3]];

// a mesh with POSITION bounds [-100..100] x [0..0] x [-100..100]
const bigPlane = {
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [-100, 0, -100], max: [100, 0, 100] }],
};

describe('checkGlb', () => {
  it('passes a well-tagged model and summarises it', () => {
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 2] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground', order: 0, elevation: 0, height: 2.7 }), children: [1] },
      { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq }) },
      { name: 'roof', extras: fp({ kind: 'level', id: 'roof', role: 'roof' }) },
    ] }));
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ levels: 2, rooms: 1, zones: 0, objects: {} });
    expect(r.levels[0]).toEqual({ id: 'ground', role: 'storey', order: 0, elevation: 0 });
  });

  it('validates the render recipe (fp.render)', () => {
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [
      { name: 'house', extras: fp({ render: { exposure: 9, camera: { fov: 40 }, toneMapping: 'Nope', bogus: 1 } }), children: [1] },
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }) },
    ] }));
    expect(r.ok).toBe(true);
    expect(r.render).toEqual({ keys: 2, recipe: { exposure: 4, camera: { fov: 40 } } });
    expect(r.warnings).toContain('render.exposure: 9 out of range 0.05..4, clamped');
    expect(r.warnings.some((w) => /render.toneMapping/.test(w))).toBe(true);
  });

  it('warns about a spot target shared by a group or too far from the lamp', () => {
    const up = (id, x) => ({ name: id, translation: [x, 0, 0], extras: fp({ kind: 'object', id, type: 'light', group: 'ups', hints: { beam: 'up', target: [6, 0.5, 0] } }) });
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 3] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), children: [1, 2] },
      up('up_1', 0), up('up_2', 2),
      { name: 'roof', extras: fp({ kind: 'level', id: 'roof', role: 'roof' }) },
    ] }));
    expect(r.warnings).toContain('spot target looks wrong (shared / too far): up_1, up_2');
  });

  it('warns about huge meshes inside storeys but not inside exterior', () => {
    const r = checkGlb(glb({ ...bigPlane, asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 2] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), children: [1] },
      { name: 'plane', mesh: 0 },
      { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [3] },
      { name: 'lawn', mesh: 0 },
    ] }));
    expect(r.warnings.filter((w) => /larger than 60 m/.test(w))).toEqual([expect.stringMatching(/ground\/plane/)]);
  });

  it('applies node scale when measuring meshes', () => {
    const r = checkGlb(glb({ ...bigPlane, asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), scale: [0.01, 0.01, 0.01], children: [1] },
      { name: 'plane', mesh: 0 },
    ] }));
    expect(r.warnings.join('\n')).not.toMatch(/larger than 60 m/);
  });

  it('reports errors, untagged models and missing roles', () => {
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [
      { name: 'a', extras: fp({ kind: 'level', id: 'dup' }) }, { name: 'b', extras: fp({ kind: 'level', id: 'dup' }) },
    ] }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/duplicate level id "dup"/);
    expect(r.warnings.join('\n')).toMatch(/no level with role "exterior"/);
    expect(r.warnings.join('\n')).toMatch(/no level with role "roof"/);
    const u = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Mesh' }] }));
    expect(u.warnings.join('\n')).toMatch(/no fp tags/);
  });

  it('measures embedded PNG textures', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(4096, 16);
    png.writeUInt32BE(1024, 20);
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [],
      buffers: [{ byteLength: 24 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }],
      images: [{ bufferView: 0, mimeType: 'image/png', name: 'grass' }] }, png));
    expect(r.warnings.join('\n')).toMatch(/texture "grass" is 4096 × 1024/);
  });

  it('rejects a file that is not a GLB', () => {
    expect(checkGlb(Buffer.from('hello world, not a model'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a binary glTF/)] });
  });

  it('handles missing child nodes without throwing', () => {
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [
      { name: 'root', extras: fp({ kind: 'level', id: 'ground' }), children: [5] },
    ] }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /invalid node structure/.test(e))).toBe(true);
  });

  it('does not crash on malformed mesh data (missing meshes array)', () => {
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), children: [1] },
      { name: 'm', mesh: 3 },
    ] }));
    expect(r).toHaveProperty('ok');
    expect(() => checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), children: [1] },
      { name: 'm', mesh: 3 },
    ] }))).not.toThrow();
  });
});

describe('CLI', () => {
  it('prints a report and exits 1 on errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
    const file = path.join(dir, 'bad.glb');
    fs.writeFileSync(file, glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [
      { name: 'a', extras: fp({ kind: 'level', id: 'x' }) }, { name: 'b', extras: fp({ kind: 'level', id: 'x' }) }] }));
    let code = 0, out = '';
    try { execFileSync('node', ['tools/check-model.mjs', file], { encoding: 'utf8' }); } catch (e) { code = e.status; out = e.stdout; }
    expect(code).toBe(1);
    expect(out).toMatch(/ERROR .*duplicate level id "x"/);
    const json = JSON.parse(execFileSync('node', ['tools/check-model.mjs', file, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString() || '{}');
    expect(json.ok).toBe(false);
  });

  it('exits 1 on unreadable file in text mode', () => {
    let code = 0, out = '';
    try { execFileSync('node', ['tools/check-model.mjs', '/nonexistent/path.glb'], { encoding: 'utf8' }); } catch (e) { code = e.status; out = e.stdout; }
    expect(code).toBe(1);
    expect(out).toMatch(/ERROR .*cannot read.*\/nonexistent\/path\.glb/);
  });

  it('exits 0 with JSON ok:false on unreadable file in JSON mode', () => {
    let code;
    let out;
    try {
      out = execFileSync('node', ['tools/check-model.mjs', '/nonexistent/path.glb', '--json'], { encoding: 'utf8' });
      code = 0;
    } catch (e) {
      code = e.status;
      out = e.stdout || '';
    }
    expect(code).toBe(0);
    const json = JSON.parse(out || '{}');
    expect(json.ok).toBe(false);
    expect(json.errors.some((e) => /cannot read/.test(e))).toBe(true);
  });
});
