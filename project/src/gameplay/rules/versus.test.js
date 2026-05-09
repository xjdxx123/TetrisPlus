import { describe, it, expect } from 'vitest';
import { buildVersusRules } from './versus.js';
import { EVENTS } from '../events.js';
import { lineClearScore } from '../scoring.js';

function makeFakeBus() {
  const calls = [];
  return { calls, emit(topic, payload) { calls.push({ topic, payload }); } };
}
function snapshot({ score = 0, lines = 0, level = 1, linesCleared = lines, timeMs = 0 } = {}) {
  return { score, lines, level, linesCleared, timeMs };
}

describe('versus rules — boot', () => {
  it('returns a frozen Rules object keyed versus', () => {
    const r = buildVersusRules();
    expect(r.key).toBe('versus');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('initialModeView seeds the HUD with opponentScore + garbageInbound + latency', () => {
    const r = buildVersusRules();
    expect(r.initialModeView).toEqual({
      kind: 'versus',
      opponentScore: 0,
      latencyMs: 0,
      garbageInbound: 0,
    });
  });

  it('lineScore matches the standard scoring table', () => {
    const r = buildVersusRules();
    expect(r.lineScore(2, 3)).toBe(lineClearScore(2, 3));
    expect(r.lineScore(4, 5)).toBe(lineClearScore(4, 5));
  });

  it('endCondition always returns null — topout is the host\'s domain', () => {
    const r = buildVersusRules();
    expect(r.endCondition(snapshot({ linesCleared: 9999, timeMs: 999_999 }))).toBeNull();
  });

  it('resetsHighScoreSlot is FALSE — Versus tracks wins/losses, not score', () => {
    expect(buildVersusRules().resetsHighScoreSlot).toBe(false);
  });

  it('shares the classic gravity curve', () => {
    const r = buildVersusRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(1)).toBeCloseTo(0.85, 5);
  });
});

describe('versus rules — onLinesCleared garbage emission', () => {
  it('a 1-line clear sends NO garbage', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 1 }), 1);
    expect(bus.calls.filter(c => c.topic === EVENTS.GARBAGE_SENT)).toHaveLength(0);
  });

  it('a 2-line clear sends 1 garbage row', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_SENT);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ rows: 1, target: 'opponent' });
  });

  it('a 3-line clear sends 2 garbage rows', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 3 }), 3);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_SENT);
    expect(sent[0].payload.rows).toBe(2);
  });

  it('a 4-line tetris sends 4 garbage rows', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 4 }), 4);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_SENT);
    expect(sent[0].payload.rows).toBe(4);
  });

  it('runs without a bus (silent no-op)', () => {
    const r = buildVersusRules();
    expect(() => r.onLinesCleared(snapshot({ linesCleared: 4 }), 4)).not.toThrow();
  });
});

describe('versus rules — combo bonus', () => {
  it('two consecutive multi-line clears stack a combo bonus on the second', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);   // 1 garbage, no bonus
    r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);   // 1 base + 1 combo
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_SENT);
    expect(sent.map(c => c.payload.rows)).toEqual([1, 2]);
  });

  it('a 1-line clear breaks the combo', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);   // 1
    r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);   // 2 (combo step 1)
    r.onLinesCleared(snapshot({ linesCleared: 1 }), 1);   // breaks combo, sends 0
    r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);   // 1 (back to base)
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_SENT);
    expect(sent.map(c => c.payload.rows)).toEqual([1, 2, 1]);
  });

  it('combo bonus caps at 4 (no infinite snowball)', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    // Six consecutive 2-line clears.
    for (let i = 0; i < 6; i++) r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_SENT).map(c => c.payload.rows);
    // 1 (base, no combo), 2, 3, 4, 5, 5 — the last cleanly capped at 1+4.
    expect(sent).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it('combo state resets across rule-pack instances (one per Mode.start)', () => {
    const bus = makeFakeBus();
    const a = buildVersusRules({ bus });
    a.onLinesCleared(snapshot({ linesCleared: 2 }), 2);
    a.onLinesCleared(snapshot({ linesCleared: 2 }), 2);
    expect(a._comboInternal()).toBe(2);
    const b = buildVersusRules({ bus });
    expect(b._comboInternal()).toBe(0);
  });
});

describe('versus rules — registry integration', () => {
  it('is selected when buildRules("versus") is called', async () => {
    const { buildRules } = await import('../rules.js');
    const r = buildRules('versus');
    expect(r.key).toBe('versus');
  });

  it('the registry passes through bus + gravityScalar', async () => {
    const { buildRules } = await import('../rules.js');
    const bus = makeFakeBus();
    const r = buildRules('versus', { bus });
    r.onLinesCleared(snapshot({ linesCleared: 4 }), 4);
    expect(bus.calls).toHaveLength(1);
    expect(bus.calls[0].payload.rows).toBe(4);
  });
});
