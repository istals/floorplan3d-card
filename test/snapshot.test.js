import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { snapshotKey, snapshotSize, SnapshotScheduler, pickSnapshot } from '../src/snapshot.js';

describe('snapshot keys and sizes', () => {
  it('keys by layout, view and mode', () => {
    expect(snapshotKey('default', 'ground', '3d')).toBe('default|ground|3d');
    expect(snapshotKey('default', null, 'top')).toBe('default||top');
  });
  it('fits into 1280 px keeping the aspect', () => {
    expect(snapshotSize(2560, 1000)).toEqual({ w: 1280, h: 500 });
    expect(snapshotSize(800, 1600)).toEqual({ w: 640, h: 1280 });
    expect(snapshotSize(640, 480)).toEqual({ w: 640, h: 480 });
  });
  it('picks the exact key, else the newest of the same layout and mode', () => {
    const list = [
      { key: 'default|a|3d', layout: 'default', mode: '3d', at: 5 },
      { key: 'default|b|3d', layout: 'default', mode: '3d', at: 9 },
      { key: 'default|b|top', layout: 'default', mode: 'top', at: 20 },
      { key: 'other|b|3d', layout: 'other', mode: '3d', at: 30 },
    ];
    expect(pickSnapshot(list, 'default', 'a', '3d').key).toBe('default|a|3d');
    expect(pickSnapshot(list, 'default', 'x', '3d').key).toBe('default|b|3d');
    expect(pickSnapshot(list, 'nope', 'x', '3d')).toBe(null);
  });
});

describe('SnapshotScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('captures 3 s after the last change (debounced)', () => {
    const capture = vi.fn();
    const s = new SnapshotScheduler(capture);
    s.notify();
    vi.advanceTimersByTime(2000);
    s.notify(); // camera moved again
    vi.advanceTimersByTime(2900);
    expect(capture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('captures at most once per 30 s', () => {
    const capture = vi.fn();
    const s = new SnapshotScheduler(capture);
    s.notify();
    vi.advanceTimersByTime(3000);
    expect(capture).toHaveBeenCalledTimes(1);
    s.notify();
    vi.advanceTimersByTime(3000); // 3 s after the first capture: waits until 30 s after it
    expect(capture).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(26000); // t = 32 s
    expect(capture).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(capture).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60000);
    expect(capture).toHaveBeenCalledTimes(2); // nothing changed since
  });

  it('cancel drops a pending capture', () => {
    const capture = vi.fn();
    const s = new SnapshotScheduler(capture, { debounce: 100, minInterval: 0 });
    s.notify();
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(capture).not.toHaveBeenCalled();
  });
});
