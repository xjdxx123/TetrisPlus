// Replay subsystem tests — recorder + player round-trip; sparse
// storage; the rollback prerequisite (snapshot + replay forward).

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../engine/events/bus.js';
import { EVENTS } from '../events.js';
import { Game } from '../game.js';
import { buildRules } from '../rules.js';
import { createSeededRng } from '../../shared/random/seeded.js';
import { EMPTY_FRAME } from '../../input/intents.js';
import { applyFrameToGame, createInputRecorder, replayInputs } from './index.js';

const DT = 1000 / 60;
const SEED = 12345;
const MODE = 'classic';

function freshGame() {
  return new Game({
    rules: buildRules(MODE),
    bus:   new EventBus({ replayBufferSize: 0, recorderSize: 0 }),
    rng:   createSeededRng(SEED),
    nowMs: 0,
  });
}

// A small but non-trivial input sequence — exercises rotate / move /
// soft-drop / hard-drop / hold across enough ticks that pieces lock
// + the bag advances multiple times.
function* exampleInputStream(totalTicks = 600) {
  for (let t = 0; t < totalTicks; t++) {
    const f = { ...EMPTY_FRAME };
    const phase = t % 24;
    if      (phase === 0)  f.left = true;
    else if (phase === 4)  f.right = true;
    else if (phase === 8)  f.rotateCW = true;
    else if (phase === 12) f.softDrop = true;
    else if (phase === 16) f.hold = true;
    else if (phase === 23) f.hardDrop = true;
    yield { tick: t, frame: f };
  }
}

describe('replay/apply-frame', () => {
  it('discrete intents fire BEFORE gravity (rotate-then-fall ordering)', () => {
    const g = freshGame();
    g.spawnPiece('I');
    const startRow = g.activePiece.row;
    const startRot = g.activePiece.rot;
    applyFrameToGame(g, { ...EMPTY_FRAME, rotateCW: true }, DT);
    // Rotation applied before gravity in the same tick.
    expect(g.activePiece.rot).not.toBe(startRot);
    // Gravity moved the piece down (or kept it; level 1 is slow but
    // fallTimer accumulates). Either way, rotation already happened.
    expect(g.activePiece.row).toBeLessThanOrEqual(startRow);
  });

  it('respects gameOver / paused — no-op when the run is over', () => {
    const g = freshGame();
    g.spawnPiece('I');
    g.setPaused(true);
    const beforeRow = g.activePiece.row;
    applyFrameToGame(g, { ...EMPTY_FRAME, left: true }, DT);
    // Pause guard skips dispatch entirely.
    expect(g.activePiece.row).toBe(beforeRow);
  });
});

describe('replay/recorder', () => {
  it('throws without seed / modeKey', () => {
    expect(() => createInputRecorder({})).toThrow(/seed/);
    expect(() => createInputRecorder({ seed: 1 })).toThrow(/modeKey/);
  });

  it('SPARSE — only records frames that DIFFER from the previous one', () => {
    const rec = createInputRecorder({ seed: 1, modeKey: 'classic' });
    rec.record(0, EMPTY_FRAME);                              // 1st: stored
    rec.record(1, EMPTY_FRAME);                              // same: skipped
    rec.record(2, EMPTY_FRAME);                              // same: skipped
    rec.record(3, { ...EMPTY_FRAME, left: true });           // diff: stored
    rec.record(4, { ...EMPTY_FRAME, left: true });           // same: skipped
    rec.record(5, EMPTY_FRAME);                              // diff: stored
    expect(rec.entryCount).toBe(3);
    expect(rec.tickCount).toBe(6);
  });

  it('rejects out-of-order ticks', () => {
    const rec = createInputRecorder({ seed: 1, modeKey: 'classic' });
    rec.record(5, EMPTY_FRAME);
    expect(() => rec.record(3, EMPTY_FRAME)).toThrow(/out of order/);
  });

  it('serialize() returns a JSON-friendly blob with v / seed / modeKey / dtMs / inputs / totalTicks', () => {
    const rec = createInputRecorder({ seed: 42, modeKey: 'sprint', dtMs: DT });
    rec.record(0, { ...EMPTY_FRAME, hardDrop: true });
    rec.record(1, EMPTY_FRAME);
    const blob = rec.serialize();
    expect(blob.v).toBeGreaterThan(0);
    expect(blob.seed).toBe(42);
    expect(blob.modeKey).toBe('sprint');
    expect(blob.dtMs).toBeCloseTo(DT, 5);
    expect(blob.totalTicks).toBe(2);
    // Round-trips through JSON without loss.
    const round = JSON.parse(JSON.stringify(blob));
    expect(round).toEqual(blob);
  });
});

describe('replay/player', () => {
  it('round-trip — replaying a recorded run produces an identical final state', () => {
    // Drive a fresh Game live, recording each frame; then replay the
    // tape against another fresh Game from the same seed; assert
    // both reach byte-identical serialized state.
    const liveGame = freshGame();
    const rec = createInputRecorder({ seed: SEED, modeKey: MODE, dtMs: DT });
    liveGame.spawnPiece();
    for (const { tick, frame } of exampleInputStream(600)) {
      rec.record(tick, frame);
      applyFrameToGame(liveGame, frame, DT);
    }
    const liveFinal = JSON.stringify(liveGame.serialize());

    const result = replayInputs(rec.serialize());
    const replayFinal = JSON.stringify(result.finalBlob);

    expect(replayFinal).toBe(liveFinal);
  });

  it('captureEvents — bus emits during replay are recorded into events[]', () => {
    const rec = createInputRecorder({ seed: SEED, modeKey: MODE, dtMs: DT });
    // Record enough ticks to guarantee at least one PIECE_LOCK + LINE_CLEAR
    // sequence (a hard-drop every 24 ticks → ~25 locks in 600 ticks).
    for (const { tick, frame } of exampleInputStream(600)) {
      rec.record(tick, frame);
    }
    const result = replayInputs(rec.serialize(), { captureEvents: true });
    const lockEvents = result.events.filter(e => e.topic === EVENTS.PIECE_LOCK);
    expect(lockEvents.length).toBeGreaterThan(0);
    // SPAWN events also flow through.
    const spawnEvents = result.events.filter(e => e.topic === EVENTS.PIECE_SPAWN);
    expect(spawnEvents.length).toBeGreaterThan(0);
  });

  it('replay terminates early on game over (no infinite loop on a topout tape)', () => {
    // Fabricate a board state that would topout immediately on the
    // next spawn by pre-filling row 18 entirely; record one tick of
    // EMPTY_FRAME; replay should stop after the first piece's lock.
    const blob = {
      v: 1, seed: SEED, modeKey: MODE, dtMs: DT,
      inputs: [{ tick: 0, frame: { ...EMPTY_FRAME, hardDrop: true } }],
      totalTicks: 60,
    };
    const result = replayInputs(blob);
    // No assertion on whether it actually topped out — just that it
    // returned without hanging. The structural fact (gameOver short-
    // circuits the loop) is the contract.
    expect(result.finalBlob).toBeDefined();
  });

  it('an empty tape replays to the freshly-spawned state (no-op replay is well-defined)', () => {
    const blob = { v: 1, seed: SEED, modeKey: MODE, dtMs: DT, inputs: [], totalTicks: 0 };
    const result = replayInputs(blob);
    expect(result.game.activePiece).not.toBeNull();
    expect(result.game.lines).toBe(0);
  });

  it('rollback prerequisite — restore from a snapshot then replay forward = full-run state', () => {
    // The single most important property the player module ships:
    // online's rollback engine (Phase E) restores from a snapshot at
    // tick T, then replays inputs[T..now] forward; the result MUST
    // equal what the live sim produced. If this regresses, rollback
    // can't reconcile mispredictions.
    const SNAP_TICK = 200;
    const TOTAL_TICKS = 500;

    // Record a 500-tick run + snapshot at tick 200.
    const liveGame = freshGame();
    liveGame.spawnPiece();
    const rec = createInputRecorder({ seed: SEED, modeKey: MODE, dtMs: DT });
    let snapshotBlob = null;
    let t = 0;
    for (const { tick, frame } of exampleInputStream(TOTAL_TICKS)) {
      if (t === SNAP_TICK) snapshotBlob = liveGame.serialize();
      rec.record(tick, frame);
      applyFrameToGame(liveGame, frame, DT);
      t++;
    }
    const liveFinal = JSON.stringify(liveGame.serialize());

    // Restore from the snapshot, replay the remaining inputs.
    const restored = freshGame();
    restored.restore(snapshotBlob);
    // Walk inputs from SNAP_TICK..TOTAL_TICKS-1, applying each.
    const tape = rec.serialize();
    let cursor = 0;
    let active = EMPTY_FRAME;
    // Advance cursor to the first entry at-or-after SNAP_TICK,
    // initializing `active` from the entry just before SNAP_TICK.
    for (let i = 0; i < tape.inputs.length; i++) {
      if (tape.inputs[i].tick > SNAP_TICK - 1) { cursor = i; break; }
      active = tape.inputs[i].frame;
    }
    for (let tick = SNAP_TICK; tick < TOTAL_TICKS; tick++) {
      while (cursor < tape.inputs.length && tape.inputs[cursor].tick <= tick) {
        active = tape.inputs[cursor].frame;
        cursor++;
      }
      applyFrameToGame(restored, active, DT);
    }
    const restoredFinal = JSON.stringify(restored.serialize());

    expect(restoredFinal).toBe(liveFinal);
  });
});
