import { describe, it, expect } from 'vitest';
import { layoutModelVersion, headerVersion, cacheUrl, cacheBase, lruEvict, progressText, readWithProgress } from '../src/model-cache.js';

describe('model cache versions', () => {
  it('versions an uploaded model by its version, size and upload time', () => {
    expect(layoutModelVersion({ version: 'abc', size: 100, uploaded: '2026-01-01T00:00:00Z' })).toBe('abc:100:2026-01-01T00:00:00Z');
    expect(layoutModelVersion({ version: 'abc' })).toBe('abc::');
    expect(layoutModelVersion({ size: 100 })).toBe(null);
    expect(layoutModelVersion(null)).toBe(null);
  });
  it('versions a URL model by ETag, else Last-Modified (with the length)', () => {
    const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
    expect(headerVersion(h({ etag: '"x1"', 'content-length': '10' }))).toBe('etag:"x1"');
    expect(headerVersion(h({ 'last-modified': 'Tue, 06 Oct 2026 10:00:00 GMT', 'content-length': '10' }))).toBe('lm:Tue, 06 Oct 2026 10:00:00 GMT:10');
    expect(headerVersion(h({ 'content-length': '10' }))).toBe(null);
    expect(headerVersion(null)).toBe(null);
  });
  it('keys a cached response by URL + version, never by query tokens of the base', () => {
    expect(cacheUrl('http://h/api/floorplan3d/model/default', 'v1:2:')).toBe('http://h/api/floorplan3d/model/default?fp_v=v1%3A2%3A');
    expect(cacheUrl('http://h/local/house.glb?x=1', 'e')).toBe('http://h/local/house.glb?x=1&fp_v=e');
    expect(cacheBase('http://h/local/house.glb?x=1&fp_v=e')).toBe('http://h/local/house.glb?x=1');
    expect(cacheBase('http://h/api/floorplan3d/model/default?fp_v=v1')).toBe('http://h/api/floorplan3d/model/default');
  });
});

describe('lruEvict', () => {
  const e = (key, size, at) => ({ key, size, at });
  it('evicts the least recently used entries until the total fits', () => {
    expect(lruEvict([e('a', 1, 3), e('b', 1, 1), e('c', 1, 2)], 2)).toEqual(['b']);
    expect(lruEvict([e('a', 1, 3), e('b', 1, 1), e('c', 1, 2)], 1)).toEqual(['b', 'c']);
    expect(lruEvict([e('a', 1, 3)], 5)).toEqual([]);
  });
  it('never evicts the kept key unless it alone is over the cap', () => {
    expect(lruEvict([e('a', 2, 1), e('b', 2, 9)], 3, 'a')).toEqual(['b']);
    expect(lruEvict([e('a', 5, 1), e('b', 1, 9)], 3, 'a')).toEqual(['a']);
  });
});

describe('progressText', () => {
  it('shows MB downloaded of the total', () => {
    expect(progressText(3.2e6, 6.1e6)).toBe('Downloading 3.2 / 6.1 MB');
    expect(progressText(1048576 * 0.5, 0)).toBe('Downloading 0.5 MB');
  });
});

describe('readWithProgress', () => {
  it('streams the body and reports progress', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const body = new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
    const res = new Response(body, { headers: { 'content-length': '3' } });
    const seen = [];
    const buf = await readWithProgress(res, (l, t) => seen.push([l, t]));
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3]);
    expect(seen).toEqual([[2, 3], [3, 3]]);
  });
  it('falls back to arrayBuffer without a stream', async () => {
    const res = { headers: { get: () => null }, body: null, arrayBuffer: async () => new Uint8Array([9]).buffer };
    const buf = await readWithProgress(res, () => {});
    expect([...new Uint8Array(buf)]).toEqual([9]);
  });
});
