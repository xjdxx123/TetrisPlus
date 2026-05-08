import { describe, it, expect } from 'vitest';
import { createOnsetDetector } from './onset.js';

const FRAME_MS = 16.67; // 60fps

// Drive a detector through a flux sequence; return the indices at which it fired.
function runSequence(det, fluxes, frameMs = FRAME_MS) {
  const fires = [];
  for (let i = 0; i < fluxes.length; i++) {
    const r = det.update(fluxes[i], frameMs);
    if (r.fired) fires.push({ i, strength: r.strength, threshold: r.threshold });
  }
  return fires;
}

describe('createOnsetDetector', () => {
  it('does not fire during warmup (first windowSize frames)', () => {
    const det = createOnsetDetector({ windowSize: 8 });
    // A clear spike on frame 3 — too early, warmup not done.
    const fluxes = [0, 0, 0, 0.5, 0, 0, 0, 0];
    const fires = runSequence(det, fluxes);
    expect(fires).toHaveLength(0);
    expect(det.warmupComplete).toBe(true); // warmup completes after 8 frames regardless
  });

  it('fires once on a clear spike after warmup', () => {
    const det = createOnsetDetector({ windowSize: 8, refractoryMs: 60 });
    // 8 zero frames to warm up, then one big spike.
    const fluxes = [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0];
    const fires = runSequence(det, fluxes);
    expect(fires).toHaveLength(1);
    expect(fires[0].i).toBe(8);
    expect(fires[0].strength).toBeGreaterThan(0);
    expect(fires[0].strength).toBeLessThanOrEqual(1);
  });

  it('does not double-fire while flux stays above threshold', () => {
    const det = createOnsetDetector({ windowSize: 8 });
    const fluxes = [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.6, 0.6, 0.6];
    const fires = runSequence(det, fluxes);
    expect(fires).toHaveLength(1);
    expect(fires[0].i).toBe(8);
  });

  it('fires twice on two distinct spikes separated by a dip', () => {
    const det = createOnsetDetector({ windowSize: 8, refractoryMs: 30 });
    // Spike at 8, fall to 0, spike again at 12. 4 frames × 16.67ms ≈ 66ms — past refractory.
    const fluxes = [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0.6];
    const fires = runSequence(det, fluxes);
    expect(fires).toHaveLength(2);
    expect(fires[0].i).toBe(8);
    expect(fires[1].i).toBe(12);
  });

  it('refractory window suppresses back-to-back fires', () => {
    const det = createOnsetDetector({ windowSize: 8, refractoryMs: 200 });
    // Two spikes one frame apart with a one-frame dip — second is inside refractory.
    const fluxes = [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0.6];
    const fires = runSequence(det, fluxes);
    // Fires once on the first spike; the second spike's rising edge is inside
    // refractory so it's suppressed.
    expect(fires).toHaveLength(1);
    expect(fires[0].i).toBe(8);
  });

  it('adaptive threshold suppresses onsets in noisy passages', () => {
    const det = createOnsetDetector({ windowSize: 8, thresholdGain: 1.5, thresholdOffset: 0.02 });
    // Sustained noise at 0.4 with no real transients above it.
    const noisy = new Array(40).fill(0).map((_, i) => 0.4 + (i % 3) * 0.01);
    const fires = runSequence(det, noisy);
    // After warmup, the median is ~0.41 → threshold ~0.63. The 0.42 peaks
    // never cross. Allow a single warmup-edge fire on frame 8 since the
    // window is initially filled with zeros — the median pivot starts low.
    expect(fires.length).toBeLessThanOrEqual(1);
  });

  it('strength scales with relative excess above threshold (clamped)', () => {
    const det = createOnsetDetector({ windowSize: 8, thresholdOffset: 0.02 });
    // Quiet baseline so threshold ≈ 0.02; a flux of 0.5 reads near max strength.
    const fluxes = [0, 0, 0, 0, 0, 0, 0, 0, 0.5];
    const fires = runSequence(det, fluxes);
    expect(fires).toHaveLength(1);
    expect(fires[0].strength).toBeCloseTo(1, 1);
  });

  it('strength reads modest for flux just above threshold', () => {
    const det = createOnsetDetector({ windowSize: 4, thresholdGain: 1.0, thresholdOffset: 0 });
    // Build a baseline at 0.4 then a small spike at 0.5 — 25% over threshold.
    const fluxes = [0.4, 0.4, 0.4, 0.4, 0.5];
    const fires = runSequence(det, fluxes);
    expect(fires).toHaveLength(1);
    expect(fires[0].strength).toBeGreaterThan(0);
    expect(fires[0].strength).toBeLessThan(0.5);
  });

  it('reset() clears warmup, fire-history, and window', () => {
    const det = createOnsetDetector({ windowSize: 4 });
    // Warm up + fire.
    runSequence(det, [0, 0, 0, 0, 0.6]);
    expect(det.warmupComplete).toBe(true);
    det.reset();
    expect(det.warmupComplete).toBe(false);
    // After reset, an immediate spike during warmup must not fire.
    const fires = runSequence(det, [0, 0.6]);
    expect(fires).toHaveLength(0);
  });

  it('throws on invalid windowSize', () => {
    expect(() => createOnsetDetector({ windowSize: 0 })).toThrow();
    expect(() => createOnsetDetector({ windowSize: 1 })).toThrow();
  });
});
