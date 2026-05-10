// Replay player — given a ReplayBlob from recorder.js, reconstruct
// a Game from the same seed + rules-pack and step it through the
// recorded inputs. Returns the final serialized state + (optionally)
// the bus event log captured during replay.
//
// Used for:
//   - Offline replay viewer (load a saved match, watch it back)
//   - Server-side replay validation (Phase H — re-runs the match
//     with the same code as the client to verify the reported outcome)
//   - Online rollback reconciliation (Phase E — restore from a
//     snapshot, replay forward through buffered remote inputs)
//
// Pure module. The Game constructed here gets its own EventBus so
// the caller can opt into capturing the event log without
// interference from any other bus subscribers.

import { EventBus } from '../../engine/events/bus.js';
import { Game } from '../game.js';
import { buildRules } from '../rules.js';
import { createSeededRng } from '../../shared/random/seeded.js';
import { EMPTY_FRAME } from '../../input/intents.js';
import { applyFrameToGame } from './apply-frame.js';

/**
 * Replay a tape end-to-end. Returns the final serialized Game state
 * + the array of bus events emitted during the run.
 *
 * @param {import('./recorder.js').ReplayBlob} blob
 * @param {Object} [opts]
 * @param {Object} [opts.gameOpts]   Extra opts forwarded to the Game
 *                                    constructor (e.g. `nowMs`,
 *                                    `garbageDelayMs`, `side`).
 * @param {boolean} [opts.captureEvents=false]
 *   When true, every bus emit during the replay is recorded into the
 *   returned `events` array. Off by default — most callers just want
 *   the final state and skipping the capture saves memory.
 * @returns {{ finalBlob: object, game: Game, events: Array<{topic:string, payload:any}> }}
 */
export function replayInputs(blob, opts = {}) {
  if (!blob || typeof blob !== 'object') {
    throw new Error('replayInputs: blob is required');
  }
  if (typeof blob.seed !== 'number' || typeof blob.modeKey !== 'string') {
    throw new Error('replayInputs: blob.seed (number) + blob.modeKey (string) required');
  }
  const dtMs       = (typeof blob.dtMs === 'number' && blob.dtMs > 0) ? blob.dtMs : (1000 / 60);
  const inputs     = Array.isArray(blob.inputs) ? blob.inputs : [];
  const totalTicks = (typeof blob.totalTicks === 'number')
    ? blob.totalTicks
    : (inputs.length > 0 ? (inputs[inputs.length - 1].tick | 0) + 1 : 0);

  const bus  = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
  const rules = buildRules(blob.modeKey);
  const game  = new Game({
    rules,
    bus,
    rng: createSeededRng(blob.seed),
    nowMs: 0,
    ...(opts.gameOpts || {}),
  });

  /** @type {Array<{topic:string, payload:any}>} */
  const events = [];
  if (opts.captureEvents) {
    // EventBus exposes a `recorder` opt or we can subscribe to a
    // wildcard. Here we install per-topic listeners by subscribing
    // to every known topic via a thin pattern: we don't know all
    // topics ahead of time, so we monkey-patch `bus.emit` instead.
    // This is replay-internal — the bus is created above and only
    // the replay reads it.
    const origEmit = bus.emit.bind(bus);
    bus.emit = (topic, payload) => {
      events.push({ topic, payload });
      origEmit(topic, payload);
    };
  }

  // Spawn the first piece — same boot path the host uses.
  game.spawnPiece();

  // Walk the input tape: at each tick, the active frame is the most
  // recently received entry whose tick ≤ current. Sparse storage
  // means most ticks have no new entry and reuse the last one.
  let cursor = 0;
  let activeFrame = EMPTY_FRAME;
  for (let t = 0; t < totalTicks; t++) {
    while (cursor < inputs.length && inputs[cursor].tick <= t) {
      activeFrame = inputs[cursor].frame || EMPTY_FRAME;
      cursor++;
    }
    applyFrameToGame(game, activeFrame, dtMs);
    if (game.gameOver) break; // run ended before tape consumed — stop early
  }

  return {
    finalBlob: game.serialize(),
    game,
    events,
  };
}
