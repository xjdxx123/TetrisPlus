import { describe, it, expect } from 'vitest';
import { createLiveBeatTracker } from './live-beat-tracker.js';

// Minimal stand-in for the FeatureBus surface the tracker touches.
// `totalSec` is the monotonic clock the tracker uses for kick times and
// anticipation projection. `onsets.on('kick', fn)` collects subscribers we
// fire manually from the test driver.
function makeFakeFeature() {
  const subs = new Set();
  return {
    totalSec: 0,
    onsets: {
      on(name, fn) {
        if (name !== 'kick') return () => {};
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
    fireKick(strength = 1) {
      for (const fn of [...subs]) fn(strength);
    },
  };
}

describe('createLiveBeatTracker', () => {
  it('throws without a FeatureBus', () => {
    expect(() => createLiveBeatTracker({})).toThrow();
    expect(() => createLiveBeatTracker({ feature: {} })).toThrow();
  });

  it('starts idle — no BPM, anticipation = 0, phase = 0', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    expect(t.isAnalyzed).toBe(false);
    expect(t.isAnalyzing).toBe(false);
    expect(t.bpm).toBe(0);
    expect(t.bpmSource).toBe('none');
    expect(t.anticipation).toBe(0);
    expect(t.phase).toBe(0);
    expect(t.historyCount).toBe(0);
    expect(t.analyzeError).toBe(null);
  });

  it('bootstrap locks BPM after just 2 kicks (single valid delta)', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    // Two kicks 0.5s apart → 120 BPM.
    feat.totalSec = 1.0; feat.fireKick();
    feat.totalSec = 1.5; feat.fireKick();
    expect(t.isAnalyzed).toBe(true);
    expect(t.bpm).toBeCloseTo(120, 5);
    expect(t.bpmSource).toBe('bootstrap');
    expect(t.historyCount).toBe(2);
  });

  it('bootstrap median tracks the median of recent intervals once 3+ kicks land', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    feat.totalSec = 1.0; feat.fireKick();
    feat.totalSec = 1.5; feat.fireKick();
    feat.totalSec = 2.0; feat.fireKick();
    expect(t.bpm).toBeCloseTo(120, 5);
    expect(t.historyCount).toBe(3);
  });

  it('isAnalyzing is true after one kick but before BPM locks', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    feat.totalSec = 1.0; feat.fireKick();
    expect(t.isAnalyzed).toBe(false);
    expect(t.isAnalyzing).toBe(true);
  });

  it('drops kicks at totalSec=0 to avoid the boot-window race', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    feat.totalSec = 0; feat.fireKick();
    feat.totalSec = 0; feat.fireKick();
    expect(t.historyCount).toBe(0);
  });

  it('phase progresses 0→1 within a beat period', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    // 120 BPM ⇒ period = 0.5 s.
    feat.totalSec = 1.0; feat.fireKick();
    feat.totalSec = 1.5; feat.fireKick();
    feat.totalSec = 2.0; feat.fireKick();
    // Right on the last kick.
    feat.totalSec = 2.0;
    expect(t.phase).toBeCloseTo(0, 5);
    // Quarter through the period.
    feat.totalSec = 2.125;
    expect(t.phase).toBeCloseTo(0.25, 5);
    // Just before next kick — phase nearly 1.
    feat.totalSec = 2.49;
    expect(t.phase).toBeCloseTo(0.98, 2);
  });

  it('anticipation is 0 outside the lookahead window, ramps 0→1 inside it', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    // Lock to 120 BPM (period 0.5s).
    feat.totalSec = 1.0; feat.fireKick();
    feat.totalSec = 1.5; feat.fireKick();
    feat.totalSec = 2.0; feat.fireKick();
    // 0.30s after last kick → 0.20s until next kick → outside the
    // 0.25s lookahead window? 0.20 < 0.25 so it's INSIDE.
    feat.totalSec = 2.30;
    // 0.20s to go in a 0.25s window → 1 - 0.20/0.25 = 0.20.
    expect(t.anticipation).toBeCloseTo(0.2, 5);
    // 0.10s before next kick → 0.6 anticipation.
    feat.totalSec = 2.40;
    expect(t.anticipation).toBeCloseTo(0.6, 5);
    // Right on the kick → anticipation ≈ 0 (ttn=0 hits the early-return).
    feat.totalSec = 2.50;
    expect(t.anticipation).toBe(0);
    // Well before the next beat (>0.25s out) → 0.
    feat.totalSec = 2.10;
    expect(t.anticipation).toBe(0);
  });

  it('anticipation handles "now ran past the projected kick" by stepping forward', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    // 120 BPM ⇒ period 0.5 s.
    feat.totalSec = 1.0; feat.fireKick();
    feat.totalSec = 1.5; feat.fireKick();
    feat.totalSec = 2.0; feat.fireKick();
    // Jump way past the last kick — beats-ahead math should still find the
    // next predicted beat inside the lookahead window.
    feat.totalSec = 10.40;  // next predicted at 10.5 → 0.10s out → 0.6
    expect(t.anticipation).toBeCloseTo(0.6, 5);
  });

  it('reset() clears bootstrap, lastKick, anticipation, and phase', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    feat.totalSec = 1.0; feat.fireKick();
    feat.totalSec = 1.5; feat.fireKick();
    feat.totalSec = 2.0; feat.fireKick();
    expect(t.bpm).toBeGreaterThan(0);
    t.reset();
    expect(t.bpm).toBe(0);
    expect(t.historyCount).toBe(0);
    expect(t.phase).toBe(0);
    expect(t.anticipation).toBe(0);
    expect(t.isAnalyzed).toBe(false);
  });

  it('setSource(null) is safe without a worklet attached', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    // Repeated null sources should never throw.
    expect(() => t.setSource(null)).not.toThrow();
    expect(() => t.setSource(null)).not.toThrow();
    expect(t.analyzeError).toBe(null);
  });

  it('isAnalyzed becomes false again after reset (analyzing transitions back to idle)', () => {
    const feat = makeFakeFeature();
    const t = createLiveBeatTracker({ feature: feat });
    feat.totalSec = 1.0; feat.fireKick();
    expect(t.isAnalyzing).toBe(true);
    t.reset();
    expect(t.isAnalyzing).toBe(false);
    expect(t.isAnalyzed).toBe(false);
  });
});
