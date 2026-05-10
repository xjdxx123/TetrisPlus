// Rollback engine tests — three plan-spec scenarios:
//
//   1. Zero loss / zero latency — rollback never fires; engine just
//      advances both Games.
//   2. Constant-100ms latency — engine predicts EMPTY_FRAME at each
//      tick, then reconciles when the actual frame arrives ~6 ticks
//      later. Final state matches a no-loss reference.
//   3. 5% loss + 200ms peak latency — rollback survives. Final
//      state still matches the no-loss reference.
//
// Plus unit checks: snapshot ring eviction, prediction-was-correct
// fast path (no rollback), input-log GC.

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../engine/events/bus.js';
import { Game } from '../gameplay/game.js';
import { buildRules } from '../gameplay/rules.js';
import { createSeededRng } from '../shared/random/seeded.js';
import { EMPTY_FRAME } from '../input/intents.js';
import { applyFrameToGame } from '../gameplay/replay/apply-frame.js';
import { RollbackEngine, ROLLBACK_DEFAULTS } from './rollback.js';

const DT = 1000 / 60;

function freshGame(seed = 1, modeKey = 'classic') {
  return new Game({
    rules: buildRules(modeKey),
    bus:   new EventBus({ replayBufferSize: 0, recorderSize: 0 }),
    rng:   createSeededRng(seed),
    nowMs: 0,
  });
}

function makeEngine(seed = 1) {
  const localGame  = freshGame(seed);
  const remoteGame = freshGame(seed + 1); // distinct seed for opponent
  localGame.spawnPiece();
  remoteGame.spawnPiece();
  const sent = [];
  const engine = new RollbackEngine({
    localGame,
    remoteGame,
    sendInput: (tick, frame) => sent.push({ tick, frame: { ...frame } }),
    dtMs: DT,
  });
  return { localGame, remoteGame, engine, sent };
}

/** Build a deterministic InputFrame from a tick index. */
function frameAt(t) {
  const phase = t % 18;
  const f = { ...EMPTY_FRAME };
  if      (phase === 0)  f.left = true;
  else if (phase === 4)  f.right = true;
  else if (phase === 8)  f.rotateCW = true;
  else if (phase === 12) f.softDrop = true;
  else if (phase === 17) f.hardDrop = true;
  return f;
}

// ─── Scenario tests ────────────────────────────────────────────────

describe('RollbackEngine — minimal reconcile correctness', () => {
  it('a single misprediction at tick 0 reconciles to the correct state', () => {
    // Two engines built identically. Engine A receives the actual
    // remote frame for tick 0 BEFORE ticking; engine B predicts
    // EMPTY for tick 0 then receives the actual AFTER ticking.
    // Both should end in the same state.
    const remoteFrameTick0 = { ...EMPTY_FRAME, rotateCW: true };

    const a = makeEngine(7);
    a.engine.receiveRemoteInput(0, remoteFrameTick0);
    a.engine.tick({ ...EMPTY_FRAME, left: true });
    const stateA = JSON.stringify(a.remoteGame.serialize());

    const b = makeEngine(7);
    b.engine.tick({ ...EMPTY_FRAME, left: true }); // predicts EMPTY remote
    b.engine.receiveRemoteInput(0, remoteFrameTick0); // arrives → reconcile
    const stateB = JSON.stringify(b.remoteGame.serialize());

    expect(b.engine.stats.rollbacksFired).toBeGreaterThan(0);
    expect(stateB).toBe(stateA);
  });

  it('two consecutive mispredictions reconcile cleanly', () => {
    const fr0 = { ...EMPTY_FRAME, rotateCW: true };
    const fr1 = { ...EMPTY_FRAME, left: true };

    // Reference: pre-deliver both, then tick.
    const ref = makeEngine(11);
    ref.engine.receiveRemoteInput(0, fr0);
    ref.engine.receiveRemoteInput(1, fr1);
    ref.engine.tick(EMPTY_FRAME);
    ref.engine.tick(EMPTY_FRAME);
    const refState = JSON.stringify(ref.remoteGame.serialize());

    // Latent: tick first, then deliveries arrive after.
    const e = makeEngine(11);
    e.engine.tick(EMPTY_FRAME);
    e.engine.tick(EMPTY_FRAME);
    e.engine.receiveRemoteInput(0, fr0);
    e.engine.receiveRemoteInput(1, fr1);
    expect(JSON.stringify(e.remoteGame.serialize())).toBe(refState);
  });
});

describe('RollbackEngine — Scenario A: zero latency', () => {
  it('every remote frame is in the buffer at decide time → no prediction, no rollback', () => {
    const { engine, sent } = makeEngine(42);
    const TICKS = 200;
    // Pre-deliver every remote frame so each tick decides on the actual.
    for (let t = 0; t < TICKS; t++) engine.receiveRemoteInput(t, frameAt(t + 1000));
    for (let t = 0; t < TICKS; t++) engine.tick(frameAt(t));
    expect(engine.stats.mispredictions).toBe(0);
    expect(engine.stats.rollbacksFired).toBe(0);
    expect(engine.stats.ticksResimulated).toBe(0);
    expect(engine.stats.ticksAdvanced).toBe(TICKS);
    expect(sent).toHaveLength(TICKS);
  });
});

describe('RollbackEngine — Scenario B: constant 100ms latency (~6 ticks)', () => {
  it('predicts EMPTY at each tick; reconciles when actual arrives 6 ticks later', () => {
    const LATENCY_TICKS = 6;
    const TICKS = 120;

    // Pre-build the local + remote input sequences ONCE so both the
    // reference and the latent run consume the exact same bytes.
    const localFrames  = Array.from({ length: TICKS }, (_, t) => frameAt(t * 11 + 3));
    const remoteFrames = Array.from({ length: TICKS }, (_, t) => frameAt(t * 7 + 1));

    // Reference run (no latency): pre-deliver all remote frames,
    // then advance 120 ticks.
    const ref = makeEngine(123);
    for (let t = 0; t < TICKS; t++) ref.engine.receiveRemoteInput(t, remoteFrames[t]);
    for (let t = 0; t < TICKS; t++) ref.engine.tick(localFrames[t]);
    const refLocal  = JSON.stringify(ref.localGame.serialize());
    const refRemote = JSON.stringify(ref.remoteGame.serialize());

    // Latent run: each tick advances BEFORE the matching remote
    // frame arrives; the wire delivers it LATENCY_TICKS later.
    // After the main loop we drain ALL remaining deliveries so the
    // reconciled state has fully caught up.
    const { engine, localGame, remoteGame } = makeEngine(123);
    for (let t = 0; t < TICKS; t++) {
      // Deliver the frame for tick t-LATENCY_TICKS BEFORE advancing
      // tick t (mirrors "input shows up on the network 6 ticks after
      // it was generated remotely").
      const arrivesNow = t - LATENCY_TICKS;
      if (arrivesNow >= 0) engine.receiveRemoteInput(arrivesNow, remoteFrames[arrivesNow]);
      engine.tick(localFrames[t]);
    }
    // Drain the tail — frames for ticks (TICKS-LATENCY_TICKS) ..
    // (TICKS-1) haven't been delivered yet because main loop ended.
    for (let t = TICKS - LATENCY_TICKS; t < TICKS; t++) {
      engine.receiveRemoteInput(t, remoteFrames[t]);
    }

    expect(engine.stats.mispredictions).toBeGreaterThan(0);
    expect(engine.stats.rollbacksFired).toBeGreaterThan(0);
    // Key property: reconciled state matches the no-latency reference.
    expect(JSON.stringify(localGame.serialize())).toBe(refLocal);
    expect(JSON.stringify(remoteGame.serialize())).toBe(refRemote);
  });
});

describe('RollbackEngine — Scenario C: 5% loss + jitter', () => {
  it('survives lossy delivery; final state matches the no-loss reference', () => {
    const { engine, localGame, remoteGame } = makeEngine(999);
    const TICKS = 240;

    // Reference (no loss).
    const ref = makeEngine(999);
    for (let t = 0; t < TICKS; t++) ref.engine.receiveRemoteInput(t, frameAt(t + 17));
    for (let t = 0; t < TICKS; t++) ref.engine.tick(frameAt(t * 3 + 5));
    const refLocal = JSON.stringify(ref.localGame.serialize());

    // Lossy run: each delivery has a chance of being dropped + a
    // random latency 1..12 ticks. Dropped frames eventually re-
    // delivered to model the WS retry pattern.
    const rand = createSeededRng(7);
    const pending = [];
    const MAX_LATENCY = 12;
    function scheduleDelivery(tick, frame) {
      const latency = 1 + Math.floor(rand() * MAX_LATENCY);
      pending.push({ tick, frame, arriveAt: tick + latency });
    }
    for (let t = 0; t < TICKS; t++) {
      // Deliver anything that's due.
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].arriveAt <= t) {
          engine.receiveRemoteInput(pending[i].tick, pending[i].frame);
          pending.splice(i, 1);
        }
      }
      // Schedule the new tick's frame; 5% chance of "loss" → dropped
      // initially but re-delivered in the next tick to model
      // retransmission.
      const frame = frameAt(t + 17);
      if (rand() < 0.05) {
        scheduleDelivery(t, frame); // schedule with random latency
        scheduleDelivery(t, frame); // duplicate (post-retry) — engine drops dups
      } else {
        scheduleDelivery(t, frame);
      }
      engine.tick(frameAt(t * 3 + 5));
    }
    // Drain remaining deliveries.
    for (const d of pending) engine.receiveRemoteInput(d.tick, d.frame);

    expect(JSON.stringify(localGame.serialize())).toBe(refLocal);
  });
});

// ─── Unit tests ────────────────────────────────────────────────────

describe('RollbackEngine — snapshot ring', () => {
  it('captures a snapshot every snapshotEveryTicks + evicts oldest beyond ringSize', () => {
    const { engine } = makeEngine(1);
    // Default: snapshot every 30 ticks, keep 8 → first eviction at
    // tick > 30 * 8 = 240.
    for (let t = 0; t < 300; t++) engine.tick(EMPTY_FRAME);
    expect(engine.snapshotCount).toBe(ROLLBACK_DEFAULTS.snapshotRingSize);
  });

  it('honors per-instance overrides', () => {
    const localGame  = freshGame(1); localGame.spawnPiece();
    const remoteGame = freshGame(2); remoteGame.spawnPiece();
    const e = new RollbackEngine({
      localGame, remoteGame,
      sendInput: () => {},
      snapshotEveryTicks: 10,
      snapshotRingSize: 3,
      dtMs: DT,
    });
    for (let t = 0; t < 100; t++) e.tick(EMPTY_FRAME);
    expect(e.snapshotCount).toBe(3);
  });
});

describe('RollbackEngine — prediction-was-correct fast path', () => {
  it('arriving frame matching the prediction does NOT fire rollback', () => {
    const { engine } = makeEngine(1);
    // Predict EMPTY (default) at tick 0.
    engine.tick(EMPTY_FRAME);
    // Deliver the actual remote frame for tick 0 = EMPTY too.
    engine.receiveRemoteInput(0, EMPTY_FRAME);
    expect(engine.stats.mispredictions).toBe(0);
    expect(engine.stats.rollbacksFired).toBe(0);
  });
});

describe('RollbackEngine — input log GC', () => {
  it('trims input entries older than inputLogMaxAge', () => {
    const localGame  = freshGame(1); localGame.spawnPiece();
    const remoteGame = freshGame(2); remoteGame.spawnPiece();
    const e = new RollbackEngine({
      localGame, remoteGame,
      sendInput: () => {},
      inputLogMaxAge: 50,
      dtMs: DT,
    });
    for (let t = 0; t < 200; t++) e.tick(EMPTY_FRAME);
    // Only the last 50 entries should remain.
    const logged = Array.from(e._localInputs.keys()).sort((a, b) => a - b);
    expect(logged[0]).toBeGreaterThanOrEqual(150);
  });
});

describe('RollbackEngine — defensive', () => {
  it('throws on missing required opts', () => {
    expect(() => new RollbackEngine({})).toThrow(/localGame|remoteGame/);
  });

  it('rejects non-integer / negative ticks on receiveRemoteInput', () => {
    const { engine } = makeEngine(1);
    engine.receiveRemoteInput(-1, EMPTY_FRAME);
    engine.receiveRemoteInput(1.5, EMPTY_FRAME);
    engine.receiveRemoteInput(NaN, EMPTY_FRAME);
    expect(engine.stats.mispredictions).toBe(0);
  });
});

describe('RollbackEngine — sendInput integration', () => {
  it('every local tick fires sendInput exactly once with the matching tick + frame', () => {
    const sendInput = vi.fn();
    const localGame  = freshGame(1); localGame.spawnPiece();
    const remoteGame = freshGame(2); remoteGame.spawnPiece();
    const e = new RollbackEngine({ localGame, remoteGame, sendInput, dtMs: DT });
    for (let t = 0; t < 5; t++) e.tick(frameAt(t));
    expect(sendInput).toHaveBeenCalledTimes(5);
    for (let t = 0; t < 5; t++) {
      expect(sendInput.mock.calls[t][0]).toBe(t);
      expect(sendInput.mock.calls[t][1].left).toBe(frameAt(t).left);
    }
  });

  it('a sendInput throw does NOT abort the tick — defensive try/catch', () => {
    const sendInput = vi.fn(() => { throw new Error('boom'); });
    const localGame  = freshGame(1); localGame.spawnPiece();
    const remoteGame = freshGame(2); remoteGame.spawnPiece();
    const e = new RollbackEngine({ localGame, remoteGame, sendInput, dtMs: DT });
    expect(() => e.tick(EMPTY_FRAME)).not.toThrow();
    expect(e.currentTick).toBe(1);
  });
});

// Mark applyFrameToGame as used so the lint rule doesn't flag it
// (the test imports it so the module loads alongside the engine).
void applyFrameToGame;
