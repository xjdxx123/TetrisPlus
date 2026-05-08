// Procedural moon — Stage 10 polish layer (per `plan_particle_2.md` §9.6,
// pivoted from the original "low-poly cosmic structure" sketch in favour
// of a single hero celestial body with high-frequency surface detail and
// a soft violet halo).
//
// Composition (returned as a `Group`):
//   1. Disc       — high-segment SphereGeometry. Custom shader doing
//                   Lambertian shading + multi-octave FBM albedo / bump
//                   perturbation. Opaque, depth-writes, NOT bloom-eligible
//                   (a glowing-from-the-inside moon reads as a light bulb,
//                   not a celestial body).
//   2. Halo       — camera-facing PlaneGeometry billboarded in the vertex
//                   shader. Soft radial falloff, additive, bloom-eligible.
//                   The bloom pass turns the halo into a dreamy violet
//                   corona without the disc itself ever blowing out.
//
// Render order: opaque pass writes the disc into depth → transparent pass
// adds the halo with depthTest=true so the disc occludes the halo's center
// (only the outer ring around the disc is visible). One draw call each.

import * as THREE from 'three';
import VERT from '../shaders/moon.vert.glsl?raw';
import FRAG from '../shaders/moon.frag.glsl?raw';

// Halo shaders are tiny + single-use; inline them rather than carving out
// dedicated .glsl files for an effect that lives entirely in this module.
const HALO_VERT = /* glsl */`
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    // Billboard: pull the model origin into view space, then add the
    // quad's local XY (scaled by uSize) WITHOUT rotation. The quad
    // always faces the camera regardless of the parent group's
    // orientation — and the parent's translation still applies because
    // it lives in modelViewMatrix.
    vec4 originVP = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 viewPos  = originVP + vec4(position.x * uSize, position.y * uSize, 0.0, 0.0);
    gl_Position = projectionMatrix * viewPos;
    vUv = uv;
  }
`;
const HALO_FRAG = /* glsl */`
  uniform vec3  uColor;
  uniform float uIntensity;
  uniform float uFalloff;       // power; higher = tighter halo
  uniform float uInnerRadius;   // 0..1 in quad-uv; below this the gradient
                                // is held flat-bright (matches the disc edge)
  varying vec2 vUv;
  void main() {
    // Distance from quad center in [0,1] where 1 = quad edge.
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    // The disc occupies the center; we don't want to fight the disc's
    // shading there. Hold a flat plateau inside uInnerRadius, then fade
    // to zero with a power curve outside it.
    float t;
    if (r < uInnerRadius) {
      t = 1.0;
    } else {
      float k = (r - uInnerRadius) / max(1e-4, 1.0 - uInnerRadius);
      t = pow(max(0.0, 1.0 - k), uFalloff);
    }
    if (t < 0.004) discard;
    // Output as alpha-premultiplied RGB so the same shader works for both
    // additive and standard alpha blending; we use additive so the alpha
    // channel is effectively ignored, but premultiplying keeps the bloom
    // contribution proportional to the visible color.
    gl_FragColor = vec4(uColor * t * uIntensity, t);
  }
`;

/**
 * @typedef {Object} MoonOpts
 * @property {THREE.Vector3 | [number, number, number]} [position]  World-space
 *   center. Default sits above the case (not behind it) and slightly
 *   off-center, so the disc dominates the upper portion of the frame
 *   without feeling pressed against the case.
 * @property {number} [radius=12]
 * @property {number} [segments=96]
 * @property {THREE.Vector3 | [number, number, number]} [sunDir]   Direction
 *   the moon is lit FROM. Mostly-frontal so the disc reads as full, with
 *   a small offset so the terminator sits gently across one edge.
 * @property {number} [highlandColor=0xe6dccd]   Warm cream highlands.
 * @property {number} [mareColor=0x8a7c93]       Lavender-tinted mare.
 * @property {number} [earthshineColor=0x301a55] Violet ambient on dark side.
 * @property {number} [terminatorSoftness=0.55]  0..1: 0 = hard line, 1 = no
 *   visible terminator. Reference looks mostly fully lit, so high default.
 * @property {number} [intensity=1.0]
 * @property {number} [spinSpeed=0.012]
 * @property {number} [bumpStrength=0.55]
 * @property {number} [mareScale=1.4]
 * @property {number} [craterScale=6.0]
 * @property {number} [fineScale=18.0]
 * @property {number} [haloColor=0xb088ff]   Violet-pink corona.
 * @property {number} [haloSizeMul=2.6]      Halo extent as a multiple of the
 *   moon's apparent diameter — 2.6× means the visible halo ring is roughly
 *   the moon's radius wide on each side.
 * @property {number} [haloIntensity=0.85]
 * @property {number} [haloFalloff=2.4]
 * @property {number} [haloInnerRadius=0.38] In quad-UV; should be ≈ disc
 *   radius / quad radius so the bright plateau matches the visible disc.
 */

/**
 * @param {MoonOpts} opts
 */
export function createMoon({
  position = new THREE.Vector3(-15, 25, -28),
  radius = 12,
  segments = 96,
  sunDir = new THREE.Vector3(0.25, 0.30, 0.95),
  highlandColor = 0xe6dccd,
  mareColor = 0x8a7c93,
  earthshineColor = 0x301a55,
  terminatorSoftness = 0.55,
  intensity = 1.0,
  spinSpeed = 0.012,
  bumpStrength = 0.55,
  mareScale = 1.4,
  craterScale = 6.0,
  fineScale = 18.0,
  haloColor = 0xb088ff,
  haloSizeMul = 2.6,
  haloIntensity = 0.85,
  haloFalloff = 2.4,
  haloInnerRadius = 0.38,
} = {}) {
  // === Disc =============================================================
  const discGeo = new THREE.SphereGeometry(radius, segments, segments);
  const sun = sunDir instanceof THREE.Vector3
    ? sunDir.clone().normalize()
    : new THREE.Vector3(...sunDir).normalize();

  const discMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir:             { value: sun },
      uHighlandColor:      { value: new THREE.Color(highlandColor) },
      uMareColor:          { value: new THREE.Color(mareColor) },
      uEarthshine:         { value: new THREE.Color(earthshineColor) },
      uIntensity:          { value: intensity },
      uBumpStrength:       { value: bumpStrength },
      uMareScale:          { value: mareScale },
      uCraterScale:        { value: craterScale },
      uFineScale:          { value: fineScale },
      uTerminatorSoftness: { value: terminatorSoftness },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
  });
  // Explicitly NOT bloom-eligible — the disc reads as a solid surface.
  // The bloom belongs to the halo, not to the moon body.
  discMat.userData.enableBloom = false;
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.renderOrder = -1; // opaque pass, behind the playfield

  // === Halo =============================================================
  // Quad sized to (haloSizeMul × diameter) on each axis. The shader scales
  // it via uSize so we only need a unit quad here.
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  const haloMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor:        { value: new THREE.Color(haloColor) },
      uIntensity:    { value: haloIntensity },
      uFalloff:      { value: haloFalloff },
      uInnerRadius:  { value: haloInnerRadius },
      uSize:         { value: radius * haloSizeMul },
    },
    vertexShader:   HALO_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest:  true,           // the disc occludes the inner ring
    blending:   THREE.AdditiveBlending,
    fog: false,
  });
  // Bloom-eligible: the soft violet bloom over the halo IS the desired
  // effect — without it the corona reads as a flat ring, with it as a
  // dreamy aura that sells the moon as luminous despite the disc itself
  // not glowing.
  haloMat.userData.enableBloom = true;
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.frustumCulled = false; // billboard sits at moon position; cull is correct
                              // but the math fights the override-hidden vertex
                              // shader, so we skip it for safety.
  halo.renderOrder = 0;       // transparent pass; depthTest discards inside disc

  // === Group =============================================================
  const group = new THREE.Group();
  group.add(disc);
  group.add(halo);
  if (position instanceof THREE.Vector3) {
    group.position.copy(position);
  } else {
    group.position.set(...position);
  }

  // Random initial axis tilt — gives a stable, slightly canted spin axis
  // so the visible terminator + mare patterns feel "natural" rather than
  // grid-aligned. Only rotates the disc — the halo is camera-facing.
  const _spinAxis = new THREE.Vector3(0.12, 1.0, 0.05).normalize();

  return {
    group,
    mesh: disc,        // back-compat alias for callers that referenced the disc
    halo,
    material: discMat,
    haloMaterial: haloMat,

    /** Slow disc rotation. Real-time `dt` so the moon keeps spinning
     *  during pause (it's environment, not gameplay). The halo is
     *  view-aligned so it doesn't move with this. */
    update(dt) {
      disc.rotateOnAxis(_spinAxis, spinSpeed * dt);
    },

    setVisible(on) {
      group.visible = !!on;
    },

    /** Brightness lever. Reserved for future per-scene lighting tweaks
     *  (e.g. dimming during line-clear flashes). Scales BOTH the disc
     *  shading and the halo intensity so they stay coherent. */
    setIntensity(v) {
      const clamped = Math.max(0, Math.min(2, v));
      discMat.uniforms.uIntensity.value = clamped;
      haloMat.uniforms.uIntensity.value = haloIntensity * clamped;
    },

    dispose() {
      discGeo.dispose();
      discMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
    },
  };
}
