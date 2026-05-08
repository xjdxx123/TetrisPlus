// Declarative stream → uniform/property bindings.
//
// Stage 5 of plan_particle_2.md. THIS IS THE ONLY PLACE in the engine where
// audio streams (FeatureBus) meet visual state (uniforms, material props,
// scalar fields). Every other module reads streams XOR writes visuals,
// never both.
//
// Why so strict: the alternative is that every visual module reaches into
// the FeatureBus, scattering audio→visual logic across dozens of files.
// When you want to retune the bass→bloom feel, you edit one binding here;
// when you want to add a new reactive surface, you add one binding here.
//
// Bindings are evaluated every render tick after FeatureBus.tick() has run.
// Each binding is `{ get, apply }` where `get` reads from a stream and
// `apply` writes the result somewhere.

function lerp(a, b, t) { return a + (b - a) * t; }

export function createBindings({ feature, targets, beatGrid = null } = {}) {
  // The bindings table. Order doesn't matter (writes are independent).
  // Shape kept identical for every entry so future bindings drop in trivially.
  const bindings = [];

  // Helper: anticipation 0..1 if a beat-grid is wired and BPM has been
  // detected; 0 otherwise. Bindings can compose with this multiplicatively
  // to ramp UP into a beat without changing their resting behaviour when
  // the analyzer is unavailable.
  const beatAnticipation = () => (beatGrid && beatGrid.isAnalyzed ? beatGrid.anticipation : 0);

  // Bass.norm → bloom layer scale (the combine pass weight).
  // Bound to `setBloomScale` not `bloomPass.strength` so this doesn't fight
  // the existing level-up / game-over event tweens that write strength
  // directly. The two paths stack multiplicatively:
  //   final bloom = base_strength * (event_modifier) * (audio_scale)
  // Range 0.6 → 2.4: noticeably under-bloomed in quiet sections, dramatic
  // glow on heavy bass. The dynamic range is the audio reactivity — flat
  // multipliers read as "always on" rather than "music driven."
  // Hybrid: small sustain from `norm` (so quiet verses still have presence)
  // + big impulse from `kick` (so each drum hit pops). `kick` is the
  // half-wave rectified flux of band energy — sustained sounds register ~0,
  // transients register big. This is what gives drum-sync feel; `norm`
  // alone pins near 1 on bass-heavy mixes due to AGC adapting to the steady
  // state.
  // Stage 5b — anticipatory pre-warm: multiplied by (1 + k·anticipation)
  // so bloom RISES across the 250ms before each beat hits. Coefficient is
  // small (0.25) — the read should be "the room is leaning in," not
  // "everything is throbbing." Combined with the audio kick, the anticipation
  // is "set up" by the climb and "released" by the kick.
  if (targets.selectiveBloom) {
    bindings.push({
      get: () => {
        const audio = 0.15 * feature.bands.highMid.norm + 0.85 * feature.bands.highMid.kick;
        return lerp(0.7, 2.6, audio) * (1 + 0.25 * beatAnticipation());
      },
      apply: (v) => { targets.selectiveBloom.setBloomScale(v); },
    });
  }

  // Same hybrid for FOV breathing — small sustain swell + impulsive expand
  // on each kick. The breathe module owns the underlying sine; the binding
  // just scales its amplitude.
  // if (targets.breathe) {
  //   bindings.push({
  //     get: () => 0.20 * feature.bands.sub.norm + 0.80 * feature.bands.sub.kick,
  //     apply: (v) => { targets.breathe.setIntensity(lerp(0.4, 2.2, v)); },
  //   });
  // }

  // Air.norm → chromatic aberration amount (Stage 6).
  // High-end shimmer (cymbals, hats, sparkly synths) drives a subtle radial
  // CA. Restrained range — even at uAmount=1 the corner offset is ~6 px on
  // a 1080p frame; full-screen CA reads as broken display, not cinematic.
  // Stage 5b — small additive anticipation. CA already serves as the "shimmer"
  // signal; layering anticipation on top biases the high-end pre-beat so the
  // air feels electric a fraction of a second before the kick lands.
  if (targets.chromatic) {
    bindings.push({
      get: () => feature.bands.air.norm + 0.20 * beatAnticipation(),
      apply: (v) => {
        const clamped = v < 0 ? 0 : (v > 1 ? 1 : v);
        targets.chromatic.uniforms.uAmount.value = lerp(0.0, 0.9, clamped);
      },
    });
  }

  // (Stage 5b will add: edge intensity from bass, ambient flow speed from
  // lowMid (after refactoring the _clearAttentionMul conflict), sparkle/dust
  // spawn rates from mid + air, kick onset → beat pulse, etc.)

  // Stage 5b — discrete onset events (kick / snare / generic). Live signal
  // accessible via `feature.onsets.on(name, fn)`. Subscribe here, not deep
  // in a target module — keeps audio→visual flow funneled through one file.
  // Verifiable now via the F-key overlay's onset dots; hook up a one-shot
  // emitter (e.g. beatPulse, sparkle pre-warm) once those modules land.
  //   Example shape:
  //     if (targets.beatPulse) {
  //       feature.onsets.on('kick', strength => targets.beatPulse.spawn(strength));
  //     }
  // Anticipatory bindings (the "room responds *before* the beat" feel) wait
  // for beat-grid.js + offline BPM detection — Stage 5b second half.

  let enabled = true;

  // Reset every bound target to a neutral baseline. Used when audio
  // reactivity is toggled off — without this, the last-modulated values
  // would freeze in place (bloom stuck dim or amped, CA stuck visible).
  function resetToBaseline() {
    if (targets.selectiveBloom) targets.selectiveBloom.setBloomScale(1.0);
    if (targets.chromatic)       targets.chromatic.uniforms.uAmount.value = 0;
    if (targets.breathe)         targets.breathe.setIntensity(1.0);
  }

  return {
    tick() {
      if (!enabled) return;
      for (const b of bindings) b.apply(b.get());
    },
    setEnabled(b) {
      const next = !!b;
      if (next === enabled) return;
      enabled = next;
      if (!enabled) resetToBaseline();
    },
    get enabled() { return enabled; },
    get bindingCount() { return bindings.length; },
  };
}
