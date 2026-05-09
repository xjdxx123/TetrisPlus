import { describe, it, expect } from 'vitest';
import { buildUltraRules, ULTRA_DURATION_MS, ULTRA_MILESTONES_MS } from './ultra.js';
import { lineClearScore } from '../scoring.js';
import { EVENTS } from '../events.js';

function makeFakeBus() {
  const calls = [];
  return { calls, emit(topic, payload) { calls.push({ topic, payload }); } };
}
function snapshot({ score = 0, lines = 0, level = 1, linesCleared = lines, timeMs = 0 } = {}) {
  return { score, lines, level, linesCleared, timeMs };
}

describe('ultra rules — boot', () => {
  it('returns a frozen Rules object keyed ultra', () => {
    const r = buildUltraRules();
    expect(r.key).toBe('ultra');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('exposes the constants the plan locked in', () => {
    expect(ULTRA_DURATION_MS).toBe(120_000);
    expect(ULTRA_MILESTONES_MS).toEqual([30_000, 60_000, 90_000, 110_000, 115_000, 118_000, 119_000]);
  });

  it('initialModeView seeds the HUD with timeRemaining + score', () => {
    const r = buildUltraRules();
    expect(r.initialModeView).toEqual({
      kind: 'ultra',
      timeRemainingMs: 120_000,
      target: 120_000,
      score: 0,
    });
  });

  it('lineScore matches the standard scoring table (no Ultra-specific multiplier)', () => {
    const r = buildUltraRules();
    expect(r.lineScore(1, 1)).toBe(lineClearScore(1, 1));
    expect(r.lineScore(4, 9)).toBe(lineClearScore(4, 9));
  });

  it('shares the classic gravity curve (level still ramps inside 2 minutes)', () => {
    const r = buildUltraRules({ gravityScalar: () => 1.0 });
    expect(r.fallIntervalSec(1)).toBeCloseTo(0.85, 5);
    expect(r.fallIntervalSec(5)).toBeCloseTo(0.85 * Math.pow(0.85, 4), 5);
  });

  it('resetsHighScoreSlot is true (Ultra score feeds the global high score)', () => {
    expect(buildUltraRules().resetsHighScoreSlot).toBe(true);
  });
});

describe('ultra rules — endCondition', () => {
  it('returns null below 120000ms', () => {
    const r = buildUltraRules();
    expect(r.endCondition(snapshot({ timeMs: 0 }))).toBeNull();
    expect(r.endCondition(snapshot({ timeMs: 119_999 }))).toBeNull();
  });

  it('returns reason: time at exactly 120000ms', () => {
    const r = buildUltraRules();
    expect(r.endCondition(snapshot({ timeMs: 120_000 }))).toEqual({ reason: 'time' });
  });

  it('still returns reason: time after the threshold (overrun by frame jitter)', () => {
    const r = buildUltraRules();
    expect(r.endCondition(snapshot({ timeMs: 120_010 }))).toEqual({ reason: 'time' });
  });

  it('safe against null state inputs', () => {
    const r = buildUltraRules();
    expect(r.endCondition(null)).toBeNull();
  });
});

describe('ultra rules — onTick milestones', () => {
  it('fires MODE_GOAL_PROGRESS the first time each milestone is crossed', () => {
    const bus = makeFakeBus();
    const r = buildUltraRules({ bus });
    // Walk through one second at a time. Each call should fire a
    // milestone IFF a threshold was crossed since the previous call.
    for (let t = 0; t <= 119_500; t += 1000) {
      r.onTick(snapshot({ timeMs: t }), 1000);
    }
    const ms = bus.calls
      .filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS && c.payload.kind === 'time')
      .map(c => c.payload.value);
    expect(ms).toEqual([30_000, 60_000, 90_000, 110_000, 115_000, 118_000, 119_000]);
  });

  it('does not double-fire a milestone on subsequent ticks', () => {
    const bus = makeFakeBus();
    const r = buildUltraRules({ bus });
    r.onTick(snapshot({ timeMs: 30_500 }), 16);
    r.onTick(snapshot({ timeMs: 31_000 }), 16);
    r.onTick(snapshot({ timeMs: 31_500 }), 16);
    const events = bus.calls.filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS);
    expect(events).toHaveLength(1);
  });

  it('fires multiple milestones in order if a single tick crosses several', () => {
    // Edge case: post-pause-resume, a single tick could see a ~5s jump.
    const bus = makeFakeBus();
    const r = buildUltraRules({ bus });
    r.onTick(snapshot({ timeMs: 0 }), 0);
    r.onTick(snapshot({ timeMs: 95_000 }), 95_000); // crosses 30s + 60s + 90s
    const ms = bus.calls
      .filter(c => c.topic === EVENTS.MODE_GOAL_PROGRESS)
      .map(c => c.payload.value);
    expect(ms).toEqual([30_000, 60_000, 90_000]);
  });

  it('emits payload with kind=time, value=milestoneMs, target=duration', () => {
    const bus = makeFakeBus();
    const r = buildUltraRules({ bus });
    r.onTick(snapshot({ timeMs: 30_500 }), 16);
    const event = bus.calls.find(c => c.topic === EVENTS.MODE_GOAL_PROGRESS);
    expect(event.payload).toEqual({ kind: 'time', value: 30_000, target: 120_000 });
  });

  it('runs without a bus (silent no-op)', () => {
    const r = buildUltraRules();
    expect(() => r.onTick(snapshot({ timeMs: 60_000 }), 16)).not.toThrow();
  });

  it('milestone state resets across rule-pack instances', () => {
    const bus = makeFakeBus();
    const a = buildUltraRules({ bus });
    a.onTick(snapshot({ timeMs: 30_500 }), 0);
    expect(bus.calls.length).toBe(1);
    const b = buildUltraRules({ bus });
    b.onTick(snapshot({ timeMs: 30_500 }), 0);
    expect(bus.calls.length).toBe(2);
  });
});

describe('ultra rules — registry integration', () => {
  it('is selected when buildRules("ultra") is called', async () => {
    const { buildRules } = await import('../rules.js');
    const r = buildRules('ultra');
    expect(r.key).toBe('ultra');
    expect(r.duration).toBe(120_000);
  });

  it('passes through bus + gravityScalar', async () => {
    const { buildRules } = await import('../rules.js');
    const bus = makeFakeBus();
    const r = buildRules('ultra', { bus });
    r.onTick(snapshot({ timeMs: 30_500 }), 16);
    expect(bus.calls).toHaveLength(1);
  });
});
