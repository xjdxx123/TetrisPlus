// After-image (feedback accumulator) pass.
//
// Stage 6 of plan_particle_2.md. Wraps Three.js's built-in AfterimagePass —
// it ping-pongs a previous-frame texture and blends with `damp`. We don't
// need custom logic here yet; if we want max() vs lerp() composition or
// audio-modulated damp we can hand-roll later.
//
// Tuning rule (from the plan):
//   damp = 0.85  → mild ghost (use this default)
//   damp = 0.92  → noticeable trail
//   damp = 0.95+ → smear (avoid — reads as input lag)

import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';

export function createAfterimagePass({ damp = 0.85 } = {}) {
  const pass = new AfterimagePass(damp);
  return pass;
}
