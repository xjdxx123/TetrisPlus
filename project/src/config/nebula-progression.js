// Level-driven nebula HUE progression.
//
// Stage 10b refactor: the nebula's resting palette is now derived from a
// single hue value, not picked from a finite list of named palettes. The
// player picks a hue in the effects panel; level-progression rotates
// through hues at fixed milestones; level-up flashes pick a contrasting
// hue at random.
//
// Two responsibilities:
//   1. hueForLevel(level) — the resting hue the nebula settles on at a
//      given level. The hue only changes at fixed level milestones, so
//      the player sees a clear environmental shift on milestones but
//      not so often it reads as flickery.
//   2. pickFlashHue(currentHue, alsoExclude) — random flash hue for the
//      level-up wash. Always 60..180° away from `currentHue` so the
//      flash is visibly distinct (analogous hues read as a wobble, not
//      a punctuation).
//
// Pure module — no THREE, no DOM. Lookup tables exposed for tests and
// for any future "next milestone at level N" UI hint.

// Resting hue per level band. The `fromLevel` is inclusive — once the
// player reaches that level, this hue becomes the resting state until
// the next band's threshold is crossed. Order MUST be ascending.
//
// Hue values picked to walk a deliberately non-adjacent path so each
// band feels like a clear environmental shift: cyan → violet → blue →
// green-aurora → teal → magenta → rose → ember.
export const LEVEL_HUE_BANDS = Object.freeze([
  { fromLevel: 1,  hue: 200 }, // cyan
  { fromLevel: 5,  hue: 280 }, // violet
  { fromLevel: 10, hue: 220 }, // blue
  { fromLevel: 15, hue: 150 }, // green-aurora
  { fromLevel: 20, hue: 180 }, // teal
  { fromLevel: 25, hue: 320 }, // magenta
  { fromLevel: 30, hue: 350 }, // rose-red
  { fromLevel: 40, hue:  25 }, // ember (warm — end-game intensity)
]);

/**
 * Resting nebula hue for the given level. Linear scan over the bands
 * (only ~8 entries — binary search would be premature optimization).
 *
 * @param {number} level  1-indexed level number from `gameplay/scoring.js`.
 * @returns {number} hue in [0, 360).
 */
export function hueForLevel(level) {
  let chosen = LEVEL_HUE_BANDS[0].hue;
  for (const band of LEVEL_HUE_BANDS) {
    if (level >= band.fromLevel) chosen = band.hue;
    else break;
  }
  return chosen;
}

// Hue distance on the wrap-around circle.
function _hueDelta(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Random flash hue for the level-up wash. Always 60..180° away from
 * `currentHue` so the flash reads as a clear color shift, not a wobble.
 * Optionally also stays ≥30° from `alsoExclude` (passed when the level
 * crosses a band: keeps the flash from previewing the new resting).
 *
 * @param {number} currentHue        0..360
 * @param {number | null} [alsoExclude]
 * @param {() => number} [rng=Math.random]  Deterministic in tests.
 * @returns {number} hue in [0, 360)
 */
export function pickFlashHue(currentHue, alsoExclude = null, rng = Math.random) {
  // Sample up to 8 candidates that satisfy the constraint set; if none
  // qualifies (extremely unlikely with two exclusions on a 360° circle),
  // fall back to opposite-hue. Bounded loop guarantees termination.
  for (let i = 0; i < 8; i++) {
    const offset = 60 + rng() * 120;        // 60..180°
    const sign = rng() < 0.5 ? -1 : 1;
    const candidate = (currentHue + sign * offset + 360) % 360;
    if (alsoExclude == null) return candidate;
    if (_hueDelta(candidate, alsoExclude) >= 30) return candidate;
  }
  return (currentHue + 180) % 360;
}
