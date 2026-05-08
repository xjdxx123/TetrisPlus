// Stage definitions — Stage 8 of plan_particle_2.md, per §1.6.4.
//
// Each stage owns:
//   - sparkleHex: the dominant hue used for line-clear sparkle (§1.6.2 rule 2 —
//                 NOT block color, this is what makes the sparkle read as "the
//                 room responding" instead of "more of the piece")
//   - accentHex:  HDR-boosted accent for flash / shockwave / camera-space veil
//                 (§1.6.2 rule 3 — feeds bloom in a hue-disciplined way)
//   - palette:    multi-color array for future per-row variety in sparkle bursts
//                 (§1.6.4 stage variation — currently informational; consumed
//                 in Stage 8b)
//   - nebulaPalette: cross-reference to a Stage 10 palette name in
//                    config/palettes.js. STAGE_CHANGE → nebula crossfade.
//   - clearRecipe: which §1.6.1 layers fire at which tier. The tiers map to
//                  row counts: 1=single, 2=double, 3=triple, 4=tetris. Each
//                  layer flag gates whether that emitter participates.
//
// Hue discipline rule (plan_particle_1.md §1.3): each stage stays within a
// 30–60° hue arc. Bloom amplifies the dominant hue, so wide-spectrum stages
// bloom into mud — anchor each stage tightly.

export const STAGES = {
  'cyan-void': {
    label: 'Cyan Void',
    sparkleHex: 0xaee7ff,                 // light cyan accent
    accentHex:  0x6cf0ff,                 // bright cyan
    palette:    [0xaee7ff, 0xff8acb, 0xc8b3ff, 0x6cf0ff],
    nebulaPalette: 'deep-cyan',
    clearRecipe: {
      single: { sparkle: true, flash: false, shockwave: false, veil: false },
      double: { sparkle: true, flash: false, shockwave: false, veil: false },
      triple: { sparkle: true, flash: false, shockwave: true,  veil: false },
      tetris: { sparkle: true, flash: true,  shockwave: true,  veil: true  },
    },
  },

  'ember-rise': {
    label: 'Ember Rise',
    sparkleHex: 0xffb060,                 // warm amber
    accentHex:  0xff6a30,                 // saturated orange
    palette:    [0xffb060, 0xff8a3c, 0xff5018, 0xffd0a0],
    nebulaPalette: 'ember',
    clearRecipe: {
      single: { sparkle: true, flash: false, shockwave: false, veil: false },
      double: { sparkle: true, flash: false, shockwave: false, veil: false },
      triple: { sparkle: true, flash: false, shockwave: true,  veil: false },
      tetris: { sparkle: true, flash: true,  shockwave: true,  veil: true  },
    },
  },

  'aurora': {
    label: 'Aurora',
    sparkleHex: 0xa0e6ff,                 // pale blue
    accentHex:  0x6cb0ff,                 // bright sky blue
    palette:    [0xa0e6ff, 0x6cb0ff, 0xb0ffd0, 0xd0ecff],
    nebulaPalette: 'aurora',
    clearRecipe: {
      single: { sparkle: true, flash: false, shockwave: false, veil: false },
      double: { sparkle: true, flash: false, shockwave: false, veil: false },
      triple: { sparkle: true, flash: false, shockwave: true,  veil: false },
      tetris: { sparkle: true, flash: true,  shockwave: true,  veil: true  },
    },
  },
};

export const STAGE_NAMES = Object.keys(STAGES);
export const DEFAULT_STAGE = 'cyan-void';

// Map a row count to a tier name. Used by the LineClearOrchestrator to look
// up the right recipe entry. The 4-row case is Tetris-tier; per §1.6.3 the
// orchestrator is also responsible for promoting to "perfect-clear-tier"
// when the board ends empty after the clear (Stage 8b).
export function tierForRows(rowCount) {
  if (rowCount >= 4) return 'tetris';
  if (rowCount === 3) return 'triple';
  if (rowCount === 2) return 'double';
  return 'single';
}
