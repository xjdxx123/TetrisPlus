// Live beat tracker — real-time BPM + lookahead anticipation from the
// audio stream. M-1 swap: BPM is now sourced from
// `realtime-bpm-analyzer` (AudioWorklet + chunk-ID probabilistic
// accumulation), with a median-of-FB-kicks bootstrap so anticipation
// still works during the worklet's warm-up window.
//
// Why hybrid:
//   - The worklet needs an AudioContext (post user-gesture) and a few
//     seconds of audio to settle. Until then `bpm == 0`.
//   - Our previous median-of-intervals estimator stabilises in ~3 kicks
//     (~1.5 s at 120 BPM). Used as a bootstrap, it gives us anticipation
//     during the warm-up; once the library returns a BPM in range, we
//     switch to it for steady-state accuracy.
//   - Phase reference (when did the last beat land?) always comes from
//     the FB `kick` onset stream — the library outputs BPM, not beat
//     positions. We project the next beat forward from `lastKick +
//     60/BPM`.
//
// Source-switch handling:
//   - The tracker connects the live audio source (BGM analyser or
//     external-capture analyser — both are AudioNodes) to the worklet
//     input. main.js calls `setSource(node)` whenever the active audio
//     source changes (post-init, on tab-capture start/stop).
//   - On switch, the worklet's `reset()` clears its accumulator so the
//     new track isn't averaged with the previous one's tempo.
//
// API matches the offline beat-grid where it overlaps (`.anticipation`,
// `.phase`, `.bpm`, `.isAnalyzed`, `.isAnalyzing`, `.analyzeError`,
// `.offsetSec`, `.historyCount`) so consumers (muon-original, debug
// overlay) treat the two interchangeably.

const LOOKAHEAD_SEC = 0.25;   // 250 ms — same window as offline grid
const HISTORY_SIZE  = 8;
// MIN_INTERVAL filters out FB.kick double-fires (bass line crashing into
// the kick body within a single beat). 0.30 s ⇒ 200 BPM cap — covers all
// realistic music while rejecting the sub-200 ms fragment-kicks that
// produced the spurious 276 BPM bootstrap lock observed in M-1 testing.
const MIN_INTERVAL  = 0.30;   // 200 bpm cap for the bootstrap median
const MAX_INTERVAL  = 2.00;   //  30 bpm floor
// Plausible-music gate on the surfaced BPM. Bootstrap medians outside
// this range are treated as "no value" rather than overridden — better
// to show "analyzing…" than to lock anticipation to a clearly-wrong
// tempo (e.g. derived from FB.kick fragments mid-fill).
const PLAUSIBLE_MIN_BPM = 60;
const PLAUSIBLE_MAX_BPM = 180;
// Sanity gate on raw worklet samples before they enter the smoothing
// histogram. Library's own internal range is 90–180; we keep a slightly
// wider window so out-of-range outliers don't poison the mode pick.
const WORKLET_MIN_BPM = 60;
const WORKLET_MAX_BPM = 200;
// Histogram bucket size for smoothing the worklet's `bpmStable` stream
// — it emits multiple values per chunk at different threshold levels,
// so the mode of recent buckets is far more stable than the latest one.
const BPM_BUCKET_SIZE  = 2;
const STABLE_HISTORY   = 30;

export function createLiveBeatTracker({ feature } = {}) {
  if (!feature || !feature.onsets) {
    throw new Error('[live-beat-tracker] requires a FeatureBus with onsets');
  }

  // --- Bootstrap path (median of recent kick intervals) ---
  const history = [];           // recent kick times (feature.totalSec)
  let bootstrapBpm = 0;         // 0 = not enough observations yet
  let lastKickTime = 0;         // most recent kick time (also used by phase)

  // --- Library path (realtime-bpm-analyzer / AudioWorklet) ---
  let workletBpm = 0;           // smoothed BPM (mode of recent bpmStable buckets)
  let workletStable = false;    // true once 'bpmStable' has fired at least once
  const stableHistory = [];     // ring of recent bpmStable buckets
  let analyzeError = null;
  let analyzer = null;          // BpmAnalyzer (lazy — needs AudioContext)
  let pendingSetup = false;
  let currentSource = null;     // AudioNode currently connected to analyzer

  function bucketBpm(t) { return Math.round(t / BPM_BUCKET_SIZE) * BPM_BUCKET_SIZE; }

  function modeOfHistory() {
    if (stableHistory.length === 0) return 0;
    const counts = new Map();
    for (const v of stableHistory) counts.set(v, (counts.get(v) || 0) + 1);
    let bestVal = stableHistory[stableHistory.length - 1];
    let bestCount = 0;
    for (const [v, c] of counts) {
      if (c > bestCount) { bestCount = c; bestVal = v; }
    }
    return bestVal;
  }

  function recomputeBootstrap() {
    // Lock from as few as 2 kicks (1 valid delta). The worklet's intrinsic
    // warm-up can be 10+ seconds on songs with weak transients; we want
    // anticipation working much sooner. The first lock is noisy by
    // design — once we have more history the median tracks the actual
    // beat period, and the worklet eventually overrides regardless.
    if (history.length < 2) { bootstrapBpm = 0; return; }
    const deltas = [];
    for (let i = 1; i < history.length; i++) {
      const d = history[i] - history[i - 1];
      if (d >= MIN_INTERVAL && d <= MAX_INTERVAL) deltas.push(d);
    }
    if (deltas.length < 1) { bootstrapBpm = 0; return; }
    deltas.sort((a, b) => a - b);
    const medianInterval = deltas[Math.floor(deltas.length / 2)];
    bootstrapBpm = medianInterval > 0 ? 60 / medianInterval : 0;
  }

  // One-shot dev diagnostics so the M-1 verification window can see in
  // the console *when* each path first produces a value. Flagged once
  // per tracker instance — no per-frame spam.
  let _loggedFirstKick = false;
  let _loggedBootstrap = false;

  feature.onsets.on('kick', () => {
    const t = feature.totalSec || 0;
    if (t <= 0) return;
    lastKickTime = t;
    history.push(t);
    if (history.length > HISTORY_SIZE) history.shift();
    const prevBpm = bootstrapBpm;
    recomputeBootstrap();
    if (!_loggedFirstKick) {
      _loggedFirstKick = true;
      console.log(`[live-beat-tracker] first FB kick at ${t.toFixed(2)}s`);
    }
    if (!_loggedBootstrap && prevBpm === 0 && bootstrapBpm > 0) {
      _loggedBootstrap = true;
      console.log(`[live-beat-tracker] bootstrap BPM locked at ${t.toFixed(2)}s = ${bootstrapBpm.toFixed(1)} bpm (history=${history.length})`);
    }
  });

  async function setupAnalyzer(audioContext) {
    if (analyzer || pendingSetup || !audioContext) return;
    pendingSetup = true;
    try {
      // Lazy import — keeps the worklet bundle off the synchronous boot
      // path, alongside the rest of the audio-reactive lazy chunks
      // (web-audio-beat-detector in bpm-cache, etc.).
      const lib = await import('realtime-bpm-analyzer');
      const a = await lib.createRealtimeBpmAnalyzer(audioContext, {
        continuousAnalysis: true,
      });
      // Only the `bpmStable` event drives our exposed BPM. The `bpm`
      // event fires every chunk at every threshold level and is far too
      // noisy (multiple disagreeing values per ~85 ms). Each stable
      // value goes into a bucketed histogram; we surface the mode. This
      // settles BPM jitter from ~±20 BPM down to ~±2 BPM within a few
      // seconds of accumulation.
      let _loggedFirstWorkletBpm = false;
      a.on('bpmStable', (data) => {
        workletStable = true;
        if (!data || !data.bpm || !data.bpm.length) return;
        const tempo = Number(data.bpm[0].tempo);
        if (!Number.isFinite(tempo) || tempo < WORKLET_MIN_BPM || tempo > WORKLET_MAX_BPM) return;
        stableHistory.push(bucketBpm(tempo));
        if (stableHistory.length > STABLE_HISTORY) stableHistory.shift();
        workletBpm = modeOfHistory();
        if (!_loggedFirstWorkletBpm) {
          _loggedFirstWorkletBpm = true;
          console.log(`[live-beat-tracker] worklet first stable BPM at ${(feature.totalSec || 0).toFixed(2)}s = ${tempo.toFixed(1)} bpm (smoothed: ${workletBpm})`);
        }
      });
      a.on('error', ({ message, error }) => {
        analyzeError = error || new Error(message);
        console.warn('[live-beat-tracker] analyzer error:', message);
      });
      analyzer = a;
      // Connect the worklet's output to destination via a silent gain.
      // AudioWorkletNodes are only scheduled to run when they have a
      // path to destination — without this sink the worklet's process()
      // never gets called, no peaks are detected, and no BPM events
      // ever fire. The worklet writes nothing to its output buffers, so
      // gain=0 isn't strictly necessary, but defends against future
      // versions that might emit anything audible.
      try {
        const silent = audioContext.createGain();
        silent.gain.value = 0;
        analyzer.node.connect(silent);
        silent.connect(audioContext.destination);
      } catch (err) {
        analyzeError = err;
        console.warn('[live-beat-tracker] failed to attach silent sink:', err?.message || err);
      }
      // If a source was set while we were awaiting, connect it now.
      if (currentSource) {
        try { currentSource.connect(analyzer.node); }
        catch (err) { analyzeError = err; }
      }
    } catch (err) {
      analyzeError = err;
      console.warn('[live-beat-tracker] failed to create analyzer:', err?.message || err);
    } finally {
      pendingSetup = false;
    }
  }

  function setSource(sourceNode) {
    if (sourceNode === currentSource) return;
    // Disconnect previous source from the worklet input.
    if (currentSource && analyzer) {
      try { currentSource.disconnect(analyzer.node); }
      catch { /* may already be disconnected by upstream tear-down */ }
    }
    currentSource = sourceNode || null;
    // New stream → reset state so the previous track's tempo doesn't
    // average with the new one. Bootstrap median is left alone — it
    // self-rotates as FB kicks come in for the new source.
    workletBpm = 0;
    workletStable = false;
    if (analyzer) { try { analyzer.reset(); } catch { /* noop */ } }
    if (!sourceNode) return;
    // Lazy-create the worklet on first non-null source. The library
    // calls audioContext.resume() internally.
    if (!analyzer) {
      void setupAnalyzer(sourceNode.context);
      return;
    }
    try { sourceNode.connect(analyzer.node); }
    catch (err) { analyzeError = err; }
  }

  function effectiveBpm() {
    // Worklet wins once it's reported a valid BPM; otherwise fall back
    // to the median bootstrap so anticipation works during warm-up.
    // Bootstrap is sanity-gated to plausible music range — fragment-
    // kicks can drive medianInterval into sub-300 ms territory and
    // produce 200+ BPM "tempos" that would mis-time anticipation.
    if (workletBpm > 0) return workletBpm;
    if (bootstrapBpm >= PLAUSIBLE_MIN_BPM && bootstrapBpm <= PLAUSIBLE_MAX_BPM) return bootstrapBpm;
    return 0;
  }

  function projectedNextKick(now) {
    const bpm = effectiveBpm();
    if (bpm <= 0 || lastKickTime <= 0) return null;
    const period = 60 / bpm;
    if (now <= lastKickTime) return lastKickTime + period;
    const beatsAhead = Math.ceil((now - lastKickTime) / period);
    return lastKickTime + beatsAhead * period;
  }

  /** Forget the current track's tempo + phase state — without
   *  re-routing the audio source. Used on BGM track change so the new
   *  track's BPM isn't averaged with the previous one's. The worklet's
   *  reset() clears its accumulator; we also drop the bootstrap history
   *  and lastKickTime so anticipation returns to idle until the new
   *  track's first kick lands. */
  function reset() {
    if (analyzer) { try { analyzer.reset(); } catch { /* noop */ } }
    workletBpm = 0;
    workletStable = false;
    stableHistory.length = 0;
    bootstrapBpm = 0;
    history.length = 0;
    lastKickTime = 0;
  }

  return {
    /** Connect / disconnect the live audio source. Pass an AudioNode
     *  (e.g. the BGM analyser, the external-capture analyser) whose
     *  output should feed the BPM worklet. Pass null to detach. */
    setSource,
    reset,

    /** True once we have any BPM estimate (worklet or bootstrap). */
    get isAnalyzed() { return effectiveBpm() > 0; },
    /** Warming up — kicks observed or worklet setup running, but no
     *  BPM yet. Drives the debug overlay's "analyzing…" label. */
    get isAnalyzing() { return effectiveBpm() <= 0 && (history.length > 0 || pendingSetup); },
    /** Surfaces worklet load / processing errors so the overlay can
     *  show '⚠ analysis failed' instead of staying in "analyzing…". */
    get analyzeError() { return analyzeError; },

    get bpm() { return effectiveBpm(); },
    /** Which source the BPM is coming from — 'worklet' (preferred),
     *  'bootstrap' (median fallback), or 'none'. Diagnostics only. */
    get bpmSource() { return workletBpm > 0 ? 'worklet' : (bootstrapBpm > 0 ? 'bootstrap' : 'none'); },
    /** Raw worklet BPM (0 = no event yet). For console diagnostics. */
    get workletBpm() { return workletBpm; },
    /** Raw bootstrap BPM (0 = not enough kicks). For console diagnostics. */
    get bootstrapBpm() { return bootstrapBpm; },
    /** True while the lazy import / worklet setup is in flight. */
    get isPendingSetup() { return pendingSetup; },
    /** True once realtime-bpm-analyzer has emitted bpmStable. */
    get isStable() { return workletStable; },
    /** Time of the most recent kick observation (feature.totalSec).
     *  Surfaced as 'offsetSec' in the debug overlay. */
    get offsetSec() { return lastKickTime; },
    get historyCount() { return history.length; },

    /** 0..1 over the LOOKAHEAD_SEC before the projected next kick. */
    get anticipation() {
      const now = feature.totalSec || 0;
      const next = projectedNextKick(now);
      if (next == null) return 0;
      const ttn = next - now;
      if (ttn <= 0 || ttn > LOOKAHEAD_SEC) return 0;
      return 1 - (ttn / LOOKAHEAD_SEC);
    },

    /** 0..1 within the current beat period. */
    get phase() {
      const now = feature.totalSec || 0;
      const bpm = effectiveBpm();
      if (bpm <= 0 || lastKickTime <= 0) return 0;
      const period = 60 / bpm;
      const since = now - lastKickTime;
      if (since < 0) return 0;
      return (since % period) / period;
    },
  };
}
