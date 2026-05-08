// Nebula sky — Stage 10 of plan_particle_2.md.
//
// A back-side icosahedron sphere centered at world origin, rendered with
// the procedural fbm-noise + palette-LUT shader. Camera orbit reveals
// different parts of the nebula since the sphere stays world-fixed.
//
// Cross-fade between palettes via the shader's dual-LUT path: uPaletteA
// holds the current palette, uPaletteB the target, uStageBlend lerps
// 0 → 1 over the requested duration. On completion, B is promoted to A
// and uStageBlend resets so subsequent fades start fresh.
//
// Future Stage 8 hooks: subscribe to STAGE_CHANGE events and call
// `crossfadeTo(stage.nebulaPalette, 2.5)`. Today exposed via console
// (`__nebula.crossfadeTo('ember')`).

import * as THREE from 'three';
import VERT from '../shaders/nebula.vert.glsl?raw';
import FRAG from '../shaders/nebula.frag.glsl?raw';
import { getPalette, PALETTE_NAMES, getPaletteForHue } from '../config/palettes.js';

export function createNebulaSky({
  radius = 120,
  initialPalette = 'deep-cyan',
  intensity = 0.35,
  detail = 4,                    // icosahedron subdivision; 4 = 1280 tris (plenty smooth)
} = {}) {
  if (!PALETTE_NAMES.includes(initialPalette)) {
    throw new Error(`Unknown initial palette: ${initialPalette}. Available: ${PALETTE_NAMES.join(', ')}`);
  }

  const geo = new THREE.IcosahedronGeometry(radius, detail);

  const initialTex = getPalette(initialPalette);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:       { value: 0 },
      uIntensity:  { value: intensity },
      uPaletteA:   { value: initialTex },
      uPaletteB:   { value: initialTex },
      uStageBlend: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,   // we view the inside of the sphere
    depthWrite: false,
    depthTest: false,       // always behind everything
    fog: false,
  });
  // Stage 2 selective bloom: nebula MUST NOT bloom — it's atmosphere, not
  // light. Without this, even a dim nebula would feed bloom and start to
  // compete with the playfield's emissive layers.
  mat.userData.enableBloom = false;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;        // render before everything else
  mesh.frustumCulled = false;    // sphere is always around the camera

  let currentName = initialPalette;
  let nextName = initialPalette;
  // Track hue independently — set by `crossfadeToHue` callers, null when
  // the current palette is name-based (set via `crossfadeTo`). Lets the
  // level-up logic know what hue to flash *away* from.
  let currentHue = null;
  let crossfadeStart = 0;
  let crossfadeDuration = 0;

  return {
    mesh,
    material: mat,

    // Drive each render frame from the engine clock.
    update(_dt, totalSec) {
      mat.uniforms.uTime.value = totalSec;
      if (crossfadeDuration > 0) {
        const elapsed = totalSec - crossfadeStart;
        const t = Math.min(1, elapsed / crossfadeDuration);
        mat.uniforms.uStageBlend.value = t;
        if (t >= 1) {
          // Promote B → A so subsequent fades start from this state.
          mat.uniforms.uPaletteA.value = mat.uniforms.uPaletteB.value;
          mat.uniforms.uStageBlend.value = 0;
          crossfadeDuration = 0;
          currentName = nextName;
        }
      }
    },

    // Trigger a palette crossfade. Idempotent if already on the target
    // and not currently crossfading.
    crossfadeTo(name, durationSec = 2.5) {
      if (!PALETTE_NAMES.includes(name)) {
        console.warn(`[nebula] unknown palette '${name}'. Available:`, PALETTE_NAMES);
        return;
      }
      if (name === currentName && crossfadeDuration === 0) return;
      // If a previous crossfade is mid-flight, snap A to its current
      // visible state (currently displayed mix of A→B) before starting
      // the next one. Cheapest correct option: snap A to B and start
      // fresh from there. Brief pop on rapid back-to-back fades, but
      // those are unusual.
      if (crossfadeDuration > 0) {
        mat.uniforms.uPaletteA.value = mat.uniforms.uPaletteB.value;
      }
      mat.uniforms.uPaletteB.value = getPalette(name);
      mat.uniforms.uStageBlend.value = 0;
      crossfadeStart = mat.uniforms.uTime.value;
      crossfadeDuration = durationSec;
      nextName = name;
      currentHue = null; // name-based path clears the hue tracker
    },

    /**
     * Crossfade to a hue-generated palette. Same machinery as `crossfadeTo`,
     * just with a procedurally generated DataTexture from `getPaletteForHue`.
     * `currentHue` getter exposes the hue post-fade so the level-up wash
     * knows what to flash *away* from.
     */
    crossfadeToHue(hue, durationSec = 2.5) {
      const tex = getPaletteForHue(hue);
      if (mat.uniforms.uPaletteB.value === tex && crossfadeDuration === 0) return;
      if (crossfadeDuration > 0) {
        mat.uniforms.uPaletteA.value = mat.uniforms.uPaletteB.value;
      }
      mat.uniforms.uPaletteB.value = tex;
      mat.uniforms.uStageBlend.value = 0;
      crossfadeStart = mat.uniforms.uTime.value;
      crossfadeDuration = durationSec;
      // Use a synthetic name so any code reading `current` for diagnostics
      // gets something meaningful. Round to integer for stability.
      const h = (((hue % 360) + 360) % 360);
      nextName = `hue:${Math.round(h)}`;
      currentHue = h;
    },

    setIntensity(v) { mat.uniforms.uIntensity.value = v; },
    get intensity() { return mat.uniforms.uIntensity.value; },
    get current()   { return currentName; },
    get currentHue() { return currentHue; }, // null when name-based, else 0..360
    get available() { return PALETTE_NAMES; },

    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
