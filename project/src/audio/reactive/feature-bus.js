// FeatureBus — the public audio→visual stream API.
//
// Stage 5 of plan_particle_2.md. Composes analyser + bands + per-band
// envelope/normalizer/flux/kick into a single object. Visual code subscribes
// here; nothing reaches into the AnalyserNode directly.
//
// Architectural rule (plan_particle_2.md §1.5): vfx/reactive/bindings.js is
// the *only* consumer that reads these streams and writes material uniforms.
//
// Per-band signals (cached, computed once per tick):
//   .value  raw band integration in [0,1]
//   .env    asymmetric attack/release envelope of value (smoothed)
//   .norm   AGC-normalized env in [0,1] — for "level" / "loudness" effects
//   .flux   half-wave rectified d/dt of value — pure transient signal
//   .kick   AGC-normalized impulse envelope of flux — for "drum hit" effects
//                                                     (fast attack, fast decay)
//
// When to bind which:
//   level (loudness): use `.norm` — sustained sounds drive sustained brightness
//   transient (drums): use `.kick` — pops on kicks/snares, fades fast
//   raw: use `.value` (debug only) or `.env` (smoothed but not normalized)
//
// Future Stage 5b adds discrete onset events + offline beat grid; both layer
// on top of this same object.

import { createAnalyserSampler } from './analyser.js';
import { createBands } from './bands.js';
import { createEnvelope } from './envelope.js';
import { createNormalizer } from './normalizer.js';

// Per-band tuning.
//   tauA / tauR — value envelope (slow tier for bloom, FOV, etc.)
//   decay        — AGC decay for value normalizer (slow — songs change)
//   kickTauA/R  — kick impulse envelope (fast — meant to "snap")
//   kickDecay    — kick AGC decay (fast — every kick should read at full)
const BAND_TUNING = {
  sub:     { tauA:  8, tauR: 220, decay: 0.9995, kickTauA: 2, kickTauR: 180, kickDecay: 0.985 },
  bass:    { tauA:  8, tauR: 180, decay: 0.9995, kickTauA: 2, kickTauR: 160, kickDecay: 0.985 },
  lowMid:  { tauA: 10, tauR: 140, decay: 0.9995, kickTauA: 3, kickTauR: 140, kickDecay: 0.985 },
  mid:     { tauA: 10, tauR: 110, decay: 0.9995, kickTauA: 3, kickTauR: 120, kickDecay: 0.985 },
  highMid: { tauA:  6, tauR:  80, decay: 0.9995, kickTauA: 2, kickTauR: 100, kickDecay: 0.985 },
  air:     { tauA:  5, tauR:  60, decay: 0.9995, kickTauA: 2, kickTauR:  80, kickDecay: 0.985 },
};

export function createFeatureBus({ audio } = {}) {
  // Pass a thunk, not the analyser itself. audio.analyser is null at boot
  // (init() runs only after the first user gesture) and the sampler would
  // otherwise capture the stale null forever.
  const sampler = createAnalyserSampler({ getAnalyser: () => audio.analyser });
  const bands = createBands();

  // Per-band stateful processors.
  const envelopes      = {};
  const normalizers    = {};
  const kickEnvelopes  = {};
  const kickNormalizers = {};
  const prevValues     = {};

  // Per-band cached output values, written once per tick(), read by getters.
  // Caching is non-negotiable: AGC normalizers mutate peak on every call, so
  // a "compute on read" getter would advance peak 3–5× per frame depending
  // on how many consumers (bindings, overlay) read it.
  const cache = {};

  for (const name of bands.bandNames) {
    const t = BAND_TUNING[name];
    envelopes[name]       = createEnvelope({ tauAttackMs: t.tauA,     tauReleaseMs: t.tauR });
    normalizers[name]     = createNormalizer({ decay: t.decay });
    kickEnvelopes[name]   = createEnvelope({ tauAttackMs: t.kickTauA, tauReleaseMs: t.kickTauR });
    kickNormalizers[name] = createNormalizer({ decay: t.kickDecay, floor: 0.001 });
    prevValues[name]      = 0;
    cache[name] = { value: 0, env: 0, norm: 0, flux: 0, kick: 0 };
  }

  // Per-band public signal objects — stable references the bindings layer
  // can hold across the boot window (before audio.analyser comes online).
  const bandSignals = {};
  for (const name of bands.bandNames) {
    const c = cache[name];
    bandSignals[name] = {
      get value() { return c.value; },
      get env()   { return c.env; },
      get norm()  { return c.norm; },
      get flux()  { return c.flux; },
      get kick()  { return c.kick; },
    };
  }

  let bound = false;
  let frameCounter = 0;

  function tryBind() {
    if (bound) return true;
    if (!audio.analyser || !audio.sampleRate) return false;
    bands.bind(audio.analyser.fftSize, audio.sampleRate);
    bound = true;
    return true;
  }

  return {
    bands: bandSignals,

    tick(dtSec) {
      if (!tryBind()) return;
      frameCounter++;
      const sample = sampler.sample(frameCounter);
      if (!sample) return;
      const integrated = bands.integrate(sample);
      const dtMs = dtSec * 1000;

      for (const name of bands.bandNames) {
        const raw = integrated[name] || 0;
        const c = cache[name];

        // Value path (slow tier — "how loud is this band?")
        c.value = raw;
        c.env   = envelopes[name].update(raw, dtMs);
        c.norm  = normalizers[name].normalize(c.env);

        // Flux path (fast tier — "did energy SPIKE this frame?")
        // Half-wave rectified derivative isolates positive transients only.
        // Sustained bass: raw ≈ prev → flux ≈ 0. A kick: raw >> prev → flux > 0.
        const flux = Math.max(0, raw - prevValues[name]);
        prevValues[name] = raw;
        c.flux = flux;
        // Smooth into an impulse envelope (fast attack catches the kick;
        // fast release lets it fall back so the next kick reads cleanly).
        const kickEnv = kickEnvelopes[name].update(flux, dtMs);
        // Normalize via fast-decay AGC so kick magnitude is song-independent.
        c.kick = kickNormalizers[name].normalize(kickEnv);
      }
    },

    get isBound() { return bound; },
    get sampler() { return sampler; },
    get bandNames() { return bands.bandNames; },

    // Debug snapshot — used by the F-key overlay and console inspection.
    snapshot() {
      const out = {};
      for (const name of bands.bandNames) out[name] = { ...cache[name] };
      return out;
    },
  };
}
