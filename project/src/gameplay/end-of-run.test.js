import { describe, it, expect, vi } from 'vitest';
import { recordEndOfRun } from './end-of-run.js';

// Helper — build hooks backed by a single in-memory blob so we can verify
// reads-through-writes behavior without touching localStorage.
function makeHooks(initial = null) {
  let blob = initial || {
    highScore: 0,
    modeBests: {},
    totals: { linesCleared: 0, piecesPlaced: 0, playTimeMs: 0 },
    lastUpdated: null,
  };
  return {
    loadStats: () => structuredClone(blob),
    saveStats: vi.fn((next) => { blob = structuredClone(next); }),
    now: () => 5_000,
    snapshot: () => structuredClone(blob),
  };
}

describe('recordEndOfRun — high score', () => {
  it('writes a new highScore when the run beats it', () => {
    const hooks = makeHooks({
      highScore: 100, modeBests: {}, totals: { linesCleared: 0, piecesPlaced: 0, playTimeMs: 0 },
    });
    recordEndOfRun({
      score: 500, lines: 3, level: 2,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 1_000, piecesPlacedThisRun: 4, linesClearedThisRun: 3,
    }, hooks);
    expect(hooks.snapshot().highScore).toBe(500);
  });

  it('does not lower an existing higher highScore', () => {
    const hooks = makeHooks({
      highScore: 1000, modeBests: {}, totals: { linesCleared: 0, piecesPlaced: 0, playTimeMs: 0 },
    });
    recordEndOfRun({
      score: 500, lines: 3, level: 2,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 1_000, piecesPlacedThisRun: 4, linesClearedThisRun: 3,
    }, hooks);
    expect(hooks.snapshot().highScore).toBe(1000);
  });

  it('skips highScore when resetsHighScoreSlot is false (Zen path)', () => {
    const hooks = makeHooks({
      highScore: 100, modeBests: {}, totals: { linesCleared: 0, piecesPlaced: 0, playTimeMs: 0 },
    });
    recordEndOfRun({
      score: 99999, lines: 200, level: 20,
      modeKey: 'zen', reason: 'forfeit',
      sessionStartMs: 1_000, piecesPlacedThisRun: 100, linesClearedThisRun: 200,
      resetsHighScoreSlot: false,
    }, hooks);
    expect(hooks.snapshot().highScore).toBe(100);
    // Per-mode best still updates.
    expect(hooks.snapshot().modeBests.zen.score).toBe(99999);
  });
});

describe('recordEndOfRun — per-mode best', () => {
  it('creates a modeBests slot for a new mode key', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 200, lines: 5, level: 1,
      modeKey: 'marathon', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 1, linesClearedThisRun: 5,
    }, hooks);
    expect(hooks.snapshot().modeBests.marathon).toEqual({
      score: 200, lines: 5, level: 1, attempts: 1,
    });
  });

  it('increments attempts on every call (regardless of reason)', () => {
    const hooks = makeHooks();
    for (let i = 0; i < 4; i++) {
      recordEndOfRun({
        score: 100, lines: 1, level: 1,
        modeKey: 'classic', reason: 'topout',
        sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 0,
      }, hooks);
    }
    expect(hooks.snapshot().modeBests.classic.attempts).toBe(4);
  });

  it('only the best of a mode replaces the score / lines / level fields', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 1000, lines: 10, level: 2,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 10,
    }, hooks);
    recordEndOfRun({
      score: 500, lines: 4, level: 1,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 4,
    }, hooks);
    const best = hooks.snapshot().modeBests.classic;
    // attempts went up to 2; score/lines/level kept the *best* run's values.
    expect(best).toEqual({ score: 1000, lines: 10, level: 2, attempts: 2 });
  });

  it('per-mode bests are independent of each other', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 9000, lines: 30, level: 4,
      modeKey: 'marathon', reason: 'goal',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 30,
    }, hooks);
    recordEndOfRun({
      score: 100, lines: 1, level: 1,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 1,
    }, hooks);
    const blob = hooks.snapshot();
    expect(blob.modeBests.marathon.score).toBe(9000);
    expect(blob.modeBests.classic.score).toBe(100);
  });
});

describe('recordEndOfRun — totals + playTime', () => {
  it('accumulates linesCleared and piecesPlaced across runs', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 100, lines: 3, level: 1,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 12, linesClearedThisRun: 3,
    }, hooks);
    recordEndOfRun({
      score: 200, lines: 7, level: 2,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 20, linesClearedThisRun: 7,
    }, hooks);
    const totals = hooks.snapshot().totals;
    expect(totals.linesCleared).toBe(10);
    expect(totals.piecesPlaced).toBe(32);
  });

  it('records playTimeMs as now() - sessionStartMs', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 100, lines: 1, level: 1,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 1_000, piecesPlacedThisRun: 1, linesClearedThisRun: 1,
    }, hooks);
    // hooks.now() returns 5000 → delta 4000ms.
    expect(hooks.snapshot().totals.playTimeMs).toBe(4000);
  });
});

describe('recordEndOfRun — goal multiplier', () => {
  it('applies goalMultiplier when reason is "goal" and returns the multiplied score', () => {
    const hooks = makeHooks();
    const result = recordEndOfRun({
      score: 1000, lines: 150, level: 6,
      modeKey: 'marathon', reason: 'goal',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 150,
      goalMultiplier: 1.5,
      runTimeMs: 480_000,
    }, hooks);
    expect(result.multiplied).toBe(true);
    expect(result.score).toBe(1500);                                // round(1000 * 1.5)
    expect(hooks.snapshot().modeBests.marathon.score).toBe(1500);
    expect(hooks.snapshot().highScore).toBe(1500);
  });

  it('does NOT apply goalMultiplier on topout (incomplete attempt)', () => {
    const hooks = makeHooks();
    const result = recordEndOfRun({
      score: 1000, lines: 100, level: 4,
      modeKey: 'marathon', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 100,
      goalMultiplier: 1.5,
    }, hooks);
    expect(result.multiplied).toBe(false);
    expect(result.score).toBe(1000);
    expect(hooks.snapshot().modeBests.marathon.score).toBe(1000);
  });

  it('rounds the multiplied score (no fractional totals leaking into stats)', () => {
    const hooks = makeHooks();
    const result = recordEndOfRun({
      score: 333, lines: 150, level: 4,
      modeKey: 'marathon', reason: 'goal',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 150,
      goalMultiplier: 1.5,                            // 333 * 1.5 = 499.5
      runTimeMs: 200_000,
    }, hooks);
    expect(result.score).toBe(500);
  });

  it('treats goalMultiplier=1.0 as a no-op (classic / non-multiplied modes)', () => {
    const hooks = makeHooks();
    const result = recordEndOfRun({
      score: 800, lines: 30, level: 2,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 30,
      goalMultiplier: 1.0,
    }, hooks);
    expect(result.multiplied).toBe(false);
    expect(result.score).toBe(800);
  });
});

describe('recordEndOfRun — Marathon completed + bestTimeMs', () => {
  it('sets completed:true and seeds bestTimeMs on first goal completion', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 1000, lines: 150, level: 6,
      modeKey: 'marathon', reason: 'goal',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 150,
      goalMultiplier: 1.5,
      runTimeMs: 480_000,                             // 8:00
    }, hooks);
    const m = hooks.snapshot().modeBests.marathon;
    expect(m.completed).toBe(true);
    expect(m.bestTimeMs).toBe(480_000);
  });

  it('lowers bestTimeMs only when a faster completion arrives', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 1000, lines: 150, level: 6,
      modeKey: 'marathon', reason: 'goal',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 150,
      goalMultiplier: 1.5, runTimeMs: 500_000,
    }, hooks);
    recordEndOfRun({
      score: 800, lines: 150, level: 5,
      modeKey: 'marathon', reason: 'goal',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 150,
      goalMultiplier: 1.5, runTimeMs: 420_000,        // faster
    }, hooks);
    expect(hooks.snapshot().modeBests.marathon.bestTimeMs).toBe(420_000);
    // A slower completion does NOT replace a faster one.
    recordEndOfRun({
      score: 1500, lines: 150, level: 7,
      modeKey: 'marathon', reason: 'goal',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 150,
      goalMultiplier: 1.5, runTimeMs: 600_000,        // slower
    }, hooks);
    expect(hooks.snapshot().modeBests.marathon.bestTimeMs).toBe(420_000);
  });

  it('does not set completed on a topout (even with the multiplier opt set)', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 800, lines: 100, level: 4,
      modeKey: 'marathon', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 100,
      goalMultiplier: 1.5, runTimeMs: 200_000,
    }, hooks);
    const m = hooks.snapshot().modeBests.marathon;
    // Either undefined (never set) or false — both are acceptable; what we
    // care about is that it isn't true.
    expect(m.completed === true).toBe(false);
  });
});

describe('recordEndOfRun — custom updateBest hook', () => {
  it('uses the custom updater when provided (Zen path)', () => {
    const hooks = makeHooks();
    const updateBest = vi.fn((best, summary) => {
      best.longestSessionMs = Math.max(best.longestSessionMs || 0, summary.runTimeMs);
      best.totalLines = (best.totalLines || 0) + (summary.linesClearedThisRun || 0);
    });
    recordEndOfRun({
      score: 5000, lines: 20, level: 3,                           // ← would normally write best.score
      modeKey: 'zen', reason: 'forfeit',
      sessionStartMs: 0, piecesPlacedThisRun: 50, linesClearedThisRun: 20,
      resetsHighScoreSlot: false,
      runTimeMs: 600_000,
      updateBest,
    }, hooks);
    expect(updateBest).toHaveBeenCalledTimes(1);
    const z = hooks.snapshot().modeBests.zen;
    expect(z.longestSessionMs).toBe(600_000);
    expect(z.totalLines).toBe(20);
    // Default branch was skipped — score should NOT have been written.
    expect(z.score).toBe(0);
    expect(z.lines).toBe(0);
  });

  it('still bumps attempts on every recordEndOfRun call (regardless of branch)', () => {
    const hooks = makeHooks();
    const updateBest = () => {};
    for (let i = 0; i < 3; i++) {
      recordEndOfRun({
        score: 100, lines: 1, level: 1,
        modeKey: 'zen', reason: 'forfeit',
        sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 0,
        runTimeMs: 1000,
        updateBest,
      }, hooks);
    }
    expect(hooks.snapshot().modeBests.zen.attempts).toBe(3);
  });

  it('still writes cumulative totals (linesCleared / piecesPlaced) regardless of updater', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 0, lines: 7, level: 1,
      modeKey: 'zen', reason: 'forfeit',
      sessionStartMs: 0, piecesPlacedThisRun: 30, linesClearedThisRun: 7,
      runTimeMs: 60_000,
      updateBest: (best, s) => { best.totalLines = (best.totalLines || 0) + s.linesClearedThisRun; },
    }, hooks);
    const totals = hooks.snapshot().totals;
    expect(totals.linesCleared).toBe(7);
    expect(totals.piecesPlaced).toBe(30);
  });

  it('a throwing updater is logged but does not block the rest of the write', () => {
    const hooks = makeHooks();
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordEndOfRun({
      score: 100, lines: 1, level: 1,
      modeKey: 'zen', reason: 'forfeit',
      sessionStartMs: 0, piecesPlacedThisRun: 0, linesClearedThisRun: 0,
      runTimeMs: 1000,
      updateBest: () => { throw new Error('boom'); },
    }, hooks);
    // attempts + totals should still be written despite the throwing updater.
    expect(hooks.snapshot().modeBests.zen.attempts).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('recordEndOfRun — write semantics', () => {
  it('flushes synchronously (saveStats called with flush:true)', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 100, lines: 1, level: 1,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 1, linesClearedThisRun: 1,
    }, hooks);
    expect(hooks.saveStats).toHaveBeenCalledTimes(1);
    expect(hooks.saveStats.mock.calls[0][1]).toEqual({ flush: true });
  });

  it('throws on missing hooks rather than silently dropping data', () => {
    expect(() => recordEndOfRun({ score: 0 }, null)).toThrow();
    expect(() => recordEndOfRun({ score: 0 }, {})).toThrow();
    expect(() => recordEndOfRun({ score: 0 }, { loadStats: () => ({}) })).toThrow();
  });

  it('lastUpdated is set to an ISO date string', () => {
    const hooks = makeHooks();
    recordEndOfRun({
      score: 100, lines: 1, level: 1,
      modeKey: 'classic', reason: 'topout',
      sessionStartMs: 0, piecesPlacedThisRun: 1, linesClearedThisRun: 1,
    }, hooks);
    const ts = hooks.snapshot().lastUpdated;
    expect(typeof ts).toBe('string');
    expect(() => new Date(ts).toISOString()).not.toThrow();
  });
});
