// Bot controller v2 — drives a Game instance via InputFrame
// (plan_gameplay_1.md §3.7 sub-phase 7d).
//
// The Phase-6 v1 versusBot was an *abstract* opponent: it never played
// pieces, it just ticked an internal score and emitted GARBAGE_RECEIVED
// at random intervals. v2 is a real player — it consumes a Game's
// snapshot, picks a target column + rotation per piece, and returns
// InputFrame objects the host feeds back into Game.tick / discrete
// methods. The same wire-up that drives the human side drives the bot.
//
// Two strengths ship in this file:
//   - 'casual'  — picks a random target column + rotation per piece.
//                 Survivable for a beginner; loses to anyone who plays
//                 deliberately. Matches the v1 cadence in difficulty.
//   - 'mirror'  — copies a reference Game's recent inputs. Used as a
//                 sparring partner; not a real AI. Provided as a
//                 simple second strength so the API surface for adding
//                 more (T-spin AI, MCTS, etc.) is exercised.
//
// Pure module: no THREE, no DOM. The bot reads `game.activePiece /
// snapshot()` and produces an InputFrame; the host owns the Game.tick
// + discrete-action dispatch loop.

import { EMPTY_FRAME } from '../input/intents.js';
import { createSeededRng } from '../shared/random/seeded.js';

/**
 * @typedef {import('../input/intents.js').InputFrame} InputFrame
 * @typedef {import('./game.js').Game} Game
 */

const STRENGTHS = ['casual', 'mirror'];

/** Legal rotations are 0..3; pieces with shape symmetries (O, S, Z, I) collapse internally. */
const NUM_ROTATIONS = 4;

/**
 * Per-piece plan: which column to drop at, with which rotation. The
 * controller advances toward the plan one frame at a time, then issues
 * a hardDrop when in position.
 *
 * @typedef {Object} BotPlan
 * @property {number}  col
 * @property {number}  rot
 * @property {boolean} dropped   Set to true after the bot fires hardDrop;
 *                               the next spawn invalidates and re-plans.
 */

/**
 * @typedef {Object} BotOpts
 * @property {Game}   game                       The Game this bot drives.
 * @property {string} [strength]                 'casual' (default) or 'mirror'.
 * @property {() => number} [rng]                Defaults to Math.random.
 *                                                Use a seeded source to get
 *                                                reproducible bot play.
 * @property {Game}   [mirrorOf]                 For strength: 'mirror' — the
 *                                                reference Game whose active
 *                                                piece position the bot copies.
 * @property {number} [actionsPerSecond]         How many input frames the bot
 *                                                "attempts" per second. Higher =
 *                                                bot moves faster. Default 8.
 */

export class BotController {
  /** @param {BotOpts} opts */
  constructor(opts) {
    if (!opts || !opts.game) throw new Error('BotController requires { game }');
    if (opts.strength && !STRENGTHS.includes(opts.strength)) {
      throw new Error(`BotController: unknown strength '${opts.strength}'`);
    }
    this._game = opts.game;
    this._strength = opts.strength || 'casual';
    // Default to a seeded source so the bot's plays are reproducible
    // across a replay or a network rollback (§3.7 sub-phase 7f). Hosts
    // that want a specific seed pass `rng: createSeededRng(matchId)`.
    this._rng = opts.rng || createSeededRng((Date.now() | 0) >>> 0);
    this._mirrorOf = opts.mirrorOf || null;
    this._aps = (typeof opts.actionsPerSecond === 'number' && opts.actionsPerSecond > 0)
      ? opts.actionsPerSecond
      : 8;
    this._actionIntervalMs = 1000 / this._aps;
    this._sinceLastActionMs = 0;

    this._plan = null;
    this._lastSeenPiece = null; // identity check via piece reference
  }

  // ─── Read-only accessors ─────────────────────────────────────────────

  get strength()   { return this._strength; }
  get plan()       { return this._plan; }
  get game()       { return this._game; }

  // ─── Tick ────────────────────────────────────────────────────────────

  /**
   * Produce an InputFrame for the next game tick. Cadence-rate-limited:
   * even if called every frame, the bot only acts every
   * 1000/actionsPerSecond ms. This avoids "perfect" play (where the bot
   * could rotate + move + drop in a single frame) and reads more like a
   * human opponent.
   *
   * @param {number} dtMs
   * @returns {InputFrame}
   */
  tick(dtMs = 0) {
    if (!this._game.activePiece || this._game.gameOver || this._game.paused) {
      return frame();
    }

    // Re-plan on a new piece. Active piece identity is the cheapest
    // change detector — Game replaces the activePiece object on each
    // spawn, so reference equality flips even if (col,row,rot) coincide.
    if (this._game.activePiece !== this._lastSeenPiece) {
      this._plan = this._planForCurrentPiece();
      this._lastSeenPiece = this._game.activePiece;
      this._sinceLastActionMs = 0;
    }

    // Rate-limit actions.
    this._sinceLastActionMs += dtMs;
    if (this._sinceLastActionMs < this._actionIntervalMs) return frame();
    this._sinceLastActionMs = 0;

    return this._executePlan();
  }

  /**
   * Build a fresh plan for the current active piece. 'mirror' delegates
   * to the reference game's piece (best-effort copy); 'casual' picks at
   * random within the legal column range for the piece's rotation.
   *
   * @returns {BotPlan}
   */
  _planForCurrentPiece() {
    if (this._strength === 'mirror' && this._mirrorOf && this._mirrorOf.activePiece) {
      const ref = this._mirrorOf.activePiece;
      return { col: ref.col, rot: ref.rot, dropped: false };
    }
    // casual: random target. Clamp col so the piece can fit at the
    // chosen rotation (collide check handles bounds, but we narrow
    // here for fewer wasted moves).
    const rot = Math.floor(this._rng() * NUM_ROTATIONS) % NUM_ROTATIONS;
    const col = Math.floor(this._rng() * this._game.cols);
    return { col, rot, dropped: false };
  }

  /**
   * Translate the current plan into one frame's worth of intents.
   * Priority: rotate → move → drop. One intent per call so the bot
   * doesn't "teleport" by dispatching multiple discrete actions in one
   * frame — that would re-introduce the v1 abstract feel.
   *
   * @returns {InputFrame}
   */
  _executePlan() {
    if (!this._plan || this._plan.dropped) return frame();
    const ap = this._game.activePiece;
    if (!ap) return frame();

    if (ap.rot !== this._plan.rot) {
      return frame({ rotateCW: true });
    }
    if (ap.col < this._plan.col) {
      return frame({ right: true });
    }
    if (ap.col > this._plan.col) {
      return frame({ left: true });
    }
    // In position — drop.
    this._plan.dropped = true;
    return frame({ hardDrop: true });
  }

  /** Reset internal plan state (host calls on Mode.start / restart). */
  reset() {
    this._plan = null;
    this._lastSeenPiece = null;
    this._sinceLastActionMs = 0;
  }
}

/** Build a fresh InputFrame, optionally overlaying intents. */
function frame(overlay) {
  const f = { ...EMPTY_FRAME };
  if (overlay) for (const k of Object.keys(overlay)) f[k] = overlay[k];
  return f;
}

export const _STRENGTHS = STRENGTHS;
