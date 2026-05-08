// Asymmetric one-pole envelope follower.
//
// Stage 5 of plan_particle_2.md. Raw FFT band values flicker frame-to-frame
// even on sustained audio. Smoothing them with a single time constant (lerp,
// EMA) costs the "punch" — fast transients get lost. Asymmetric attack /
// release fixes both: short attack catches the kick; long release lets the
// glow linger.
//
// Math reference: Kyle Ferguson's *Audio Reactive Programming: Envelope
// Followers*. Tuning rule of thumb (plan_particle_1.md §4.7):
//   fast tier (sparkle, CA): τ_a 5–15 ms, τ_r 50–80 ms
//   slow tier (bloom, FOV):  τ_a 50 ms,    τ_r 200–500 ms

export function createEnvelope({ tauAttackMs = 8, tauReleaseMs = 180 } = {}) {
  let env = 0;
  return {
    update(raw, dtMs) {
      const tau = raw > env ? tauAttackMs : tauReleaseMs;
      // 1 - exp(-dt/τ) is the discrete-time one-pole coefficient. Stable
      // across variable frame intervals (dtMs from the engine clock).
      env += (raw - env) * (1 - Math.exp(-dtMs / tau));
      return env;
    },
    get value() { return env; },
    reset(v = 0) { env = v; },
  };
}
