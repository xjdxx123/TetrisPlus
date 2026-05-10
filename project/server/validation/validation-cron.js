// Replay validation cron — Cloudflare Workers scheduled handler.
// Wakes every 5 min (configured in wrangler.toml's [triggers] crons),
// pulls unvalidated matches from D1, runs each through validateMatch,
// + commits the result.
//
// Plan online §H: server-side proof that a reported outcome is
// consistent with the inputs that produced it. ELO updates from
// validated matches stay; updates from rejected matches are clawed
// back + flagged for manual review.

import { validateMatch } from './validate-match.js';
import { applyMatch } from '../lobby/elo.js';

/**
 * @param {ScheduledController} _controller
 * @param {{ DB: D1Database }} env
 * @param {ExecutionContext} _ctx
 */
export async function scheduled(_controller, env, _ctx) {
  // Pull a batch of unvalidated matches. Limit to 100 per run so a
  // single cron tick stays under Workers' CPU budget; subsequent
  // ticks drain the rest.
  const { results } = await env.DB.prepare(
    `SELECT match_id, seed, mode_key, p1_user_id, p2_user_id, reported_winner, p1_inputs_json, p2_inputs_json
     FROM matches
     WHERE validated IS NULL
     LIMIT 100`
  ).all();

  for (const row of results) {
    const submission = {
      matchId:        row.match_id,
      seed:           row.seed,
      modeKey:        row.mode_key,
      reportedWinner: row.reported_winner,
      p1: {
        userId:     row.p1_user_id,
        inputs:     JSON.parse(row.p1_inputs_json),
        totalTicks: 0, // replayInputs derives from inputs[]
      },
      p2: {
        userId:     row.p2_user_id,
        inputs:     JSON.parse(row.p2_inputs_json),
        totalTicks: 0,
      },
    };

    const result = validateMatch(submission);

    // Commit result. ELO move only on validated; on reject, claw
    // back the previously-applied delta (which lobby/matchmaking
    // optimistically credits at match-end).
    if (result.validated) {
      await env.DB.prepare(
        `UPDATE matches SET validated = 1 WHERE match_id = ?`
      ).bind(row.match_id).run();
    } else {
      // Reject: undo any optimistic ELO + flag.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE matches SET validated = 0, reject_reason = ? WHERE match_id = ?`
        ).bind(result.reason || 'UNKNOWN', row.match_id),
        env.DB.prepare(
          `UPDATE players SET elo = elo - delta_pending WHERE user_id IN (?, ?)`
        ).bind(row.p1_user_id, row.p2_user_id),
        env.DB.prepare(
          `UPDATE players SET delta_pending = 0 WHERE user_id IN (?, ?)`
        ).bind(row.p1_user_id, row.p2_user_id),
      ]);
    }
  }
}

// Convenience: re-export applyMatch so the cron is self-contained
// when imported by an integration test.
export { applyMatch };
