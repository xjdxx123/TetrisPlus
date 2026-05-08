import { describe, it, expect } from 'vitest';
import { createBreathe } from './breathe.js';

const fakeCamera = (fov = 38) => {
  const c = { fov, updateProjectionMatrix() { c._updated = (c._updated || 0) + 1; } };
  return c;
};

describe('breathe', () => {
  it('captures the camera base FOV on first update', () => {
    const b = createBreathe({ amplitudeDeg: 0.5, periodSec: 10 });
    const cam = fakeCamera(38);
    b.update(cam, 0);
    expect(b.baseFov).toBe(38);
  });

  it('returns to base FOV at integer multiples of the period', () => {
    const b = createBreathe({ amplitudeDeg: 0.5, periodSec: 10 });
    const cam = fakeCamera(38);
    b.update(cam, 0);
    expect(cam.fov).toBeCloseTo(38, 5);
    b.update(cam, 10);   // one full period
    expect(cam.fov).toBeCloseTo(38, 5);
    b.update(cam, 20);
    expect(cam.fov).toBeCloseTo(38, 5);
  });

  it('peaks at +amplitude at quarter-period', () => {
    const b = createBreathe({ amplitudeDeg: 0.5, periodSec: 10 });
    const cam = fakeCamera(38);
    b.update(cam, 2.5);
    expect(cam.fov).toBeCloseTo(38.5, 5);
  });

  it('intensity multiplier scales the deflection', () => {
    const b = createBreathe({ amplitudeDeg: 1.0, periodSec: 10 });
    const cam = fakeCamera(38);
    b.setIntensity(0.5);
    b.update(cam, 2.5);
    expect(cam.fov).toBeCloseTo(38.5, 5); // 1.0 * 0.5 = 0.5
  });

  it('updateProjectionMatrix is called on every update', () => {
    const b = createBreathe();
    const cam = fakeCamera(38);
    b.update(cam, 0);
    b.update(cam, 1);
    b.update(cam, 2);
    expect(cam._updated).toBe(3);
  });
});
