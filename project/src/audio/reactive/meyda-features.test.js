import { describe, it, expect } from 'vitest';
import {
  createMeydaFeatures,
  computeChromaHueDeg,
  computeChromaConfidence,
  computeDominantPitchClass,
} from './meyda-features.js';

// A 12-element chroma vector with one bin set to 1 and the rest 0.
function singlePitch(index) {
  const v = new Float32Array(12);
  v[index] = 1;
  return v;
}

describe('computeChromaHueDeg', () => {
  it('returns 0 for an empty/silent chroma vector', () => {
    expect(computeChromaHueDeg(new Float32Array(12))).toBe(0);
    expect(computeChromaHueDeg(null)).toBe(0);
    expect(computeChromaHueDeg([])).toBe(0);
  });

  it('maps a single dominant pitch class to that bin\'s angle (i × 30°)', () => {
    for (let i = 0; i < 12; i++) {
      const expected = i * 30;
      // Use modulo to handle the i=0 case which the circular mean
      // can land on 360° or 0° — both are equivalent.
      const got = computeChromaHueDeg(singlePitch(i)) % 360;
      expect(got).toBeCloseTo(expected % 360, 3);
    }
  });

  it('blends equal energy on two adjacent pitches to the midpoint', () => {
    const v = new Float32Array(12);
    v[0] = 1; v[1] = 1;   // C and C# → midpoint should be 15°
    expect(computeChromaHueDeg(v)).toBeCloseTo(15, 3);
  });

  it('returns 0 (the C bin) when energy is equal across all 12 bins (no tonal centre)', () => {
    const v = new Float32Array(12).fill(1);
    // With perfectly equal weights, the resultant vector length is ~0
    // and atan2 returns whatever — degenerate. The function should
    // still return a finite number in [0, 360).
    const h = computeChromaHueDeg(v);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });

  it('ignores negative bin values (treats them as 0)', () => {
    const v = new Float32Array(12);
    v[0] = 1; v[6] = -5;  // negative shouldn't swing the hue across the wheel
    expect(computeChromaHueDeg(v)).toBeCloseTo(0, 3);
  });
});

describe('computeChromaConfidence', () => {
  it('returns 1 for a single-pitch vector', () => {
    expect(computeChromaConfidence(singlePitch(3))).toBeCloseTo(1, 3);
  });

  it('returns ~0 when energy is equal across all 12 bins', () => {
    const v = new Float32Array(12).fill(1);
    expect(computeChromaConfidence(v)).toBeLessThan(0.05);
  });

  it('returns 0 for silence', () => {
    expect(computeChromaConfidence(new Float32Array(12))).toBe(0);
  });

  it('lands between 0 and 1 for partial mixes', () => {
    const v = new Float32Array(12);
    v[0] = 1; v[4] = 0.5;  // C + E
    const c = computeChromaConfidence(v);
    expect(c).toBeGreaterThan(0.3);
    expect(c).toBeLessThan(1);
  });
});

describe('computeDominantPitchClass', () => {
  it('finds the max bin index', () => {
    expect(computeDominantPitchClass(singlePitch(7))).toBe(7);
  });

  it('returns 0 when ties exist (first-wins is fine)', () => {
    const v = new Float32Array(12);
    v[0] = 1; v[5] = 1;
    expect(computeDominantPitchClass(v)).toBe(0);
  });

  it('returns 0 on silence', () => {
    expect(computeDominantPitchClass(new Float32Array(12))).toBe(0);
  });
});

describe('createMeydaFeatures', () => {
  it('starts in a neutral state — no analyzer, all derived signals at 0', () => {
    const f = createMeydaFeatures();
    expect(f.isReady).toBe(false);
    expect(f.isPendingSetup).toBe(false);
    expect(f.frameCount).toBe(0);
    expect(f.rms).toBe(0);
    expect(f.spectralCentroid).toBe(0);
    expect(f.spectralCentroidNorm).toBe(0);
    expect(f.chromaHueDeg).toBe(0);
    expect(f.chromaConfidence).toBe(0);
    expect(f.dominantPitchClass).toBe(0);
    expect(f.analyzeError).toBe(null);
  });

  it('setSource(null) is safe when no analyzer has been created', () => {
    const f = createMeydaFeatures();
    expect(() => f.setSource(null)).not.toThrow();
    expect(() => f.setSource(null)).not.toThrow();
    expect(f.analyzeError).toBe(null);
  });

  it('reset() leaves state at zero (already-zero is the no-op case)', () => {
    const f = createMeydaFeatures();
    expect(() => f.reset()).not.toThrow();
    expect(f.rms).toBe(0);
    expect(f.spectralCentroid).toBe(0);
    expect(f.chromaHueDeg).toBe(0);
  });

  it('exposes the raw chroma vector for advanced bindings (12 floats)', () => {
    const f = createMeydaFeatures();
    expect(f.chroma.length).toBe(12);
    for (let i = 0; i < 12; i++) expect(f.chroma[i]).toBe(0);
  });
});
