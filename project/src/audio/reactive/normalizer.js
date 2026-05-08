// Running-peak AGC (Automatic Gain Control) per band.
//
// Stage 5 of plan_particle_2.md. Tracks a slowly-decaying peak per band and
// divides the raw value by it, producing a normalized [0,1] signal that's
// stable across loud and quiet songs alike. Without this, a quiet track has
// the visuals barely moving and a loud track clips everything to 1.
//
//   peak ← max(raw, peak * decay)
//   norm ← clamp01(raw / max(peak, floor))
//
// `decay` controls how fast the peak forgets a transient:
//   0.999  → ~10s memory at 60fps  (calm music)
//   0.9995 → ~30s memory            (default — covers verse/chorus shifts)
//   0.9999 → ~minutes               (set-and-forget; slow to adapt)

export function createNormalizer({ decay = 0.9995, floor = 0.01 } = {}) {
  let peak = 0;
  return {
    normalize(raw) {
      // Peak rises instantly to new highs, falls slowly toward 0.
      peak = Math.max(raw, peak * decay);
      if (peak < floor) return 0;
      const v = raw / peak;
      return v < 0 ? 0 : (v > 1 ? 1 : v);
    },
    get peak() { return peak; },
    reset() { peak = 0; },
  };
}
