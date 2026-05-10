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
// Strengths shipped in this file:
//   - 'casual'    — greedy heuristic plus the slow 8-aps cadence. The
//                   bot picks a placement by simulating every (col, rot)
//                   candidate and scoring the resulting board with the
//                   classic 4-feature heuristic (aggregate height /
//                   line clears / holes / bumpiness). Plays competently
//                   — survives long enough to send garbage but loses
//                   to a focused human on speed.
//   - 'random'    — picks (col, rot) at random per piece. The pre-
//                   heuristic behavior; kept for tests + as a "tutorial
//                   opponent" stand-in.
//   - 'mirror'    — copies a reference Game's active-piece position.
//                   Sparring partner, not a real AI. Provided as a
//                   simple second strategy so the strength API surface
//                   is exercised by something other than the heuristic.
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

const STRENGTHS = ['casual', 'random', 'mirror'];

// Heuristic weights — Dellacherie / "El-Tetris"-inspired numbers,
// tuned mild so the bot is competent but beatable. Higher magnitude
// `lines` would make the bot greedy for clears (good for sending
// garbage); higher `holes` magnitude would make it more conservative
// (safer survival). The current balance plays cleanly in casual play
// without feeling oppressive.
const HEURISTIC_WEIGHTS = Object.freeze({
  aggregateHeight: -0.51,
  completeLines:    0.76,
  holes:           -0.36,
  bumpiness:       -0.18,
});

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
    // Online versus always supplies its own seeded rng; the Date.now()
    // fallback only runs in offline play and just chooses a seed (the
    // RNG output stays deterministic given that seed).
    // eslint-disable-next-line no-restricted-syntax
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
   * Build a fresh plan for the current active piece.
   *  - 'mirror'   → copy the reference game's piece position.
   *  - 'random'   → pick (col, rot) uniformly at random.
   *  - 'casual'   → greedy heuristic over all (col, rot) candidates.
   *
   * @returns {BotPlan}
   */
  _planForCurrentPiece() {
    if (this._strength === 'mirror' && this._mirrorOf && this._mirrorOf.activePiece) {
      const ref = this._mirrorOf.activePiece;
      return { col: ref.col, rot: ref.rot, dropped: false };
    }
    if (this._strength === 'random') {
      const rot = Math.floor(this._rng() * NUM_ROTATIONS) % NUM_ROTATIONS;
      const col = Math.floor(this._rng() * this._game.cols);
      return { col, rot, dropped: false };
    }
    return this._heuristicPlan();
  }

  /**
   * Greedy heuristic — for every (col, rot) where the active piece
   * can be placed, simulate the lock and score the resulting board.
   * Pick the highest-scoring placement.
   *
   * Cost: ~4 rotations × ~12 columns = ~48 candidates per piece.
   * Each candidate copies the board (~200 cells), places the piece,
   * and scans columns once. Roughly 1ms per planning call on modern
   * hardware. Planning runs once per spawn (cached in `this._plan`),
   * not per frame.
   */
  _heuristicPlan() {
    const game = this._game;
    const ap   = game.activePiece;
    if (!ap) return { col: 0, rot: 0, dropped: false };

    let bestScore = -Infinity;
    let bestPlan  = { col: ap.col, rot: ap.rot, dropped: false };

    // Iterate all rotations and a column range that covers every
    // legal placement. game.collides() handles out-of-bounds safely;
    // wasted candidates fall through quickly.
    for (let rot = 0; rot < NUM_ROTATIONS; rot++) {
      for (let col = -2; col < game.cols + 2; col++) {
        const piece = { key: ap.key, col, row: game.rows - 2, rot, color: ap.color };
        // Reject placements that don't fit even at spawn position.
        if (game.collides(piece, col, piece.row, rot)) continue;

        // Drop until the piece can fall no further.
        let restRow = piece.row;
        while (!game.collides(piece, col, restRow - 1, rot)) restRow--;

        // Place on a virtual board copy. Topouts (cells above ROWS)
        // disqualify the candidate — we don't want the bot picking a
        // suicide drop.
        const cells = game.getPieceCells({ ...piece, row: restRow });
        let topout = false;
        for (const cell of cells) {
          if (cell.row >= game.rows) { topout = true; break; }
        }
        if (topout) continue;

        const virt = game.board.map(row => row.slice());
        for (const cell of cells) {
          virt[cell.row][cell.col] = ap.color;
        }

        const score = _scoreBoard(virt, game.cols);
        if (score > bestScore) {
          bestScore = score;
          bestPlan  = { col, rot, dropped: false };
        }
      }
    }
    return bestPlan;
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

// ─── Heuristic scoring (private) ───────────────────────────────────────

function _columnHeights(board, cols) {
  const heights = new Array(cols).fill(0);
  const rows = board.length;
  for (let c = 0; c < cols; c++) {
    for (let r = rows - 1; r >= 0; r--) {
      if (board[r][c] != null) {
        heights[c] = r + 1;
        break;
      }
    }
  }
  return heights;
}

function _countCompleteLines(board, cols) {
  let lines = 0;
  for (let r = 0; r < board.length; r++) {
    let full = true;
    for (let c = 0; c < cols; c++) {
      if (board[r][c] == null) { full = false; break; }
    }
    if (full) lines++;
  }
  return lines;
}

function _countHoles(board, heights, cols) {
  let holes = 0;
  for (let c = 0; c < cols; c++) {
    const h = heights[c];
    for (let r = 0; r < h - 1; r++) {
      if (board[r][c] == null) holes++;
    }
  }
  return holes;
}

function _bumpiness(heights) {
  let b = 0;
  for (let i = 0; i < heights.length - 1; i++) {
    b += Math.abs(heights[i] - heights[i + 1]);
  }
  return b;
}

/**
 * Mentally clear all complete rows from `board` (returns a new array
 * — does NOT mutate the input). Surviving rows shift down by the
 * number cleared below them; the top is padded with empty rows so
 * the returned board has the same dimensions. Used by `_scoreBoard`
 * so the height/hole/bumpiness features reflect the *post-clear*
 * state — otherwise filling a row that's about to clear gets
 * penalized for its height instead of rewarded for the clear.
 */
function _clearLinesVirtual(board, cols) {
  const kept = [];
  let cleared = 0;
  for (const row of board) {
    let full = true;
    for (let c = 0; c < cols; c++) {
      if (row[c] == null) { full = false; break; }
    }
    if (full) cleared++;
    else      kept.push(row);
  }
  while (kept.length < board.length) kept.push(new Array(cols).fill(null));
  return { kept, cleared };
}

/**
 * Heuristic score for a candidate board state. Higher = more
 * preferable to the bot. The four features (aggregate height,
 * complete lines, holes, bumpiness) are the standard "El-Tetris"
 * inputs and capture most of what makes a tetris board good or bad
 * for further play. Lines are simulated as cleared first so the
 * post-clear height/hole/bumpiness features reflect the actual board
 * the next piece lands on.
 */
function _scoreBoard(board, cols) {
  const { kept, cleared } = _clearLinesVirtual(board, cols);
  const heights = _columnHeights(kept, cols);
  const aggregateHeight = heights.reduce((a, b) => a + b, 0);
  const holes           = _countHoles(kept, heights, cols);
  const bumpiness       = _bumpiness(heights);
  const w = HEURISTIC_WEIGHTS;
  return w.aggregateHeight * aggregateHeight
       + w.completeLines   * cleared
       + w.holes           * holes
       + w.bumpiness       * bumpiness;
}

export const _STRENGTHS = STRENGTHS;
export const _HEURISTIC_WEIGHTS = HEURISTIC_WEIGHTS;
export {
  _columnHeights,
  _countCompleteLines,
  _countHoles,
  _bumpiness,
  _scoreBoard,
};
