// FakeTransport — in-memory transport for tests + headless replay.
//
// Same surface as the real WebSocket transport (Phase F's
// `transport-ws.js`): `send(msg)` ships an encoded message and
// `onMessage(handler)` registers a receive callback. The fake
// implements both ends of a "wire" by pairing two FakeTransports
// in opposite roles.
//
// Used by:
//   - rollback.test.js — already inlines an array-fake; this
//     promotes that pattern into a reusable module
//   - VersusSession integration tests — pair two fakes, each
//     drives one side
//   - The replay validation server (Phase H) — the offline
//     re-runner doesn't need a real socket; a FakeTransport with
//     pre-loaded messages drives the rollback engine the same way
//
// Pure module: no DOM, no actual network. Tests run in pure Node.

import { decode, serialize } from './protocol.js';

/**
 * Make a connected pair of FakeTransports — anything one sends, the
 * other receives. Useful for two-Game integration tests where each
 * side runs a full RollbackEngine + protocol stack.
 *
 * @returns {[FakeTransport, FakeTransport]}
 */
export function pair() {
  const a = new FakeTransport();
  const b = new FakeTransport();
  a._peer = b;
  b._peer = a;
  return [a, b];
}

/**
 * Standalone FakeTransport — `send` queues into `outbound` for the
 * test to inspect; the test calls `deliver(msg)` to simulate an
 * arrival.
 */
export class FakeTransport {
  constructor() {
    /** @type {Array<object>} every msg the engine sent — for assertions */
    this.outbound = [];
    /** @type {((msg:object)=>void)|null} */
    this._handler = null;
    /** @type {FakeTransport|null} when paired, deliver into peer */
    this._peer = null;
    /** @type {{loss:number, latencyTicks:number, jitterTicks:number}|null} */
    this._fault = null;
    /** Fault-injection scheduler when latency > 0. */
    this._scheduled = []; // [{ deliverAtTick, msg }]
    this._tickCounter = 0;
    /** Optional seeded rng for fault decisions; defaults to Math.random — only used in tests */
    this._rng = null;
  }

  // ─── Engine-facing API ───────────────────────────────────────────

  /** Send a (already-encoded plain object) message. */
  send(msg) {
    // Defensive copy + JSON-roundtrip so the receiver gets a fresh
    // object the sender can't mutate (matches real-wire semantics).
    const wireform = decode(serialize(msg));
    this.outbound.push(wireform);
    this._dispatch(wireform);
  }

  /** Register the receive callback. Replaces any prior. */
  onMessage(handler) { this._handler = handler; }

  /** Disconnect: drop pair binding + clear handler. Idempotent. */
  close() {
    this._peer = null;
    this._handler = null;
    this._scheduled.length = 0;
  }

  // ─── Test-facing API ─────────────────────────────────────────────

  /** Manually deliver a msg to the local handler (no pair needed). */
  deliver(msg) {
    if (!this._handler) return;
    try { this._handler(msg); }
    catch (err) { console.warn('[fake-transport] handler threw:', err); }
  }

  /**
   * Simulate network conditions for messages this transport SENDS to
   * its peer. `loss` is the per-msg drop probability (0..1);
   * `latencyTicks` + `jitterTicks` describe a uniform random delay
   * `[latencyTicks, latencyTicks+jitterTicks]` measured in advanceTick
   * calls (the test's tick driver). With loss>0 the transport may
   * also dup-deliver to model retransmission.
   */
  setFault({ loss = 0, latencyTicks = 0, jitterTicks = 0, rng = null } = {}) {
    this._fault = { loss, latencyTicks, jitterTicks };
    this._rng = rng;
  }

  /**
   * Tick the fault scheduler — delivers any messages whose delay
   * window expired. Called by the test driver once per simulated
   * tick (separate from Game.tick).
   */
  advanceTick() {
    this._tickCounter++;
    for (let i = this._scheduled.length - 1; i >= 0; i--) {
      const e = this._scheduled[i];
      if (e.deliverAtTick <= this._tickCounter) {
        this._scheduled.splice(i, 1);
        if (this._peer) this._peer.deliver(e.msg);
      }
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  _dispatch(msg) {
    if (!this._peer) return;
    if (!this._fault) {
      this._peer.deliver(msg);
      return;
    }
    const r = this._rng ? this._rng : Math.random;
    if (r() < this._fault.loss) {
      // Dropped this delivery — but model retransmission by
      // scheduling a duplicate at random delay.
      const delay = this._fault.latencyTicks + Math.floor(r() * (this._fault.jitterTicks + 1));
      this._scheduled.push({ deliverAtTick: this._tickCounter + Math.max(1, delay * 2), msg });
      return;
    }
    if (this._fault.latencyTicks > 0 || this._fault.jitterTicks > 0) {
      const delay = this._fault.latencyTicks + Math.floor(r() * (this._fault.jitterTicks + 1));
      this._scheduled.push({ deliverAtTick: this._tickCounter + Math.max(1, delay), msg });
      return;
    }
    this._peer.deliver(msg);
  }
}
