import { describe, it, expect } from 'vitest';
import { createEnvelope } from './envelope.js';

describe('envelope', () => {
  it('starts at zero', () => {
    const e = createEnvelope();
    expect(e.value).toBe(0);
  });

  it('rises toward raw on attack with the configured time constant', () => {
    const e = createEnvelope({ tauAttackMs: 10, tauReleaseMs: 100 });
    // After one τ, follower reaches ~63% of the step.
    e.update(1.0, 10);
    expect(e.value).toBeGreaterThan(0.6);
    expect(e.value).toBeLessThan(0.7);
  });

  it('falls toward raw on release with the slower time constant', () => {
    const e = createEnvelope({ tauAttackMs: 10, tauReleaseMs: 100 });
    // Saturate first.
    for (let i = 0; i < 100; i++) e.update(1.0, 10);
    expect(e.value).toBeCloseTo(1.0, 3);
    // Now drop input to zero. After 100ms (one release τ), should be ~0.37.
    e.update(0.0, 100);
    expect(e.value).toBeGreaterThan(0.3);
    expect(e.value).toBeLessThan(0.5);
  });

  it('release is slower than attack — asymmetry preserved', () => {
    const fast = createEnvelope({ tauAttackMs: 10, tauReleaseMs: 100 });
    const sym  = createEnvelope({ tauAttackMs: 100, tauReleaseMs: 100 });
    fast.update(1.0, 10);
    sym.update(1.0, 10);
    // Fast attack should reach a much higher value at 10ms in.
    expect(fast.value).toBeGreaterThan(sym.value * 5);
  });

  it('reset returns to a known value', () => {
    const e = createEnvelope();
    for (let i = 0; i < 50; i++) e.update(1.0, 10);
    e.reset(0);
    expect(e.value).toBe(0);
    e.reset(0.4);
    expect(e.value).toBe(0.4);
  });
});
