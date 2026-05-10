// Replay validation — re-runs a reported match server-side using
// the same `gameplay/` package as the client + asserts the outcome
// matches what was reported. The architectural lynchpin from
// plan_online_versus.md §3.2 (Pillar A: simulation as the source
// of truth) + §H (anti-cheat).
//
// Runs as a Cloudflare Workers cron (every 5 min, configurable in
// wrangler.toml). Pulls unvalidated matches from D1, re-simulates
// each via the replay player + gameplay/, and:
//
//   - validate=true  → accepted, ELO delta is published
//   - validate=false → flagged, ELO update rolled back, telemetry
//                       counter ticks (for Phase I anomaly detection)
//
// Pure module — no DB I/O of its own. The cron handler in
// `validation-cron.js` does the D1 read/write; this function is the
// pure decision logic so it tests + audits cleanly.

import { replayInputs } from '../../src/gameplay/replay/index.js';

/**
 * @typedef {Object} MatchSubmission
 * @property {string} matchId
 * @property {number} seed
 * @property {string} modeKey
 * @property {Object} p1   { userId, inputs:[{tick,frame}], totalTicks }
 * @property {Object} p2   { userId, inputs, totalTicks }
 * @property {string} reportedWinner   p1's userId, p2's userId, or 'draw'
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} validated
 *   true when both sides re-simulate to a consistent outcome that
 *   matches the reported winner; false otherwise.
 * @property {string} actualWinner
 *   The winner the server-side re-run produced. May differ from
 *   the reported winner when validated=false.
 * @property {string} [reason]
 *   When validated=false, a short tag describing the failure mode.
 *   Surfaced in telemetry for tuning.
 * @property {{p1:number, p2:number}} ticksRun
 *   How many ticks each side simulated before terminating. Useful
 *   for anomaly detection ("did the player resign at tick 5?").
 */

/**
 * Re-simulate a reported match outcome + verify it matches.
 *
 * @param {MatchSubmission} submission
 * @returns {ValidationResult}
 */
export function validateMatch(submission) {
  if (!submission || !submission.p1 || !submission.p2) {
    return { validated: false, actualWinner: 'draw', reason: 'MALFORMED_SUBMISSION', ticksRun: { p1: 0, p2: 0 } };
  }
  const { matchId, seed, modeKey, p1, p2, reportedWinner } = submission;
  void matchId;

  // Replay each side from the same seed + reported inputs.
  let r1, r2;
  try {
    r1 = replayInputs({ v: 1, seed, modeKey, dtMs: 1000/60, inputs: p1.inputs, totalTicks: p1.totalTicks });
    r2 = replayInputs({ v: 1, seed, modeKey, dtMs: 1000/60, inputs: p2.inputs, totalTicks: p2.totalTicks });
  } catch (err) {
    return { validated: false, actualWinner: 'draw', reason: 'REPLAY_THREW:' + err.message, ticksRun: { p1: 0, p2: 0 } };
  }

  const p1End = r1.finalBlob;
  const p2End = r2.finalBlob;
  const ticksRun = { p1: p1End.modeTimeMs ? Math.round(p1End.modeTimeMs / (1000/60)) : 0,
                     p2: p2End.modeTimeMs ? Math.round(p2End.modeTimeMs / (1000/60)) : 0 };

  // Determine actual winner from the re-simulated end states.
  // Standard rule: whoever's gameOver=false at the longest tick
  // count wins; if both topped out at identical times, it's a draw.
  // (More elaborate arbitration goes here when the rules pack
  // grows additional terminal conditions.)
  let actualWinner;
  const p1Lost = !!p1End.gameOver;
  const p2Lost = !!p2End.gameOver;
  if (p1Lost && p2Lost) {
    if (ticksRun.p1 === ticksRun.p2) actualWinner = 'draw';
    else actualWinner = (ticksRun.p1 > ticksRun.p2) ? p1.userId : p2.userId;
  } else if (p1Lost) {
    actualWinner = p2.userId;
  } else if (p2Lost) {
    actualWinner = p1.userId;
  } else {
    // Neither topped out within the recorded inputs — the match
    // was cut short. Fall back to whoever has the higher score at
    // this tick.
    actualWinner = (p1End.score >= p2End.score) ? p1.userId : p2.userId;
  }

  if (actualWinner === reportedWinner) {
    return { validated: true, actualWinner, ticksRun };
  }
  return {
    validated: false,
    actualWinner,
    reason: `WINNER_MISMATCH:reported=${reportedWinner},actual=${actualWinner}`,
    ticksRun,
  };
}
