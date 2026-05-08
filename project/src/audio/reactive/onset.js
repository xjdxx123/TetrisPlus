// Discrete onset event detector — Stage 5b of plan_particle_2.md.
//
// The FeatureBus already exposes a continuous `kick` signal per band — an
// AGC-normalized impulse envelope of the half-wave-rectified flux. That's
// great for *binding to uniforms* (a smooth ramp on bloom or sparkle size).
// It is NOT great for *one-shot triggers*: "the kick just landed, fire one
// burst." A continuous envelope crossing 0.7 every frame for 80ms would
// fire 5 bursts; a discrete onset event fires exactly once per hit.
//
// Algorithm (Bello et al. 2005, simplified for live use):
//   1. Maintain a rolling window of recent flux values per band.
//   2. Compute an adaptive threshold from the window's median, scaled and
//      offset so quiet passages don't fire on noise floor and loud passages
//      don't pin onsets to "always."
//   3. Fire on rising-edge crossing of the threshold (this frame above, last
//      frame below). Peak detection is more accurate but adds latency; the
//      rising edge is what musicians feel as "the moment."
//   4. Refractory window: ignore further fires for N ms after one. Drum
//      machines double-trigger constantly; a 60ms gate corresponds to ~16Hz,
//      faster than any musical kick rate.
//
// Tuning notes:
//   - windowSize 24 ≈ 400ms at 60fps. Long enough to span 1–2 beats at
//     90–140 BPM so the median tracks the recent noise floor; short enough
//     that a sudden quiet→loud transition adapts within ~1 measure.
//   - thresholdGain 1.5 + thresholdOffset 0.02 = "median pivot * 1.5, never
//     below 0.02." The offset keeps a silent track from firing on numerical
//     drift; the gain sets sensitivity. 1.5 is conservative (misses some
//     softer hits); 1.2 fires more aggressively.
//   - refractoryMs 60 is the standard from drum-machine literature.
//
// The detector is band-agnostic — pass it the appropriate band's flux. The
// FeatureBus owns the band→onset-name mapping (kick=bass, snare=mid,
// generic=air) so consumers subscribe to musical concepts, not bin indices.

/**
 * @typedef {Object} OnsetUpdate
 * @property {boolean} fired       True only on the frame the onset triggers
 * @property {number}  strength    [0,1] — relative excess above threshold; clamped
 * @property {number}  threshold   The current adaptive threshold (debug)
 */

export function createOnsetDetector({
  windowSize = 24,
  thresholdGain = 1.5,
  thresholdOffset = 0.02,
  refractoryMs = 60,
} = {}) {
  if (windowSize < 2) throw new Error('onset windowSize must be ≥ 2');

  const window = new Float32Array(windowSize);
  // Reusable scratch buffer for the median sort. Allocating inside update()
  // would churn GC at 60Hz × N detectors.
  const scratch = new Float32Array(windowSize);
  let writeIdx = 0;
  let elapsedSinceFireMs = Infinity;
  let aboveLast = false;
  // Don't fire until the window has filled — the median is meaningless on a
  // half-zero buffer and would fire on the first non-trivial flux value.
  let warmupFrames = 0;

  /**
   * @param {number} flux Current frame's spectral-flux value (≥ 0)
   * @param {number} dtMs Frame interval in ms
   * @returns {OnsetUpdate}
   */
  function update(flux, dtMs) {
    elapsedSinceFireMs += dtMs;

    // Median of the window. sort() on N=24 is ~115 ops/frame — trivial.
    for (let i = 0; i < windowSize; i++) scratch[i] = window[i];
    scratch.sort();
    const median = scratch[windowSize >> 1];
    const threshold = median * thresholdGain + thresholdOffset;

    const above = flux > threshold;
    let fired = false;
    let strength = 0;

    if (
      warmupFrames >= windowSize &&
      above && !aboveLast &&
      elapsedSinceFireMs >= refractoryMs
    ) {
      fired = true;
      // Relative excess above threshold, clamped. Threshold is small in quiet
      // passages so a clear hit reads ~1.0; large in loud passages so the
      // same flux value reads more modestly. That's the desired behaviour.
      const excess = (flux - threshold) / Math.max(0.01, threshold);
      strength = excess > 1 ? 1 : (excess < 0 ? 0 : excess);
      elapsedSinceFireMs = 0;
    }
    aboveLast = above;

    window[writeIdx] = flux;
    writeIdx = (writeIdx + 1) % windowSize;
    if (warmupFrames < windowSize) warmupFrames++;

    return { fired, strength, threshold };
  }

  function reset() {
    for (let i = 0; i < windowSize; i++) window[i] = 0;
    writeIdx = 0;
    elapsedSinceFireMs = Infinity;
    aboveLast = false;
    warmupFrames = 0;
  }

  return {
    update,
    reset,
    get warmupComplete() { return warmupFrames >= windowSize; },
  };
}
