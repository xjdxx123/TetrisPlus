import { describe, it, expect } from 'vitest';
import { createBands } from './bands.js';

describe('bands', () => {
  it('default ranges include the 6 named bands', () => {
    const b = createBands();
    expect(b.bandNames).toEqual(['sub', 'bass', 'lowMid', 'mid', 'highMid', 'air']);
  });

  it('integrate is a no-op until bound to fftSize/sampleRate', () => {
    const b = createBands();
    expect(b.isBound).toBe(false);
    const result = b.integrate(new Uint8Array(512));
    // Should silently return the (zeroed) values without throwing.
    for (const name of b.bandNames) expect(result[name]).toBe(0);
  });

  it('integrates a flat-spectrum sample as ~equal across bands', () => {
    const b = createBands();
    b.bind(1024, 44100);
    // Float32Array of all 0.5 (the analyser produces normalized [0,1]).
    const flat = new Float32Array(512);
    flat.fill(0.5);
    const v = b.integrate(flat);
    for (const name of b.bandNames) {
      expect(v[name]).toBeCloseTo(0.5, 5);
    }
  });

  it('integrates a bass-only impulse into the bass band only', () => {
    const b = createBands();
    b.bind(1024, 44100);
    const bins = new Float32Array(512);
    // Bin width @ 44100/1024 ≈ 43Hz. A bin near 100Hz is bin ~2.
    bins[2] = 1.0;
    bins[3] = 1.0;
    const v = b.integrate(bins);
    expect(v.bass).toBeGreaterThan(v.air);
    expect(v.bass).toBeGreaterThan(v.mid);
  });

  it('integrates an air-only impulse into the air band only', () => {
    const b = createBands();
    b.bind(1024, 44100);
    const bins = new Float32Array(512);
    // Bin width @ 44100/1024 ≈ 43Hz. 8kHz = bin ~186.
    for (let i = 180; i < 200; i++) bins[i] = 1.0;
    const v = b.integrate(bins);
    expect(v.air).toBeGreaterThan(v.bass);
    expect(v.air).toBeGreaterThan(v.mid);
  });
});
