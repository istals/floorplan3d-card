import { describe, it, expect, vi } from 'vitest';
import { GroundCache, GROUND_CELL } from '../src/surface.js';
import { outdoorShown } from '../src/views.js';

describe('GroundCache', () => {
  it('casts once per 0.5 m cell, at the cell centre', () => {
    const c = new GroundCache();
    const ray = vi.fn((x, y) => ({ y: x + y, level: 'ext' }));
    expect(GROUND_CELL).toBe(0.5);
    const a = c.get(1.1, 2.2, 'k', ray);
    expect(ray).toHaveBeenCalledWith(1.25, 2.25);
    expect(a).toEqual({ y: 3.5, level: 'ext' });
    c.get(1.4, 2.01, 'k', ray);
    expect(ray).toHaveBeenCalledTimes(1);
    c.get(1.6, 2.2, 'k', ray);
    expect(ray).toHaveBeenCalledTimes(2);
  });

  it('negative coordinates fall in their own cells', () => {
    const c = new GroundCache();
    const ray = vi.fn(() => null);
    c.get(-0.1, -0.1, 'k', ray);
    expect(ray).toHaveBeenCalledWith(-0.25, -0.25);
  });

  it('remembers misses (null) too', () => {
    const c = new GroundCache();
    const ray = vi.fn(() => null);
    expect(c.get(0, 0, 'k', ray)).toBeNull();
    expect(c.get(0.1, 0.1, 'k', ray)).toBeNull();
    expect(ray).toHaveBeenCalledTimes(1);
  });

  it('a new placement key or clear() starts over', () => {
    const c = new GroundCache();
    const ray = vi.fn(() => ({ y: 0 }));
    c.get(0, 0, 'a', ray);
    c.get(0, 0, 'b', ray);
    expect(ray).toHaveBeenCalledTimes(2);
    c.clear();
    c.get(0, 0, 'b', ray);
    expect(ray).toHaveBeenCalledTimes(3);
  });
});

describe('outdoorShown', () => {
  const levels = [{ id: 'level0', role: 'storey', node: { visible: true } }, { id: 'exterior', role: 'exterior', node: { visible: false } }];
  const index = { nodes: [{ levelId: 'level0' }, { levelId: 'exterior' }, { levelId: 'exterior' }] };

  it('null without exterior levels or a lawn level (the floor rule applies)', () => {
    expect(outdoorShown([{ id: 'a', role: 'storey', node: { visible: true } }])).toBeNull();
    expect(outdoorShown(null)).toBeNull();
  });

  it('per-node flags: any shown node on an exterior level', () => {
    expect(outdoorShown(levels, index, [true, false, false])).toBe(false);
    expect(outdoorShown(levels, index, [false, false, true])).toBe(true);
  });

  it('no flags: the level nodes', () => {
    expect(outdoorShown(levels)).toBe(false);
    expect(outdoorShown([levels[0], { ...levels[1], node: { visible: true } }])).toBe(true);
  });

  it('the level holding the lawn counts too', () => {
    const storeys = [levels[0]];
    expect(outdoorShown(storeys, null, null, 'level0')).toBe(true);
    expect(outdoorShown(storeys, index, [false, true, true], 'level0')).toBe(false);
  });
});
