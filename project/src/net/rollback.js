// Rollback netcode engine — the algorithm from plan_online_versus.md
// §3 + §3.2. Owns three things:
//
//   - Local input log: every InputFrame the local player produced for
//     the last N ticks. Drives "what would I have done at past tick T?"
//     during reconciliation.
//   - Snapshot ring: a serialized Game state every K ticks. Drives
//     "rewind to tick T" by `Game.restore(snapshot)`.
//   - Per-tick decide: at each tick, if the remote frame for this tick
//     is known, advance both Games. If not, predict EMPTY_FRAME and
//     mark the tick as predicted. When the actual remote frame arrives
//     LATER, compare against the prediction; if it differs, rewind to
//     the nearest snapshot before the misprediction tick, replay every
//     tick from there with the corrected remote inputs, and the local
//     view jumps to the reconciled state.
//
// The two Games (local + opponent) are stepped together — they form
// one logical "match state" that's snapshot atomically. When rewinding
// we restore BOTH from their saved blobs.
//
// Pure module: no THREE, no DOM, no audio, no real network. The
// engine consumes a `transport` interface (push-input / on-receive)
// + a `view` interface (call after each tick to render). Both are
// injected so the engine can be tested with fake transports + no
// renderer at all.

import { applyFrameToGame } from '../gameplay/replay/apply-frame.js';
import { EMPTY_FRAME } from '../input/intents.js';

// ─── Tunables ────────────────────────────────────────────────────────
//
// Conservative defaults from plan §3.1. Snapshot every 30 ticks
// (~500ms) so reconciliation never replays more than 30 ticks at
// once — bounded resimulation cost. Keep 8 snapshots → ~4s rollback
// window. Local input log mirrors that window (240 ticks).

export const ROLLBACK_DEFAULTS = Object.freeze({
  /** Save a Game.serialize() snapshot every N ticks. */
  snapshotEveryTicks: 30,
  /** Keep the most recent K snapshots. */
  snapshotRingSize: 8,
  /** Keep input log entries for at most this many ticks. */
  inputLogMaxAge: 240,
});

/**
 * @typedef {Object} RollbackOpts
 * @property {import('../gameplay/game.js').Game} localGame
 * @property {import('../gameplay/game.js').Game} remoteGame
 * @property {(tick:number, frame:object) => void} sendInput
 *   Called by the engine when a local InputFrame is captured + needs
 *   to ship to the remote. Transport layer (Phase F) wires this to
 *   protocol.encodeInput + WS send. In tests, a fake captures the
 *   payloads.
 * @property {number} [snapshotEveryTicks]
 * @property {number} [snapshotRingSize]
 * @property {number} [inputLogMaxAge]
 * @property {number} [dtMs=1000/60]
 */

export class RollbackEngine {
  /** @param {RollbackOpts} opts */
  constructor(opts) {
    if (!opts || !opts.localGame || !opts.remoteGame) {
      throw new Error('RollbackEngine requires { localGame, remoteGame }');
    }
    if (typeof opts.sendInput !== 'function') {
      throw new Error('RollbackEngine requires { sendInput }');
    }
    this._local      = opts.localGame;
    this._remote     = opts.remoteGame;
    this._sendInput  = opts.sendInput;
    this._snapEvery  = (opts.snapshotEveryTicks | 0) || ROLLBACK_DEFAULTS.snapshotEveryTicks;
    this._snapRing   = (opts.snapshotRingSize | 0) || ROLLBACK_DEFAULTS.snapshotRingSize;
    this._logMaxAge  = (opts.inputLogMaxAge | 0) || ROLLBACK_DEFAULTS.inputLogMaxAge;
    this._dtMs       = (typeof opts.dtMs === 'number' && opts.dtMs > 0) ? opts.dtMs : (1000 / 60);

    this._currentTick = 0;

    /** Local input log: tick → InputFrame. Bounded by _logMaxAge. */
    this._localInputs  = new Map();
    /** Remote input log: tick → InputFrame. Wire deliveries land here. */
    this._remoteInputs = new Map();
    /** Predicted tick → predicted frame. Erased on reconciliation. */
    this._predictions  = new Map();

    /**
     * Snapshot ring: array of { tick, localBlob, remoteBlob },
     * oldest first. Eviction trims when length > _snapRing.
     */
    this._snapshots = [];

    /** Counters surface to telemetry. */
    this._stats = {
      ticksAdvanced: 0,
      mispredictions: 0,
      rollbacksFired: 0,
      ticksResimulated: 0,
    };

    // Initial snapshot at tick=0 — represents "before any tick was
    // advanced". Without this, a misprediction at tick=0 has no
    // snapshot to rewind to and reconciliation silently bails. The
    // ring eviction policy still handles long matches; this entry
    // just gives reconcile a floor to land on for the very first
    // ticks.
    this._takeSnapshot(0);
  }

  // ─── Per-frame entrypoint ────────────────────────────────────────

  /**
   * Advance the engine one tick.
   *
   * @param {object} localFrame   The local player's InputFrame this tick.
   */
  tick(localFrame) {
    const tick = this._currentTick;

    // Capture + ship local input.
    const localCopy = { ...localFrame };
    this._localInputs.set(tick, localCopy);
    try { this._sendInput(tick, localCopy); }
    catch (err) { console.warn('[rollback] sendInput threw:', err); }

    // Decide remote frame for this tick.
    let remoteFrame;
    let predicted = false;
    if (this._remoteInputs.has(tick)) {
      remoteFrame = this._remoteInputs.get(tick);
    } else {
      remoteFrame = EMPTY_FRAME;
      this._predictions.set(tick, EMPTY_FRAME);
      predicted = true;
    }
    void predicted;

    // Advance both Games. The order is local-first / remote-second
    // for tie-breaking determinism — both clients agree because the
    // engine on each end runs the same code with the same input
    // pair at this tick.
    applyFrameToGame(this._local,  localCopy,   this._dtMs);
    applyFrameToGame(this._remote, remoteFrame, this._dtMs);

    this._stats.ticksAdvanced++;
    this._currentTick++;

    // Snapshot at cadence — captured AFTER advancing this tick so the
    // snapshot represents end-of-tick state.
    if ((tick % this._snapEvery) === 0) this._takeSnapshot(this._currentTick);

    // GC the input log so it doesn't grow unbounded.
    this._gcInputLog();
  }

  // ─── Wire-arrival callback ───────────────────────────────────────

  /**
   * Transport layer calls this when a remote InputFrame arrives.
   * Decides whether reconciliation is required: if the tick was
   * already predicted AND the actual frame differs from the
   * prediction, rewind to the nearest snapshot ≤ tick and replay.
   *
   * @param {number} tick
   * @param {object} frame
   */
  receiveRemoteInput(tick, frame) {
    if (!Number.isInteger(tick) || tick < 0) return;
    if (!frame) return;
    const stored = { ...frame };
    this._remoteInputs.set(tick, stored);

    // Future tick — no rollback needed; the per-tick decide will
    // pick it up when we get there.
    if (tick >= this._currentTick) return;

    const predicted = this._predictions.get(tick);
    if (!predicted) return; // we already had it (rare race) or already reconciled
    if (framesEqual(predicted, stored)) {
      // Prediction was correct — clear the entry, no work needed.
      this._predictions.delete(tick);
      return;
    }

    // Misprediction — reconcile.
    this._stats.mispredictions++;
    this._reconcileFrom(tick);
  }

  // ─── Snapshot management ─────────────────────────────────────────

  _takeSnapshot(tickAtSnap) {
    this._snapshots.push({
      tick:       tickAtSnap,
      localBlob:  this._local.serialize(),
      remoteBlob: this._remote.serialize(),
    });
    while (this._snapshots.length > this._snapRing) this._snapshots.shift();
  }

  /**
   * Find the most recent snapshot whose tick ≤ targetTick. Returns
   * null if no snapshot exists in the window — caller falls back to
   * "best effort" (apply the corrected frame at its tick going
   * forward; past divergence stays as-is).
   */
  _nearestSnapshotBefore(targetTick) {
    for (let i = this._snapshots.length - 1; i >= 0; i--) {
      if (this._snapshots[i].tick <= targetTick) return this._snapshots[i];
    }
    return null;
  }

  // ─── Reconciliation ──────────────────────────────────────────────

  /**
   * Rewind both Games to the nearest snapshot ≤ mispredictionTick,
   * then replay every tick from there with the corrected remote
   * inputs (the local input log is unchanged). On exit, both Games
   * have been re-stepped to the engine's current tick.
   *
   * Important invariant: snapshots taken AFTER the misprediction
   * tick are stale (they baked in the wrong prediction). Drop
   * them up-front + retake at the cadence as we replay forward, so
   * subsequent mispredictions land on accurate snapshots.
   */
  _reconcileFrom(mispredictionTick) {
    const snap = this._nearestSnapshotBefore(mispredictionTick);
    if (!snap) {
      // No snapshot in the window — accept the divergence; clear
      // the prediction so we don't loop. This is the
      // packet-loss-too-old case; plan §3.4 documents that a brief
      // "high latency" warning surfaces in this regime.
      this._predictions.delete(mispredictionTick);
      return;
    }

    this._stats.rollbacksFired++;

    // Drop any snapshot whose tick is strictly AFTER the snap we're
    // restoring from — those captured the now-corrected predictions
    // and would mislead a future _nearestSnapshotBefore query.
    const keepUntil = this._snapshots.indexOf(snap);
    this._snapshots.length = keepUntil + 1;

    // Restore both Games to the snapshot.
    this._local.restore(snap.localBlob);
    this._remote.restore(snap.remoteBlob);

    // Replay forward from snap.tick to currentTick. For ticks with
    // a known actual remote frame, use it; for ticks where the
    // actual STILL hasn't arrived, fall back to EMPTY (the
    // prediction) — those predictions stay live so a future
    // receiveRemoteInput can still detect their misprediction. Only
    // the misprediction target tick (the one that triggered THIS
    // reconcile) gets its prediction cleared at the end.
    const targetTick = this._currentTick;
    for (let t = snap.tick; t < targetTick; t++) {
      const localFrame  = this._localInputs.get(t)  || EMPTY_FRAME;
      const remoteFrame = this._remoteInputs.get(t) || EMPTY_FRAME;
      applyFrameToGame(this._local,  localFrame,  this._dtMs);
      applyFrameToGame(this._remote, remoteFrame, this._dtMs);
      this._stats.ticksResimulated++;
      // Re-snapshot at cadence — same condition the live tick uses.
      if ((t % this._snapEvery) === 0) this._takeSnapshot(t + 1);
    }
    // The misprediction target tick is now reconciled; clear it.
    // Predictions for ticks WITHOUT known actuals stay live.
    this._predictions.delete(mispredictionTick);
  }

  // ─── Bookkeeping ─────────────────────────────────────────────────

  _gcInputLog() {
    const cutoff = this._currentTick - this._logMaxAge;
    if (cutoff <= 0) return;
    for (const t of this._localInputs.keys())  if (t < cutoff) this._localInputs.delete(t);
    for (const t of this._remoteInputs.keys()) if (t < cutoff) this._remoteInputs.delete(t);
    for (const t of this._predictions.keys())  if (t < cutoff) this._predictions.delete(t);
  }

  // ─── Read-only diagnostics ───────────────────────────────────────

  get currentTick()       { return this._currentTick; }
  get snapshotCount()     { return this._snapshots.length; }
  get pendingPredictions() { return this._predictions.size; }
  get stats()             { return { ...this._stats }; }
}

// ─── Helpers ────────────────────────────────────────────────────────

function framesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.right === b.right
      && a.softDrop === b.softDrop && a.hardDrop === b.hardDrop
      && a.rotateCW === b.rotateCW && a.rotateCCW === b.rotateCCW
      && a.hold === b.hold && a.pause === b.pause;
}
