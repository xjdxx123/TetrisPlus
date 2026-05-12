// Meyda feature extraction — harmonic + timbral signals that FeatureBus
// doesn't provide. Sits alongside FB, NOT replacing it:
//   - FeatureBus: 6-band energies / envelopes / kicks / onset events.
//     Drives bloom, ambient flow, edge intensity, kick flashes.
//   - Meyda (this): chroma vector, spectral centroid, MFCC, RMS,
//     spectral flux. Drives hue/saturation/lightness — visual response
//     to *musical content*, not just loudness.
//
// Plan reference: plan_audio_interaction.md L-1 ("Harmonic-reactive
// colour via Meyda"). This module is the L-1 spike entry point.
//
// Architectural rule (plan_particle_2.md §1.5): only `bindings.js`
// reads these features AND writes visual state. This module produces
// signals; the binding layer composes them with visuals.
//
// Source-switch handling: same pattern as the BPM tracker —
// `setSource(node)` swaps between BGM analyser and external-capture
// analyser. Meyda's own `MeydaAnalyzer.setSource()` handles the
// reconnection internally; we drive that on each switch.

// Smoothing time constants. Chroma is the noisiest signal (each frame
// is one 512-sample FFT, ~12 ms at 44.1 kHz, more at 48 kHz). The
// resulting per-frame vector flicker would translate into hue strobing
// without low-pass filtering. EMA chosen over a sliding window for
// O(1) update with no array churn.
const CHROMA_SMOOTH_TC_MS    = 350;   // hue should *settle* on a chord
const CENTROID_SMOOTH_TC_MS  = 200;
const RMS_SMOOTH_TC_MS       = 120;

// AGC for spectralCentroid (raw values vary wildly with sample rate
// and content). We normalize to a song-relative [0, 1] via a slowly-
// decaying peak tracker.
const CENTROID_AGC_DECAY     = 0.9995;
const CENTROID_AGC_FLOOR     = 100;   // Hz — avoid divide-by-zero on silence

// The features we ask Meyda for. Asking for fewer is faster; we pick
// what bindings actually consume + a couple cheap ones for future use.
//
// `spectralFlux` is intentionally OMITTED — Meyda's implementation
// requires the caller to thread the previous spectrum through, and
// without that scaffolding it throws TypeError on every buffer
// (observed at runtime as ~1000 errors/min flooding the console).
// FeatureBus already computes per-band flux for our 6 bands, which is
// more useful anyway. If we ever want a global broadband flux signal,
// we'd derive it ourselves from `amplitudeSpectrum` deltas.
const FEATURES = ['chroma', 'spectralCentroid', 'rms', 'perceptualSharpness'];

// ===== Pure helpers (exported for unit testing) =====

/** Circular mean of a 12-element chroma vector in degrees [0, 360).
 *  Each bin is one pitch class (C..B). The chroma is treated as a
 *  weighted set of points on a unit circle; the resultant vector's
 *  angle is the dominant pitch class with smooth interpolation when
 *  multiple pitches are active. */
export function computeChromaHueDeg(chroma) {
  if (!chroma || chroma.length < 12) return 0;
  let x = 0, y = 0, total = 0;
  for (let i = 0; i < 12; i++) {
    const w = chroma[i];
    if (!(w > 0)) continue;
    const theta = (i / 12) * 2 * Math.PI;
    x += w * Math.cos(theta);
    y += w * Math.sin(theta);
    total += w;
  }
  if (total <= 0) return 0;
  const rad = Math.atan2(y, x);
  return ((rad * 180 / Math.PI) + 360) % 360;
}

/** Resultant length of the chroma circular mean, [0, 1]. 1 = all
 *  energy at one pitch class. 0 = equal energy spread across all 12
 *  (atonal / noise / silence). */
export function computeChromaConfidence(chroma) {
  if (!chroma || chroma.length < 12) return 0;
  let x = 0, y = 0, total = 0;
  for (let i = 0; i < 12; i++) {
    const w = chroma[i];
    if (!(w > 0)) continue;
    const theta = (i / 12) * 2 * Math.PI;
    x += w * Math.cos(theta);
    y += w * Math.sin(theta);
    total += w;
  }
  if (total <= 0) return 0;
  const r = Math.hypot(x, y) / total;
  return r < 0 ? 0 : (r > 1 ? 1 : r);
}

/** Index 0..11 of the chroma's peak bin. Useful for discrete pitch
 *  class bindings (e.g. a 12-step palette swap). */
export function computeDominantPitchClass(chroma) {
  if (!chroma || chroma.length < 12) return 0;
  let best = 0, bestVal = chroma[0];
  for (let i = 1; i < 12; i++) {
    if (chroma[i] > bestVal) { bestVal = chroma[i]; best = i; }
  }
  return best;
}

export function createMeydaFeatures({ bufferSize = 512 } = {}) {
  // Smoothed feature state — written by the analyzer callback, read
  // through getters. Initialised to neutral so consumers don't see
  // NaN/undefined before the first frame.
  const chromaSmooth = new Float32Array(12);
  let centroidSmooth = 0;
  let centroidPeak = CENTROID_AGC_FLOOR;
  let rmsSmooth = 0;
  let perceptualSharpnessSmooth = 0;
  let lastFrameTimeMs = 0;
  let frameCount = 0;

  // Worklet-side state.
  let analyzer = null;
  let pendingSetup = false;
  let currentSource = null;
  let analyzeError = null;
  let _loggedFirstFrame = false;

  function emaMix(prev, next, dtMs, tcMs) {
    if (tcMs <= 0) return next;
    // Exponential-decay alpha for a time-constant TC: each TC ms, the
    // signal closes ~63% of the gap to the new value.
    const alpha = 1 - Math.exp(-dtMs / tcMs);
    return prev + alpha * (next - prev);
  }

  function onFeatures(features) {
    // Meyda fires per script-processor callback, not per render tick.
    // We need our own dt for EMA smoothing — perf.now() is the
    // simplest stable clock available from worklet-adjacent code.
    const nowMs = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const dtMs = lastFrameTimeMs > 0 ? Math.max(1, nowMs - lastFrameTimeMs) : 16;
    lastFrameTimeMs = nowMs;
    frameCount++;

    // chroma is a 12-element array (one per pitch class C..B). Some
    // frames it can be null/undefined on silence — guard each read.
    if (features.chroma && features.chroma.length === 12) {
      for (let i = 0; i < 12; i++) {
        const raw = Number(features.chroma[i]) || 0;
        chromaSmooth[i] = emaMix(chromaSmooth[i], raw, dtMs, CHROMA_SMOOTH_TC_MS);
      }
    }
    if (typeof features.spectralCentroid === 'number' && Number.isFinite(features.spectralCentroid)) {
      const raw = Math.max(0, features.spectralCentroid);
      centroidSmooth = emaMix(centroidSmooth, raw, dtMs, CENTROID_SMOOTH_TC_MS);
      // AGC peak: rises instantly on new highs, decays slowly so quiet
      // sections still produce a sensible 0..1 normalized value.
      centroidPeak = Math.max(centroidSmooth, centroidPeak * CENTROID_AGC_DECAY);
      if (centroidPeak < CENTROID_AGC_FLOOR) centroidPeak = CENTROID_AGC_FLOOR;
    }
    if (typeof features.rms === 'number' && Number.isFinite(features.rms)) {
      rmsSmooth = emaMix(rmsSmooth, Math.max(0, features.rms), dtMs, RMS_SMOOTH_TC_MS);
    }
    if (typeof features.perceptualSharpness === 'number' && Number.isFinite(features.perceptualSharpness)) {
      perceptualSharpnessSmooth = emaMix(perceptualSharpnessSmooth, features.perceptualSharpness, dtMs, CENTROID_SMOOTH_TC_MS);
    }

    if (!_loggedFirstFrame) {
      _loggedFirstFrame = true;
      console.log(`[meyda-features] first frame after ${frameCount} buffers — chroma=[${[...chromaSmooth].map(n => n.toFixed(2)).join(',')}], centroid=${centroidSmooth.toFixed(0)} Hz, rms=${rmsSmooth.toFixed(3)}`);
    }
  }

  async function setupAnalyzer(audioContext, sourceNode) {
    if (analyzer || pendingSetup || !audioContext) return;
    pendingSetup = true;
    try {
      // Lazy import — keeps the ~50 KB meyda bundle off the synchronous
      // boot path, same pattern as realtime-bpm-analyzer.
      const Meyda = (await import('meyda')).default;
      analyzer = Meyda.createMeydaAnalyzer({
        audioContext,
        source: sourceNode,
        bufferSize,
        featureExtractors: FEATURES,
        callback: onFeatures,
      });
      analyzer.start();
      currentSource = sourceNode;
    } catch (err) {
      analyzeError = err;
      console.warn('[meyda-features] failed to create analyzer:', err?.message || err);
    } finally {
      pendingSetup = false;
    }
  }

  function setSource(sourceNode) {
    if (sourceNode === currentSource) return;
    if (!sourceNode) {
      // Detach: stop extraction, drop the reference. We don't tear the
      // analyzer down so a subsequent re-attach can use the same
      // ScriptProcessorNode (createMediaElementSource is one-per-node
      // but createMediaStreamSource permits multiples).
      if (analyzer) { try { analyzer.stop(); } catch { /* noop */ } }
      currentSource = null;
      return;
    }
    if (!analyzer) {
      void setupAnalyzer(sourceNode.context, sourceNode);
      return;
    }
    try {
      analyzer.setSource(sourceNode);
      analyzer.start();
      currentSource = sourceNode;
    } catch (err) {
      analyzeError = err;
      console.warn('[meyda-features] setSource failed:', err?.message || err);
    }
  }

  function reset() {
    for (let i = 0; i < 12; i++) chromaSmooth[i] = 0;
    centroidSmooth = 0;
    centroidPeak = CENTROID_AGC_FLOOR;
    rmsSmooth = 0;
    perceptualSharpnessSmooth = 0;
  }

  function centroidNorm() {
    if (centroidPeak <= 0) return 0;
    const v = centroidSmooth / centroidPeak;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  return {
    setSource,
    reset,

    get isReady() { return analyzer != null && frameCount > 0; },
    get analyzeError() { return analyzeError; },
    get isPendingSetup() { return pendingSetup; },
    get frameCount() { return frameCount; },

    // Raw + smoothed scalars.
    get rms() { return rmsSmooth; },
    get spectralCentroid() { return centroidSmooth; },
    get spectralCentroidNorm() { return centroidNorm(); },
    get perceptualSharpness() { return perceptualSharpnessSmooth; },

    // Chroma — exposed both raw (for advanced bindings) and as derived
    // hue/confidence values (for the typical hue-tint use case).
    get chroma() { return chromaSmooth; },
    get chromaHueDeg() { return computeChromaHueDeg(chromaSmooth); },
    get chromaConfidence() { return computeChromaConfidence(chromaSmooth); },
    get dominantPitchClass() { return computeDominantPitchClass(chromaSmooth); },
  };
}
