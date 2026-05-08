// Chromatic aberration ShaderPass.
//
// Stage 6 of plan_particle_2.md. Wraps the radial CA shader as a Three.js
// ShaderPass so it slots into EffectComposer like any other post pass.
// The audio binding writes uAmount in [0, 1] each frame.

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import VERT from '../../shaders/vignette.vert.glsl?raw';   // identical passthrough
import FRAG from '../../shaders/chromatic.frag.glsl?raw';

export function createChromaticPass({ amount = 0.0 } = {}) {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uAmount:  { value: amount },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  return pass;
}
