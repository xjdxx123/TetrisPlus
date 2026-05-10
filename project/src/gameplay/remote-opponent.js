// RemoteOpponent — drop-in replacement for BotController whose
// per-tick InputFrame comes from an external buffer instead of an
// AI planner. Used by online versus's VersusSession + by
// replay-validation paths that re-step a recorded match.
//
// Surface mirrors BotController's: `tick(dtMs) → InputFrame` and
// `reset()`. VersusSession's `opponentMode` selects between
// 'bot' / 'local' / 'remote'; everything else (game wiring,
// garbage bridge, side-end handling) is identical.
//
// The buffer is filled by the transport layer (net/transport-ws.js
// in production; a fake transport in tests). RemoteOpponent itself
// has no network awareness — it only knows how to read frames.
// This keeps gameplay/ pure (no transport imports) and lets the
// same opponent class power online play, offline replay viewer,
// and rollback-engine reconciliation.
//
// Pure module: no DOM, no THREE, no audio, no I/O. The
// determinism rule on `gameplay/**` (eslint.config.js) applies.

import { EMPTY_FRAME } from '../input/intents.js';

/**
 * @typedef {import('../input/intents.js').InputFrame} InputFrame
 */

/**
 * @typedef {Object} RemoteOpponentOpts
 * @property {() => number} [now]
 *   Optional thunk for diagnostic timestamps. Defaults to `0`.
 *   The simulation NEVER reads time from here — only the diagnostic
 *   counters (`framesAheadCount`, `framesBehindCount`) use it for
 *   roll-up.
 */

export class RemoteOpponent {
  /** @param {RemoteOpponentOpts} [opts] */
  constructor(opts = {}) {
    /** @type {Map<number, InputFrame>} tick → frame */
    this._inputBuffer = new Map();
    // The internal tick counter advances exactly once per `tick()`
    // call. The transport's `receiveFrame(tick, frame)` writes future
    // frames in here; `tick()` reads the matching tick + advances.
    this._currentTick = 0;
    // Held when no new frame has arrived for the current tick — the
    // wire's "send only on change + heartbeat" pattern means the
    // absence of a new frame implies "still in the same intent."
    // Phase E (rollback) replaces this hold-prediction with proper
    // misprediction-and-reconcile logic.
    this._lastFrame = EMPTY_FRAME;
    // Diagnostics: how often we hit the buffer exactly vs how often
    // we had to fall back to the held frame. Surfaces packet-loss /
    // late-arrival in the host's HUD.
    this._stats = { hits: 0, holds: 0 };
    this._now = (typeof opts.now === 'function') ? opts.now : (() => 0);
  }

  // ─── Mirror of BotController's surface ────────────────────────────

  /**
   * Advance the internal tick counter + return the InputFrame for
   * this tick. VersusSession's tickOpponent calls this once per
   * frame; the returned frame is dispatched into the opponent's
   * Game via applyFrameToGame.
   *
   * @param {number} _dtMs   Unused — included to mirror BotController's
   *                          signature so VersusSession can swap them.
   * @returns {InputFrame}
   */
  tick(_dtMs) {
    void _dtMs;
    const t = this._currentTick++;
    const arrived = this._inputBuffer.get(t);
    if (arrived) {
      this._lastFrame = arrived;
      this._stats.hits++;
      // The buffer is consumed once and discarded — keeping it
      // around forever would balloon memory over a long match.
      // Rollback (Phase E) keeps a separate copy of the input log.
      this._inputBuffer.delete(t);
      return arrived;
    }
    this._stats.holds++;
    return this._lastFrame;
  }

  /** Reset between rounds — clears buffer + held frame + tick counter. */
  reset() {
    this._inputBuffer.clear();
    this._currentTick = 0;
    this._lastFrame = EMPTY_FRAME;
    this._stats = { hits: 0, holds: 0 };
  }

  // ─── Wire-side API ────────────────────────────────────────────────

  /**
   * Push an arrived InputFrame into the buffer. Transport layer
   * calls this when it decodes an `in` message off the wire.
   * Defensive copy so the caller can mutate their frame after
   * handing it over.
   *
   * @param {number} tick
   * @param {InputFrame} frame
   */
  receiveFrame(tick, frame) {
    if (!Number.isInteger(tick) || tick < 0) return;
    if (!frame) return;
    // Skip frames already consumed (transport may re-deliver under
    // packet loss + retransmission).
    if (tick < this._currentTick) return;
    this._inputBuffer.set(tick, { ...frame });
  }

  // ─── Diagnostics ──────────────────────────────────────────────────

  get currentTick()    { return this._currentTick; }
  get bufferedCount()  { return this._inputBuffer.size; }
  get hitCount()       { return this._stats.hits; }
  get holdCount()      { return this._stats.holds; }

  /**
   * Ratio of "frame arrived in time" vs "had to hold last frame".
   * 1.0 = perfect; 0.0 = remote stopped sending. The host's HUD
   * surfaces this as a connection-quality indicator.
   */
  get hitRate() {
    const total = this._stats.hits + this._stats.holds;
    return total > 0 ? (this._stats.hits / total) : 1.0;
  }
}
