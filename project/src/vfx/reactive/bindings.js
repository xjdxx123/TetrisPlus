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

export function createBindings({ feature, targets, beatGrid = null, meydaFeatures = null } = {}) {
  // The bindings table. Order doesn't matter (writes are independent).
  // Shape kept identical for every entry so future bindings drop in trivially.
  const bindings = [];

  // Capture the nebula's authored intensity so the bass binding modulates
  // around it as a multiplier rather than overwriting with absolute values
  // (different stages can ship different baselines without changing the
  // binding). Read once at boot — runtime tweaks via `__nebula.setIntensity`
  // would be lost, but those are dev-only inspector pokes.
  const nebulaBaseIntensity = targets.nebula
    ? (targets.nebula.intensity ?? 1.0)
    : 1.0;

  // Helper: anticipation 0..1 if a beat-grid is wired and BPM has been
  // detected; 0 otherwise. Bindings can compose with this multiplicatively
  // to ramp UP into a beat without changing their resting behaviour when
  // the analyzer is unavailable.
  const beatAnticipation = () => (beatGrid && beatGrid.isAnalyzed ? beatGrid.anticipation : 0);

  // Helper to give existing bindings a name for the `debug()` console
  // helper below. Pre-Stage-5b bindings were anonymous; named here without
  // changing behaviour so `__bindings.debug()` can list them by what they
  // bind, not by index.
  const named = (name, b) => ({ name, ...b });

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
    bindings.push(named('highMid.{norm,kick} → selectiveBloom.scale', {
      get: () => {
        const audio = 0.15 * feature.bands.highMid.norm + 0.85 * feature.bands.highMid.kick;
        return lerp(0.7, 2.6, audio) * (1 + 0.25 * beatAnticipation());
      },
      apply: (v) => { targets.selectiveBloom.setBloomScale(v); },
    }));

    // sub + bass kick → selectiveBloom flash. Direct envelope read (not
    // the discrete onset event, which has ~400ms structural latency from
    // the 24-frame median threshold) so the flash lands on the actual
    // beat instead of trailing it. Pushed AFTER the highMid binding so
    // its apply() runs second this tick — we read what highMid just
    // wrote and take max, never demoting it. Reach for kick=1 → 3.5,
    // hotter than highMid's 2.6 ceiling so kick clearly dominates when
    // both fire (and gracefully no-ops on the down-beat when only the
    // highMid sustain is non-zero).
    bindings.push(named('sub+bass.kick → selectiveBloom.scale (max-merge)', {
      get: () => {
        const kick = Math.min(
          1,
          feature.bands.sub.kick * 0.6 + feature.bands.bass.kick * 0.7,
        );
        return lerp(1.0, 3.5, kick);
      },
      apply: (v) => {
        const cur = targets.selectiveBloom.combinePass
          && targets.selectiveBloom.combinePass.uniforms
          && targets.selectiveBloom.combinePass.uniforms.uBloomScale
          ? targets.selectiveBloom.combinePass.uniforms.uBloomScale.value
          : 1.0;
        if (v > cur) targets.selectiveBloom.setBloomScale(v);
      },
    }));
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
    bindings.push(named('air.norm → chromatic.uAmount', {
      get: () => feature.bands.air.norm + 0.20 * beatAnticipation(),
      apply: (v) => {
        const clamped = v < 0 ? 0 : (v > 1 ? 1 : v);
        targets.chromatic.uniforms.uAmount.value = lerp(0.0, 0.9, clamped);
      },
    }));
  }

  // Stage 5b — lowMid.norm → ambient flow speed. The lever was exposed in
  // Stage 4. The `_clearAttentionMul` worry from earlier turned out to be a
  // false alarm: that path writes `uIntensity` (brightness), not flow speed.
  // Range 0.4 → 1.6: deliberately wide so the field visibly slows during
  // breakdowns and surges on instrumental energy. lowMid (~200–500 Hz) is
  // where bass guitars / synth pads sit — the sustained energy that "should"
  // breathe the field — and is mostly silent during pure drum hits, which
  // would otherwise make the field strobe.
  if (targets.ambientField) {
    bindings.push({
      name: 'lowMid.norm → ambientField.flowSpeed',
      get: () => feature.bands.lowMid.norm,
      apply: (v) => { targets.ambientField.setFlowSpeed(lerp(0.4, 1.6, v)); },
    });
  }

  // Stage 5b — bass.norm → active-piece edge intensity (the §1.6.2 "case
  // breathes with the bass" rule, applied to the active piece's fresnel
  // shell). Range 0.40 → 0.95 sits centered on the static 0.55 default;
  // tuned to be visible but not overpowering the inner core glow. Locked
  // cubes don't bind — only the active piece "feels" the music, which is
  // the cinematic readability rule from `plan_particle_1.md` §1.4.
  if (targets.activePieceEdges) {
    bindings.push({
      name: 'bass.norm → activePieceEdges.uEdgeIntensity',
      get: () => feature.bands.bass.norm,
      apply: (v) => { targets.activePieceEdges.setEdgeIntensity(lerp(0.40, 0.95, v)); },
    });
  }

  // Stage 5b — bass.norm → nebula intensity (slow tier; the periphery
  // breathes with the low end). Multiplier 0.85 → 1.15 around the authored
  // base so the nebula reads as "alive" without ever competing with the
  // playfield for attention (the §1.3 attention-budget rule). Bass.norm is
  // the right band — sub is too low (most music doesn't have content there)
  // and lowMid is already taken by the field; bass is the remaining slow,
  // present signal.
  if (targets.nebula) {
    bindings.push({
      name: 'bass.norm → nebula.uIntensity',
      get: () => feature.bands.bass.norm,
      apply: (v) => {
        targets.nebula.setIntensity(nebulaBaseIntensity * lerp(0.85, 1.15, v));
      },
    });
  }

  // Meyda L-1 — chroma circular-mean → spiral hue tint. The chroma
  // vector's resultant angle is the tonal centre of the music as a
  // continuous value in [0, 360); we feed it to the spiral as a target
  // hue, weighted by chroma confidence (low when the signal is atonal
  // / silent → no tint applied → the spiral falls back to its time-
  // based cycle).
  //
  // Apply receives the hue and reads confidence from `meydaFeatures`
  // directly — bindings convention is one scalar through `get` for
  // the `debug()` console helper, with side-channel reads in apply
  // when a binding needs a second signal.
  if (targets.spiralWave && meydaFeatures && targets.spiralWave.setChromaHue) {
    bindings.push({
      name: 'meyda.chroma → spiralWave.hue (tint)',
      get: () => meydaFeatures.chromaHueDeg,
      apply: (deg) => {
        targets.spiralWave.setChromaHue(deg, meydaFeatures.chromaConfidence);
      },
    });
  }

  // (Stage 5b still pending: sparkle/dust spawn rates from mid + air, kick
  // onset → beat pulse emitter — both wait for new emitters from Stage 8c.)

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
    if (targets.selectiveBloom)    targets.selectiveBloom.setBloomScale(1.0);
    if (targets.chromatic)         targets.chromatic.uniforms.uAmount.value = 0;
    if (targets.breathe)           targets.breathe.setIntensity(1.0);
    // Stage-5b additions. Restore the authored static values these bindings
    // were modulating so toggling reactivity off reads as "neutral," not
    // "frozen at the last-modulated frame."
    if (targets.ambientField)       targets.ambientField.setFlowSpeed(0.85);
    if (targets.activePieceEdges)   targets.activePieceEdges.setEdgeIntensity(0.55);
    if (targets.nebula)             targets.nebula.setIntensity(nebulaBaseIntensity);
    // Drop the chroma tint when reactivity is off so the spiral's hue
    // returns to its pure time-based cycle.
    if (targets.spiralWave && targets.spiralWave.setChromaHue) {
      targets.spiralWave.setChromaHue(0, 0);
    }
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
    // Console diagnostic. Returns the live value each binding is reading
    // *right now*; call repeatedly during playback to see whether the audio
    // chain is delivering signal. If every value is ~0, the issue is in the
    // analyser (silent BGM, suspended AudioContext, missing crossorigin) —
    // not in the bindings.
    debug() {
      return bindings.map(b => ({
        name: b.name || '(unnamed)',
        value: Number(b.get().toFixed(4)),
      }));
    },
  };
}
