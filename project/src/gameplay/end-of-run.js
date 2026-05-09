// End-of-run helper — writes high score + per-mode best + cumulative totals
// to storage. Extracted from inline `triggerGameOver` (plan_gameplay_1.md §10.1).
//
// The writer is a single function: given the run summary and the persistence
// hooks, it computes the new stats blob and saves it. Pure logic except for
// the injected `loadStats` / `saveStats` calls — those are exactly the
// engine/storage.js exports today. Tests stub them with in-memory shadows.
//
// Extracted because four future modes (Marathon, Sprint, Ultra, Zen) each
// need to *augment* this write with a mode-specific best slot. Doing the
// extraction in a Classic-only PR is the cheapest time — when Sprint lands
// it adds a Sprint case, not a fork of the writer.

/**
 * @typedef {Object} EndOfRunSummary
 * @property {number} score
 * @property {number} lines
 * @property {number} level
 * @property {string} modeKey
 * @property {'topout'|'goal'|'time'|'forfeit'} reason
 * @property {number} sessionStartMs        performance.now() at run start
 * @property {number} piecesPlacedThisRun
 * @property {number} linesClearedThisRun
 * @property {boolean} [resetsHighScoreSlot]   When false (Zen), high score is
 *                                              not updated; only per-mode best.
 *                                              Default true.
 * @property {number} [goalMultiplier]      Score multiplier applied ONLY on
 *                                              `reason: 'goal'`. Default 1.0
 *                                              (no-op). Marathon: 1.5.
 * @property {number} [runTimeMs]           Pause-aware run duration. Used by
 *                                              modes that record best-time
 *                                              (Marathon `bestTimeMs`,
 *                                              Sprint, etc.).
 * @property {(best:any, summary:any) => void} [updateBest]
 *   Optional per-mode override for the per-mode-best update. Default
 *   behaviour is "score-based": replace best.score/lines/level when the
 *   new score is higher. Zen overrides this to track longestSessionMs +
 *   cumulative totalLines instead.
 */

/**
 * @typedef {Object} EndOfRunResult
 * @property {number}  score      The score that was recorded — equals
 *                                input score, post-multiplier when applied.
 * @property {boolean} multiplied  True when the goal multiplier modified the
 *                                input score.
 * @property {any}     stats       The persisted stats blob.
 */

/**
 * Persist a finished run to storage.
 *
 * @param {EndOfRunSummary} summary
 * @param {Object} hooks
 * @param {() => any} hooks.loadStats         Returns a deep-merged stats blob.
 * @param {(blob: any, opts?: any) => void} hooks.saveStats
 * @param {() => number} [hooks.now]          performance.now() override for tests.
 * @returns {EndOfRunResult}
 */
export function recordEndOfRun(summary, hooks) {
  const {
    score: inputScore, lines, level, modeKey, sessionStartMs,
    reason,
    piecesPlacedThisRun, linesClearedThisRun,
    resetsHighScoreSlot = true,
    goalMultiplier = 1.0,
    runTimeMs = null,
    updateBest = null,
  } = summary || {};
  if (!hooks || typeof hooks.loadStats !== 'function' || typeof hooks.saveStats !== 'function') {
    throw new Error('recordEndOfRun requires { loadStats, saveStats } hooks');
  }
  const now = (hooks.now || (() => (typeof performance !== 'undefined' ? performance.now() : 0)))();

  // Apply the goal multiplier — Marathon's "+50% bonus" surface — but ONLY
  // when the run terminated by completing the goal. Topouts en route to the
  // goal record the un-multiplied score (incomplete attempt).
  const applyMultiplier = (reason === 'goal') && (goalMultiplier !== 1.0) && Number.isFinite(goalMultiplier);
  const score = applyMultiplier ? Math.round(inputScore * goalMultiplier) : inputScore;

  const stats = hooks.loadStats();

  // Global high score — gated by `resetsHighScoreSlot` (Zen never writes it).
  if (resetsHighScoreSlot && score > (stats.highScore || 0)) {
    stats.highScore = score;
  }

  // Per-mode best slot. Each mode key gets its own object — adding a new
  // field on a future mode (e.g. `bestTimeMs` for Sprint) is forward-compatible
  // because storage's deep-merge backfills missing fields on load.
  if (!stats.modeBests) stats.modeBests = {};
  if (!stats.modeBests[modeKey]) stats.modeBests[modeKey] = { score: 0, lines: 0, level: 1, attempts: 0 };
  const best = stats.modeBests[modeKey];
  best.attempts = (best.attempts || 0) + 1;

  // Custom updater (Zen tracks longestSessionMs + totalLines instead of
  // score-based best). Default path applies when no override is supplied.
  if (typeof updateBest === 'function') {
    try {
      updateBest(best, { ...summary, score, runTimeMs });
    } catch (err) {
      console.warn('[end-of-run] updateBest threw:', err?.message || err);
    }
  } else {
    if (score > (best.score || 0)) {
      best.score = score;
      best.lines = lines;
      best.level = level;
    }
  }
  // Goal-completion best fields — track whether the player has *ever*
  // reached the goal, and the fastest completion. These are independent
  // of the score/lines/level write above, so they apply regardless of
  // whether the score itself was higher than the prior best (e.g., a
  // slower Marathon run with a lower score still records bestTimeMs if
  // it's the first completion). Forward-compatible across modes —
  // storage's deep-merge backfills `completed:false` / `bestTimeMs:null`
  // on load for every mode.
  if (reason === 'goal') {
    best.completed = true;
    if (Number.isFinite(runTimeMs) && runTimeMs >= 0) {
      const prev = best.bestTimeMs;
      if (prev == null || runTimeMs < prev) {
        best.bestTimeMs = runTimeMs;
      }
    }
  }

  if (!stats.totals) stats.totals = { linesCleared: 0, piecesPlaced: 0, playTimeMs: 0 };
  stats.totals.linesCleared = (stats.totals.linesCleared || 0) + (linesClearedThisRun  || 0);
  stats.totals.piecesPlaced = (stats.totals.piecesPlaced || 0) + (piecesPlacedThisRun  || 0);
  stats.totals.playTimeMs   = (stats.totals.playTimeMs   || 0) + Math.round(now - (sessionStartMs || now));

  stats.lastUpdated = new Date().toISOString();
  hooks.saveStats(stats, { flush: true });
  return { score, multiplied: applyMultiplier, stats };
}
