import { describe, it, expect } from 'vitest';
import { buildPhysicsRules, _PHYSICS_TOPOUT_Y, _PHYSICS_LAYER_SCORE } from './rules.js';

describe('buildPhysicsRules — shape', () => {
  it('returns a frozen Rules object keyed "physics"', () => {
    const r = buildPhysicsRules();
    expect(r.key).toBe('physics');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('initialModeView identifies physics for the HUD switch', () => {
    const r = buildPhysicsRules();
    expect(r.initialModeView).toEqual({
      kind: 'physics',
      settledCubes: 0,
      layersCleared: 0,
      bodyOverflow: false,
    });
  });

  it('softDrop / hardDrop point values match the standard constants', () => {
    const r = buildPhysicsRules();
    expect(r.softDropPerCell).toBe(1);
    expect(r.hardDropPerCell).toBe(2);
  });

  it('resetsHighScoreSlot is FALSE — physics scores are in their own slot', () => {
    expect(buildPhysicsRules().resetsHighScoreSlot).toBe(false);
  });

  it('goalMultiplier is 1.0 (explicit opt-out of §12 multiplier paths)', () => {
    expect(buildPhysicsRules().goalMultiplier).toBe(1.0);
  });

  it('exposes physicsTopoutY + physicsLayerScore for HUD/tests', () => {
    const r = buildPhysicsRules();
    expect(r.physicsTopoutY).toBe(_PHYSICS_TOPOUT_Y);
    expect(r.physicsLayerScore).toBe(_PHYSICS_LAYER_SCORE);
  });
});

describe('buildPhysicsRules — lineScore', () => {
  it('layers × 100, no level multiplier', () => {
    const r = buildPhysicsRules();
    expect(r.lineScore(1, 1)).toBe(100);
    expect(r.lineScore(2, 1)).toBe(200);
    expect(r.lineScore(3, 5)).toBe(300); // level=5 ignored
    expect(r.lineScore(4, 99)).toBe(400);
  });

  it('clearType arg is ignored — physics doesn\'t recognize §12 paths', () => {
    const r = buildPhysicsRules();
    expect(r.lineScore(2, 1, 'tspin')).toBe(200);    // not 1200
    expect(r.lineScore(2, 1, 'mini')).toBe(200);
    expect(r.lineScore(4, 1, 'tspin')).toBe(400);    // not 1600
  });

  it('returns 0 on zero / negative input', () => {
    const r = buildPhysicsRules();
    expect(r.lineScore(0, 1)).toBe(0);
    expect(r.lineScore(-1, 1)).toBe(0);
    expect(r.lineScore(NaN, 1)).toBe(0);
  });
});

describe('buildPhysicsRules — endCondition', () => {
  it('returns null when no body has overflowed', () => {
    const r = buildPhysicsRules();
    expect(r.endCondition({})).toBeNull();
    expect(r.endCondition({ physicsHighestY: 0 })).toBeNull();
    expect(r.endCondition({ physicsHighestY: 22 })).toBeNull(); // boundary inclusive — only > 22 ends
  });

  it('returns { reason:"topout" } when a body rests above the threshold', () => {
    const r = buildPhysicsRules();
    expect(r.endCondition({ physicsHighestY: 22.001 })).toEqual({ reason: 'topout' });
    expect(r.endCondition({ physicsHighestY: 30 })).toEqual({ reason: 'topout' });
  });

  it('handles missing / non-finite physicsHighestY (host hasn\'t plumbed it yet)', () => {
    const r = buildPhysicsRules();
    expect(r.endCondition({ physicsHighestY: undefined })).toBeNull();
    expect(r.endCondition({ physicsHighestY: NaN })).toBeNull();
    expect(r.endCondition({ physicsHighestY: -Infinity })).toBeNull();
    expect(r.endCondition(null)).toBeNull();
  });
});

describe('buildPhysicsRules — fallIntervalSec', () => {
  it('returns the constant base / gravityScalar()', () => {
    const r = buildPhysicsRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(1)).toBe(0.85);
    // Higher gravity = faster fall.
    const r2 = buildPhysicsRules({ gravityScalar: () => 2.0 });
    expect(r2.fallIntervalSec(1)).toBe(0.425);
  });

  it('does NOT scale with level — physics gravity is Rapier\'s domain', () => {
    const r = buildPhysicsRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(1)).toBe(r.fallIntervalSec(99));
  });

  it('reads gravityScalar live (closure not snapshot)', () => {
    let g = 1.0;
    const r = buildPhysicsRules({ gravityScalar: () => g });
    const before = r.fallIntervalSec(1);
    g = 2.0;
    expect(r.fallIntervalSec(1)).toBe(before / 2);
  });
});

describe('buildPhysicsRules — hooks', () => {
  it('onLinesCleared and onTick are null (no per-clear / per-tick hooks)', () => {
    const r = buildPhysicsRules();
    expect(r.onLinesCleared).toBeNull();
    expect(r.onTick).toBeNull();
  });
});

describe('buildPhysicsRules — updateBest', () => {
  it('records bestLayersCleared as max-of-prior, totalLayersCleared as cumulative', () => {
    const r = buildPhysicsRules();
    const best = { bestLayersCleared: 0, totalLayersCleared: 0, score: 0 };
    r.updateBest(best, { physicsLayersCleared: 5, score: 500 });
    expect(best.bestLayersCleared).toBe(5);
    expect(best.totalLayersCleared).toBe(5);
    expect(best.score).toBe(500);

    r.updateBest(best, { physicsLayersCleared: 3, score: 300 });
    // bestLayers stays at 5 (lower run); total accumulates; score doesn't fall back.
    expect(best.bestLayersCleared).toBe(5);
    expect(best.totalLayersCleared).toBe(8);
    expect(best.score).toBe(500);

    r.updateBest(best, { physicsLayersCleared: 7, score: 700 });
    expect(best.bestLayersCleared).toBe(7);
    expect(best.totalLayersCleared).toBe(15);
    expect(best.score).toBe(700);
  });

  it('handles missing physicsLayersCleared gracefully (legacy callers / fresh slot)', () => {
    const r = buildPhysicsRules();
    const best = { bestLayersCleared: 0, totalLayersCleared: 0, score: 0 };
    r.updateBest(best, { score: 100 });
    expect(best.bestLayersCleared).toBe(0);
    expect(best.totalLayersCleared).toBe(0);
    expect(best.score).toBe(100);
  });
});
