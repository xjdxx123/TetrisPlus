// Tests for the pure layer-detection algorithm (plan v2 §2.3).
//
// The algorithm is run against hand-crafted cube position arrays — no
// Rapier dependency, no THREE. Each test poses a "what would physics
// actually settle to" arrangement and asserts the right cubes are
// detected as a clearable layer (or correctly NOT detected).

import { describe, it, expect } from 'vitest';
import { detectLayers, indicesToClear, _DEFAULT_OPTS } from './layer-detection.js';

// Shorthand — build a cube at (x, y, z=0). Z stays constant for the
// 2D Tetris case (every test below).
const c = (x, y, z = 0) => ({ x, y, z });

describe('detectLayers — simple horizontal row', () => {
  it('a perfectly-horizontal row of 10 cubes at y=0 is one layer', () => {
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 0));
    const layers = detectLayers(cubes);
    expect(layers).toHaveLength(1);
    expect(layers[0].cubeIndices).toHaveLength(10);
    expect(layers[0].centerY).toBe(0);
    expect(layers[0].minY).toBe(0);
    expect(layers[0].maxY).toBe(0);
  });

  it('9 cubes is NOT a layer (need minSize=10)', () => {
    const cubes = [];
    for (let x = 0; x < 9; x++) cubes.push(c(x, 0));
    expect(detectLayers(cubes)).toHaveLength(0);
  });

  it('two perfect rows produce two layers, sorted bottom-up', () => {
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 4)); // upper row
    for (let x = 0; x < 10; x++) cubes.push(c(x, 0)); // lower row
    const layers = detectLayers(cubes);
    expect(layers).toHaveLength(2);
    // Bottom-first sort: layers[0] is y=0, layers[1] is y=4.
    expect(layers[0].centerY).toBe(0);
    expect(layers[1].centerY).toBe(4);
  });
});

describe('detectLayers — slightly-tilted row (the "good emergent" case)', () => {
  it('cubes at staggered Y within ±0.4 form a layer', () => {
    // 10 cubes at incrementing Y between 4.0 and 4.4 — total range 0.4,
    // within the default yBand of 0.8. All face-touching pairwise (dy
    // between adjacent cubes is ~0.044). Should clear.
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 4 + (x * 0.044)));
    const layers = detectLayers(cubes);
    expect(layers).toHaveLength(1);
    expect(layers[0].cubeIndices).toHaveLength(10);
    expect(layers[0].maxY - layers[0].minY).toBeCloseTo(0.4 * 99 / 100, 3); // ~0.396
  });

  it('cubes spanning a Y range BEYOND yBand do NOT form a layer (diagonal staircase rejection)', () => {
    // 10 cubes at Y = 4.0, 4.1, 4.2, ..., 4.9 — pairwise dy = 0.1
    // (within yLink=0.8, so they ARE connected), but total span is 0.9
    // (> yBand=0.8) so the post-filter rejects it as a layer.
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 4 + x * 0.1));
    expect(detectLayers(cubes)).toHaveLength(0);
  });
});

describe('detectLayers — gaps and disconnected groups', () => {
  it('a row with a 1-cell gap (cube missing in the middle) does NOT clear', () => {
    // x = 0..3, then 5..9 (cube at x=4 missing). The two halves are
    // separated by a gap (|dx| = 2.0 between x=3 and x=5), wider than
    // xLink=1.4, so they're NOT connected. Each half is < 10 cubes.
    const cubes = [];
    for (let x = 0; x < 4; x++) cubes.push(c(x, 0));
    for (let x = 5; x < 10; x++) cubes.push(c(x, 0));
    expect(detectLayers(cubes)).toHaveLength(0);
  });

  it('a row with a barely-wider-than-cell gap (1.5) splits into two components', () => {
    // x = 0..4 then x = 5.5..10.5, missing roughly one cube width.
    const cubes = [];
    for (let x = 0; x < 5; x++) cubes.push(c(x, 0));
    for (let x = 0; x < 5; x++) cubes.push(c(x + 5.5, 0));
    expect(detectLayers(cubes)).toHaveLength(0); // each component < 10
  });

  it('a row with cubes overlapping closer than 1.0 (e.g., a wedged double-stacked column) still counts each cube once', () => {
    // 10 normal cubes at y=0, plus 1 extra cube wedged at (4, 0.05)
    // due to settling. The extra cube is connected to its neighbors
    // (dx<1.4, dy=0.05<0.8) and is part of the same layer.
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 0));
    cubes.push(c(4, 0.05));
    const layers = detectLayers(cubes);
    expect(layers).toHaveLength(1);
    expect(layers[0].cubeIndices).toHaveLength(11);
  });
});

describe('detectLayers — multi-layer scenarios', () => {
  it('three stacked rows produce three layers (each > 10 cubes)', () => {
    const cubes = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 10; x++) cubes.push(c(x, y));
    }
    const layers = detectLayers(cubes);
    expect(layers).toHaveLength(3);
    expect(layers.map(l => l.centerY)).toEqual([0, 1, 2]);
  });

  it('a single full row + sparse junk above does NOT incorrectly merge', () => {
    // Bottom row full at y=0; 3 stray cubes at y=4 (way above, below
    // minSize threshold).
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 0));
    cubes.push(c(2, 4));
    cubes.push(c(5, 4));
    cubes.push(c(8, 4));
    const layers = detectLayers(cubes);
    expect(layers).toHaveLength(1);
    expect(layers[0].centerY).toBe(0);
  });
});

describe('detectLayers — input edge cases', () => {
  it('empty input returns an empty layer list', () => {
    expect(detectLayers([])).toEqual([]);
  });

  it('input below minSize returns empty (early return)', () => {
    const cubes = [];
    for (let x = 0; x < 9; x++) cubes.push(c(x, 0));
    expect(detectLayers(cubes)).toHaveLength(0);
  });

  it('cubes at constant z are unaffected by zLink (default 2D)', () => {
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 0, 0.5));
    expect(detectLayers(cubes)).toHaveLength(1);
  });

  it('cubes split across two different Z planes do NOT merge with default zLink', () => {
    // First 6 at z=0, next 4 at z=2.0 (>= zLink default 1.4 → not connected).
    const cubes = [];
    for (let x = 0; x < 6; x++) cubes.push(c(x, 0, 0));
    for (let x = 0; x < 4; x++) cubes.push(c(x + 6, 0, 2.0));
    expect(detectLayers(cubes)).toHaveLength(0);
  });
});

describe('detectLayers — opts', () => {
  it('minSize override allows smaller layers', () => {
    const cubes = [];
    for (let x = 0; x < 5; x++) cubes.push(c(x, 0));
    const layers = detectLayers(cubes, { minSize: 5 });
    expect(layers).toHaveLength(1);
  });

  it('yBand override admits taller "layers" (e.g., for forgiveness mode)', () => {
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x, 4 + x * 0.15));
    // Total range 1.35 > default 0.8. With yBand: 1.5, it qualifies.
    expect(detectLayers(cubes, { yBand: 1.5 })).toHaveLength(1);
  });

  it('xLink override allows wider-spaced rows (e.g., tilted but still touching at corners)', () => {
    const cubes = [];
    for (let x = 0; x < 10; x++) cubes.push(c(x * 1.5, 0));
    // Default xLink=1.4 — adjacent cubes are 1.5 apart, so they don't
    // link. Bumping xLink to 1.6 makes them adjacent.
    expect(detectLayers(cubes)).toHaveLength(0);
    expect(detectLayers(cubes, { xLink: 1.6 })).toHaveLength(1);
  });
});

describe('indicesToClear', () => {
  it('returns the union of all layer indices, sorted', () => {
    const layers = [
      { cubeIndices: [3, 1, 2], centerY: 0, minY: 0, maxY: 0 },
      { cubeIndices: [5, 7, 6], centerY: 1, minY: 1, maxY: 1 },
    ];
    expect(indicesToClear(layers)).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it('dedupes when layers share a cube index (defensive)', () => {
    // Shouldn't happen with the standard detector, but the helper is
    // robust against accidental duplication.
    const layers = [
      { cubeIndices: [1, 2, 3], centerY: 0, minY: 0, maxY: 0 },
      { cubeIndices: [3, 4, 5], centerY: 1, minY: 1, maxY: 1 },
    ];
    expect(indicesToClear(layers)).toEqual([1, 2, 3, 4, 5]);
  });

  it('empty input returns empty array', () => {
    expect(indicesToClear([])).toEqual([]);
  });
});

describe('_DEFAULT_OPTS', () => {
  it('exposes the default thresholds for documentation / tests', () => {
    expect(_DEFAULT_OPTS).toEqual({
      xLink: 1.4, yLink: 0.8, yBand: 0.8, minSize: 10, zLink: 1.4,
    });
  });
});
