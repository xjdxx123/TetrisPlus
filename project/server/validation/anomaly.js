// Anomaly detection — surfaces accounts whose replay-validation
// failure rate is unusually high over a rolling window.
//
// Plan online §I. Pure module: takes a player's recent
// match-validation history + returns a flag verdict. No DB I/O —
// the cron handler reads + writes; this function is the decision.
//
// The threshold is deliberately loose at launch (default 1% over
// 100 matches) — a single bad-luck rejection (network glitch
// caused desync, manual-review-needed false positive) shouldn't
// suspend an account. Tuning happens in Phase J after observing
// soft-launch data.

const DEFAULT_WINDOW             = 100;  // most recent N matches
const DEFAULT_FAILURE_RATE_FLAG  = 0.01; // 1% — chosen to ignore single fluky failures
const DEFAULT_MIN_MATCHES_TO_FLAG = 20;  // don't flag accounts with < 20 matches

/**
 * @typedef {Object} MatchOutcome
 * @property {boolean} validated   true when validateMatch accepted
 * @property {number}  endedAtMs   wall clock at end-of-match
 */

/**
 * @typedef {Object} AnomalyVerdict
 * @property {'ok'|'flag'} status
 * @property {string} [reason]
 * @property {{ recent:number, failed:number, rate:number }} stats
 */

/**
 * Check a player's validation record + return a flag verdict.
 *
 * @param {MatchOutcome[]} history    sorted desc by endedAtMs (most recent first)
 * @param {Object} [opts]
 * @param {number} [opts.windowSize=100]
 * @param {number} [opts.failureRateFlag=0.01]
 * @param {number} [opts.minMatchesToFlag=20]
 * @returns {AnomalyVerdict}
 */
export function checkPlayerHealth(history, opts = {}) {
  if (!Array.isArray(history)) {
    return {
      status: 'ok',
      stats: { recent: 0, failed: 0, rate: 0 },
    };
  }
  const window      = opts.windowSize        || DEFAULT_WINDOW;
  const flagRate    = opts.failureRateFlag   || DEFAULT_FAILURE_RATE_FLAG;
  const minMatches  = opts.minMatchesToFlag  || DEFAULT_MIN_MATCHES_TO_FLAG;

  const recent = history.slice(0, window);
  const failed = recent.filter(m => !m.validated).length;
  const rate   = recent.length > 0 ? (failed / recent.length) : 0;

  const stats = { recent: recent.length, failed, rate };

  // Don't flag accounts with insufficient sample size — false-
  // positive risk too high.
  if (recent.length < minMatches) {
    return { status: 'ok', stats };
  }

  if (rate > flagRate) {
    return {
      status: 'flag',
      reason: `validation_failure_rate=${(rate * 100).toFixed(2)}% over ${recent.length} matches (threshold ${(flagRate * 100).toFixed(2)}%)`,
      stats,
    };
  }
  return { status: 'ok', stats };
}

export const _DEFAULT_WINDOW              = DEFAULT_WINDOW;
export const _DEFAULT_FAILURE_RATE_FLAG   = DEFAULT_FAILURE_RATE_FLAG;
export const _DEFAULT_MIN_MATCHES_TO_FLAG = DEFAULT_MIN_MATCHES_TO_FLAG;
