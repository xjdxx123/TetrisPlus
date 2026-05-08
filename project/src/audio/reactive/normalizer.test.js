import { describe, it, expect } from 'vitest';
import { createNormalizer } from './normalizer.js';

describe('normalizer', () => {
  it('returns 0 below the floor', () => {
    const n = createNormalizer({ decay: 0.99, floor: 0.05 });
    expect(n.normalize(0.001)).toBe(0);
  });

  it('saturates at 1 when input matches the running peak', () => {
    const n = createNormalizer({ decay: 0.99 });
    expect(n.normalize(0.5)).toBe(1);
    // Steady input: peak stays at the input level (max(raw, peak*decay) = raw),
    // so output stays at 1.0 — the AGC is "calibrated."
    expect(n.normalize(0.5)).toBe(1);
    expect(n.normalize(0.5)).toBe(1);
  });

  it('peak rises instantly to new highs', () => {
    const n = createNormalizer({ decay: 0.99 });
    n.normalize(0.3);
    n.normalize(0.6);
    expect(n.peak).toBeGreaterThanOrEqual(0.6);
  });

  it('peak decays when input is consistently lower', () => {
    const n = createNormalizer({ decay: 0.5 });  // very fast decay for the test
    n.normalize(1.0);
    expect(n.peak).toBeCloseTo(1.0, 3);
    for (let i = 0; i < 5; i++) n.normalize(0.1);
    // After several lower-input frames, peak should have fallen well below 1.
    expect(n.peak).toBeLessThan(0.5);
  });

  it('normalized output is always clamped to [0,1]', () => {
    const n = createNormalizer({ decay: 0.99 });
    for (let i = 0; i < 100; i++) {
      const v = n.normalize(Math.random());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('reset clears the running peak', () => {
    const n = createNormalizer();
    n.normalize(0.8);
    n.reset();
    expect(n.peak).toBe(0);
  });
});
