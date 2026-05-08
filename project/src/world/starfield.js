// Sparse starfield on a far sphere shell. Static positions, slow group
// rotation only — no per-frame buffer uploads. One draw call.
//
// Stage 1 of plan_particle_2.md. Stays as-is into Stage 5 where bands.air.norm
// will gate a subtle twinkle uniform.

import * as THREE from 'three';
import VERT from '../shaders/starfield.vert.glsl?raw';
import FRAG from '../shaders/starfield.frag.glsl?raw';

export function createStarfield({
  count = 10000,
  radius = 100,
  baseColor = 0xb8c4ff,    // pale lavender-white
  accentColor = 0xff9ed0,  // warm pink for variation
  pixelRatio = 1,
  rotationSpeed = 0.006,   // radians/sec on Y; very slow drift
} = {}) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  // Even sphere distribution via inverse-CDF (Marsaglia / spherical coords).
  // Push 8% of stars to a tighter inner shell so the field has visible depth
  // when the camera moves rather than reading as a flat skybox.
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = (Math.random() < 0.08) ? radius * 0.7 : radius;
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Size distribution skewed small; ~10% are "bright" stars.
    const isBright = Math.random() < 0.10;
    sizes[i] = isBright ? 1.6 + Math.random() * 1.2 : 0.6 + Math.random() * 0.7;
    seeds[i] = Math.random();
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor:       { value: new THREE.Color(baseColor) },
      uColorAccent: { value: new THREE.Color(accentColor) },
      uPx:          { value: pixelRatio },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  // Stage 2 (selective bloom) reads this flag from material.userData.
  mat.userData.enableBloom = true;

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // sphere is large enough that culling is wrong
  points.renderOrder = -1;       // drawn before opaque scene; far depth

  // Wrap in a group so we can rotate the whole field cheaply.
  const group = new THREE.Group();
  group.add(points);

  return {
    group,
    points,
    material: mat,

    // Slow Y-axis rotation, advanced by the engine clock so it stays in sync
    // with the rest of the engine's render tick (no internal clock state).
    update(dt) {
      group.rotation.y += rotationSpeed * dt;
    },

    setPixelRatio(px) {
      mat.uniforms.uPx.value = px;
    },

    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
