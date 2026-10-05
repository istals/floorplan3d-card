// @vitest-environment jsdom
// Live map camera timer across disconnect / reconnect (a wall tablet switching dashboard views).
import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/floorplan3d-card.js';

const proto = customElements.get('floorplan3d-card').prototype;

function fake(connected) {
  const o = Object.create(proto);
  Object.defineProperty(o, 'isConnected', { value: connected, writable: true });
  o._refreshMapOverlay = vi.fn();
  return o;
}

describe('_setCameraTimer', () => {
  afterEach(() => vi.useRealTimers());
  it('while disconnected counts as 0 s, so a later reconnect can start the interval', () => {
    vi.useFakeTimers();
    const c = fake(false);
    c._setCameraTimer(10); // e.g. model load .then finishing after the disconnect
    expect(c._cameraTimer).toBeNull();
    expect(c._cameraTimerSec).toBe(0);
    c.isConnected = true;
    c._setCameraTimer(10); // reconnect -> _refreshMapOverlay
    expect(c._cameraTimer).not.toBeNull();
    vi.advanceTimersByTime(10000);
    expect(c._refreshMapOverlay).toHaveBeenCalledTimes(1);
    c._setCameraTimer(0);
  });
  it('the image timer behaves the same', () => {
    vi.useFakeTimers();
    const c = fake(false);
    c._detectMower = vi.fn();
    c._setImageTimer(5);
    expect(c._imageTimer).toBeNull();
    c.isConnected = true;
    c._setImageTimer(5);
    vi.advanceTimersByTime(5000);
    expect(c._detectMower).toHaveBeenCalledTimes(1);
    c._setImageTimer(0);
  });
});
