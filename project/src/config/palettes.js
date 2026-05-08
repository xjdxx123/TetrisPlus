// Stage palettes — color stops that bake into 256x1 RGBA LUT textures used
// by the nebula sky shader (and reusable by Stage 8's stage system).
//
// A palette is an ordered array of { t, color } stops where t ∈ [0,1] is
// the position in the gradient and color is [r, g, b] in linear-ish [0,1].
// LinearFilter sampling between stops produces the smooth gradient.
//
// Hue discipline rule (plan_particle_2.md §1.7): each stage stays within a
// 30–60° arc on the color wheel for any given level, with one accent hue
// used sparingly. Bloom amplifies the dominant hue, so a wide-spectrum
// palette blooms into mud — anchor each stage tightly.

import * as THREE from 'three';

const PALETTES = {
  // Default — matches the existing dark/violet/cyan vibe of the project's
  // current 'void' mood preset. Anchored on indigo/purple with a bright
  // cyan-violet streak as the accent.
  'deep-cyan': [
    { t: 0.00, color: [0.02, 0.03, 0.10] }, // very dark blue (sparse / deep space)
    { t: 0.30, color: [0.08, 0.06, 0.18] }, // dark indigo
    { t: 0.60, color: [0.22, 0.10, 0.45] }, // violet (denser cloud regions)
    { t: 0.85, color: [0.45, 0.20, 0.75] }, // purple-pink (bright filaments)
    { t: 1.00, color: [0.20, 0.55, 0.95] }, // cyan accent (brightest hot spots)
  ],

  // Warm alternative — orange/red/gold ember palette.
  'ember': [
    { t: 0.00, color: [0.05, 0.02, 0.05] }, // near-black
    { t: 0.30, color: [0.18, 0.05, 0.08] }, // dark red-brown
    { t: 0.60, color: [0.50, 0.18, 0.10] }, // amber
    { t: 0.85, color: [0.85, 0.42, 0.18] }, // bright orange
    { t: 1.00, color: [1.00, 0.78, 0.35] }, // golden hot spots
  ],

  // Sea-green / aurora palette — calm, organic.
  'aurora': [
    { t: 0.00, color: [0.02, 0.05, 0.06] }, // deep teal-black
    { t: 0.30, color: [0.05, 0.15, 0.18] }, // dark sea-green
    { t: 0.60, color: [0.10, 0.45, 0.40] }, // teal cloud
    { t: 0.85, color: [0.40, 0.85, 0.55] }, // green aurora streak
    { t: 1.00, color: [0.75, 0.95, 0.70] }, // pale yellow-green tip
  ],

  // Pure black — for testing or dark scenes (kills the nebula visually).
  'void': [
    { t: 0.00, color: [0.00, 0.00, 0.00] },
    { t: 1.00, color: [0.00, 0.00, 0.00] },
  ],
};

function buildLUT(stops, size = 256) {
  // Defensive: stops should be sorted by t ascending. We don't sort in place
  // (mutation), but assume they're authored correctly.
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    // Find the segment containing t.
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j].t && t <= stops[j + 1].t) {
        lo = stops[j];
        hi = stops[j + 1];
        break;
      }
    }
    const span = Math.max(1e-6, hi.t - lo.t);
    const segT = (t - lo.t) / span;
    const r = lo.color[0] + (hi.color[0] - lo.color[0]) * segT;
    const g = lo.color[1] + (hi.color[1] - lo.color[1]) * segT;
    const b = lo.color[2] + (hi.color[2] - lo.color[2]) * segT;
    data[i * 4 + 0] = Math.round(255 * Math.max(0, Math.min(1, r)));
    data[i * 4 + 1] = Math.round(255 * Math.max(0, Math.min(1, g)));
    data[i * 4 + 2] = Math.round(255 * Math.max(0, Math.min(1, b)));
    data[i * 4 + 3] = 255;
  }
  return data;
}

const _texCache = new Map();

export function getPalette(name) {
  if (_texCache.has(name)) return _texCache.get(name);
  const stops = PALETTES[name];
  if (!stops) throw new Error(`Unknown palette: ${name}`);
  const data = buildLUT(stops);
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _texCache.set(name, tex);
  return tex;
}

// Tests use the raw bake function without the THREE dependency.
export function _buildLUT(stops, size = 256) {
  return buildLUT(stops, size);
}

export const PALETTE_NAMES = Object.keys(PALETTES);
