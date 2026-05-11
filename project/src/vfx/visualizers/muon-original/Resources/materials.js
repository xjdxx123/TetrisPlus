import * as THREE from "three";
// Patched for vendored use: glslify dropped (no #pragma directives in these
// shaders, so it was an identity wrapper); Vite ?raw imports for the GLSL.
import particleVertexShader from "../Shaders/particleVertexShader.glsl?raw";
import particleFragmentShader from "../Shaders/particleFragmentShader.glsl?raw";
import { Uniforms } from "../CoreControls/wave";

export default {
  particleMaterial: new THREE.ShaderMaterial({
    uniforms: Uniforms,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    transparent: true,
    vertexColors: true,
    vertexShader: particleVertexShader,
    fragmentShader: particleFragmentShader,
  }),
};
