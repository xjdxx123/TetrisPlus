import { describe, it, expect } from 'vitest';
import { buildRules } from './rules.js';
import { lineClearScore } from './scoring.js';

describe('rules — buildRules(classic)', () => {
  it('returns a frozen Rules object for the classic key', () => {
    const r = buildRules('classic');
    expect(r.key).toBe('classic');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('lineScore matches the standard scoring table', () => {
    const r = buildRules('classic');
    expect(r.lineScore(1, 1)).toBe(lineClearScore(1, 1));
    expect(r.lineScore(4, 7)).toBe(lineClearScore(4, 7));
  });

  it('softDrop and hardDrop point values match the constants', () => {
    const r = buildRules('classic');
    expect(r.softDropPerCell).toBe(1);
    expect(r.hardDropPerCell).toBe(2);
  });

  it('fallIntervalSec mirrors the inline gravity curve', () => {
    const r = buildRules('classic', { gravityScalar: () => 1.0 });
    // (0.85 * 0.85^(level-1)) / 1.0 — matches main.js#fallInterval pre-refactor.
    expect(r.fallIntervalSec(1)).toBeCloseTo(0.85, 5);
    expect(r.fallIntervalSec(2)).toBeCloseTo(0.85 * 0.85, 5);
    // Floor at 0.04s — extreme levels never tick faster than this.
    expect(r.fallIntervalSec(50)).toBe(0.04);
  });

  it('fallIntervalSec reads gravityScalar live (closure, not snapshot)', () => {
    let scalar = 1.0;
    const r = buildRules('classic', { gravityScalar: () => scalar });
    const before = r.fallIntervalSec(1);
    scalar = 2.0;
    const after = r.fallIntervalSec(1);
    expect(after).toBeCloseTo(before / 2, 5);
  });

  it('endCondition returns null (classic never ends except on topout)', () => {
    const r = buildRules('classic');
    expect(r.endCondition({ score: 10000, lines: 999, level: 99, linesCleared: 999, timeMs: 0 })).toBeNull();
  });

  it('onLinesCleared and onTick are null hooks (cheap to no-op)', () => {
    const r = buildRules('classic');
    expect(r.onLinesCleared).toBeNull();
    expect(r.onTick).toBeNull();
  });

  it('resetsHighScoreSlot is true (classic feeds the global high score)', () => {
    expect(buildRules('classic').resetsHighScoreSlot).toBe(true);
  });

  it('initialModeView has kind=classic for HUD dispatch', () => {
    const r = buildRules('classic');
    expect(r.initialModeView).toEqual({ kind: 'classic' });
  });
});

describe('rules — fallback / unknown keys', () => {
  it('every standard mode key is registered (returns a Rules)', () => {
    for (const key of ['classic', 'marathon', 'sprint', 'ultra', 'zen', 'versus']) {
      const r = buildRules(key);
      expect(r).toBeTruthy();
      expect(typeof r.lineScore).toBe('function');
    }
  });

  it('unknown keys fall back to classic so a stale persisted key does not crash', () => {
    const r = buildRules('garbage-mode-name');
    expect(r.key).toBe('classic');
  });

  it('versus is the only remaining stub that resolves to classic', () => {
    // Marathon/Sprint/Ultra/Zen each have their own pack now (Phases 2-5).
    // Versus is the last stub — it stays classic-equivalent until Phase 6
    // ships the dedicated pack with the garbage table + send/receive
    // hooks. This test locks in that pre-Phase-6 baseline.
    const reference = buildRules('classic');
    const r = buildRules('versus');
    expect(r.softDropPerCell).toBe(reference.softDropPerCell);
    expect(r.hardDropPerCell).toBe(reference.hardDropPerCell);
    expect(r.fallIntervalSec(5)).toBeCloseTo(reference.fallIntervalSec(5), 5);
    expect(r.lineScore(4, 3)).toBe(reference.lineScore(4, 3));
  });

  it('the four shipped packs differ from classic where the plan calls for it', () => {
    const c = buildRules('classic');
    // Marathon: same scoring/gravity, distinct goalMultiplier.
    expect(buildRules('marathon').goalMultiplier).toBe(1.5);
    // Sprint: lineScore is zero (timed only).
    expect(buildRules('sprint').lineScore(4, 9)).toBe(0);
    // Ultra: same scoring/gravity, distinct duration constant.
    expect(buildRules('ultra').duration).toBe(120_000);
    // Zen: distinct gentler gravity (level 1 base interval is 1.0s, vs 0.85s).
    expect(buildRules('zen').fallIntervalSec(1)).toBeCloseTo(1.0, 5);
    expect(c.fallIntervalSec(1)).toBeCloseTo(0.85, 5);
  });
});
