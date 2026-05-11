// Live beat tracker — real-time BPM estimation + lookahead anticipation
// from FeatureBus kick onsets. Replaces the offline web-audio-beat-detector
// path for audio sources where we don't have a pre-decoded AudioBuffer
// (external tab capture) and for songs where the offline estimate is
// wrong (half/double tempo, tempo changes, weak kicks).
//
// Strategy:
//   - Subscribe to FB's 'kick' onset events. Each fire is one observed
//     kick timestamp on FB's clock (feature.totalSec, advances with ticks).
//   - Maintain a ring buffer of the last N kick times.
//   - Beat period ≈ median of recent inter-kick intervals (filtered to
//     a plausible BPM range so a missed kick doesn't pollute the median).
//   - Project next kick forward from the most recent kick + median period;
//     anticipation = 1 - timeToNext/leadTime in the lookahead window.
//
// API matches the offline beat-grid where it overlaps (`.anticipation`,
// `.phase`, `.bpm`, `.isAnalyzed`) so consumers (muon-original, debug
// overlay) treat the two interchangeably.

const LOOKAHEAD_SEC = 0.25;   // 250 ms — same window as offline grid
const HISTORY_SIZE  = 8;
const MIN_INTERVAL  = 0.20;   // 300 bpm cap (anything tighter is noise)
const MAX_INTERVAL  = 2.00;   //  30 bpm floor

export function createLiveBeatTracker({ feature } = {}) {
  if (!feature || !feature.onsets) {
    throw new Error('[live-beat-tracker] requires a FeatureBus with onsets');
  }

  const history = [];      // recent kick times (feature.totalSec)
  let medianInterval = 0;  // estimated beat period (sec); 0 = not ready

  function recomputeMedian() {
    if (history.length < 3) { medianInterval = 0; return; }
    const deltas = [];
    for (let i = 1; i < history.length; i++) {
      const d = history[i] - history[i - 1];
      if (d >= MIN_INTERVAL && d <= MAX_INTERVAL) deltas.push(d);
    }
    if (deltas.length < 2) { medianInterval = 0; return; }
    deltas.sort((a, b) => a - b);
    medianInterval = deltas[Math.floor(deltas.length / 2)];
  }

  feature.onsets.on('kick', () => {
    const t = feature.totalSec || 0;
    // Ignore "now=0" callbacks that can sneak in before FB has ticked.
    if (t <= 0) return;
    history.push(t);
    if (history.length > HISTORY_SIZE) history.shift();
    recomputeMedian();
  });

  function projectedNextKick(now) {
    if (medianInterval <= 0 || history.length === 0) return null;
    const last = history[history.length - 1];
    // Advance by whole-period steps until we're ahead of `now`.
    if (now <= last) return last + medianInterval;
    const beatsAhead = Math.ceil((now - last) / medianInterval);
    return last + beatsAhead * medianInterval;
  }

  return {
    /** True once we have enough observations to estimate BPM. */
    get isAnalyzed() { return medianInterval > 0; },
    /** False sentinel — kept so debug-overlay reuses the analyzing-state
     *  branch as a "warming up" indicator. */
    get isAnalyzing() { return medianInterval <= 0 && history.length > 0; },
    /** No equivalent to the offline grid's "analyse failed" — leave
     *  as null so the consumer's else-branch labels it "awaiting BGM". */
    get analyzeError() { return null; },

    get bpm() { return medianInterval > 0 ? 60 / medianInterval : 0; },
    get offsetSec() { return history.length ? history[0] : 0; },
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
      if (medianInterval <= 0 || history.length === 0) return 0;
      const last = history[history.length - 1];
      const since = now - last;
      if (since < 0) return 0;
      return (since % medianInterval) / medianInterval;
    },
  };
}
