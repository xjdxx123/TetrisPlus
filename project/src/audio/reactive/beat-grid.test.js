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

  it('analyze() runs the analyzer each call (overwrites — per-track flow)', async () => {
    // Idempotency was an artifact of the single-file legacy where re-running
    // the analyzer would have wasted CPU. The per-track pipeline expects
    // overwrites — bpm-cache.js is the layer that dedupes work via its URL
    // cache; beat-grid no longer needs to.
    const a = vi.fn()
      .mockResolvedValueOnce({ bpm: 100, offset: 0 })
      .mockResolvedValueOnce({ bpm: 140, offset: 0.1 });
    const grid = createBeatGrid({ getSongTimeSec: () => 0, analyzer: a });
    await grid.analyze({});
    expect(grid.bpm).toBe(100);
    await grid.analyze({});
    expect(a).toHaveBeenCalledTimes(2);
    expect(grid.bpm).toBe(140);
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
// Per-track BPM injection (replaces analyzeWindow + drift detection).
// New flow: bpm-cache.js runs whole-track analysis offline; main.js calls
// setBpm/clearBpm on every playlist track change.
// ===================================================================

describe('beat-grid — setBpm', () => {
  it('sets bpm and offset directly without an analyzer call', () => {
    const grid = createBeatGrid({ getSongTimeSec: () => 0 });
    grid.setBpm(140, 0.25);
    expect(grid.bpm).toBe(140);
    expect(grid.offsetSec).toBeCloseTo(0.25, 5);
    expect(grid.isAnalyzed).toBe(true);
  });

  it('overwrites a prior bpm cleanly (track-switch path)', () => {
    const grid = createBeatGrid({ getSongTimeSec: () => 0 });
    grid.setBpm(120, 0);
    grid.setBpm(160, 0.10);
    expect(grid.bpm).toBe(160);
    expect(grid.offsetSec).toBeCloseTo(0.10, 5);
  });

  it('resets scheduler state on every set', () => {
    let songTime = 0;
    const grid = createBeatGrid({ getSongTimeSec: () => songTime });
    grid.setBpm(120, 0);
    songTime = 0.6; grid.tick();   // crossed beat 0
    expect(grid.lastBeatIdx).toBeGreaterThan(-1);
    grid.setBpm(140, 0);            // new track — reset
    expect(grid.lastBeatIdx).toBe(-1);
    expect(grid.anticipation).toBe(0);
  });

  it('clearBpm() reverts to pre-analysis state', () => {
    const grid = createBeatGrid({ getSongTimeSec: () => 0 });
    grid.setBpm(120, 0);
    expect(grid.isAnalyzed).toBe(true);
    grid.clearBpm();
    expect(grid.isAnalyzed).toBe(false);
    expect(grid.bpm).toBeNull();
  });

  it('rejects bogus inputs by clearing rather than crashing', () => {
    const grid = createBeatGrid({ getSongTimeSec: () => 0 });
    grid.setBpm(120, 0);
    grid.setBpm(null);
    expect(grid.isAnalyzed).toBe(false);
    grid.setBpm(120, 0);
    grid.setBpm(NaN, 0);
    expect(grid.isAnalyzed).toBe(false);
    grid.setBpm(120, 0);
    grid.setBpm(0, 0);     // zero/negative bpm makes no sense
    expect(grid.isAnalyzed).toBe(false);
  });

  it('drops pending schedules on track switch', () => {
    let songTime = 0;
    const grid = createBeatGrid({ getSongTimeSec: () => songTime });
    grid.setBpm(120, 0);
    const fn = vi.fn();
    grid.scheduleAt(0.5, fn);
    grid.setBpm(140, 0);   // new track — pending schedule from old timeline must vanish
    songTime = 1.0; grid.tick();
    expect(fn).not.toHaveBeenCalled();
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
