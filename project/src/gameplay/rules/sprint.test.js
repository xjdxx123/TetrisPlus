import { describe, it, expect } from 'vitest';
import { buildSprintRules, SPRINT_TARGET_LINES, SPRINT_MILESTONE_STEP } from './sprint.js';
import { EVENTS } from '../events.js';

function makeFakeBus() {
  const calls = [];
  return { calls, emit(topic, payload) { calls.push({ topic, payload }); } };
}
function snapshot({ score = 0, lines = 0, level = 1, linesCleared = lines, timeMs = 0 } = {}) {
  return { score, lines, level, linesCleared, timeMs };
}

describe('sprint rules — boot', () => {
  it('returns a frozen Rules object keyed sprint', () => {
    const r = buildSprintRules();
    expect(r.key).toBe('sprint');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('exposes the constants the plan locked in', () => {
    expect(SPRINT_TARGET_LINES).toBe(40);
    expect(SPRINT_MILESTONE_STEP).toBe(5);
  });

  it('initialModeView seeds the HUD with target + zeroed timer', () => {
    const r = buildSprintRules();
    expect(r.initialModeView).toEqual({
      kind: 'sprint',
      linesRemaining: 40,
      target: 40,
      timeMs: 0,
    });
  });

  it('lineScore is always 0 (Sprint is timed only)', () => {
    const r = buildSprintRules();
    expect(r.lineScore(1, 1)).toBe(0);
    expect(r.lineScore(4, 9)).toBe(0);   // even a tetris at level 9 = 0
  });

  it('resetsHighScoreSlot is false (Sprint score never enters global high score)', () => {
    expect(buildSprintRules().resetsHighScoreSlot).toBe(false);
  });

  it('goalMultiplier is 1.0 (no Marathon-style end bonus)', () => {
    expect(buildSprintRules().goalMultiplier).toBe(1.0);
  });
});

describe('sprint rules — gravity lock', () => {
  it('fallIntervalSec returns the level-1 interval regardless of level', () => {
    const r = buildSprintRules({ gravityScalar: () => 1.0 });
    const lvl1 = r.fallIntervalSec(1);
    expect(r.fallIntervalSec(5)).toBe(lvl1);
    expect(r.fallIntervalSec(50)).toBe(lvl1);
  });

  it('still respects gravityScalar for the level-1 base interval', () => {
    let scalar = 1.0;
    const r = buildSprintRules({ gravityScalar: () => scalar });
    const before = r.fallIntervalSec(1);
    scalar = 2.0;
    expect(r.fallIntervalSec(1)).toBeCloseTo(before / 2, 5);
  });
});

describe('sprint rules — endCondition', () => {
  it('returns null below 40 lines', () => {
    const r = buildSprintRules();
    expect(r.endCondition(snapshot({ linesCleared: 0 }))).toBeNull();
    expect(r.endCondition(snapshot({ linesCleared: 39 }))).toBeNull();
  });

  it('returns reason: goal at exactly 40 lines', () => {
    const r = buildSprintRules();
    expect(r.endCondition(snapshot({ linesCleared: 40 }))).toEqual({ reason: 'goal' });
  });

  it('returns reason: goal when a multi-line clear overshoots 40', () => {
    const r = buildSprintRules();
    expect(r.endCondition(snapshot({ linesCleared: 43 }))).toEqual({ reason: 'goal' });
  });

  it('safe against null state inputs', () => {
    const r = buildSprintRules();
    expect(r.endCondition(null)).toBeNull();
    expect(r.endCondition(undefined)).toBeNull();
  });
});

describe('sprint rules — onLinesCleared milestones', () => {
  it('emits MODE_GOAL_PROGRESS at every 5-line crossing', () => {
    const bus = makeFakeBus();
    const r = buildSprintRules({ bus });
    for (let lines = 1; lines <= 25; lines++) {
      r.onLinesCleared(snapshot({ linesCleared: lines }));
    }
    const milestones = bus.calls
      .filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS)
      .map(c => Math.floor(c.payload.value / 5) * 5);
    expect(milestones).toEqual([5, 10, 15, 20, 25]);
  });

  it('does not double-fire the same milestone', () => {
    const bus = makeFakeBus();
    const r = buildSprintRules({ bus });
    r.onLinesCleared(snapshot({ linesCleared: 5 }));
    r.onLinesCleared(snapshot({ linesCleared: 6 }));
    r.onLinesCleared(snapshot({ linesCleared: 7 }));
    const events = bus.calls.filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS);
    expect(events).toHaveLength(1);
  });

  it('does not emit a 40-line milestone — that is MODE_END territory', () => {
    const bus = makeFakeBus();
    const r = buildSprintRules({ bus });
    for (let lines = 35; lines <= 40; lines++) {
      r.onLinesCleared(snapshot({ linesCleared: lines }));
    }
    const events = bus.calls.filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS);
    // Last event's reported value is < 40 (the milestone is for 35).
    expect(events[events.length - 1].payload.value).toBeLessThan(40);
  });

  it('runs without a bus (silent no-op for tests)', () => {
    const r = buildSprintRules();
    expect(() => r.onLinesCleared(snapshot({ linesCleared: 5 }))).not.toThrow();
  });

  it('milestone state resets across rule-pack instances', () => {
    const bus = makeFakeBus();
    const a = buildSprintRules({ bus });
    a.onLinesCleared(snapshot({ linesCleared: 5 }));
    expect(bus.calls.length).toBe(1);
    const b = buildSprintRules({ bus });
    b.onLinesCleared(snapshot({ linesCleared: 5 }));
    expect(bus.calls.length).toBe(2);
  });
});

describe('sprint rules — registry integration', () => {
  it('is selected when buildRules("sprint") is called via the main registry', async () => {
    const { buildRules } = await import('../rules.js');
    const r = buildRules('sprint');
    expect(r.key).toBe('sprint');
    expect(r.lineScore(4, 9)).toBe(0);
    expect(r.goalTarget).toBe(40);
  });

  it('passes through bus + gravityScalar to the sprint builder', async () => {
    const { buildRules } = await import('../rules.js');
    const bus = makeFakeBus();
    const r = buildRules('sprint', { bus });
    r.onLinesCleared(snapshot({ linesCleared: 5 }));
    expect(bus.calls).toHaveLength(1);
  });
});
