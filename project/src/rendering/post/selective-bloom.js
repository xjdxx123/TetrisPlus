// Selective bloom via material-swap.
//
// Stage 2 of plan_particle_2.md. The earlier setup applied UnrealBloomPass to
// the *whole scene* — every fragment over the threshold contributed to bloom,
// including case glass and dim background, which muddied the look. The fix
// is to render the scene twice each frame:
//
//   1. Bloom pass: every material whose `userData.enableBloom !== true` is
//      temporarily swapped to a black MeshBasicMaterial. The remaining
//      materials (cube cores, sparkles, shards, ambient field, starfield,
//      hard-drop trails, line-clear flash) render against black, get blurred
//      by UnrealBloomPass, and produce the bloom layer texture.
//
//   2. Final pass: the scene renders normally; a small additive ShaderPass
//      adds the bloom layer texture on top.
//
// Cost: one extra scene render per frame (~30 draw calls in our scene; the
// material-swap pass is fast because most fragments output black and discard).
// Wins back the visual control we need — case glass stays calm, only the
// emitters bloom.
//
// Usage in main.js:
//   const sb = createSelectiveBloom({ renderer, scene, camera, ... });
//   // each frame, BEFORE composer.render():
//   sb.renderBloomLayer();
//   composer.render();
//
// Final composer caller is responsible for adding sb.combinePass into its
// pass chain (after RenderPass, before vignette / SMAA / output).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const BLACK_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x000000 });
BLACK_MATERIAL.transparent = true;
BLACK_MATERIAL.opacity = 0;     // truly invisible — additive blend over a
                                  // black canvas means nothing leaks through

// Combine shader: regular scene color + bloom texture, additive.
const CombineShader = {
  uniforms: {
    tDiffuse:    { value: null },   // base scene color
    tBloom:      { value: null },   // bloom layer
    uBloomScale: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float uBloomScale;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec4 bloom = texture2D(tBloom, vUv);
      gl_FragColor = vec4(base.rgb + bloom.rgb * uBloomScale, base.a);
    }
  `,
};

export function createSelectiveBloom({
  renderer,
  scene,
  camera,
  width,
  height,
  pixelRatio = 1,
  // Bloom params — tuned smaller than the previous full-scene UnrealBloom.
  // Selective bloom can afford a lower threshold because only emissive layers
  // pass through; the dim glass case can't blow out anymore.
  strength = 0.9,
  radius = 0.45,
  threshold = 0.0,    // 0 because the mask is what gates contribution now
  bloomScale = 1.0,
} = {}) {
  // Bloom composer — renders the masked scene then blurs.
  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.setPixelRatio(pixelRatio);
  bloomComposer.setSize(width, height);
  bloomComposer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    strength, radius, threshold,
  );
  bloomComposer.addPass(bloomPass);

  // Combine pass — added by the caller into the final composer.
  const combinePass = new ShaderPass(CombineShader);
  combinePass.uniforms.tBloom.value = bloomComposer.readBuffer.texture;
  combinePass.uniforms.uBloomScale.value = bloomScale;
  combinePass.needsSwap = true;

  // Material-swap state. We hold a Map<Mesh, originalMaterial> only during
  // the bloom render; outside that window the scene is untouched.
  const _swap = new Map();

  // Default-bloom rule: a material contributes to bloom UNLESS it is
  // explicitly tagged `userData.enableBloom === false`. Our scene's bloom
  // population (particles, sparkles, shards, glows, frame, starfield) is
  // 3–4× more numerous than the non-bloom glassy structure, so the inverse
  // default would mean dozens of brittle tag sites. With this rule, only
  // the structural materials (locked cube body, case glass, inner floor,
  // back grid) need to opt out.
  function isBloomEligible(mat) {
    return !(mat && mat.userData && mat.userData.enableBloom === false);
  }
  function darkenNonBloom(obj) {
    if (obj.isMesh || obj.isPoints || obj.isLineSegments || obj.isLine) {
      const m = obj.material;
      if (Array.isArray(m)) {
        const swapped = m.map((mat) => isBloomEligible(mat) ? mat : BLACK_MATERIAL);
        if (swapped.some((mat, i) => mat !== m[i])) {
          _swap.set(obj, m);
          obj.material = swapped;
        }
      } else if (m && !isBloomEligible(m)) {
        _swap.set(obj, m);
        obj.material = BLACK_MATERIAL;
      }
    }
  }

  function restoreMaterials() {
    _swap.forEach((mat, obj) => { obj.material = mat; });
    _swap.clear();
  }

  // Public render hook. Call BEFORE the final composer.render().
  function renderBloomLayer() {
    scene.traverse(darkenNonBloom);
    bloomComposer.render();
    restoreMaterials();
    // Ensure the combine pass sees the freshest bloom texture.
    combinePass.uniforms.tBloom.value = bloomComposer.readBuffer.texture;
  }

  function setSize(w, h) {
    bloomComposer.setSize(w, h);
    bloomPass.setSize(w, h);
  }

  return {
    renderBloomLayer,
    combinePass,
    bloomComposer,
    bloomPass,           // exposed so callers can tween .strength
    setSize,
    setBloomScale(v)  { combinePass.uniforms.uBloomScale.value = v; },
    get bloomTexture() { return bloomComposer.readBuffer.texture; },
  };
}
