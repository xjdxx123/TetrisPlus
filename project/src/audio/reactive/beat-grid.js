// Beat grid — Stage 5b second half of plan_particle_2.md.
//
// The "Tetris Effect feel" of *anticipation* — visuals leading the audio by
// ~250ms — cannot be done with live onset detection. By the time onset.js
// reports a kick, the kick has already happened. To run *ahead* of the
// audio you need to know where the next beat *will be*, which means
// pre-analyzed BPM + downbeat phase.
//
// This module owns the *projection*, not the analysis. The caller (today
// `audio/reactive/bpm-cache.js`) runs whole-track BPM analysis offline and
// hands the result to `setBpm(bpm, offsetSec)`. From there the grid:
//   1. Projects beat times: t_n = offsetSec + n * (60 / bpm).
//   2. On every tick, given the current song-time, dispatches:
//        'preBeat' once when each upcoming beat enters the lookahead
//                  window (default 250ms ahead),
//        'beat'    once when each beat's projected time has passed.
//   3. Maintains a continuous `anticipation` value [0..1] that ramps up
//      across the lookahead window — bindings consume this directly to
//      produce smooth pre-beat ramps without owning their own timers.
//
// Pure module — no Web Audio, no DOM. The legacy `analyze(buffer)` method
// remains for the existing test suite (it just delegates to setBpm), but
// production code uses `setBpm` directly via the per-track cache.
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
 * @param {BeatAnalyzer} [opts.analyzer]       Optional — only used by the legacy `analyze(buffer)`
 *                                             helper that the test suite still calls. Production
 *                                             code calls `setBpm(bpm, offset)` directly via the
 *                                             per-track cache.
 */
export function createBeatGrid({
  getSongTimeSec,
  lookaheadSec = 0.25,
  analyzer = null,
} = {}) {
  if (typeof getSongTimeSec !== 'function') {
    throw new Error('beat-grid requires getSongTimeSec function');
  }
  if (lookaheadSec <= 0) throw new Error('lookaheadSec must be > 0');

  // Cached BPM result. null until setBpm() lands.
  let bpm = null;
  let offsetSec = 0;
  let analyzing = false;       // surfaced by isAnalyzing for the debug overlay
  let analyzeError = null;

  // Scheduler state — tracks "what's the latest beat index whose time has
  // passed (or is approaching)" so we never double-fire.
  let lastBeatIdx = -1;
  let lastPreBeatIdx = -1;
  let lastSongTimeSec = 0;
  let cachedAnticipation = 0;
  let cachedPhase = 0;

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

  // Reset scheduler indices — called on song-time scrub-backward / loop and
  // on every track switch (the new playhead is at 0 of a different song).
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

  /**
   * Apply a {bpm, offset} pair from the per-track cache. This is the
   * production entry point — the new pipeline runs whole-track analysis
   * up-front (`audio/reactive/bpm-cache.js`) and feeds results in here on
   * every track change.
   *
   * Resets scheduler state so the projection starts clean from the new
   * track's first beat. Passing `bpm=null` (or omitting it) clears the
   * grid back to the pre-analysis state — useful while a new track's
   * analysis is still running.
   *
   * @param {number|null} bpmIn
   * @param {number}      [offsetIn=0]   Song-time of the first beat (sec)
   */
  function setBpm(bpmIn, offsetIn = 0) {
    if (bpmIn == null || !isFinite(bpmIn) || bpmIn <= 0) {
      bpm = null;
      offsetSec = 0;
      analyzeError = null;
      resetSchedulerState();
      return;
    }
    bpm = bpmIn;
    offsetSec = isFinite(offsetIn) ? offsetIn : 0;
    analyzeError = null;
    resetSchedulerState();
  }

  /** Convenience: drop the active BPM (e.g. while a new track is decoding). */
  function clearBpm() { setBpm(null); }

  /**
   * Legacy whole-buffer helper retained for the test suite. New production
   * code should run analysis through `audio/reactive/bpm-cache.js` and call
   * `setBpm(bpm, offset)` directly. This wrapper just runs the injected
   * analyzer on the buffer and forwards the result into setBpm.
   *
   * Unlike the previous semantics, each call is allowed to overwrite —
   * idempotency was a property the old single-file flow needed; the
   * per-track flow does not.
   *
   * @param {AudioBuffer} audioBuffer
   * @param {BeatAnalyzer} [analyzerOverride]
   */
  async function analyze(audioBuffer, analyzerOverride = null) {
    if (analyzing) return null;
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
      const localOffset = typeof result.offset === 'number' ? result.offset : 0;
      setBpm(result.bpm, localOffset);
      return { bpm, offset: offsetSec };
    } catch (err) {
      analyzeError = err;
      console.warn('[beat-grid] BPM analysis failed:', err?.message || err);
      return null;
    } finally {
      analyzing = false;
    }
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
    setBpm,
    clearBpm,
    analyze,             // legacy whole-buffer helper retained for tests
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
