// InputRecorder — captures per-tick InputFrames into a tape that
// `player.js` can replay against a fresh Game with the same seed.
//
// The tape is the on-the-wire shape (plan_online_versus.md §2.2) +
// the offline-replay-viewer's storage shape. Same struct, two
// consumers — keeps the formats from drifting.
//
// Pure module. No DOM, no I/O. The host owns where the tape lives
// (localStorage for offline replays, R2 blob upload for online
// match records); this module only produces / consumes the tape
// shape.

/**
 * @typedef {Object} ReplayBlob
 * @property {number} v          Format version. Bumped if the tape shape changes.
 * @property {number} seed       The RNG seed the recording started from.
 * @property {string} modeKey    Rules-pack key (e.g. 'classic' / 'sprint').
 * @property {number} dtMs       Tick duration. Locked at recording time so
 *                                replay reproduces the same fall timing.
 * @property {Array<{tick:number, frame:InputFrame}>} inputs
 *   SPARSE — only ticks where the active frame DIFFERS from the
 *   previous one are stored. Replay fills the gaps with the most
 *   recent frame. This compresses a 600-tick run with ~20 keypresses
 *   into ~20 entries instead of 600, and matches the on-the-wire
 *   "send only on change + heartbeat" pattern.
 * @property {number} totalTicks Total ticks recorded — needed because
 *                                trailing no-input ticks have no entry.
 */

const FORMAT_VERSION = 1;

function framesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false; // null sentinel ≠ any real frame
  return a.left === b.left && a.right === b.right
      && a.softDrop === b.softDrop && a.hardDrop === b.hardDrop
      && a.rotateCW === b.rotateCW && a.rotateCCW === b.rotateCCW
      && a.hold === b.hold && a.pause === b.pause;
}

/**
 * Build a recorder pinned to the (seed, modeKey, dtMs) the run will
 * use. Call `record(tick, frame)` every tick the host's input router
 * advances; call `serialize()` at end-of-run to get the blob.
 *
 * @param {Object} opts
 * @param {number} opts.seed
 * @param {string} opts.modeKey
 * @param {number} [opts.dtMs=1000/60]
 * @returns {{
 *   record: (tick:number, frame:InputFrame) => void,
 *   serialize: () => ReplayBlob,
 *   readonly tickCount: number,
 *   readonly entryCount: number,
 * }}
 */
export function createInputRecorder(opts) {
  if (!opts || typeof opts.seed !== 'number') {
    throw new Error('createInputRecorder requires { seed }');
  }
  if (typeof opts.modeKey !== 'string') {
    throw new Error('createInputRecorder requires { modeKey }');
  }
  const seed    = opts.seed | 0;
  const modeKey = opts.modeKey;
  const dtMs    = (typeof opts.dtMs === 'number' && opts.dtMs > 0) ? opts.dtMs : (1000 / 60);

  /** @type {Array<{tick:number, frame:InputFrame}>} */
  const inputs = [];
  // Sentinel — the FIRST recorded frame always stores (so the
  // replayer knows what's in effect from tick 0 onward). Subsequent
  // identical frames get skipped per the sparse-storage contract.
  let lastFrame = null;
  let highestTick = -1;

  return {
    /**
     * Capture the frame in effect at `tick`. Sparse — if `frame` is
     * the same as the prior recorded frame, no entry is added (the
     * replayer will hold the previous frame across the gap).
     * `tick` must be monotonically non-decreasing.
     */
    record(tick, frame) {
      if (!Number.isFinite(tick) || tick < highestTick) {
        throw new Error(`createInputRecorder.record: tick ${tick} out of order (highest seen ${highestTick})`);
      }
      highestTick = tick;
      if (!framesEqual(frame, lastFrame)) {
        // Defensive copy — caller may mutate their frame object.
        inputs.push({ tick, frame: { ...frame } });
        lastFrame = frame;
      }
    },
    serialize() {
      return {
        v: FORMAT_VERSION,
        seed,
        modeKey,
        dtMs,
        inputs: inputs.map(e => ({ tick: e.tick, frame: { ...e.frame } })),
        totalTicks: highestTick + 1,
      };
    },
    get tickCount()  { return highestTick + 1; },
    get entryCount() { return inputs.length; },
  };
}

export const _FORMAT_VERSION = FORMAT_VERSION;
