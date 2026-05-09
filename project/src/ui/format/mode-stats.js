// Per-mode formatters for the settings panel's Stats tab + Mode tab
// best-display row (plan_gameplay_1.md §5.4 + §5.1).
//
// Each mode's "best" looks different — Marathon shows score + best
// completion time, Sprint shows bestTimeMs only, Ultra shows bestScore,
// Zen shows longestSessionMs + totalLines, Versus shows W-L + ELO. The
// generic `(score) ? toLocaleString : '—'` row in the legacy panel
// flattened all of these into one. This module dispatches on mode key
// and produces the right shape per mode.
//
// Pure module. No DOM, no THREE. Tested in pure Node.

const DEFAULT_DASH = '—';

/**
 * Format an integer count with locale separators. `null`/`0`/non-finite
 * inputs render as the dash sentinel rather than "0" — keeps fresh-install
 * stat slots from looking like real records.
 *
 * @param {number} n
 * @param {Object} [opts]
 * @param {boolean} [opts.zeroIsReal]   Treat 0 as a real value (default false → dash).
 * @returns {string}
 */
export function formatCount(n, { zeroIsReal = false } = {}) {
  if (!Number.isFinite(n)) return DEFAULT_DASH;
  if (!zeroIsReal && (n === 0 || n == null)) return DEFAULT_DASH;
  return n.toLocaleString();
}

/**
 * `m:ss.mmm` for short durations (Sprint completions). Floors to ms;
 * `null`/`undefined`/non-finite → dash.
 */
export function formatTimePrecise(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_DASH;
  const total   = Math.floor(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis  = total % 1000;
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

/**
 * `Hh Mm` / `Mm Ss` / `Ss` for longer durations (Marathon completion time,
 * Zen longest session, totals.playTimeMs). Drops smaller units when a
 * larger one is present, matching the legacy `defaultFormatTime`.
 */
export function formatTimeFriendly(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_DASH;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Dispatch on mode key — given a mode-bests slot and the mode key,
 * return the *primary* metric string that goes in the Stats tab's
 * "Best by mode" row. The Mode-tab UX upgrade calls a richer formatter
 * (`formatModeBestSummary`) that shows multiple lines.
 *
 * @param {string} modeKey
 * @param {any}    best     The `stats.modeBests[modeKey]` slot, or undefined.
 * @returns {string}
 */
export function formatModeBestPrimary(modeKey, best) {
  best = best || {};
  switch (modeKey) {
    case 'marathon': {
      // Headline = score (multiplied score after a goal completion). The
      // best-time line lives in the secondary string.
      return formatCount(best.score);
    }
    case 'sprint': {
      // Sprint score is always 0 — the meaningful metric is bestTimeMs.
      return formatTimePrecise(best.bestTimeMs);
    }
    case 'ultra': {
      return formatCount(best.score);
    }
    case 'zen': {
      // Zen tracks longestSessionMs as the "best" — score is intentionally
      // not shown. 0ms is treated as "no session recorded yet" (the
      // fresh-install storage default), distinct from a real 0s session
      // that the player would never play.
      const ms = best.longestSessionMs;
      if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_DASH;
      return formatTimeFriendly(ms);
    }
    case 'versus': {
      const wins   = best.wins   || 0;
      const losses = best.losses || 0;
      if (wins === 0 && losses === 0) return DEFAULT_DASH;
      return `${wins}W–${losses}L`;
    }
    case 'physics': {
      // Physics' headline is the single-run high score (layers × 100).
      // Falls back to dash when nothing has been scored yet.
      return formatCount(best.score);
    }
    case 'classic':
    default:
      return formatCount(best.score);
  }
}

/**
 * Secondary line — supplementary detail. Used by the Mode-tab UX upgrade
 * (§5.1) to render "Personal best: 145,200 (best time 7:42)" style
 * sub-info under the primary metric. Returns null when there's nothing
 * meaningful to show beyond the primary.
 *
 * @param {string} modeKey
 * @param {any}    best
 * @returns {string|null}
 */
export function formatModeBestSecondary(modeKey, best) {
  best = best || {};
  switch (modeKey) {
    case 'marathon': {
      const parts = [];
      if (best.completed && Number.isFinite(best.bestTimeMs)) {
        parts.push(`best time ${formatTimeFriendly(best.bestTimeMs)}`);
      }
      if ((best.attempts || 0) > 0) {
        const completed = best.completed ? 'completed' : 'no completions';
        parts.push(`${best.attempts} attempt${best.attempts === 1 ? '' : 's'}${best.completed ? ', ' + completed : ', ' + completed}`);
      }
      return parts.length ? parts.join(' · ') : null;
    }
    case 'sprint': {
      const attempts = best.attempts || 0;
      if (attempts === 0) return null;
      const status = best.completed ? 'completed' : 'no completions';
      return `${attempts} attempt${attempts === 1 ? '' : 's'}, ${status}`;
    }
    case 'ultra': {
      const lines = best.lines || 0;
      if (lines === 0) return null;
      return `${formatCount(lines, { zeroIsReal: true })} lines on best run`;
    }
    case 'zen': {
      const total = best.totalLines || 0;
      if (total === 0) return null;
      return `${formatCount(total, { zeroIsReal: true })} lines total`;
    }
    case 'versus': {
      // ELO is initialized at 1200; only show it when the player has
      // played a match (otherwise it's just "1200" with no signal).
      const played = (best.wins || 0) + (best.losses || 0) + (best.draws || 0);
      if (played === 0) return null;
      const elo = Number.isFinite(best.eloMmr) ? best.eloMmr : 1200;
      return `ELO ${elo}`;
    }
    case 'physics': {
      // Physics shows total layers cleared across all attempts (Zen-
      // style cumulative metric) plus the best-single-run.
      const total = best.totalLayersCleared || 0;
      const bestRun = best.bestLayersCleared || 0;
      if (total === 0 && bestRun === 0) return null;
      const parts = [];
      if (bestRun > 0) parts.push(`best run ${formatCount(bestRun, { zeroIsReal: true })} layers`);
      if (total > 0)   parts.push(`${formatCount(total, { zeroIsReal: true })} layers total`);
      return parts.join(' · ');
    }
    case 'classic':
    default: {
      const lines = best.lines || 0;
      const level = best.level || 1;
      if (lines === 0) return null;
      return `${formatCount(lines, { zeroIsReal: true })} lines, level ${level}`;
    }
  }
}

/**
 * One-line summary for the Mode-tab best-display row (§5.1). Combines
 * primary + secondary: "287,400 · 145 lines, level 8".
 *
 * @param {string} modeKey
 * @param {any}    best
 * @returns {string}
 */
export function formatModeBestSummary(modeKey, best) {
  const primary = formatModeBestPrimary(modeKey, best);
  if (primary === DEFAULT_DASH) return 'No record yet';
  const secondary = formatModeBestSecondary(modeKey, best);
  return secondary ? `${primary} · ${secondary}` : primary;
}

/**
 * Modern-rules tertiary line (plan_gameplay_2.md §1.1) — surfaces the
 * §12 / §13-polish stats persisted by `gameplay/end-of-run.js`:
 *   - `bestB2bChain`         : highest Back-to-Back chain reached.
 *   - `bestCombo`            : highest combo step reached.
 *   - `perfectClears`        : cumulative count across runs.
 *   - `tspinClears`          : cumulative count across runs.
 *   - `bestGarbageCancelled` : versus-only — highest single-round eat.
 *
 * Each field is gated on `> 0` so a fresh slot returns null (no row).
 * Sprint's slot only defines `bestCombo` (its lineScore is 0, so the
 * other modern fields are intentionally absent from its storage
 * default and silently skipped here).
 *
 * Returns `null` when no field has a meaningful value — the settings
 * panel uses `null` as "skip this row".
 *
 * @param {string} modeKey
 * @param {any}    best
 * @returns {string|null}
 */
export function formatModeBestModern(modeKey, best) {
  best = best || {};
  const parts = [];
  const b2b   = best.bestB2bChain         | 0;
  const combo = best.bestCombo            | 0;
  const pc    = best.perfectClears        | 0;
  const tsc   = best.tspinClears          | 0;
  const cnx   = best.bestGarbageCancelled | 0;

  switch (modeKey) {
    case 'sprint': {
      // Sprint only tracks bestCombo — the other modern fields aren't
      // in its storage default.
      if (combo > 0) parts.push(`best combo ×${combo}`);
      break;
    }
    case 'versus': {
      if (b2b   > 0) parts.push(`best B2B ×${b2b}`);
      if (combo > 0) parts.push(`best combo ×${combo}`);
      if (pc    > 0) parts.push(`${formatCount(pc, { zeroIsReal: true })} perfect clear${pc === 1 ? '' : 's'}`);
      if (tsc   > 0) parts.push(`${formatCount(tsc, { zeroIsReal: true })} T-spin clear${tsc === 1 ? '' : 's'}`);
      if (cnx   > 0) parts.push(`${formatCount(cnx, { zeroIsReal: true })} cancelled best`);
      break;
    }
    case 'classic':
    case 'marathon':
    case 'ultra':
    case 'zen':
    default: {
      if (b2b   > 0) parts.push(`best B2B ×${b2b}`);
      if (combo > 0) parts.push(`best combo ×${combo}`);
      if (pc    > 0) parts.push(`${formatCount(pc, { zeroIsReal: true })} perfect clear${pc === 1 ? '' : 's'}`);
      if (tsc   > 0) parts.push(`${formatCount(tsc, { zeroIsReal: true })} T-spin clear${tsc === 1 ? '' : 's'}`);
      break;
    }
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Goal-line text shown above the mode-button grid. Mirrors `Mode.config(key)`
 * but adds runtime tweaks (e.g., reading the live multiplier instead of a
 * baked string). v1: just returns config.goalLabel.
 *
 * @param {string} modeKey
 * @param {{goalLabel:string, estimatedDurationMin:number|null}} cfg
 * @returns {{ goal: string, duration: string|null }}
 */
export function formatModeGoalAndDuration(modeKey, cfg) {
  const c = cfg || {};
  const goal = c.goalLabel || '—';
  const duration = (typeof c.estimatedDurationMin === 'number' && c.estimatedDurationMin > 0)
    ? `~${c.estimatedDurationMin} min`
    : null;
  return { goal, duration };
}

export const _DEFAULT_DASH = DEFAULT_DASH;
