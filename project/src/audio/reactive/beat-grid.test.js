import { describe, it, expect, vi } from 'vitest';
import { createBeatGrid } from './beat-grid.js';

// Helper: drive the grid with a controllable song-time.
function makeGrid({ bpm = 120, offset = 0, lookaheadSec = 0.25 } = {}) {
  let songTime = 0;
  const grid = createBeatGrid({
    getSongTimeSec: () => songTime,
    lookaheadSec,
    analyzer: async () => ({ bpm, offset }),
  });
  return {
    grid,
    setSongTime(t) { songTime = t; },
    advance(dt) { songTime += dt; grid.tick(); },
  };
}

describe('createBeatGrid', () => {
  it('throws if getSongTimeSec is missing', () => {
    expect(() => createBeatGrid({})).toThrow();
    expect(() => createBeatGrid({ getSongTimeSec: () => 0, lookaheadSec: 0 })).toThrow();
  });

  it('isAnalyzed is false until analyze() resolves', async () => {
    const { grid } = makeGrid();
    expect(grid.isAnalyzed).toBe(false);
    await grid.analyze({});
    expect(grid.isAnalyzed).toBe(true);
    expect(grid.bpm).toBe(120);
  });

  it('tick() is a no-op before analysis', () => {
    const { grid, advance } = makeGrid();
    const fn = vi.fn();
    grid.on('beat', fn);
    advance(2);
    expect(fn).not.toHaveBeenCalled();
    expect(grid.anticipation).toBe(0);
  });

  it('analyze() is idempotent — second call returns cached result', async () => {
    const a = vi.fn(async () => ({ bpm: 100, offset: 0 }));
    const grid = createBeatGrid({ getSongTimeSec: () => 0, analyzer: a });
    await grid.analyze({});
    await grid.analyze({});
    expect(a).toHaveBeenCalledTimes(1);
    expect(grid.bpm).toBe(100);
  });

  it('rejects an analyzer that returns no BPM and surfaces analyzeError', async () => {
    const grid = createBeatGrid({
      getSongTimeSec: () => 0,
      analyzer: async () => ({ bpm: NaN, offset: 0 }),
    });
    const result = await grid.analyze({});
    expect(result).toBeNull();
    expect(grid.isAnalyzed).toBe(false);
    expect(grid.analyzeError).toBeInstanceOf(Error);
  });

  it('throws on subscribing to an unknown channel', async () => {
    const { grid } = makeGrid();
    expect(() => grid.on('downbeat', () => {})).toThrow();
    expect(() => grid.on('beat', null)).toThrow();
  });

  it('dispatches a single "beat" event per beat boundary at 120bpm', async () => {
    // Use a 0.1s offset so the first beat is at t=0.1 — avoids the
    // first-tick-fires-beat-0 boundary which is tested separately.
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0.1 });
    await grid.analyze({});
    const fn = vi.fn();
    grid.on('beat', fn);

    // Period = 0.5s, offset = 0.1 → beats at 0.1, 0.6, 1.1, ...
    setSongTime(0.05); grid.tick();
    expect(fn).not.toHaveBeenCalled();
    setSongTime(0.5); grid.tick();
    expect(fn).toHaveBeenCalledTimes(1); // crossed beat #0 at t=0.1
    expect(fn.mock.calls[0][1]).toBe(0);
    setSongTime(0.55); grid.tick();
    expect(fn).toHaveBeenCalledTimes(1); // no double-fire while between beats
    setSongTime(0.7); grid.tick();
    expect(fn).toHaveBeenCalledTimes(2); // crossed beat #1 at t=0.6
    expect(fn.mock.calls[1][1]).toBe(1);
  });

  it('does not retroactively fire when analysis lands mid-song', async () => {
    // Song is already at t=10s when analysis lands. We must not fire
    // 20+ "missed" beats — that would dump every binding on the floor.
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0 });
    setSongTime(10.0);
    await grid.analyze({});
    const fn = vi.fn();
    grid.on('beat', fn);
    grid.tick();
    // First tick after analysis should only fire the most recent beat at most.
    expect(fn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('preBeat fires once when the upcoming beat enters the lookahead window', async () => {
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0, lookaheadSec: 0.1 });
    await grid.analyze({});
    const fn = vi.fn();
    grid.on('preBeat', fn);

    // Period = 0.5s, lookahead = 0.1s. The first beat is at t=0.5; preBeat
    // should fire when we cross t=0.4 and not fire again for that beat.
    setSongTime(0.39); grid.tick();
    expect(fn).not.toHaveBeenCalled();
    setSongTime(0.42); grid.tick();
    expect(fn).toHaveBeenCalledTimes(1);
    setSongTime(0.48); grid.tick();
    expect(fn).toHaveBeenCalledTimes(1); // still beat #1's preBeat
    // Next beat at 1.0; its preBeat window starts at 0.9.
    setSongTime(0.91); grid.tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('anticipation ramps 0→1 across the lookahead window', async () => {
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0, lookaheadSec: 0.2 });
    await grid.analyze({});
    // Beat at t=0.5; lookahead window [0.3 .. 0.5].
    setSongTime(0.2); grid.tick();
    expect(grid.anticipation).toBe(0);
    setSongTime(0.3); grid.tick();
    expect(grid.anticipation).toBeCloseTo(0, 2);
    setSongTime(0.4); grid.tick();
    expect(grid.anticipation).toBeCloseTo(0.5, 2);
    setSongTime(0.49); grid.tick();
    expect(grid.anticipation).toBeGreaterThan(0.9);
    setSongTime(0.51); grid.tick();
    // Past the beat — anticipation should reset (next window starts at 0.8)
    expect(grid.anticipation).toBe(0);
  });

  it('handles BGM loop — backward jump in song-time resets the scheduler', async () => {
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0 });
    await grid.analyze({});
    const fn = vi.fn();
    grid.on('beat', fn);
    setSongTime(2.0); grid.tick();   // mid-song first tick
    setSongTime(2.6); grid.tick();   // beat fires
    const beforeLoop = fn.mock.calls.length;
    // Loop back to t=0.0
    setSongTime(0.0); grid.tick();
    setSongTime(0.6); grid.tick();
    // Beat #1 of the loop should fire — not silently swallowed by the
    // scheduler thinking it already fired.
    expect(fn.mock.calls.length).toBeGreaterThan(beforeLoop);
  });

  it('honors a non-zero offset (downbeat phase)', async () => {
    // Offset 0.1s, period 0.5s → beats at 0.1, 0.6, 1.1, ...
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0.1 });
    await grid.analyze({});
    const fn = vi.fn();
    grid.on('beat', fn);
    setSongTime(0.05); grid.tick();
    expect(fn).not.toHaveBeenCalled();
    setSongTime(0.15); grid.tick();
    expect(fn).toHaveBeenCalledTimes(1);
    setSongTime(0.65); grid.tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('phase sweeps 0→1 across a beat period', async () => {
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0 });
    await grid.analyze({});
    setSongTime(0.0);  grid.tick();
    expect(grid.phase).toBeCloseTo(0, 2);
    setSongTime(0.25); grid.tick();
    expect(grid.phase).toBeCloseTo(0.5, 2);
    setSongTime(0.49); grid.tick();
    expect(grid.phase).toBeGreaterThan(0.95);
    setSongTime(0.5);  grid.tick();
    expect(grid.phase).toBeCloseTo(0, 2);
  });

  it('a throwing handler does not block siblings', async () => {
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0 });
    await grid.analyze({});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error('x'); });
    const good = vi.fn();
    grid.on('beat', bad);
    grid.on('beat', good);
    setSongTime(0.6); grid.tick();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('reset() clears scheduler state', async () => {
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0 });
    await grid.analyze({});
    setSongTime(0.6); grid.tick();
    expect(grid.lastBeatIdx).toBeGreaterThan(-1);
    grid.reset();
    expect(grid.lastBeatIdx).toBe(-1);
    expect(grid.anticipation).toBe(0);
  });
});

// ===================================================================
// Stage 5b multi-track support — analyzeWindow + drift detection.
// ===================================================================

describe('beat-grid — analyzeWindow', () => {
  it('treats the buffer as covering [windowStart, windowStart + duration]', async () => {
    let songTime = 100;
    const grid = createBeatGrid({ getSongTimeSec: () => songTime });
    // Analyzer claims the first beat is 0.10s into the buffer; the buffer
    // started at song-time 90 (windowStart). So absolute first beat = 90.10.
    const fakeBuffer = { duration: 10 };
    const result = await grid.analyzeWindow(fakeBuffer, 90, async () => ({ bpm: 120, offset: 0.10 }));
    expect(result.bpm).toBe(120);
    expect(result.offset).toBeCloseTo(90.10, 5);
    expect(grid.offsetSec).toBeCloseTo(90.10, 5);
  });

  it('overwrites a prior analysis (multi-track switch)', async () => {
    let songTime = 0;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      analyzer: async () => ({ bpm: 100, offset: 0 }),
    });
    await grid.analyze({});
    expect(grid.bpm).toBe(100);
    songTime = 300;  // we've moved into a new track
    await grid.analyzeWindow({ duration: 10 }, 290, async () => ({ bpm: 140, offset: 0.05 }));
    expect(grid.bpm).toBe(140);
    expect(grid.offsetSec).toBeCloseTo(290.05, 5);
  });

  it('preserves prior bpm when re-analysis fails', async () => {
    let songTime = 0;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      analyzer: async () => ({ bpm: 120, offset: 0 }),
    });
    await grid.analyze({});
    expect(grid.bpm).toBe(120);
    // Failing re-analysis must NOT wipe the cached bpm — the old projection
    // is still better than nothing while we wait for the next attempt.
    await grid.analyzeWindow({ duration: 10 }, 100, async () => { throw new Error('boom'); });
    expect(grid.bpm).toBe(120);
    expect(grid.analyzeError).toBeInstanceOf(Error);
  });

  it('updates bpmSetAtSongTimeSec to current song-time on success', async () => {
    let songTime = 50;
    const grid = createBeatGrid({ getSongTimeSec: () => songTime });
    await grid.analyzeWindow({ duration: 10 }, 40, async () => ({ bpm: 120, offset: 0 }));
    expect(grid.bpmSetAtSongTimeSec).toBeCloseTo(50, 5);
  });
});

describe('beat-grid — drift detection', () => {
  it('recordOnset is a no-op before BPM is known', () => {
    const grid = createBeatGrid({ getSongTimeSec: () => 0 });
    grid.recordOnset(1.0);
    grid.recordOnset(2.0);
    expect(grid.driftSampleCount).toBe(0);
    expect(grid.isDrifting).toBe(false);
  });

  it('reports zero mean error when onsets land exactly on beats', async () => {
    let songTime = 100;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      driftMinAgeSec: 0,  // disable cooldown for this test
    });
    // 120bpm → period 0.5s. Beats at 0, 0.5, 1.0, ...
    await grid.analyzeWindow({ duration: 10 }, 0, async () => ({ bpm: 120, offset: 0 }));
    songTime = 110;
    grid.recordOnset(0.5);
    grid.recordOnset(1.0);
    grid.recordOnset(1.5);
    grid.recordOnset(2.0);
    grid.recordOnset(2.5);
    expect(grid.driftMeanAbsSec).toBeCloseTo(0, 4);
    expect(grid.isDrifting).toBe(false);
  });

  it('flags drift when onsets land systematically off the predicted beats', async () => {
    let songTime = 100;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      driftToleranceMs: 40,
      driftMinAgeSec: 0,
      driftMinSamples: 4,
    });
    // 120bpm → beats at 0.5, 1.0, 1.5, 2.0, ...
    await grid.analyzeWindow({ duration: 10 }, 0, async () => ({ bpm: 120, offset: 0.5 }));
    songTime = 110;
    // Onsets land 80ms after each beat — well past 40ms tolerance.
    grid.recordOnset(0.58);
    grid.recordOnset(1.08);
    grid.recordOnset(1.58);
    grid.recordOnset(2.08);
    expect(grid.driftMeanAbsSec * 1000).toBeGreaterThan(40);
    expect(grid.isDrifting).toBe(true);
  });

  it('does not flag drift below driftMinSamples', async () => {
    let songTime = 100;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      driftMinAgeSec: 0,
      driftMinSamples: 4,
    });
    await grid.analyzeWindow({ duration: 10 }, 0, async () => ({ bpm: 120, offset: 0 }));
    songTime = 110;
    // Three onsets — below threshold even if they're badly off.
    grid.recordOnset(0.20);
    grid.recordOnset(0.70);
    grid.recordOnset(1.20);
    expect(grid.driftSampleCount).toBe(3);
    expect(grid.isDrifting).toBe(false);
  });

  it('suppresses drift flag during the cooldown window after analysis', async () => {
    let songTime = 100;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      driftToleranceMs: 40,
      driftMinAgeSec: 4,    // 4s cooldown
      driftMinSamples: 4,
    });
    await grid.analyzeWindow({ duration: 10 }, 90, async () => ({ bpm: 120, offset: 0 }));
    // bpmSetAt = 100. Push onsets that would normally trip drift…
    grid.recordOnset(0.20);
    grid.recordOnset(0.70);
    grid.recordOnset(1.20);
    grid.recordOnset(1.70);
    // …but song-time is still 100 (just analyzed) — cooldown blocks the flag.
    expect(grid.isDrifting).toBe(false);
    // Advance song-time past cooldown.
    songTime = 105;
    expect(grid.isDrifting).toBe(true);
  });

  it('drift state is reset by a new analysis', async () => {
    let songTime = 100;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      driftMinAgeSec: 0,
    });
    await grid.analyzeWindow({ duration: 10 }, 0, async () => ({ bpm: 120, offset: 0 }));
    songTime = 110;
    grid.recordOnset(0.20);
    grid.recordOnset(0.70);
    grid.recordOnset(1.20);
    grid.recordOnset(1.70);
    expect(grid.driftSampleCount).toBe(4);
    // New analysis lands — drift state must clear.
    await grid.analyzeWindow({ duration: 10 }, 100, async () => ({ bpm: 140, offset: 0 }));
    expect(grid.driftSampleCount).toBe(0);
    expect(grid.driftMeanAbsSec).toBe(0);
    expect(grid.isDrifting).toBe(false);
  });

  it('rolls oldest entry out when window fills', async () => {
    let songTime = 100;
    const grid = createBeatGrid({
      getSongTimeSec: () => songTime,
      driftWindow: 4,
      driftMinAgeSec: 0,
    });
    await grid.analyzeWindow({ duration: 10 }, 0, async () => ({ bpm: 120, offset: 0 }));
    songTime = 110;
    // Fill with 4 large-error onsets, then push 4 zero-error onsets — the
    // mean should converge to ~zero after the window rotates.
    // Beats at 0, 0.5, 1.0, 1.5 → these onsets each lag by 0.20s.
    grid.recordOnset(0.20); grid.recordOnset(0.70);
    grid.recordOnset(1.20); grid.recordOnset(1.70);
    expect(grid.driftMeanAbsSec).toBeCloseTo(0.20, 2);
    // Push 4 zero-error onsets — the rolling window now contains only these.
    grid.recordOnset(2.0); grid.recordOnset(2.5);
    grid.recordOnset(3.0); grid.recordOnset(3.5);
    expect(grid.driftMeanAbsSec).toBeCloseTo(0, 3);
  });
});

// ===================================================================
// Schedule queue (used by LineClearOrchestrator beat quantization).
// ===================================================================

describe('beat-grid — scheduleAt', () => {
  it('fires a scheduled callback once song-time crosses the target', async () => {
    const { grid, advance } = makeGrid({ bpm: 120 });
    await grid.analyze({});
    const fn = vi.fn();
    grid.scheduleAt(0.30, fn);
    advance(0.10);
    expect(fn).not.toHaveBeenCalled();
    advance(0.10);  // now at 0.20 — still before
    expect(fn).not.toHaveBeenCalled();
    advance(0.15);  // now at 0.35 — past 0.30
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires each callback exactly once even if many ticks pass', async () => {
    const { grid, advance } = makeGrid({ bpm: 120 });
    await grid.analyze({});
    const fn = vi.fn();
    grid.scheduleAt(0.05, fn);
    advance(0.10);
    advance(0.10);
    advance(0.10);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects non-function callbacks', async () => {
    const { grid } = makeGrid();
    await grid.analyze({});
    expect(() => grid.scheduleAt(0.5, null)).toThrow();
    expect(() => grid.scheduleAt(NaN, () => {})).toThrow();
    expect(() => grid.scheduleAt(Infinity, () => {})).toThrow();
  });

  it('reset() drops pending schedules (loop / scrub-back path)', async () => {
    const { grid, advance, setSongTime } = makeGrid({ bpm: 120 });
    await grid.analyze({});
    const fn = vi.fn();
    grid.scheduleAt(0.30, fn);
    setSongTime(0.20);
    grid.tick();
    expect(fn).not.toHaveBeenCalled();
    grid.reset();
    advance(0.50);  // would normally fire the callback at t=0.30
    expect(fn).not.toHaveBeenCalled();
  });

  it('handler error is logged but does not break the scheduler', async () => {
    const { grid, advance } = makeGrid({ bpm: 120 });
    await grid.analyze({});
    const goodFn = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    grid.scheduleAt(0.10, () => { throw new Error('boom'); });
    grid.scheduleAt(0.10, goodFn);
    advance(0.20);
    expect(goodFn).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('beat-grid — secondsUntilNextBeat', () => {
  it('returns null until analyze() resolves', () => {
    const { grid } = makeGrid();
    expect(grid.secondsUntilNextBeat).toBeNull();
  });

  it('measures the gap from the current song-time to the next beat', async () => {
    const { grid, setSongTime } = makeGrid({ bpm: 120, offset: 0.10 });
    await grid.analyze({});
    // Period 0.5s. Beats at 0.10, 0.60, 1.10, ...
    setSongTime(0.50);   // before first beat at 0.10? no — 0.50 > 0.10
    grid.tick();         // crosses beat #0 at 0.10; lastBeatIdx becomes 0
    setSongTime(0.55);   // 0.05s before beat #1 at 0.60
    expect(grid.secondsUntilNextBeat).toBeCloseTo(0.05, 5);
    setSongTime(0.20);   // immediately after beat #0; beat #1 still at 0.60
    expect(grid.secondsUntilNextBeat).toBeCloseTo(0.40, 5);
  });
});
