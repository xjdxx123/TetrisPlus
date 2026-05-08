import { describe, it, expect } from 'vitest';
import {
  LEVEL_HUE_BANDS,
  hueForLevel,
  pickFlashHue,
} from './nebula-progression.js';

describe('nebula progression — hueForLevel', () => {
  it('returns the first band for levels at or below the lowest threshold', () => {
    expect(hueForLevel(1)).toBe(LEVEL_HUE_BANDS[0].hue);
    expect(hueForLevel(0)).toBe(LEVEL_HUE_BANDS[0].hue);
    expect(hueForLevel(-5)).toBe(LEVEL_HUE_BANDS[0].hue);
  });

  it('crosses into the next band exactly at the threshold (inclusive)', () => {
    for (let i = 0; i < LEVEL_HUE_BANDS.length; i++) {
      const band = LEVEL_HUE_BANDS[i];
      expect(hueForLevel(band.fromLevel)).toBe(band.hue);
      if (i > 0) {
        expect(hueForLevel(band.fromLevel - 1)).toBe(LEVEL_HUE_BANDS[i - 1].hue);
      }
    }
  });

  it('clamps to the last band for very high levels', () => {
    const last = LEVEL_HUE_BANDS[LEVEL_HUE_BANDS.length - 1].hue;
    expect(hueForLevel(999)).toBe(last);
  });

  it('all band hues are in [0, 360)', () => {
    for (const band of LEVEL_HUE_BANDS) {
      expect(band.hue).toBeGreaterThanOrEqual(0);
      expect(band.hue).toBeLessThan(360);
    }
  });
});

describe('nebula progression — pickFlashHue', () => {
  // Wrap-around hue distance helper for the assertions.
  function hueDelta(a, b) {
    const d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  }

  it('always returns a hue 60..180° away from the resting hue', () => {
    for (let i = 0; i < 100; i++) {
      const flash = pickFlashHue(200);
      const d = hueDelta(flash, 200);
      expect(d).toBeGreaterThanOrEqual(60 - 1e-6);
      expect(d).toBeLessThanOrEqual(180 + 1e-6);
    }
  });

  it('returns a hue in [0, 360)', () => {
    for (let i = 0; i < 50; i++) {
      const flash = pickFlashHue(280);
      expect(flash).toBeGreaterThanOrEqual(0);
      expect(flash).toBeLessThan(360);
    }
  });

  it('honours the alsoExclude argument (≥ 30° away from it)', () => {
    for (let i = 0; i < 100; i++) {
      const flash = pickFlashHue(200, 280);
      expect(hueDelta(flash, 200)).toBeGreaterThanOrEqual(60 - 1e-6);
      expect(hueDelta(flash, 280)).toBeGreaterThanOrEqual(30 - 1e-6);
    }
  });

  it('is deterministic with a seeded rng', () => {
    let n = 0;
    const seq = [0.13, 0.42, 0.71, 0.91, 0.05];
    const rng = () => seq[n++ % seq.length];
    const a = pickFlashHue(200, null, rng);
    n = 0;
    const b = pickFlashHue(200, null, rng);
    expect(a).toBe(b);
  });

  it('handles wrap-around correctly for hues near 0 / 360', () => {
    // Resting near 0; distance is wrap-around symmetric.
    for (let i = 0; i < 50; i++) {
      const flash = pickFlashHue(5);
      const d = hueDelta(flash, 5);
      expect(d).toBeGreaterThanOrEqual(60 - 1e-6);
      expect(d).toBeLessThanOrEqual(180 + 1e-6);
    }
    // Resting near 360.
    for (let i = 0; i < 50; i++) {
      const flash = pickFlashHue(355);
      const d = hueDelta(flash, 355);
      expect(d).toBeGreaterThanOrEqual(60 - 1e-6);
      expect(d).toBeLessThanOrEqual(180 + 1e-6);
    }
  });
});
