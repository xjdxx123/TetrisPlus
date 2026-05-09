import { describe, it, expect } from 'vitest';
import { buildZenRules, ZEN_RESCUE_ROW_COUNT, ZEN_FALL_INTERVAL_FN } from './zen.js';
import { lineClearScore } from '../scoring.js';

function snapshot({ score = 0, lines = 0, level = 1, linesCleared = lines, timeMs = 0 } = {}) {
  return { score, lines, level, linesCleared, timeMs };
}

describe('zen rules — boot', () => {
  it('returns a frozen Rules object keyed zen', () => {
    const r = buildZenRules();
    expect(r.key).toBe('zen');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('exposes the rescue-row constant the plan locked in', () => {
    expect(ZEN_RESCUE_ROW_COUNT).toBe(4);
  });

  it('initialModeView seeds the HUD with shiftDownsTriggered=0', () => {
    const r = buildZenRules();
    expect(r.initialModeView).toEqual({
      kind: 'zen',
      shiftDownsTriggered: 0,
    });
  });

  it('lineScore matches the standard scoring table', () => {
    const r = buildZenRules();
    expect(r.lineScore(2, 3)).toBe(lineClearScore(2, 3));
    expect(r.lineScore(4, 5)).toBe(lineClearScore(4, 5));
  });

  it('resetsHighScoreSlot is FALSE — Zen never enters the global high score', () => {
    expect(buildZenRules().resetsHighScoreSlot).toBe(false);
  });

  it('endCondition always returns null — only Mode.stop ends Zen', () => {
    const r = buildZenRules();
    expect(r.endCondition(snapshot({ linesCleared: 9999 }))).toBeNull();
    expect(r.endCondition(snapshot({ timeMs: 24 * 60 * 60 * 1000 }))).toBeNull();
  });
});

describe('zen rules — gentler gravity curve', () => {
  it('base interval at level 1 is 1.0s (vs 0.85s for classic)', () => {
    const r = buildZenRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(1)).toBeCloseTo(1.0, 5);
  });

  it('decay is 0.92 (gentler than classic 0.85)', () => {
    const r = buildZenRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(2)).toBeCloseTo(1.0 * 0.92, 5);
    expect(r.fallIntervalSec(5)).toBeCloseTo(1.0 * Math.pow(0.92, 4), 5);
  });

  it('floor is 0.4s — never ticks faster than this', () => {
    const r = buildZenRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(50)).toBe(0.4);
    expect(r.fallIntervalSec(100)).toBe(0.4);
  });

  it('respects gravityScalar', () => {
    let scalar = 1.0;
    const r = buildZenRules({ gravityScalar: () => scalar });
    const before = r.fallIntervalSec(1);
    scalar = 2.0;
    expect(r.fallIntervalSec(1)).toBeCloseTo(before / 2, 5);
  });

  it('the exported curve function matches the rules pack', () => {
    expect(ZEN_FALL_INTERVAL_FN(1, 1.0)).toBeCloseTo(1.0, 5);
    expect(ZEN_FALL_INTERVAL_FN(50, 1.0)).toBe(0.4);
  });
});

describe('zen rules — onTopOut interceptor', () => {
  it('returns { end: false, shift: 4 }', () => {
    const r = buildZenRules();
    expect(r.onTopOut(snapshot())).toEqual({ end: false, shift: 4 });
  });

  it('rescueRows is exposed for HUDs that show the configured shift size', () => {
    const r = buildZenRules();
    expect(r.rescueRows).toBe(4);
  });
});

describe('zen rules — updateBest hook', () => {
  it('replaces the default score-based best with longestSessionMs + totalLines', () => {
    const r = buildZenRules();
    const best = { score: 0, lines: 0, level: 1, attempts: 0, longestSessionMs: 0, totalLines: 0 };
    r.updateBest(best, { runTimeMs: 60_000, linesClearedThisRun: 12 });
    expect(best.longestSessionMs).toBe(60_000);
    expect(best.totalLines).toBe(12);
    // score/lines/level must NOT be touched by Zen.
    expect(best.score).toBe(0);
    expect(best.lines).toBe(0);
    expect(best.level).toBe(1);
  });

  it('keeps the longer session, accumulates total lines across runs', () => {
    const r = buildZenRules();
    const best = { longestSessionMs: 0, totalLines: 0 };
    r.updateBest(best, { runTimeMs: 60_000, linesClearedThisRun: 10 });
    r.updateBest(best, { runTimeMs: 30_000, linesClearedThisRun: 5 });   // shorter — does NOT replace longest
    r.updateBest(best, { runTimeMs: 90_000, linesClearedThisRun: 15 });  // longer — replaces
    expect(best.longestSessionMs).toBe(90_000);
    expect(best.totalLines).toBe(30); // cumulative
  });

  it('safe against missing fields on the summary', () => {
    const r = buildZenRules();
    const best = {};
    expect(() => r.updateBest(best, {})).not.toThrow();
    expect(best.longestSessionMs).toBe(0);
    expect(best.totalLines).toBe(0);
  });
});

describe('zen rules — registry integration', () => {
  it('is selected when buildRules("zen") is called', async () => {
    const { buildRules } = await import('../rules.js');
    const r = buildRules('zen');
    expect(r.key).toBe('zen');
    expect(r.onTopOut).toBeTypeOf('function');
    expect(r.updateBest).toBeTypeOf('function');
  });
});
