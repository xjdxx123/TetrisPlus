import { describe, it, expect } from 'vitest';
import { build3DRules, _DEFAULT_DIMENSIONS, _FALL_INTERVAL_BASE_3D } from './rules.js';
import { LAYER_CLEAR_SCORE } from './layer-detection.js';

describe('build3DRules — shape', () => {
  it('returns a frozen Rules object keyed "3d"', () => {
    const r = build3DRules();
    expect(r.key).toBe('3d');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('exposes the default 10×20×10 dimensions', () => {
    const r = build3DRules();
    expect(r.dimensions).toEqual({ COLS: 10, ROWS: 20, DEPTH: 10 });
    expect(r.dimensions).toEqual(_DEFAULT_DIMENSIONS);
  });

  it('declares pieceSet:"tetracubes" so the host swaps the piece registry', () => {
    expect(build3DRules().pieceSet).toBe('tetracubes');
  });

  it('initialModeView identifies 3d for the HUD switch', () => {
    const r = build3DRules();
    expect(r.initialModeView).toEqual({
      kind: '3d',
      layersCleared: 0,
      level: 1,
      bestLayerCount: 0,
    });
  });

  it('softDrop / hardDrop point values match the standard constants', () => {
    const r = build3DRules();
    expect(r.softDropPerCell).toBe(1);
    expect(r.hardDropPerCell).toBe(2);
  });

  it('resetsHighScoreSlot is FALSE — 3D scores live in their own slot', () => {
    expect(build3DRules().resetsHighScoreSlot).toBe(false);
  });

  it('goalMultiplier is 1.0 (explicit opt-out of §12 multiplier paths)', () => {
    expect(build3DRules().goalMultiplier).toBe(1.0);
  });
});

describe('build3DRules — dimensions option', () => {
  it('accepts a custom 6×6×6 footprint (archived §6.11 advanced variant)', () => {
    const r = build3DRules({ dimensions: { COLS: 6, ROWS: 12, DEPTH: 6 } });
    expect(r.dimensions).toEqual({ COLS: 6, ROWS: 12, DEPTH: 6 });
  });

  it('falls back to defaults on invalid dimensions (forward-compat with stale persisted opts)', () => {
    expect(build3DRules({ dimensions: null }).dimensions).toEqual(_DEFAULT_DIMENSIONS);
    expect(build3DRules({ dimensions: { COLS: 0 } }).dimensions).toEqual(_DEFAULT_DIMENSIONS);
    expect(build3DRules({ dimensions: { COLS: 'wide' } }).dimensions).toEqual(_DEFAULT_DIMENSIONS);
  });

  it('rejects below-minimum axes (4-cell I-tetracube needs at least 4 in some axis)', () => {
    const r = build3DRules({ dimensions: { COLS: 3, ROWS: 20, DEPTH: 10 } });
    expect(r.dimensions.COLS).toBe(_DEFAULT_DIMENSIONS.COLS);
  });

  it('produces a frozen dimensions object', () => {
    const r = build3DRules();
    expect(Object.isFrozen(r.dimensions)).toBe(true);
  });
});

describe('build3DRules — lineScore', () => {
  it('matches the LAYER_CLEAR_SCORE table at level 1', () => {
    const r = build3DRules();
    expect(r.lineScore(0, 1)).toBe(0);
    expect(r.lineScore(1, 1)).toBe(LAYER_CLEAR_SCORE[1]); // 1000
    expect(r.lineScore(2, 1)).toBe(LAYER_CLEAR_SCORE[2]); // 3000
    expect(r.lineScore(3, 1)).toBe(LAYER_CLEAR_SCORE[3]); // 5000
    expect(r.lineScore(4, 1)).toBe(LAYER_CLEAR_SCORE[4]); // 8000
  });

  it('multiplies by level (a 4-layer clear at level 5 is 8000 × 5 = 40000)', () => {
    const r = build3DRules();
    expect(r.lineScore(4, 5)).toBe(40000);
    expect(r.lineScore(2, 10)).toBe(30000);
  });

  it('clearType arg is ignored — 3D mode opts out of §12 paths', () => {
    const r = build3DRules();
    expect(r.lineScore(2, 1, 'tspin')).toBe(LAYER_CLEAR_SCORE[2]); // not promoted
    expect(r.lineScore(4, 1, 'mini')).toBe(LAYER_CLEAR_SCORE[4]);
  });

  it('caps at the max table entry (>4 layers — defensive, not reachable in practice)', () => {
    const r = build3DRules();
    expect(r.lineScore(99, 1)).toBe(LAYER_CLEAR_SCORE[4]);
  });

  it('treats negative / NaN row counts as zero', () => {
    const r = build3DRules();
    expect(r.lineScore(-2, 1)).toBe(0);
    expect(r.lineScore(NaN, 1)).toBe(0);
  });

  it('coerces level<1 to 1 (defensive for fresh runs before levelForLines fires)', () => {
    const r = build3DRules();
    expect(r.lineScore(1, 0)).toBe(LAYER_CLEAR_SCORE[1]);
    expect(r.lineScore(1, -3)).toBe(LAYER_CLEAR_SCORE[1]);
  });
});

describe('build3DRules — fallIntervalSec', () => {
  it('starts more forgiving than classic at level 1 (10×10 layers are harder to fill)', () => {
    const r = build3DRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(1)).toBe(_FALL_INTERVAL_BASE_3D);
    expect(r.fallIntervalSec(1)).toBeGreaterThan(0.85); // classic baseline
  });

  it('ramps with level (each level 0.85× the previous)', () => {
    const r = build3DRules({ gravityScalar: () => 1.0 });
    const lvl1 = r.fallIntervalSec(1);
    const lvl2 = r.fallIntervalSec(2);
    expect(lvl2).toBeCloseTo(lvl1 * 0.85, 5);
  });

  it('never goes below the 0.05s floor', () => {
    const r = build3DRules();
    expect(r.fallIntervalSec(99)).toBeGreaterThanOrEqual(0.05);
  });

  it('reads gravityScalar live (closure not snapshot)', () => {
    let g = 1.0;
    const r = build3DRules({ gravityScalar: () => g });
    const before = r.fallIntervalSec(1);
    g = 2.0;
    expect(r.fallIntervalSec(1)).toBeCloseTo(before / 2, 5);
  });
});

describe('build3DRules — hooks', () => {
  it('endCondition returns null (host owns spawn-collision topout)', () => {
    const r = build3DRules();
    expect(r.endCondition({})).toBeNull();
    expect(r.endCondition(null)).toBeNull();
  });

  it('onLinesCleared and onTick are null (no per-clear / per-tick hooks)', () => {
    const r = build3DRules();
    expect(r.onLinesCleared).toBeNull();
    expect(r.onTick).toBeNull();
  });
});

describe('build3DRules — updateBest', () => {
  it('records bestLayerCount as max-of-prior, totalLayersCleared as cumulative', () => {
    const r = build3DRules();
    const best = { bestLayerCount: 0, totalLayersCleared: 0, score: 0 };

    r.updateBest(best, { layersClearedThisRun: 8, bestLayerCountThisRun: 2, score: 5000 });
    expect(best.bestLayerCount).toBe(2);
    expect(best.totalLayersCleared).toBe(8);
    expect(best.score).toBe(5000);

    r.updateBest(best, { layersClearedThisRun: 4, bestLayerCountThisRun: 1, score: 1000 });
    // best stays at 2 (lower run); total accumulates; score doesn't fall back.
    expect(best.bestLayerCount).toBe(2);
    expect(best.totalLayersCleared).toBe(12);
    expect(best.score).toBe(5000);

    r.updateBest(best, { layersClearedThisRun: 12, bestLayerCountThisRun: 4, score: 32000 });
    expect(best.bestLayerCount).toBe(4);
    expect(best.totalLayersCleared).toBe(24);
    expect(best.score).toBe(32000);
  });

  it('handles missing summary fields gracefully', () => {
    const r = build3DRules();
    const best = { bestLayerCount: 0, totalLayersCleared: 0, score: 0 };
    r.updateBest(best, { score: 100 });
    expect(best.bestLayerCount).toBe(0);
    expect(best.totalLayersCleared).toBe(0);
    expect(best.score).toBe(100);
  });
});
