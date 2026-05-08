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

  // Aurora variants — same "atmospheric cool" feel, different hue arcs.
  // Each holds a 30–60° arc per the §1.7 hue-discipline rule so bloom
  // amplifies a single dominant hue rather than smearing into mud.

  // Cosmic violet — matches the reference moon image (screenshots/image.png).
  'aurora-violet': [
    { t: 0.00, color: [0.05, 0.02, 0.10] }, // deep purple-black
    { t: 0.30, color: [0.12, 0.05, 0.25] }, // dark indigo
    { t: 0.60, color: [0.40, 0.15, 0.65] }, // violet
    { t: 0.85, color: [0.75, 0.30, 0.85] }, // bright magenta-pink
    { t: 1.00, color: [0.90, 0.65, 1.00] }, // pale lavender
  ],

  // Vivid magenta northern-lights variant.
  'aurora-magenta': [
    { t: 0.00, color: [0.04, 0.02, 0.06] }, // dark purple-black
    { t: 0.30, color: [0.20, 0.05, 0.20] }, // deep magenta
    { t: 0.60, color: [0.65, 0.20, 0.55] }, // bright magenta
    { t: 0.85, color: [0.95, 0.45, 0.80] }, // vivid pink
    { t: 1.00, color: [1.00, 0.85, 0.95] }, // pale rose
  ],

  // Teal-mint — colder than 'aurora' (which leans yellow-green).
  'aurora-teal': [
    { t: 0.00, color: [0.01, 0.04, 0.06] }, // deep teal-black
    { t: 0.30, color: [0.05, 0.20, 0.25] }, // dark teal
    { t: 0.60, color: [0.15, 0.55, 0.65] }, // bright teal
    { t: 0.85, color: [0.45, 0.85, 0.80] }, // cyan-mint
    { t: 1.00, color: [0.85, 0.98, 0.95] }, // pale aqua
  ],

  // Warmer rose-aurora — pinkier, slightly off-cool.
  'aurora-rose': [
    { t: 0.00, color: [0.06, 0.02, 0.04] }, // dark wine
    { t: 0.30, color: [0.25, 0.08, 0.15] }, // deep rose
    { t: 0.60, color: [0.65, 0.20, 0.30] }, // rose-red
    { t: 0.85, color: [0.95, 0.45, 0.55] }, // vibrant pink
    { t: 1.00, color: [1.00, 0.85, 0.85] }, // pale peach
  ],

  // Deep navy → sky blue. The most "cosmic" of the cool palettes — reads
  // as deep space rather than aurora-streaked sky.
  'cosmic-blue': [
    { t: 0.00, color: [0.01, 0.02, 0.10] }, // deep navy
    { t: 0.30, color: [0.05, 0.10, 0.30] }, // dark indigo
    { t: 0.60, color: [0.15, 0.35, 0.70] }, // mid blue
    { t: 0.85, color: [0.40, 0.65, 0.95] }, // bright sky-blue
    { t: 1.00, color: [0.80, 0.90, 1.00] }, // pale steel
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

// =============================================================
// Hue-based procedural palettes — Stage 10b.
// =============================================================
// Generate a 5-stop gradient from a single hue value. Same shape as the
// curated PALETTES (dark → dark → medium → bright → pale-with-hue-shift),
// just driven by HSL math rather than hand-picked colors.
//
// Why a fixed sat/lum profile instead of free-form: a single hue fully
// specifies the gradient via this profile, so the player picks ONE value
// and gets a coherent night-sky palette. Free-form would mean exposing
// 5 color pickers, which is overwhelming and lets bad combinations
// happen (e.g. a red-to-green gradient that blooms into mud).
//
// The profile mirrors the curated palettes' shape so generated gradients
// sit comfortably alongside any remaining hand-tuned ones (e.g. the
// stage-system palettes referenced by `nebulaPalette`).
const _HUE_PROFILE = Object.freeze([
  { t: 0.00, sat: 0.40, lum: 0.04, hueShift: 0     }, // very dark base
  { t: 0.30, sat: 0.55, lum: 0.13, hueShift: 0     }, // dark cloud
  { t: 0.60, sat: 0.70, lum: 0.32, hueShift: 0     }, // medium cloud
  { t: 0.85, sat: 0.75, lum: 0.55, hueShift: 0     }, // bright filament
  { t: 1.00, sat: 0.55, lum: 0.85, hueShift: 0.04  }, // pale tip — +14° toward analogous
]);

const _hueColor = new THREE.Color();

function _normHue(hue) {
  // Hue can come from a slider (0–360) or arithmetic that produced a
  // negative or >360 result (e.g. flash picker). Normalize and convert
  // to [0,1] for THREE.Color.setHSL.
  return (((hue % 360) + 360) % 360) / 360;
}

/**
 * Build a 5-stop gradient from a single hue. Returns the same `[{t,color}]`
 * shape the LUT bake expects.
 *
 * @param {number} hue 0..360
 * @returns {Array<{ t: number, color: [number, number, number] }>}
 */
export function paletteFromHue(hue) {
  const h0 = _normHue(hue);
  return _HUE_PROFILE.map((p) => {
    const h = (h0 + p.hueShift) % 1;
    _hueColor.setHSL(h < 0 ? h + 1 : h, p.sat, p.lum);
    return { t: p.t, color: [_hueColor.r, _hueColor.g, _hueColor.b] };
  });
}

const _hueTexCache = new Map();

/**
 * Get (or bake + cache) a DataTexture for a given hue. Cached by integer
 * hue — 360 max textures, ~360 KB if all populated, which is well under
 * any practical budget. Fractional hues are rounded; the slider's 1°
 * resolution makes this lossless in practice.
 *
 * @param {number} hue 0..360
 * @returns {THREE.DataTexture}
 */
export function getPaletteForHue(hue) {
  const key = Math.round(_normHue(hue) * 360) % 360;
  if (_hueTexCache.has(key)) return _hueTexCache.get(key);
  const stops = paletteFromHue(key);
  const data = buildLUT(stops);
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _hueTexCache.set(key, tex);
  return tex;
}

// Map curated stage palette names to representative hues so the STAGE_CHANGE
// handler can drive the nebula in hue-space (consistent with level-up and
// player-override paths). Add an entry whenever a new named palette gets
// referenced from a stage spec.
export const STAGE_HUE_FOR_NAME = Object.freeze({
  'deep-cyan':       200,
  'cosmic-blue':     220,
  'aurora':          150,
  'aurora-teal':     180,
  'aurora-violet':   280,
  'aurora-magenta':  320,
  'aurora-rose':     350,
  'ember':            25,
  'void':              0, // debug — pure black palette has no hue; pick something
});

// Tests use the raw bake function without the THREE dependency.
export function _buildLUT(stops, size = 256) {
  return buildLUT(stops, size);
}

export const PALETTE_NAMES = Object.keys(PALETTES);

// Human-readable names for the effects-panel palette dropdown. Order is
// authored (cool → warm → debug) so the dropdown reads naturally; keep
// in sync with PALETTES additions. Don't auto-derive — `aurora-violet`
// → "Aurora Violet" is fine but `cosmic-blue` → "Cosmic Blue" needs
// title-casing logic that's not worth the savings on 9 entries.
export const PALETTE_LABELS = Object.freeze({
  'deep-cyan':      'Deep Cyan',
  'cosmic-blue':    'Cosmic Blue',
  'aurora':         'Aurora (Sea Green)',
  'aurora-teal':    'Aurora Teal',
  'aurora-violet':  'Aurora Violet',
  'aurora-magenta': 'Aurora Magenta',
  'aurora-rose':    'Aurora Rose',
  'ember':          'Ember',
  'void':           'Void (debug)',
});
