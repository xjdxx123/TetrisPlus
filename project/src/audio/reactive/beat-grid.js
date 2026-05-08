// Beat grid — Stage 5b second half of plan_particle_2.md.
//
// The "Tetris Effect feel" of *anticipation* — visuals leading the audio by
// ~250ms — cannot be done with live onset detection. By the time onset.js
// reports a kick, the kick has already happened. To run *ahead* of the
// audio you need to know where the next beat *will be*, which means
// pre-analyzed BPM + downbeat phase.
//
// This module:
//   1. Runs offline BPM/downbeat detection on a decoded BGM buffer (via
//      web-audio-beat-detector, injected for testability).
//   2. Projects beat times: t_n = offsetSec + n * (60 / bpm).
//   3. On every tick, given the current song-time, dispatches:
//        'preBeat' once when each upcoming beat enters the lookahead
//                  window (default 250ms ahead),
//        'beat'    once when each beat's projected time has passed.
//   4. Maintains a continuous `anticipation` value [0..1] that ramps up
//      across the lookahead window — bindings consume this directly to
//      produce smooth pre-beat ramps without owning their own timers.
//
// Coupling discipline: the module knows nothing about Web Audio internals
// (beyond the `analyzer` callback's signature). The caller decodes the
// BGM, supplies a `getSongTimeSec()` thunk (bgmEl.currentTime), and the
// scheduler does the rest. That keeps the file unit-testable in pure Node.
//
// Sync-source choice: getSongTimeSec is the BGM element's currentTime, NOT
// the AudioContext's currentTime. They drift. AudioContext.currentTime is
// monotonic since context creation; bgmEl.currentTime resets on loop and
// reflects user-driven scrubbing — exactly what we need for beat alignment.

/**
 * @typedef {Object} BeatAnalyzeResult
 * @property {number} bpm
 * @property {number} offset   First-beat time in song-seconds
 */

/**
 * @typedef {(audioBuffer: any) => Promise<BeatAnalyzeResult>} BeatAnalyzer
 */

/**
 * @param {Object} opts
 * @param {() => number} opts.getSongTimeSec   Source of truth for "where are we in the song"
 * @param {number}       [opts.lookaheadSec=0.25]  How far ahead to fire preBeat
 * @param {BeatAnalyzer} [opts.analyzer]       Injected for tests; defaults to web-audio-beat-detector's `guess`
 * @param {number}       [opts.driftWindow=8]      How many recent onsets to track for drift
 * @param {number}       [opts.driftMinSamples=4]  Min onsets needed before isDrifting can be true
 * @param {number}       [opts.driftToleranceMs=40] Mean |onset-vs-predicted| above this = drifting
 * @param {number}       [opts.driftMinAgeSec=4]   Suppress drift flag for this long after an analysis
 */
export function createBeatGrid({
  getSongTimeSec,
  lookaheadSec = 0.25,
  analyzer = null,
  driftWindow = 8,
  driftMinSamples = 4,
  driftToleranceMs = 40,
  driftMinAgeSec = 4,
} = {}) {
  if (typeof getSongTimeSec !== 'function') {
    throw new Error('beat-grid requires getSongTimeSec function');
  }
  if (lookaheadSec <= 0) throw new Error('lookaheadSec must be > 0');

  // Cached BPM result. null until analyze() resolves successfully.
  let bpm = null;
  let offsetSec = 0;
  let analyzing = false;
  let analyzeError = null;
  // Song-time at which the latest BPM was set. Used to suppress the drift
  // flag right after an analysis lands (no tracks change BPM in 4 seconds).
  let bpmSetAtSongTimeSec = -Infinity;

  // Scheduler state — tracks "what's the latest beat index whose time has
  // passed (or is approaching)" so we never double-fire.
  let lastBeatIdx = -1;
  let lastPreBeatIdx = -1;
  let lastSongTimeSec = 0;
  let cachedAnticipation = 0;
  let cachedPhase = 0;

  // Drift detector state — circular buffer of signed alignment errors
  // (onsetTime - nearestBeatTime, in seconds). Each onset pushed via
  // recordOnset() updates the rolling sum so isDrifting/driftMeanAbs are
  // O(1) reads.
  const driftErrors = new Float32Array(driftWindow);
  let driftCount = 0;       // how many slots currently filled (≤ driftWindow)
  let driftWriteIdx = 0;
  let driftSumAbs = 0;      // sum of |errors| over filled slots

  // Subscriber sets, FeatureBus.onsets pattern.
  const subs = {
    beat:    new Set(),  // (strength: 1.0, beatIndex: number) — fired ON the beat
    preBeat: new Set(),  // (timeUntilSec: number, beatIndex: number) — fired ENTERING window
  };

  // One-shot schedule queue. Each entry fires exactly once when song-time
  // crosses `atSongTimeSec`. Used by the LineClearOrchestrator to peak its
  // flash/shockwave/veil layers ON the next beat for beat-quantized punch.
  // Plain array — at most a handful pending at a time so the linear scan
  // in tick() is cheaper than a heap.
  const pendingSchedules = [];

  function on(name, fn) {
    const set = subs[name];
    if (!set) throw new Error(`unknown beat event '${name}'. Available: ${Object.keys(subs).join(',')}`);
    if (typeof fn !== 'function') throw new Error('beat-grid subscriber must be a function');
    set.add(fn);
    return () => set.delete(fn);
  }

  function dispatch(name, ...args) {
    const set = subs[name];
    if (set.size === 0) return;
    const handlers = [...set];
    for (const fn of handlers) {
      try { fn(...args); }
      catch (err) { console.error(`[beat-grid] '${name}' handler threw:`, err); }
    }
  }

  // Reset scheduler indices — called on song-time scrub-backward / loop.
  function resetSchedulerState() {
    lastBeatIdx = -1;
    lastPreBeatIdx = -1;
    cachedAnticipation = 0;
    cachedPhase = 0;
    // Drop any pending schedules whose `atSongTimeSec` is in the future of
    // a previous song-time. After a loop / scrub-back, those would never
    // fire in the new timeline. Cheaper than per-schedule timeline tracking.
    pendingSchedules.length = 0;
  }

  function resetDriftState() {
    for (let i = 0; i < driftWindow; i++) driftErrors[i] = 0;
    driftCount = 0;
    driftWriteIdx = 0;
    driftSumAbs = 0;
  }

  /**
   * Run BPM/downbeat detection. Internal — called by both analyze (full
   * file: buffer covers song-time [0, duration]) and analyzeWindow
   * (rolling capture: buffer covers [endSongTime - duration, endSongTime]).
   *
   * Sets cached `bpm` + absolute `offsetSec` (song-time of first beat).
   * Resets scheduler + drift state on success so projections start clean.
   *
   * Unlike the original analyze() this is NOT idempotent — analyzeWindow
   * must be able to overwrite the cached BPM when a new track plays.
   */
  async function _runAnalysis(audioBuffer, windowStartSongTime, allowOverwrite, analyzerOverride) {
    if (analyzing) return null;
    if (!allowOverwrite && bpm != null) return { bpm, offset: offsetSec };
    const fn = analyzerOverride || analyzer;
    if (typeof fn !== 'function') {
      analyzeError = new Error('no analyzer injected; pass `analyzer` to createBeatGrid or analyze()');
      return null;
    }
    analyzing = true;
    analyzeError = null;
    try {
      const result = await fn(audioBuffer);
      if (!result || typeof result.bpm !== 'number' || !isFinite(result.bpm) || result.bpm <= 0) {
        throw new Error('analyzer returned invalid bpm');
      }
      bpm = result.bpm;
      const localOffset = typeof result.offset === 'number' ? result.offset : 0;
      // Translate the buffer-local first-beat offset into absolute song-time.
      // For the legacy analyze() path, windowStartSongTime is 0 so offsetSec
      // is just the analyzer's offset. For analyzeWindow, the buffer covers
      // [windowStart, windowEnd] so the absolute first beat is windowStart + offset.
      offsetSec = windowStartSongTime + localOffset;
      bpmSetAtSongTimeSec = getSongTimeSec();
      resetSchedulerState();
      resetDriftState();
      return { bpm, offset: offsetSec };
    } catch (err) {
      analyzeError = err;
      console.warn('[beat-grid] BPM analysis failed:', err?.message || err);
      // Don't wipe a previously-good bpm just because a re-analysis failed —
      // the old projection is better than none.
      if (!allowOverwrite) bpm = null;
      return null;
    } finally {
      analyzing = false;
    }
  }

  /**
   * One-shot analysis: the buffer is treated as covering song-time
   * [0, buffer.duration]. Idempotent (no-op once bpm is set).
   * @param {AudioBuffer} audioBuffer
   * @param {BeatAnalyzer} [analyzerOverride]
   */
  function analyze(audioBuffer, analyzerOverride = null) {
    return _runAnalysis(audioBuffer, 0, false, analyzerOverride);
  }

  /**
   * Windowed analysis: the buffer covers [windowStartSongTime,
   * windowStartSongTime + buffer.duration] in song-time. Replaces any
   * existing bpm — used to switch tempo when a new track starts.
   * @param {AudioBuffer} audioBuffer
   * @param {number}      windowStartSongTime  song-time at the start of the captured window
   * @param {BeatAnalyzer} [analyzerOverride]
   */
  function analyzeWindow(audioBuffer, windowStartSongTime, analyzerOverride = null) {
    return _runAnalysis(audioBuffer, windowStartSongTime, true, analyzerOverride);
  }

  /**
   * Push an onset's song-time into the drift detector. Computes the signed
   * error onsetTime - nearestPredictedBeatTime; the rolling mean |error|
   * powers `isDrifting`. No-op if BPM hasn't been set yet (no predictions
   * to compare against).
   * @param {number} songTimeSec
   */
  function recordOnset(songTimeSec) {
    if (bpm == null) return;
    if (!isFinite(songTimeSec)) return;
    const period = 60 / bpm;
    const phaseFromOffset = (songTimeSec - offsetSec) / period;
    const nearestIdx = Math.round(phaseFromOffset);
    const predicted = offsetSec + nearestIdx * period;
    const err = songTimeSec - predicted;     // signed seconds
    // Update rolling |error| sum: subtract the slot we're overwriting.
    if (driftCount === driftWindow) {
      driftSumAbs -= Math.abs(driftErrors[driftWriteIdx]);
    } else {
      driftCount++;
    }
    driftErrors[driftWriteIdx] = err;
    driftSumAbs += Math.abs(err);
    driftWriteIdx = (driftWriteIdx + 1) % driftWindow;
  }

  function driftMeanAbsSec() {
    if (driftCount === 0) return 0;
    return driftSumAbs / driftCount;
  }

  function isDrifting() {
    if (bpm == null) return false;
    if (driftCount < driftMinSamples) return false;
    const ageSec = getSongTimeSec() - bpmSetAtSongTimeSec;
    if (ageSec < driftMinAgeSec) return false;
    return driftMeanAbsSec() * 1000 > driftToleranceMs;
  }

  /**
   * Per-frame tick. Updates anticipation/phase, dispatches beat/preBeat.
   * Safe to call before analyze() resolves — no-ops until BPM is known.
   */
  function tick() {
    if (bpm == null) return;
    const t = getSongTimeSec();
    if (typeof t !== 'number' || !isFinite(t)) return;

    // Loop / scrub-backward detection. The vaporwave BGM loops; without
    // this, after one loop we'd compute a giant negative `elapsed`, fire
    // no beats forever, and pin anticipation at 0. The 0.5s threshold
    // ignores rounding noise but catches every loop or seek.
    if (t < lastSongTimeSec - 0.5) resetSchedulerState();
    lastSongTimeSec = t;

    const period = 60 / bpm;
    const elapsed = t - offsetSec;

    // Beat dispatch — every passed-or-equal beat index since the last tick.
    const passedIdx = Math.floor(elapsed / period);
    if (passedIdx > lastBeatIdx) {
      // First-time-running pin: when the user starts the song mid-track
      // (or scrubs forward), don't retroactively fire dozens of beats.
      // Skip everything except the most recent.
      const fireFrom = lastBeatIdx < 0 ? passedIdx : lastBeatIdx + 1;
      for (let i = fireFrom; i <= passedIdx; i++) {
        if (i >= 0) dispatch('beat', 1.0, i);
      }
      lastBeatIdx = passedIdx;
    }

    // PreBeat dispatch + anticipation ramp.
    const nextIdx = passedIdx + 1;
    const nextTime = offsetSec + nextIdx * period;
    const timeToNext = nextTime - t;

    if (timeToNext <= lookaheadSec && timeToNext >= 0) {
      // 0 at start of window (timeToNext == lookahead), 1 at the beat.
      cachedAnticipation = 1 - timeToNext / lookaheadSec;
      if (cachedAnticipation < 0) cachedAnticipation = 0;
      else if (cachedAnticipation > 1) cachedAnticipation = 1;
      if (nextIdx > lastPreBeatIdx) {
        lastPreBeatIdx = nextIdx;
        dispatch('preBeat', timeToNext, nextIdx);
      }
    } else {
      cachedAnticipation = 0;
    }

    // Phase: 0..1 sawtooth across one beat. 0 just after a beat, → 1 next beat.
    const m = elapsed % period;
    cachedPhase = ((m + period) % period) / period;

    // One-shot scheduled callbacks. Iterate backwards so we can splice in
    // place; small-N so O(n²) doesn't matter.
    for (let i = pendingSchedules.length - 1; i >= 0; i--) {
      if (t >= pendingSchedules[i].atSongTimeSec) {
        const { fn } = pendingSchedules[i];
        pendingSchedules.splice(i, 1);
        try { fn(); }
        catch (err) { console.error('[beat-grid] scheduled callback threw:', err); }
      }
    }
  }

  /**
   * Schedule a one-shot callback to fire when song-time crosses `atSongTimeSec`.
   * Driven by the same tick that drives beat events, so it works correctly
   * across pause / scrub / loop boundaries (a schedule that becomes
   * unreachable after a scrub-back is dropped by resetSchedulerState).
   *
   * @param {number}   atSongTimeSec  Song-time at which to fire.
   * @param {() => void} fn
   */
  function scheduleAt(atSongTimeSec, fn) {
    if (typeof fn !== 'function') {
      throw new Error('beat-grid scheduleAt requires a function');
    }
    if (typeof atSongTimeSec !== 'number' || !isFinite(atSongTimeSec)) {
      throw new Error('beat-grid scheduleAt requires a finite atSongTimeSec');
    }
    pendingSchedules.push({ atSongTimeSec, fn });
  }

  return {
    on,
    tick,
    analyze,
    analyzeWindow,
    recordOnset,
    scheduleAt,
    reset: resetSchedulerState,

    // Snapshot accessors. These are read every frame by bindings + the
    // F-key overlay; avoid allocations.
    get bpm()           { return bpm; },
    get offsetSec()     { return offsetSec; },
    get isAnalyzed()    { return bpm != null; },
    get isAnalyzing()   { return analyzing; },
    get analyzeError()  { return analyzeError; },
    get anticipation()  { return cachedAnticipation; },
    get phase()         { return cachedPhase; },
    get lastBeatIdx()   { return lastBeatIdx; },
    get bpmSetAtSongTimeSec() { return bpmSetAtSongTimeSec; },
    // Drift detector accessors — main.js polls these to decide when to
    // trigger a re-analysis.
    get driftMeanAbsSec()   { return driftMeanAbsSec(); },
    get driftSampleCount()  { return driftCount; },
    get isDrifting()        { return isDrifting(); },
    get nextBeatTimeSec() {
      if (bpm == null) return null;
      const period = 60 / bpm;
      return offsetSec + (lastBeatIdx + 1) * period;
    },
    /** Seconds until the next projected beat. `null` if not analyzed yet.
     *  Negative if we're inside the small "current beat just passed" gap
     *  before tick() advances `lastBeatIdx`. Read-only — bindings + the
     *  orchestrator use this to decide "schedule, or fire now?". */
    get secondsUntilNextBeat() {
      if (bpm == null) return null;
      const period = 60 / bpm;
      const nextBeat = offsetSec + (lastBeatIdx + 1) * period;
      return nextBeat - getSongTimeSec();
    },
  };
}
