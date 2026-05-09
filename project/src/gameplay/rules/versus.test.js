import { describe, it, expect } from 'vitest';
import { buildVersusRules } from './versus.js';
import { EVENTS } from '../events.js';
import { lineClearScore } from '../scoring.js';

function makeFakeBus() {
  const calls = [];
  return { calls, emit(topic, payload) { calls.push({ topic, payload }); } };
}
function snapshot({
  score = 0, lines = 0, level = 1, linesCleared = lines, timeMs = 0,
  b2b = 0, combo = 0,
} = {}) {
  return { score, lines, level, linesCleared, timeMs, b2b, combo };
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
    expect(bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING)).toHaveLength(0);
  });

  it('a 2-line clear sends 1 garbage row', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 2 }), 2);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ rows: 1, target: 'opponent' });
  });

  it('a 3-line clear sends 2 garbage rows', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 3 }), 3);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING);
    expect(sent[0].payload.rows).toBe(2);
  });

  it('a 4-line tetris sends 4 garbage rows', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 4 }), 4);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING);
    expect(sent[0].payload.rows).toBe(4);
  });

  it('runs without a bus (silent no-op)', () => {
    const r = buildVersusRules();
    expect(() => r.onLinesCleared(snapshot({ linesCleared: 4 }), 4)).not.toThrow();
  });
});

describe('versus rules — combo bonus (M4: combo lives in Game)', () => {
  // Post-§12 M4: Game owns `_combo` and includes it in the state
  // snapshot. Versus's onLinesCleared reads `state.combo` and uses
  // `combo - 1` as the comboStep for the staged garbage table:
  //   step:    0 1 2 3 4 5 6 7 8 9 10 11+
  //   garbage: 0 0 1 1 2 2 3 3 4 4 4  5

  it('two consecutive 2-line clears: step=0 then step=1 — both send 1 (no bonus until step 2)', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    // First clear: state.combo=1, step=0 → 1 base + 0 = 1
    r.onLinesCleared(snapshot({ linesCleared: 2, combo: 1 }), 2);
    // Second clear: state.combo=2, step=1 → 1 base + 0 = 1
    r.onLinesCleared(snapshot({ linesCleared: 2, combo: 2 }), 2);
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING);
    expect(sent.map(c => c.payload.rows)).toEqual([1, 1]);
  });

  it('third 2-line clear (step=2) starts adding a combo bonus', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 2, combo: 1 }), 2); // 1+0 = 1
    r.onLinesCleared(snapshot({ linesCleared: 2, combo: 2 }), 2); // 1+0 = 1
    r.onLinesCleared(snapshot({ linesCleared: 2, combo: 3 }), 2); // 1+1 = 2
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING);
    expect(sent.map(c => c.payload.rows)).toEqual([1, 1, 2]);
  });

  it('long combo plateaus at +5 (step ≥ 11)', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    for (let combo = 1; combo <= 13; combo++) {
      r.onLinesCleared(snapshot({ linesCleared: 2, combo }), 2);
    }
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING).map(c => c.payload.rows);
    // base (2-line) = 1; bonus follows COMBO_STEP_GARBAGE [0,0,1,1,2,2,3,3,4,4,4]
    // and 5 plateau for step ≥ 11.
    expect(sent).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6]);
  });

  it('M4 modern table: combo SINGLES eventually contribute', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    // Single line clears extend combo too (the old rule that 1-line
    // clears reset is removed in M4).
    r.onLinesCleared(snapshot({ linesCleared: 1, combo: 1  }), 1); // step 0  → 0+0 = 0 (no emit)
    r.onLinesCleared(snapshot({ linesCleared: 1, combo: 2  }), 1); // step 1  → 0+0 = 0 (no emit)
    r.onLinesCleared(snapshot({ linesCleared: 1, combo: 3  }), 1); // step 2  → 0+1 = 1
    r.onLinesCleared(snapshot({ linesCleared: 1, combo: 11 }), 1); // step 10 → 0+4 = 4
    r.onLinesCleared(snapshot({ linesCleared: 1, combo: 12 }), 1); // step 11 → 0+5 = 5 (plateau)
    const sent = bus.calls.filter(c => c.topic === EVENTS.GARBAGE_OUTGOING).map(c => c.payload.rows);
    expect(sent).toEqual([1, 4, 5]); // only non-zero sends emit
  });

  it('_comboInternal mirrors the most recently observed Game.combo (legacy accessor)', () => {
    const bus = makeFakeBus();
    const r = buildVersusRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 2, combo: 5 }), 2);
    expect(r._comboInternal()).toBe(5);
    // A fresh rule pack hasn't observed any clears.
    const r2 = buildVersusRules({ bus });
    expect(r2._comboInternal()).toBe(0);
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
