import { describe, it, expect, vi } from 'vitest';
import { buildMarathonRules, MARATHON_TARGET_LINES, MARATHON_MULTIPLIER, MARATHON_MILESTONE_STEP } from './marathon.js';
import { EVENTS } from '../events.js';

function makeFakeBus() {
  const calls = [];
  return {
    calls,
    emit(topic, payload) { calls.push({ topic, payload }); },
  };
}

function snapshot({ score = 0, lines = 0, level = 1, linesCleared = lines, timeMs = 0 } = {}) {
  return { score, lines, level, linesCleared, timeMs };
}

describe('marathon rules — boot', () => {
  it('exposes the constants the plan locked in', () => {
    expect(MARATHON_TARGET_LINES).toBe(150);
    expect(MARATHON_MULTIPLIER).toBe(1.5);
    expect(MARATHON_MILESTONE_STEP).toBe(10);
  });

  it('returns a frozen Rules object keyed marathon', () => {
    const r = buildMarathonRules();
    expect(r.key).toBe('marathon');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('initialModeView seeds the HUD with target + multiplier', () => {
    const r = buildMarathonRules();
    expect(r.initialModeView).toEqual({
      kind: 'marathon',
      linesRemaining: 150,
      target: 150,
      multiplier: 1.5,
    });
  });

  it('exposes goalMultiplier + goalTarget for end-of-run / HUD consumers', () => {
    const r = buildMarathonRules();
    expect(r.goalMultiplier).toBe(1.5);
    expect(r.goalTarget).toBe(150);
  });

  it('shares the classic gravity curve (gravityScalar live thunk)', () => {
    let scalar = 1.0;
    const r = buildMarathonRules({ gravityScalar: () => scalar });
    expect(r.fallIntervalSec(1)).toBeCloseTo(0.85, 5);
    scalar = 2.0;
    expect(r.fallIntervalSec(1)).toBeCloseTo(0.425, 5);
  });
});

describe('marathon rules — endCondition', () => {
  it('returns null below 150 lines', () => {
    const r = buildMarathonRules();
    expect(r.endCondition(snapshot({ linesCleared: 0 }))).toBeNull();
    expect(r.endCondition(snapshot({ linesCleared: 149 }))).toBeNull();
  });

  it('returns reason: goal at exactly 150 lines', () => {
    const r = buildMarathonRules();
    expect(r.endCondition(snapshot({ linesCleared: 150 }))).toEqual({ reason: 'goal' });
  });

  it('returns reason: goal when a multi-line clear overshoots 150', () => {
    // Player at 148, scores a tetris → 152. Goal still fires.
    const r = buildMarathonRules();
    expect(r.endCondition(snapshot({ linesCleared: 152 }))).toEqual({ reason: 'goal' });
  });

  it('safe against null state inputs (defensive)', () => {
    const r = buildMarathonRules();
    expect(r.endCondition(null)).toBeNull();
    expect(r.endCondition(undefined)).toBeNull();
  });
});

describe('marathon rules — onLinesCleared milestones', () => {
  it('emits MODE_GOAL_PROGRESS at every 10-line crossing', () => {
    const bus = makeFakeBus();
    const r = buildMarathonRules({ bus });
    // Single-line clears, one at a time. Hooks fire after the simulation
    // updates state.linesCleared, mirroring main.js#clearLines.
    for (let lines = 1; lines <= 30; lines++) {
      r.onLinesCleared(snapshot({ linesCleared: lines }));
    }
    const milestones = bus.calls
      .filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS)
      .map(c => Math.floor(c.payload.value / 10) * 10);
    expect(milestones).toEqual([10, 20, 30]);
  });

  it('does not double-fire the same milestone', () => {
    // After crossing 10, clearing one more line should NOT re-emit.
    const bus = makeFakeBus();
    const r = buildMarathonRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 10 }));
    r.onLinesCleared(snapshot({ linesCleared: 11 }));
    r.onLinesCleared(snapshot({ linesCleared: 12 }));
    const events = bus.calls.filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS);
    expect(events).toHaveLength(1);
  });

  it('a multi-line clear that crosses two milestones at once still fires once', () => {
    // Player at 28 → tetris → 32. Plan §3.2 §8: a single MODE_GOAL_PROGRESS
    // is the right signal here (the bus topic is "milestone reached", not
    // "every milestone in the path").
    const bus = makeFakeBus();
    const r = buildMarathonRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 28 })); // crosses 20
    r.onLinesCleared(snapshot({ linesCleared: 32 })); // crosses 30 — one event
    const events = bus.calls.filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS);
    expect(events).toHaveLength(2);
    // The second event reports the actual current lines value (32), not
    // the floored milestone — HUDs should display the live count.
    expect(events[1].payload).toEqual({ kind: 'lines', value: 32, target: 150 });
  });

  it('does not emit a milestone for the 0-line state', () => {
    const bus = makeFakeBus();
    const r = buildMarathonRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 0 }));
    expect(bus.calls).toHaveLength(0);
  });

  it('does not emit a 150-line milestone — that is MODE_END territory', () => {
    // The plan deliberately reserves the 150-line crossing for the louder
    // MODE_END signal, so HUDs / the director don't double-react.
    const bus = makeFakeBus();
    const r = buildMarathonRules({ bus });
    for (let lines = 140; lines <= 150; lines++) {
      r.onLinesCleared(snapshot({ linesCleared: lines }));
    }
    const events = bus.calls.filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS);
    expect(events.map(e => e.payload.value < 150)).toEqual(events.map(() => true));
    // The last milestone fired should be 140's, not 150's.
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].payload.value).toBeGreaterThanOrEqual(140);
    expect(events[events.length - 1].payload.value).toBeLessThan(150);
  });

  it('milestone state resets across rule-pack instances', () => {
    // main.js builds a fresh rules pack on every Mode.start — this test
    // locks in that behavior so a new run starts with a clean milestone
    // tracker.
    const bus = makeFakeBus();
    const a = buildMarathonRules({ bus });
    a.onLinesCleared(snapshot({ linesCleared: 10 }));
    expect(bus.calls.length).toBe(1);
    const b = buildMarathonRules({ bus });
    b.onLinesCleared(snapshot({ linesCleared: 10 }));
    expect(bus.calls.length).toBe(2);
  });

  it('runs without a bus (silent no-op for tests + Versus)', () => {
    const r = buildMarathonRules(/* no opts */);
    // Should not throw — the bus is optional.
    expect(() => r.onLinesCleared(snapshot({ linesCleared: 50 }))).not.toThrow();
  });

  it('handles null state inputs without throwing', () => {
    const r = buildMarathonRules();
    expect(() => r.onLinesCleared(null)).not.toThrow();
    expect(() => r.onLinesCleared(undefined)).not.toThrow();
  });
});

describe('marathon rules — buildRules registry integration', () => {
  it('is selected when buildRules("marathon") is called via the main registry', async () => {
    const { buildRules } = await import('../rules.js');
    const r = buildRules('marathon');
    expect(r.key).toBe('marathon');
    expect(r.goalTarget).toBe(150);
  });

  it('still differs from classic on the marathon-specific surface', async () => {
    const { buildRules } = await import('../rules.js');
    const m = buildRules('marathon');
    const c = buildRules('classic');
    expect(m.goalMultiplier).toBe(1.5);
    expect(c.goalMultiplier).toBe(1.0);
    // But the line score, soft/hard drop, gravity curve are the same — the
    // mode is identical until you reach 150 lines.
    expect(m.lineScore(4, 3)).toBe(c.lineScore(4, 3));
    expect(m.softDropPerCell).toBe(c.softDropPerCell);
    expect(m.hardDropPerCell).toBe(c.hardDropPerCell);
  });

  it('passes through bus + gravityScalar to the marathon builder', async () => {
    const { buildRules } = await import('../rules.js');
    const bus = makeFakeBus();
    let scalar = 1.5;
    const r = buildRules('marathon', { bus, gravityScalar: () => scalar });
    // Trigger a milestone to verify bus plumbing.
    r.onLinesCleared(snapshot({ linesCleared: 10 }));
    expect(bus.calls).toHaveLength(1);
    // Verify gravityScalar plumbing by mutating + reading again.
    const before = r.fallIntervalSec(1);
    scalar = 3.0;
    expect(r.fallIntervalSec(1)).toBeCloseTo(before / 2, 5);
  });
});

describe('vi mock check', () => {
  it('vitest is available', () => {
    expect(typeof vi.fn).toBe('function');
  });
});
