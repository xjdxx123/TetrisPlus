// Matchmaking — pair queued players into matches.
//
// Two pairing strategies (selectable by region/lobby config):
//
//   - 'elo'   — closest-ELO pair within ±SEARCH_INITIAL_RANGE; the
//               range expands ELO_RANGE_GROWTH_PER_SEC over the
//               wait, so a queueing player eventually pairs with
//               anyone available.
//   - 'fcfs'  — first-come-first-served; ignores ELO. Useful for
//               friend-invite flows where the pair is already
//               picked.
//
// Pure module. Wraps no I/O of its own — the host (DO or Worker)
// drives the queue + persists matches. Tests run in pure Node.

const SEARCH_INITIAL_RANGE      = 75;   // ±75 ELO at t=0
const SEARCH_RANGE_GROWTH_PER_S = 25;   // expand by 25/sec
const SEARCH_MAX_RANGE          = 600;  // cap

/**
 * @typedef {Object} QueueEntry
 * @property {string} userId
 * @property {number} elo
 * @property {string} region
 * @property {number} enqueuedAtMs   wall clock — used only for waited-time math
 */

/**
 * Pair every queued player who has a viable opponent. Returns the
 * removed pairs + the queue tail of unmatched players. Caller is
 * responsible for persisting the queue + dispatching match-found
 * messages to the paired players.
 *
 * Matched pairs are returned in the order they were resolved; the
 * unmatched residual preserves insertion order so older entries
 * keep priority on the next pass.
 *
 * @param {QueueEntry[]} queue
 * @param {number} nowMs
 * @returns {{ pairs: [QueueEntry, QueueEntry][], unmatched: QueueEntry[] }}
 */
export function pairQueue(queue, nowMs) {
  if (!Array.isArray(queue) || queue.length < 2) {
    return { pairs: [], unmatched: Array.isArray(queue) ? queue.slice() : [] };
  }
  const remaining = queue.slice();
  const pairs = [];
  // Sort by enqueuedAtMs so older entries are paired first
  // (priority FIFO within the search-range constraint).
  remaining.sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs);

  while (remaining.length >= 2) {
    const a = remaining.shift();
    const range = currentSearchRange(nowMs - a.enqueuedAtMs);
    let bestIdx = -1;
    let bestEloDiff = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      if (c.region !== a.region) continue; // strict region match — cross-region opt-in is a future flag
      const diff = Math.abs(c.elo - a.elo);
      if (diff <= range && diff < bestEloDiff) {
        bestEloDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const b = remaining.splice(bestIdx, 1)[0];
      pairs.push([a, b]);
    } else {
      // No viable partner this pass — push `a` back to the residual
      // (keep at front to preserve priority on next call).
      remaining.unshift(a);
      break;
    }
  }
  return { pairs, unmatched: remaining };
}

function currentSearchRange(waitedMs) {
  const range = SEARCH_INITIAL_RANGE + (waitedMs / 1000) * SEARCH_RANGE_GROWTH_PER_S;
  return Math.min(range, SEARCH_MAX_RANGE);
}

// Test exports.
export const _SEARCH_INITIAL_RANGE      = SEARCH_INITIAL_RANGE;
export const _SEARCH_RANGE_GROWTH_PER_S = SEARCH_RANGE_GROWTH_PER_S;
export const _SEARCH_MAX_RANGE          = SEARCH_MAX_RANGE;
