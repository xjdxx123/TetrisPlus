// validateMatch tests — drives the validator with synthetic
// submissions through the gameplay/replay pipeline + asserts the
// validation decision matches expectations.

import { describe, it, expect } from 'vitest';
import { validateMatch } from './validate-match.js';
import { createInputRecorder, applyFrameToGame } from '../../src/gameplay/replay/index.js';
import { Game } from '../../src/gameplay/game.js';
import { buildRules } from '../../src/gameplay/rules.js';
import { EventBus } from '../../src/engine/events/bus.js';
import { createSeededRng } from '../../src/shared/random/seeded.js';
import { EMPTY_FRAME } from '../../src/input/intents.js';

const DT = 1000 / 60;

/** Drive a Game with a per-tick frame producer + return both the
 *  recorded tape AND the final serialized state. */
function runAndRecord(seed, modeKey, frameAt, ticks) {
  const game = new Game({
    rules: buildRules(modeKey),
    bus:   new EventBus({ replayBufferSize: 0, recorderSize: 0 }),
    rng:   createSeededRng(seed),
    nowMs: 0,
  });
  game.spawnPiece();
  const rec = createInputRecorder({ seed, modeKey, dtMs: DT });
  for (let t = 0; t < ticks; t++) {
    const f = frameAt(t);
    rec.record(t, f);
    applyFrameToGame(game, f, DT);
  }
  return { tape: rec.serialize(), final: game.serialize() };
}

const SEED = 7;
const MODE = 'classic';

describe('validateMatch — happy path', () => {
  it('validates a match where both sides report the actual winner', () => {
    // Run two short side-runs; pick the side with higher score as
    // the "reported winner". Validation should green-light.
    const a = runAndRecord(SEED, MODE, t => t === 5 ? { ...EMPTY_FRAME, hardDrop: true } : EMPTY_FRAME, 30);
    const b = runAndRecord(SEED + 1, MODE, () => EMPTY_FRAME, 30);
    const winner = a.final.score >= b.final.score ? 'p1-uid' : 'p2-uid';
    const r = validateMatch({
      matchId: 'm-1', seed: SEED, modeKey: MODE,
      p1: { userId: 'p1-uid', inputs: a.tape.inputs, totalTicks: a.tape.totalTicks },
      p2: { userId: 'p2-uid', inputs: b.tape.inputs, totalTicks: b.tape.totalTicks },
      reportedWinner: winner,
    });
    expect(r.validated).toBe(true);
    expect(r.actualWinner).toBe(winner);
  });
});

describe('validateMatch — rejection paths', () => {
  it('rejects a match with a fabricated winner (winner mismatch)', () => {
    // Both sides do nothing; identical state by symmetry. Report a
    // winner anyway — the actual is "whoever has higher score" but
    // both have 0 → the algorithm picks p1 by tiebreak. Report 'p2'
    // → mismatch.
    const a = runAndRecord(SEED, MODE, () => EMPTY_FRAME, 30);
    const b = runAndRecord(SEED, MODE, () => EMPTY_FRAME, 30);
    const r = validateMatch({
      matchId: 'm-2', seed: SEED, modeKey: MODE,
      p1: { userId: 'p1', inputs: a.tape.inputs, totalTicks: a.tape.totalTicks },
      p2: { userId: 'p2', inputs: b.tape.inputs, totalTicks: b.tape.totalTicks },
      reportedWinner: 'p2',
    });
    expect(r.validated).toBe(false);
    expect(r.reason).toMatch(/WINNER_MISMATCH/);
  });

  it('rejects a malformed submission (missing p1 / p2)', () => {
    const r = validateMatch({ matchId: 'm-3', seed: 1, modeKey: 'classic' });
    expect(r.validated).toBe(false);
    expect(r.reason).toBe('MALFORMED_SUBMISSION');
  });

  it('rejects when the replayer throws on a malformed tape (e.g. seed missing)', () => {
    // replayInputs requires seed (number) + modeKey (string); missing
    // seed throws before any simulation happens.
    const r = validateMatch({
      matchId: 'm-4', seed: 'oops', modeKey: 'classic',
      p1: { userId: 'p1', inputs: [], totalTicks: 0 },
      p2: { userId: 'p2', inputs: [], totalTicks: 0 },
      reportedWinner: 'p1',
    });
    expect(r.validated).toBe(false);
    expect(r.reason).toMatch(/REPLAY_THREW/);
  });
});

describe('validateMatch — symmetry', () => {
  it('rerunning the same submission twice produces the same decision (deterministic)', () => {
    const a = runAndRecord(SEED, MODE, t => (t % 7) === 0 ? { ...EMPTY_FRAME, rotateCW: true } : EMPTY_FRAME, 60);
    const b = runAndRecord(SEED + 9, MODE, () => EMPTY_FRAME, 60);
    const sub = {
      matchId: 'm-5', seed: SEED, modeKey: MODE,
      p1: { userId: 'p1', inputs: a.tape.inputs, totalTicks: a.tape.totalTicks },
      p2: { userId: 'p2', inputs: b.tape.inputs, totalTicks: b.tape.totalTicks },
      reportedWinner: 'p1',
    };
    const r1 = validateMatch(sub);
    const r2 = validateMatch(sub);
    expect(r1.validated).toBe(r2.validated);
    expect(r1.actualWinner).toBe(r2.actualWinner);
  });
});
