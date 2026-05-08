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

export function createBindings({ feature, targets } = {}) {
  // The bindings table. Order doesn't matter (writes are independent).
  // Shape kept identical for every entry so future bindings drop in trivially.
  const bindings = [];

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
  if (targets.selectiveBloom) {
    bindings.push({
      get: () => 0.15 * feature.bands.highMid.norm + 0.85 * feature.bands.highMid.kick,
      apply: (v) => { targets.selectiveBloom.setBloomScale(lerp(0.7, 2.6, v)); },
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

  // (Stage 5b will add: edge intensity from bass, ambient flow speed from
  // lowMid (after refactoring the _clearAttentionMul conflict), sparkle/dust
  // spawn rates from mid + air, chromatic aberration from air, kick onset →
  // beat pulse, etc.)

  return {
    tick() {
      for (const b of bindings) b.apply(b.get());
    },
    get bindingCount() { return bindings.length; },
  };
}
