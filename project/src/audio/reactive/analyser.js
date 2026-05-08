// Per-frame AnalyserNode tap.
//
// Stage 5 of plan_particle_2.md. Wraps the playback module's AnalyserNode so
// downstream consumers (bands, beat detector, etc.) all see the *same* sample
// per frame. Reading getByteFrequencyData more than once per frame is a
// surprisingly common cause of jank — see plan_particle_1.md §2.4.
//
// Convention: the bins are renormalized to [0, 1] at the analyser layer so
// every consumer above sees a consistent range. The Uint8 0..255 values from
// getByteFrequencyData come pre-scaled by Web Audio's internal smoothing +
// dB-to-byte mapping; renormalizing here keeps that conversion in one place.

// Takes a `getAnalyser` thunk rather than the AnalyserNode itself: the
// analyser is null at construction time (audio init runs only after the user
// gesture) and would otherwise be captured stale forever. Reading it through
// a thunk per-frame is the safe pattern.
export function createAnalyserSampler({ getAnalyser, fftSize = 1024 } = {}) {
  let bins = null;
  let lastFrame = -1;
  let lastSample = null;

  function ensureBuffers(node) {
    const n = node.frequencyBinCount;
    if (!bins || bins.length !== n) {
      bins = new Uint8Array(n);
      lastSample = new Float32Array(n);
    }
  }

  return {
    // Sample once per frame; subsequent calls in the same frame return the
    // cached buffer. `frameId` is a monotonic counter (e.g., the engine
    // clock's totalSec * 1000 floored, or just a frame counter).
    sample(frameId) {
      const analyser = getAnalyser();
      if (!analyser) return null;
      if (frameId === lastFrame && lastSample) return lastSample;
      ensureBuffers(analyser);
      analyser.getByteFrequencyData(bins);
      // Normalize 0..255 → 0..1 in-place into lastSample.
      for (let i = 0; i < bins.length; i++) lastSample[i] = bins[i] / 255;
      lastFrame = frameId;
      return lastSample;
    },

    get binCount() {
      const a = getAnalyser();
      return a ? a.frequencyBinCount : 0;
    },
    get isReady() { return !!getAnalyser(); },
    // For band integration: bin index → frequency Hz mapping.
    binFrequency(i, sampleRate) {
      const a = getAnalyser();
      return (i * sampleRate) / (a ? a.fftSize : fftSize);
    },
  };
}
