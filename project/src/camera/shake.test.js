import { describe, it, expect } from 'vitest';
import { createShake } from './shake.js';

describe('shake', () => {
  it('starts with zero intensity and zero offset', () => {
    const s = createShake();
    expect(s.intensity).toBe(0);
    expect(s.offset.length()).toBe(0);
  });

  it('impulse() takes max — does not lower intensity', () => {
    const s = createShake();
    s.impulse(0.5);
    expect(s.intensity).toBeCloseTo(0.5);
    s.impulse(0.2);
    expect(s.intensity).toBeCloseTo(0.5);
    s.impulse(0.9);
    expect(s.intensity).toBeCloseTo(0.9);
  });

  it('setForce() can lower intensity, capped at maxIntensity', () => {
    const s = createShake({ maxIntensity: 1.6 });
    s.impulse(1.0);
    s.setForce(0.3);
    expect(s.intensity).toBeCloseTo(0.3);
    s.setForce(99);
    expect(s.intensity).toBeCloseTo(1.6);
  });

  it('update produces non-zero offset while intensity is positive', () => {
    const s = createShake();
    s.impulse(1.0);
    s.update(1 / 60, 1 / 60);
    expect(s.offset.length()).toBeGreaterThan(0);
  });

  it('update decays intensity with dtGame, not dtRender', () => {
    const s = createShake({ decayBase: 0.001 });
    s.impulse(1.0);
    // Real-time advances 1s, but game time is paused (dtGame = 0).
    s.update(1.0, 0);
    expect(s.intensity).toBeCloseTo(1.0); // no decay during pause
    // Now game time advances.
    s.update(0, 1.0);
    expect(s.intensity).toBeCloseTo(0.001, 4); // 1 * 0.001^1
  });

  it('update zeros offset when intensity is below threshold', () => {
    const s = createShake();
    s.update(1 / 60, 1 / 60);
    expect(s.offset.length()).toBe(0);
  });
});
