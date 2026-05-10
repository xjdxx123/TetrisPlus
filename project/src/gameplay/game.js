// Game container — the reusable per-instance gameplay simulation
// (plan_gameplay_1.md §3.7).
//
// A `Game` owns one Tetris simulation: the board, the active piece, the
// bag/queue, the score/lines/level counters, the mode timer, and the
// inbound garbage queue. The host (currently `app/main.js`) constructs a
// Game on Mode.start, feeds it ticks + input, and listens to the events
// the Game emits on its bus to drive rendering, audio, HUD, and stats.
//
// Why this exists: `app/main.js` accumulated ~5,200 lines of mixed
// gameplay + render + audio + UI state. Phase 6 (Versus v1) shipped a
// single-sim AI inside that file; the planned dual-board layout
// (Player 1 + Player 2) would require a second simulation, which the
// module-scope state in main.js cannot represent. Extracting the
// simulation into a class fixes that and unblocks online Versus (§7),
// the future replay viewer, and 3D Tetris (§6) as a separate `Game`
// variant.
//
// Pure module. No THREE, no DOM, no AudioContext. Tested in pure Node.
// Visual side-effects (mesh updates, particle bursts, sfx) are driven by
// subscribers to the gameplay events emitted on the bus — Game itself
// only mutates simulation state.

import { EVENTS } from './events.js';
import { PIECES, PIECE_COLORS, PIECE_KEYS } from './pieces.js';
import { TETRACUBES, TETRACUBE_KEYS, TETRACUBE_COLORS } from './experimental/3d/tetracubes.js';
import { rotateX as rotate3DX, rotateY as rotate3DY, rotateZ as rotate3DZ, normalize as normalize3D } from './experimental/3d/rotation.js';
import { getKicks3D } from './experimental/3d/kicks.js';
import { getKickOffsets, nextRotation } from './rotation.js';
import { detectTSpin } from './t-spin.js';
import { perfectClearBonus } from './scoring.js';
import { createSeededRng } from '../shared/random/seeded.js';

const DEFAULT_COLS = 10;
const DEFAULT_ROWS = 20;
const DEFAULT_DEPTH = 1; // 2D modes; 3D mode (rules.dimensions.DEPTH) sets this to 10.
const GARBAGE_QUEUE_CAP_ROWS = 20;
const GARBAGE_COLOR = 0x808080;
// Modern-rules spawn-delay window (plan §12 M5). When a piece of garbage
// arrives, it doesn't apply immediately — it waits `GARBAGE_DELAY_MS`
// of game time (pause-aware, via `_modeTimeMs`) before becoming
// "ready" to drain. During that window the player's outgoing clears
// can cancel the queued garbage front-first.
const GARBAGE_DELAY_MS_DEFAULT = 800;

/**
 * @typedef {Object} GameOpts
 * @property {import('./rules.js').Rules} rules
 *   Active rules pack — controls scoring, gravity, end conditions, hooks.
 * @property {import('../engine/events/bus.js').EventBus} bus
 *   Event bus for emit/on. Per-game in dual-sim setups; shared in single-sim.
 * @property {string} [side]
 *   Opaque tag carried in event payloads + snapshot (default 'player').
 *   Used by HUDs and the future dual-board host to route events to the
 *   correct view.
 * @property {number} [cols]   Default 10.
 * @property {number} [rows]   Default 20.
 * @property {() => number} [rng]
 *   PRNG returning [0,1). Default `Math.random`. The 7f sub-phase
 *   replaces this with a seeded source for replay determinism.
 * @property {number} [nowMs]
 *   Wall-clock seed for the cosmetic `_sessionStart` HUD timer.
 *   Defaults to 0 — the simulation never reads time internally
 *   (`gameplay/` is `performance.now()`-free per the online-versus
 *   determinism rule, plan_online_versus.md §0.2). Hosts that want
 *   the legacy "session length displayed in HUD" feel pass
 *   `nowMs: Date.now()` here.
 * @property {(info: { reason: string, winner?: string }) => void} [onEndRun]
 *   Host callback invoked when the simulation detects topout (or
 *   `forceTopOut` is called externally). The host handles stats
 *   persistence + emitting MODE_END; Game stays focused on simulation.
 */

/**
 * @typedef {Object} InputFrame
 * @property {boolean} [softDrop]
 *   When true during a tick, fallTimer advances 12× normal — matches the
 *   legacy "down-arrow held" gravity multiplier in main.js.
 */

/** Per-row average color (hex 0xRRGGBB) used by LINE_CLEAR's `colors[]`. */
function avgRowColor(boardRow) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const cell of boardRow) {
    if (cell == null) continue;
    r += (cell >> 16) & 0xff;
    g += (cell >> 8) & 0xff;
    b += cell & 0xff;
    n++;
  }
  if (n === 0) return 0xffffff;
  return ((Math.round(r / n) & 0xff) << 16) |
         ((Math.round(g / n) & 0xff) << 8)  |
          (Math.round(b / n) & 0xff);
}

/**
 * Average color across a full Y-slab — every (col, depth) at the
 * given row. For 2D modes (depth=1) this collapses to `avgRowColor`
 * on the front slice. For 3D it folds all slices into one mean
 * color, which is what LINE_CLEAR needs to drive the shockwave hue.
 */
function avgLayerColor(board3D, rowIdx, depth) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let d = 0; d < depth; d++) {
    const row = board3D[d][rowIdx];
    for (const cell of row) {
      if (cell == null) continue;
      r += (cell >> 16) & 0xff;
      g += (cell >> 8)  & 0xff;
      b += cell & 0xff;
      n++;
    }
  }
  if (n === 0) return 0xffffff;
  return ((Math.round(r / n) & 0xff) << 16) |
         ((Math.round(g / n) & 0xff) << 8)  |
          (Math.round(b / n) & 0xff);
}

/** Mean of an array of hex colors. */
function meanColor(colors) {
  if (!colors.length) return 0xffffff;
  let r = 0, g = 0, b = 0;
  for (const c of colors) {
    r += (c >> 16) & 0xff;
    g += (c >> 8) & 0xff;
    b += c & 0xff;
  }
  const n = colors.length;
  return ((Math.round(r / n) & 0xff) << 16) |
         ((Math.round(g / n) & 0xff) << 8)  |
          (Math.round(b / n) & 0xff);
}

export class Game {
  /** @param {GameOpts} opts */
  constructor(opts) {
    if (!opts || !opts.rules) throw new Error('Game requires { rules }');
    if (!opts.bus) throw new Error('Game requires { bus }');

    this._rules    = opts.rules;
    this._bus      = opts.bus;
    this._side     = opts.side || 'player';
    // Dimensions — rules.dimensions takes precedence over opts so the
    // 3D rules pack (plan v2 §2.1) can declare a 10×20×10 footprint
    // without the host having to hard-code the numbers per mode. 2D
    // modes either omit `dimensions` or set DEPTH=1; in either case
    // _depth=1 keeps `_board[0][r][c]` equivalent to the legacy
    // `_board[r][c]` shape — backward compatible.
    const ruleDims = (this._rules && this._rules.dimensions) || null;
    this._cols     = (ruleDims && ruleDims.COLS  > 0) ? (ruleDims.COLS  | 0) : (opts.cols  || DEFAULT_COLS);
    this._rows     = (ruleDims && ruleDims.ROWS  > 0) ? (ruleDims.ROWS  | 0) : (opts.rows  || DEFAULT_ROWS);
    this._depth    = (ruleDims && ruleDims.DEPTH > 0) ? (ruleDims.DEPTH | 0) : (opts.depth || DEFAULT_DEPTH);
    // Piece library selector — 2D modes use `tetrominoes` (PIECES from
    // pieces.js); 3D mode uses `tetracubes` (the 8-piece polycube
    // library from experimental/3d/tetracubes.js). Reads the rules
    // pack's declaration first; opts.pieceSet is the test-side override.
    this._pieceSet = (this._rules && this._rules.pieceSet)
      ? this._rules.pieceSet
      : (opts.pieceSet || 'tetrominoes');
    // RNG default: seeded by Date.now() so a fresh Game without an
    // explicit `rng` is *reproducible from its seed* for replay/online
    // (§3.7 sub-phase 7f). Hosts that want a specific seed pass
    // `rng: createSeededRng(myMatchId)`. Hosts that genuinely want
    // non-determinism (legacy single-sim) pass `rng: Math.random`.
    //
    // Online versus (plan_online_versus.md) ALWAYS supplies an explicit
    // rng — the Date.now() fallback never runs in that mode, so it
    // doesn't compromise the determinism rule. Inline eslint-disable
    // because the new no-restricted-syntax rule below would otherwise
    // ban Date.now() throughout gameplay/.
    // eslint-disable-next-line no-restricted-syntax
    this._rng      = opts.rng || createSeededRng((Date.now() | 0) >>> 0);
    this._onEndRun = opts.onEndRun || null;

    // M5 spawn-delay window (plan §12.5). Tunable via opts so single-
    // player modes (which don't receive garbage anyway) and existing
    // tests can keep the legacy "drain immediately" semantic by passing
    // `garbageDelayMs: 0`. Production Versus uses the 800ms default.
    this._garbageDelayMs = (typeof opts.garbageDelayMs === 'number')
      ? Math.max(0, opts.garbageDelayMs | 0)
      : GARBAGE_DELAY_MS_DEFAULT;

    // Board: `_depth × _rows × _cols`. Outer index is the depth slice
    // (0 = front, _depth-1 = back); board[d][0] is the BOTTOM row at
    // that slice; cell stores piece color (hex int) or null. For 2D
    // modes _depth=1 so the layout collapses to a single 2D plane —
    // `_board[0][r][c]` is the only data, identical to the legacy
    // `_board[r][c]` shape from before §2.1. The `board` getter
    // exposes that 2D plane to existing 2D consumers (main.js,
    // bot-controller.js); 3D-aware consumers read `boardLayers`
    // instead.
    this._board = Array.from({ length: this._depth }, () =>
      Array.from({ length: this._rows }, () => Array(this._cols).fill(null))
    );

    this._activePiece = null;
    this._nextQueue   = [];
    this._holdPiece   = null;
    this._canHold     = true;

    this._score    = 0;
    this._lines    = 0;
    this._level    = 1;
    this._gameOver = false;
    this._paused   = false;
    this._endRunCalled = false; // single-shot guard for _onEndRun

    this._fallTimer    = 0;
    this._modeTimeMs   = 0;
    // Cosmetic-only — display "session length" in HUD. Never read by
    // any rule / event / lock / clear path. Default 0 (deterministic);
    // hosts that want the wall-clock UI pass `nowMs: Date.now()`.
    this._sessionStart = (opts.nowMs | 0) || 0;
    this._piecesThisSession = 0;
    this._linesThisSession  = 0;

    /** @type {Array<{rows:number, holeColumn:number, readyAt:number}>} */
    this._garbageQueue = [];
    this._garbageBlocked = false;

    // Modern-rules state (plan_gameplay_1.md §12.3). `_lastAction` records
    // what the player just did so T-spin detection (M2) can answer "was
    // the last successful action a rotation?" at lock time. `_lastKickIndex`
    // (0..4, -1 = none/spawn) records which SRS kick test fit; T-spin Mini
    // detection uses kick index ≥ 3 as a "hard kick" signal.
    this._lastAction    = null; // 'rotation' | 'move' | 'drop' | null
    this._lastKickIndex = -1;

    // Back-to-Back counter (plan §12 M3). Tracks consecutive "difficult"
    // clears (Tetris OR T-spin-with-clear). Increments at the END of
    // clearLines for difficult clears; resets to 0 on plain 1/2/3-line
    // clears. The 1.5× score multiplier applies when the chain is
    // already active at the START of a clear (i.e. _b2b > 0 BEFORE
    // increment) — the first difficult clear of a chain doesn't get
    // the multiplier, only continuations do.
    this._b2b = 0;

    // Modern combo counter (plan §12 M4). Lifted from the versus rules
    // pack into Game so non-versus modes can also score combos. Counts
    // consecutive locks-with-clear (any size — single/double/triple/
    // tetris all extend). Increments at the START of clearLines (since
    // clearLines is only called when rows.length > 0), and resets to 0
    // on a non-clear lock in lockPiece. The garbage table is indexed by
    // `_combo - 1` (the "combo step" — 0 for first clear of a streak).
    this._combo = 0;

    // Modern-rules per-run accumulators (plan §13 next-moves item 2).
    // Tallied during the run; consumed by `gameplay/end-of-run.js` to
    // write per-mode bests. All counts are PER-RUN — reset on `reset()`
    // and on a fresh `Game` construction.
    //
    //   tspinSingles / tspinDoubles / tspinTriples : count of regular
    //     T-spin clears at each row count (no T-spin Triples Mini —
    //     mini multiline doesn't exist in the guideline).
    //   tspinMinis    : count of Mini-classified T-spins (any cleared).
    //   perfectClears : count of board-empty clears.
    //   maxB2b        : highest `_b2b` value reached during the run.
    //   maxCombo      : highest `_combo` value reached during the run.
    //   garbageCancelled : sum of cancellation amounts (Versus only;
    //     other modes never receive garbage so the field stays 0).
    this._runStats = {
      tspinSingles:     0,
      tspinDoubles:     0,
      tspinTriples:     0,
      tspinMinis:       0,
      perfectClears:    0,
      maxB2b:           0,
      maxCombo:         0,
      garbageCancelled: 0,
    };

    // Subscribe to inbound garbage. v1 single-bus: bot's emission lands
    // here. v2 dual-sim: per-game bus + host bridge calls applyGarbage()
    // directly, but this subscription remains harmless (no other emitters).
    this._unsubGarbage = this._bus.on(EVENTS.GARBAGE_RECEIVED, (e) => {
      if (!e || typeof e.rows !== 'number' || e.rows <= 0) return;
      this.applyGarbage(e.rows, e.holeColumn);
    });

    // M5 cancellation broker. Versus's onLinesCleared emits
    // GARBAGE_OUTGOING (raw amount, pre-cancellation). Game intercepts
    // here, cancels front-first against the inbound queue, and
    // re-emits the net amount as GARBAGE_SENT.
    this._unsubOutgoing = this._bus.on(EVENTS.GARBAGE_OUTGOING, (e) => {
      if (!e || typeof e.rows !== 'number' || e.rows <= 0) return;
      this._processOutgoingGarbage(e.rows | 0, e.target || 'opponent');
    });
  }

  // ─── Public read-only accessors ──────────────────────────────────────

  get rules()             { return this._rules; }
  get bus()               { return this._bus; }
  get side()              { return this._side; }
  get cols()              { return this._cols; }
  get rows()              { return this._rows; }
  get depth()             { return this._depth; }
  get pieceSet()          { return this._pieceSet; }
  /**
   * 2D-compatible board accessor. Returns the front depth-slice as a
   * `_rows × _cols` array of cell colors (or `null`). For 2D modes this
   * is the entire board; for 3D modes it's just the front layer (z=0)
   * — 3D-aware consumers should use `boardLayers` instead.
   */
  get board()             { return this._board[0]; }
  /**
   * Full 3D board: `_depth` slices each `_rows × _cols`. Identical
   * shape across 2D + 3D modes (2D = single-element outer array). The
   * 3D mode's renderer reads this for a per-z mesh registry.
   */
  get boardLayers()       { return this._board; }
  get activePiece()       { return this._activePiece; }
  get nextQueue()         { return this._nextQueue; }
  get holdPiece()         { return this._holdPiece; }
  get canHold()           { return this._canHold; }
  get score()             { return this._score; }
  get lines()             { return this._lines; }
  get level()             { return this._level; }
  get gameOver()          { return this._gameOver; }
  get paused()            { return this._paused; }
  get fallTimer()         { return this._fallTimer; }
  get modeTimeMs()        { return this._modeTimeMs; }
  get sessionStart()      { return this._sessionStart; }
  get piecesThisSession() { return this._piecesThisSession; }
  get linesThisSession()  { return this._linesThisSession; }
  get garbageQueue()      { return this._garbageQueue; }
  get garbageBlocked()    { return this._garbageBlocked; }
  get queuedGarbageRows() {
    let total = 0;
    for (const e of this._garbageQueue) total += e.rows;
    return total;
  }

  /**
   * Read-only snapshot of the modern-rules per-run accumulators
   * (plan §13 next-moves item 2). Consumed by end-of-run.js to write
   * per-mode bests. Returns a fresh object so callers can't mutate the
   * internal counters.
   */
  getRunStats() {
    return { ...this._runStats };
  }

  // ─── State snapshots ─────────────────────────────────────────────────

  /**
   * Minimal state shape consumed by the rules engine (plan_gameplay_1 §2.1).
   * `b2b` is the chain counter at the time of the snapshot — read by
   * versus.onLinesCleared (plan §12 M3) to add +1 garbage when a
   * difficult clear extends an active chain.
   */
  getStateSnapshot() {
    return {
      score:        this._score,
      lines:        this._lines,
      level:        this._level,
      linesCleared: this._lines,
      timeMs:       this._modeTimeMs,
      b2b:          this._b2b,
      combo:        this._combo,
    };
  }

  /**
   * Full frozen snapshot for views/HUDs. Per §3.7.3.
   */
  snapshot() {
    // 2D-compatible snapshot — exposes the front depth-slice as
    // `board` for legacy 2D consumers (HUD, replay viewer). 3D-aware
    // consumers read `boardLayers` for the full `_depth × _rows × _cols`
    // structure. For 2D modes the two are the same data.
    return Object.freeze({
      side:     this._side,
      board:    this._board[0].map(row => Object.freeze([...row])),
      boardLayers: Object.freeze(
        this._board.map(layer => Object.freeze(layer.map(row => Object.freeze([...row]))))
      ),
      depth:    this._depth,
      active:   this._activePiece ? Object.freeze({ ...this._activePiece }) : null,
      next:     [...this._nextQueue],
      hold:     this._holdPiece,
      score:    this._score,
      lines:    this._lines,
      level:    this._level,
      modeView: this._rules.initialModeView || null,
      gameOver: this._gameOver,
      paused:   this._paused,
    });
  }

  // ─── Bag randomizer ──────────────────────────────────────────────────

  refillBag() {
    // Bag contents pivot on the active piece library: 7-bag for 2D
    // tetrominoes, 8-bag for 3D tetracubes. Fisher-Yates shuffle is
    // identical for both.
    const bag = (this._pieceSet === 'tetracubes')
      ? [...TETRACUBE_KEYS]
      : [...PIECE_KEYS];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this._rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this._nextQueue.push(...bag);
  }

  nextPieceKey() {
    if (this._nextQueue.length < 4) this.refillBag();
    return this._nextQueue.shift();
  }

  // ─── Piece geometry ──────────────────────────────────────────────────

  /**
   * Cells occupied by `piece` at rotation `rot`. Returns `{col, row, depth}`
   * triples in board space — `depth` is always 0 in 2D modes (so existing
   * 2D consumers can ignore the field) and 0..DEPTH-1 in 3D mode.
   *
   * 2D path mirrors the legacy main.js geometry: top-down 4×4 shape rows
   * flipped to bottom-origin board rows.
   *
   * 3D path reads sparse `[x,y,z]` cells from the tetracube definition,
   * applies the piece's rotation (an `orientations[]` index — see
   * §2.1 Phase D for full kick-table integration), and offsets by
   * `piece.col / piece.row / piece.depth`.
   */
  getPieceCells(piece, rot = piece.rot) {
    if (this._pieceSet === 'tetracubes') {
      // 3D path. piece.key indexes TETRACUBES; piece.cells (cached on
      // the piece at spawn time, oriented for the current rotation
      // state) is the per-rotation cell list. For Phase B without the
      // 3D kick table (Phase D), we just read the base orientation.
      const tc = TETRACUBES[piece.key];
      if (!tc) return [];
      const baseCells = piece.cells || tc.cells;
      const out = [];
      for (const [x, y, z] of baseCells) {
        out.push({
          col:   piece.col   + x,
          row:   piece.row   + y,
          depth: (piece.depth | 0) + z,
        });
      }
      return out;
    }
    // 2D path — `depth: 0` so callers that branch on the field don't
    // have to special-case 2D.
    const shape = PIECES[piece.key][rot];
    const cells = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (shape[r][c]) {
          cells.push({ col: piece.col + c, row: piece.row + (3 - r), depth: 0 });
        }
      }
    }
    return cells;
  }

  /**
   * True when `piece` at (col,row,rot) intersects walls/floor/stack.
   * Cells above the visible top (row >= ROWS) are allowed (so a tall piece
   * can pivot at the spawn row); only sub-floor and stack collisions count.
   */
  collides(piece, col, row, rot) {
    const test = { ...piece, col, row, rot };
    const cells = this.getPieceCells(test, rot);
    const ROWS = this._rows;
    const COLS = this._cols;
    const DEPTH = this._depth;
    for (const { col: c, row: r, depth: d } of cells) {
      if (c < 0 || c >= COLS) return true;
      if (r < 0) return true;
      // 3D bounds — out-of-range Z cells are a wall hit. For 2D the
      // tetromino cells already report depth=0 so this is a no-op.
      if (d < 0 || d >= DEPTH) return true;
      if (r >= ROWS + 4) continue;
      if (r < ROWS && this._board[d][r][c]) return true;
    }
    return false;
  }

  // ─── Spawn / topout ──────────────────────────────────────────────────

  /**
   * Spawn the next piece. If `forcedKey` is given, use that key (used by
   * holdActive's swap path); otherwise pull from the bag. On collision
   * with the existing stack, the rules pack's `onTopOut` hook is consulted
   * for a possible rescue (Zen returns `{ end:false, shift:4 }`); if the
   * rescue declines or fails, the run ends via `_onEndRun({reason:'topout'})`.
   */
  spawnPiece(forcedKey) {
    const is3D = this._pieceSet === 'tetracubes';
    const key = forcedKey || this.nextPieceKey();
    // Spawn position — 2D modes drop pieces in the top-center column;
    // 3D mode drops them in the top-center of the 10×10 footprint and
    // at depth = floor(DEPTH / 2) so the player has equal slack on
    // each side of the well to nudge forward / backward (once the
    // 3D-axis input layer ships in §2.1 Phase D).
    const p = is3D
      ? {
          key,
          rot:   0,
          col:   Math.max(0, ((this._cols - 2) >> 1) | 0),
          row:   this._rows - 2,
          depth: ((this._depth - 2) >> 1) | 0,
          // Cache the rotated cell list on the piece so getPieceCells
          // doesn't need to re-walk the rotation table per call.
          // Phase B uses the base orientation; Phase D plugs in the
          // 24-rotation enumerator from experimental/3d/rotation.js.
          cells: TETRACUBES[key]?.cells || [],
        }
      : {
          key,
          rot: 0,
          col: 3,
          row: this._rows - 2,
        };
    p.color = is3D ? TETRACUBE_COLORS[key] : PIECE_COLORS[key];
    if (this.collides(p, p.col, p.row, p.rot)) {
      if (this._handleTopOutWithRescue(p)) return;
      this._signalEndRun({ reason: 'topout' });
      return;
    }
    this._commitSpawn(p);
  }

  _commitSpawn(p) {
    this._piecesThisSession++;
    this._activePiece = p;
    this._canHold = true;
    // Fresh piece — reset the "last action" tracking. T-spin detection
    // requires the most recent action to have been a rotation; on spawn
    // there is no prior action.
    this._lastAction    = null;
    this._lastKickIndex = -1;
    this._bus.emit(EVENTS.PIECE_SPAWN, {
      key: p.key, color: p.color, rotation: p.rot, side: this._side,
    });
  }

  /**
   * Zen rescue path. Returns true when the rules pack opted in to a stack
   * shift AND the retry spawn succeeded; false otherwise (caller falls
   * through to topout).
   */
  _handleTopOutWithRescue(originalPiece) {
    const onTopOutFn = this._rules.onTopOut;
    if (!onTopOutFn) return false;
    let result = null;
    try { result = onTopOutFn(this.getStateSnapshot()); }
    catch (err) { console.warn('[rules] onTopOut threw:', err); return false; }
    if (!result || result.end !== false) return false;
    const shift = (typeof result.shift === 'number') ? Math.max(0, Math.floor(result.shift)) : 0;
    if (shift <= 0) return false;

    this.shiftStackDown(shift);
    this._bus.emit(EVENTS.ZEN_RESCUE, { rowsRemoved: shift, side: this._side });

    const p2 = { ...originalPiece, row: this._rows - 2 };
    if (this.collides(p2, p2.col, p2.row, p2.rot)) return false;
    this._commitSpawn(p2);
    return true;
  }

  /**
   * Remove `n` rows from the bottom of the stack and shift the rest down.
   * Used by Zen's topout-rescue path. Pathologically safe — n > stack
   * height clears all populated rows and leaves the board empty.
   *
   * Pure board op: render-side mesh management lives in the host (or in
   * BoardView, post-7b).
   */
  shiftStackDown(rows) {
    if (!Number.isFinite(rows) || rows <= 0) return;
    const n = Math.min(rows | 0, this._rows);
    // Apply per depth slice so the 3D mode's same-rescue semantics
    // shift every (col, depth) at the bottom row out together. For 2D
    // the outer loop runs once.
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < this._depth; d++) {
        this._board[d].splice(0, 1);
        this._board[d].push(Array(this._cols).fill(null));
      }
    }
  }

  // ─── Movement / rotation ─────────────────────────────────────────────

  /**
   * Move the active piece by (dCol, dRow). Returns true on success. Emits
   * PIECE_MOVE on every successful move so the host can rebuild the
   * piece + ghost mesh from one subscriber instead of duplicating the
   * rebuild call after every wrapper. The host filters on `dCol !== 0`
   * to play sfx (silent on gravity / soft drop / hard drop).
   *
   * Sets `_lastAction = 'move'` on success so T-spin detection (M2) can
   * tell that the last successful action was not a rotation.
   */
  tryMove(dCol, dRow, dDepth = 0) {
    if (!this._activePiece || this._gameOver || this._paused) return false;
    const nc = this._activePiece.col + dCol;
    const nr = this._activePiece.row + dRow;
    // Depth movement is meaningful only in 3D mode. For 2D pieces
    // dDepth is ignored (piece.depth stays undefined → defaults to 0
    // in collides / getPieceCells).
    const ndOriginal = (this._activePiece.depth | 0);
    const nd = ndOriginal + (dDepth | 0);
    // Probe collision with the candidate pose. We pass a shallow clone
    // so collides reads the test depth; the live piece is only mutated
    // after the probe succeeds.
    const candidate = { ...this._activePiece, depth: nd };
    if (this.collides(candidate, nc, nr, this._activePiece.rot)) return false;
    this._activePiece.col = nc;
    this._activePiece.row = nr;
    if (dDepth !== 0) this._activePiece.depth = nd;
    this._lastAction = 'move';
    this._bus.emit(EVENTS.PIECE_MOVE, { dCol, dRow, dDepth, side: this._side });
    return true;
  }

  /**
   * Rotate the active piece.
   *
   * 2D mode (`pieceSet === 'tetrominoes'`): `dir` is +1 (CW) or -1 (CCW)
   * around the screen-perpendicular Z axis. Tries each SRS kick offset
   * for the (fromRot, toRot) pair in order; first non-colliding offset
   * wins. Returns `{ rotated, kicked, kickIndex }` — `kickIndex` is 0..4
   * (the SRS test index that fit; 0 = no kick).
   *
   * 3D mode (`pieceSet === 'tetracubes'`): `axis` selects the rotation
   * axis ('x' / 'y' / 'z'); `dir` is +1 / -1 (right-handed CCW around
   * +axis). Cells are rotated via `experimental/3d/rotation.js` and
   * re-normalized so the piece's bounding box stays origin-anchored.
   * No kick table for Phase D — a colliding rotation simply fails
   * (legacy "tap rotate" feel). The 6-face + 12-edge kick table from
   * archived §6.4 is a Phase D-2 follow-up.
   *
   * On success, emits PIECE_ROTATE and updates `_lastAction = 'rotation'`
   * + `_lastKickIndex`.
   *
   * @param {number} dir   ±1
   * @param {'x'|'y'|'z'} [axis='z']  3D mode only; ignored in 2D
   */
  tryRotate(dir, axis = 'z') {
    if (!this._activePiece || this._gameOver || this._paused) {
      return { rotated: false, kicked: 0, kickIndex: -1 };
    }
    if (this._pieceSet === 'tetracubes') {
      return this._tryRotate3D(dir, axis);
    }
    const fromRot = this._activePiece.rot;
    const nrot    = nextRotation(fromRot, dir);
    const offsets = getKickOffsets(this._activePiece.key, fromRot, nrot);
    for (let i = 0; i < offsets.length; i++) {
      const { dCol, dRow } = offsets[i];
      const nc = this._activePiece.col + dCol;
      const nr = this._activePiece.row + dRow;
      if (!this.collides(this._activePiece, nc, nr, nrot)) {
        this._activePiece.col = nc;
        this._activePiece.row = nr;
        this._activePiece.rot = nrot;
        this._lastAction    = 'rotation';
        this._lastKickIndex = i;
        this._bus.emit(EVENTS.PIECE_ROTATE, {
          rotation:  nrot,
          dir,
          kicked:    i !== 0,
          kickIndex: i,
          dCol,
          dRow,
          side:      this._side,
        });
        return { rotated: true, kicked: i, kickIndex: i };
      }
    }
    return { rotated: false, kicked: 0, kickIndex: -1 };
  }

  /**
   * 3D rotation (plan v2 §2.1 Phase D + D-2). Applies one 90° rotation
   * around the requested axis to the active piece's cached cells,
   * normalizes the result, and walks the 19-test kick table from
   * `experimental/3d/kicks.js` (identity + 6 face + 12 edge offsets,
   * axis-biased so in-plane shifts come first). The first non-
   * colliding (col+dx, row+dy, depth+dz) wins — matches the 2D SRS
   * "first kick that fits" semantics. `kickIndex` 0 = no kick;
   * 1..6 = face; 7..18 = edge.
   *
   * @param {number} dir   ±1 (right-handed: positive = CCW around +axis)
   * @param {'x'|'y'|'z'} axis
   */
  _tryRotate3D(dir, axis) {
    const piece = this._activePiece;
    const cells = piece.cells || (TETRACUBES[piece.key] && TETRACUBES[piece.key].cells) || [];
    if (cells.length === 0) return { rotated: false, kicked: 0, kickIndex: -1 };

    // Choose rotation primitive. The `rotate3D*` family does a single
    // CCW 90° turn; for `dir = -1` we compose three CCW turns (== one
    // CW). Cheap enough — 4 cells × at most 3 calls.
    const rotOnce = axis === 'x' ? rotate3DX
                  : axis === 'y' ? rotate3DY
                  : rotate3DZ;
    let rotated = cells;
    const turns = (dir > 0) ? 1 : 3;
    for (let i = 0; i < turns; i++) rotated = rotOnce(rotated);
    rotated = normalize3D(rotated);

    // Walk the kick table. Each test offsets the candidate's
    // (col, row, depth) by (dx, dy, dz). Identity (kickIndex=0) is
    // always the first test, so a rotation that already fits passes
    // through immediately with no observable shift.
    const kicks = getKicks3D(axis);
    const baseDepth = (piece.depth | 0);
    for (let i = 0; i < kicks.length; i++) {
      const { dx, dy, dz } = kicks[i];
      const nc = piece.col + dx;
      const nr = piece.row + dy;
      const nd = baseDepth + dz;
      const candidate = { ...piece, cells: rotated, depth: nd };
      if (!this.collides(candidate, nc, nr, piece.rot)) {
        piece.cells = rotated;
        piece.col   = nc;
        piece.row   = nr;
        piece.depth = nd;
        this._lastAction    = 'rotation';
        this._lastKickIndex = i;
        this._bus.emit(EVENTS.PIECE_ROTATE, {
          rotation: piece.rot, // 2D rot index unused in 3D — reported for shape parity
          dir,
          axis,
          kicked:    i !== 0,
          kickIndex: i,
          dx, dy, dz,
          side: this._side,
        });
        return { rotated: true, kicked: i, kickIndex: i };
      }
    }
    // Every kick collided — rotation rejected.
    return { rotated: false, kicked: 0, kickIndex: -1 };
  }

  // ─── Drops ───────────────────────────────────────────────────────────

  /**
   * One soft-drop tick. If the piece can fall, +softDropPerCell points;
   * otherwise it locks. Emits SCORE_DELTA on success.
   *
   * Soft drop overrides `_lastAction` to 'drop' (the underlying tryMove
   * sets 'move' first; this re-tags it as a drop so T-spin detection
   * can tell a player-driven downward step apart from a horizontal nudge).
   */
  softDrop() {
    if (!this._activePiece || this._gameOver || this._paused) return;
    if (!this.tryMove(0, -1)) {
      this.lockPiece();
      return;
    }
    this._lastAction = 'drop';
    const delta = this._rules.softDropPerCell;
    this._score += delta;
    this._bus.emit(EVENTS.SCORE_DELTA, {
      delta, total: this._score, source: 'soft-drop', side: this._side,
    });
  }

  /**
   * Hard drop — descend until floor/stack, score `dropped *
   * hardDropPerCell`, then return piece-space data so the host can
   * compute world-space ring coordinates and emit HARD_DROP *before*
   * the lock cascade fires. The host is expected to call
   * `lockPiece()` immediately after emitting HARD_DROP.
   *
   * Returns `{ dropRows, cells, minRow, color }`.
   *
   * Splitting the lock from the drop preserves the legacy ordering
   * (impact ring → lock visuals → line clear) that vfx subscribers
   * rely on, and makes the contract explicit: Game scored + dropped;
   * the host is responsible for the visual sequencing + the lock.
   */
  hardDrop() {
    if (!this._activePiece || this._gameOver || this._paused) return null;
    let dropped = 0;
    while (this.tryMove(0, -1)) dropped++;
    if (!this._activePiece) return null;
    // Hard drop overrides the trailing `_lastAction = 'move'` from the
    // tryMove loop above so T-spin detection sees a "drop", not a "move".
    this._lastAction = 'drop';

    const cells = this.getPieceCells(this._activePiece);
    let minRow = Infinity;
    for (const cell of cells) if (cell.row < minRow) minRow = cell.row;
    const color = this._activePiece.color;
    const summary = {
      dropRows: dropped,
      // Carry depth so the host's HARD_DROP impact ring + sparks land at
      // the piece's actual depth in 3D mode (otherwise they default to
      // z=0 — the well's center — and the visual decouples from where
      // the piece actually settled). 2D pieces report depth=0 uniformly
      // so this is invisible there.
      cells: cells.map(({ col, row, depth }) => ({ col, row, depth: depth | 0 })),
      minRow,
      color,
    };

    const delta = dropped * this._rules.hardDropPerCell;
    this._score += delta;
    this._bus.emit(EVENTS.SCORE_DELTA, {
      delta, total: this._score, source: 'hard-drop', side: this._side,
    });

    return summary;
  }

  // ─── Lock & line clear ───────────────────────────────────────────────

  lockPiece() {
    if (!this._activePiece) return;
    const cells = this.getPieceCells(this._activePiece);
    const lockColor = this._activePiece.color;

    // Topout pre-check — separated from the write loop so a topout
    // doesn't leave a half-written piece in the board (the prior
    // implementation wrote some cells then bailed mid-iteration).
    for (const { row } of cells) {
      if (row >= this._rows) {
        this._signalEndRun({ reason: 'topout' });
        return;
      }
    }

    // T-spin classification — performed BEFORE the piece's cells are
    // written so the corner check sees the board state at lock time.
    // Returns 'none' / 'tspin' / 'mini'. (See gameplay/t-spin.js.)
    // T-spin only applies to 2D play (the 3D rules pack opts out via
    // `goalMultiplier: 1.0` per file header), so we pass the front
    // depth-slice to keep the 2D detector's expected shape — for 3D
    // tetracubes the piece key isn't 'T' anyway and detectTSpin returns
    // 'none' immediately.
    const tspinKind = detectTSpin(
      this._activePiece, this._board[0],
      this._lastAction, this._lastKickIndex,
      this._cols, this._rows,
    );

    for (const { col, row, depth } of cells) {
      this._board[depth | 0][row][col] = lockColor;
    }

    // Count full rows / layers BEFORE emitting so the host's PIECE_LOCK
    // subscriber can route to announceLineClear vs noteNoClearLock
    // without waiting for LINE_CLEAR to (or not to) follow. 2D = full
    // row at z=0; 3D = full Y-slab where every (col, depth) is filled.
    const fullRows = this._collectFullRows();

    this._bus.emit(EVENTS.PIECE_LOCK, {
      cells: cells.map(({ col, row, depth }) => ({ col, row, depth: depth | 0 })),
      color:     lockColor,
      side:      this._side,
      cleared:   fullRows.length,
      tspinKind, // 'none' / 'tspin' / 'mini' — host HUD reads this
    });

    // T-spin event + bonus score for the no-clear case. When lines are
    // cleared, the score is paid via clearLines (which threads `tspinKind`
    // through to rules.lineScore so the T-spin table is used).
    if (tspinKind !== 'none') {
      const tspinScore = this._rules.lineScore(fullRows.length, this._level, tspinKind);
      this._bus.emit(EVENTS.T_SPIN, {
        kind:    tspinKind,
        cleared: fullRows.length,
        score:   tspinScore,
        side:    this._side,
      });
      // Per-run stats (plan §13 #2). Mini and regular T-spins each get
      // their own bucket; regular splits by row count for the HUD's
      // "T-spin Single / Double / Triple" scoreboard. No-clear T-spins
      // count as well — they're a real technique, just no row reward.
      if (tspinKind === 'mini') {
        this._runStats.tspinMinis += 1;
      } else {
        if      (fullRows.length === 1) this._runStats.tspinSingles += 1;
        else if (fullRows.length === 2) this._runStats.tspinDoubles += 1;
        else if (fullRows.length === 3) this._runStats.tspinTriples += 1;
        // 0-clear regular T-spins are tracked via the score bonus only;
        // they don't fit the Single/Double/Triple buckets.
      }
      if (fullRows.length === 0 && tspinScore > 0) {
        this._score += tspinScore;
        this._bus.emit(EVENTS.SCORE_DELTA, {
          delta: tspinScore, total: this._score, source: 'line-clear', side: this._side,
        });
      }
    }

    if (fullRows.length > 0) {
      this.clearLines(fullRows, tspinKind);
    } else {
      // No-clear lock breaks the combo streak (plan §12 M4). Emit
      // COMBO_END so HUDs can flash the broken streak; gates on
      // `_combo > 0` so a series of no-clear locks doesn't spam.
      if (this._combo > 0) {
        this._bus.emit(EVENTS.COMBO_END, { count: this._combo, side: this._side });
        this._combo = 0;
      }
    }

    // 3D stack-overflow topout (plan v2 §2.1). 2D modes catch topout
    // via spawnPiece's collision check at (col=3, row=18) — the spawn
    // necessarily intersects any tall stack. 3D mode spawns at the
    // well's center depth, so an asymmetric tower built only at the
    // front (or back) face never reaches the spawn position; the
    // player would otherwise stack indefinitely. Run AFTER any clear
    // so a layer that fills + clears in the same lock doesn't false-
    // positive.
    if (this._depth > 1 && this._stackOverflowed()) {
      this._signalEndRun({ reason: 'topout' });
      return;
    }

    // Garbage application — between piece locks, after any clears resolve.
    this._drainInboundGarbage();

    this.spawnPiece();
  }

  /**
   * 3D stack-overflow predicate — `true` when ANY (col, depth) at the
   * topmost playable row contains a cube. Used by `lockPiece` for the
   * 3D topout that the per-piece spawn-collision check can miss
   * (asymmetric stacks that don't reach the spawn's center depth).
   * 2D modes don't call this — the spawn check is sufficient there.
   */
  _stackOverflowed() {
    const topRow = this._rows - 1;
    for (let d = 0; d < this._depth; d++) {
      const row = this._board[d][topRow];
      for (let c = 0; c < this._cols; c++) {
        if (row[c] !== null) return true;
      }
    }
    return false;
  }

  /**
   * Find every row that's "full" — meaning a candidate for line / layer
   * clear. The condition depends on dimensionality:
   *
   *   - 2D (`_depth === 1`): every cell in the row is non-null. The
   *     classic Tetris row-clear condition.
   *   - 3D (`_depth > 1`): the row's **projection onto the XY plane**
   *     is full — for every column `c`, AT LEAST ONE depth slice has
   *     a cube at (c, row). The 100-cube "every (col, depth) filled"
   *     rule from archived §6.5 was deemed too strict in playtest
   *     (most tetracubes are flat at z=0, so reaching 100 cubes per
   *     layer takes ~25 piece placements). Projection-based clearing
   *     keeps the "3D well, layer payoff" feel — clears still vacate
   *     all 100 positions at row Y and the layers above settle by 1
   *     — while letting players reach a clear in roughly the same
   *     piece count as 2D Tetris (10 cubes covering 10 columns
   *     suffices, even if they're scattered across z-slices).
   *
   * Returns ascending row indices.
   *
   * @returns {number[]}
   */
  _collectFullRows() {
    const rows = [];
    if (this._depth === 1) {
      const layer = this._board[0];
      for (let r = 0; r < this._rows; r++) {
        if (layer[r].every(c => c !== null)) rows.push(r);
      }
      return rows;
    }
    // 3D projection rule — for every column, at least one depth slice
    // at row Y has a cube. Short-circuits on the first uncovered
    // column (an "empty pillar" through the depth axis).
    rowLoop:
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        let columnCovered = false;
        for (let d = 0; d < this._depth; d++) {
          if (this._board[d][r][c] !== null) {
            columnCovered = true;
            break;
          }
        }
        if (!columnCovered) continue rowLoop; // empty pillar — not full
      }
      rows.push(r);
    }
    return rows;
  }

  /**
   * Clear `rows` (board-space row indices), shift remaining stack down,
   * update score/lines/level, emit LINE_CLEAR/LEVEL_UP/SCORE_DELTA.
   * `rows` may arrive in any order — sorted top-down internally.
   *
   * Modern-rules wiring (plan §12 M3):
   *   - "Difficult" clears (Tetris OR T-spin-with-clear) extend the
   *     B2B chain. A 1.5× score multiplier applies when a difficult
   *     clear EXTENDS an already-active chain (i.e. `_b2b > 0` BEFORE
   *     the increment).
   *   - "Perfect Clear" — when this clear empties the board entirely —
   *     adds a flat per-clear-type bonus to the score. Detection is
   *     done BEFORE the rows are spliced (the rows about to disappear
   *     are the only filled rows; everything else is already empty).
   *   - The plain rules.onLinesCleared hook gets a 3rd `info` argument
   *     describing this clear's modern-rules classification (clearType,
   *     isB2B, isPerfectClear) so versus.js can compose +1 / +10
   *     garbage atop the standard table.
   */
  clearLines(rowsArg, clearType = 'normal') {
    const rows = rowsArg.slice().sort((a, b) => b - a);

    // Combo step (plan §12 M4). `_combo` tracks consecutive
    // locks-with-clear; increment at the START so the count reflects
    // "this is the Nth consecutive clear" by the time we score and
    // emit. The "combo step" used for the garbage table is `_combo - 1`
    // (zero-indexed: the first clear of a streak has combo=1, step=0).
    const wasFirstOfStreak = this._combo === 0;
    this._combo += 1;
    if (wasFirstOfStreak) {
      this._bus.emit(EVENTS.COMBO_START, { count: this._combo, side: this._side });
    }

    // Difficult-clear classification (M3). Tetris (4-line) OR any
    // T-spin-with-clear is "difficult"; plain 1/2/3 clears are not.
    const isDifficult = (rows.length === 4)
      || (clearType === 'tspin' || clearType === 'mini');
    // B2B chain continuation requires the chain to already be active
    // BEFORE this clear (so the FIRST difficult clear of a chain
    // doesn't get the multiplier — only continuations do).
    const isB2B = isDifficult && this._b2b > 0;

    // Perfect Clear pre-check — before the splice removes the cleared
    // rows. The board "will be" perfectly clear iff every row at every
    // depth slice is either (a) one of the rows about to be removed,
    // or (b) already empty. For 2D modes _depth=1 and the outer loop
    // is a no-op (single iteration).
    const clearedRowSet = new Set(rows);
    let isPerfectClear = true;
    pcCheck:
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        if (clearedRowSet.has(r)) continue;
        for (const cell of this._board[d][r]) {
          if (cell !== null) { isPerfectClear = false; break pcCheck; }
        }
      }
    }

    // Score: base + B2B 1.5× + Perfect Clear bonus + combo bonus.
    let scoreDelta = this._rules.lineScore(rows.length, this._level, clearType);
    if (isB2B) scoreDelta = Math.floor(scoreDelta * 1.5);
    const pcBonus = isPerfectClear ? perfectClearBonus(rows.length, this._level) : 0;
    scoreDelta += pcBonus;
    // Combo score bonus (plan §12 M4): +50 × (combo step) × level.
    // The first clear of a streak has step 0 → no combo bonus; second
    // gets +50 × level; third +100 × level; etc.
    if (this._combo > 1) {
      scoreDelta += 50 * (this._combo - 1) * this._level;
    }

    this._score += scoreDelta;
    this._lines += rows.length;
    this._linesThisSession += rows.length;

    this._bus.emit(EVENTS.SCORE_DELTA, {
      delta: scoreDelta, total: this._score, source: 'line-clear', side: this._side,
    });

    // Rules hook — pass clearType + B2B/PC flags so versus can compose
    // outgoing garbage. State snapshot also carries the pre-update b2b
    // value (read from `state.b2b`).
    if (this._rules.onLinesCleared) {
      try {
        this._rules.onLinesCleared(this.getStateSnapshot(), rows.length, {
          clearType, isB2B, isPerfectClear,
        });
      } catch (err) { console.warn('[rules] onLinesCleared threw:', err); }
    }

    // Update B2B counter AFTER scoring + onLinesCleared, BEFORE the
    // LINE_CLEAR event so subscribers see the post-update value.
    if (isDifficult) {
      this._b2b += 1;
      this._bus.emit(EVENTS.B2B_CHAIN, { count: this._b2b, side: this._side });
    } else {
      if (this._b2b > 0) {
        this._bus.emit(EVENTS.B2B_BREAK, { side: this._side });
      }
      this._b2b = 0;
    }

    // Per-run stats high-water marks (plan §13 #2).
    if (this._b2b   > this._runStats.maxB2b)   this._runStats.maxB2b   = this._b2b;
    if (this._combo > this._runStats.maxCombo) this._runStats.maxCombo = this._combo;

    const newLevel = this._rules.levelForLines(this._lines);
    if (newLevel > this._level) {
      this._level = newLevel;
      this._bus.emit(EVENTS.LEVEL_UP, { level: newLevel, side: this._side });
    }

    // Layer color for the LINE_CLEAR event — 2D averages the row's
    // cells; 3D averages across all (col, depth) at the cleared Y.
    const rowColors = rows.map(r => avgLayerColor(this._board, r, this._depth));
    const overallColor = meanColor(rowColors);
    this._bus.emit(EVENTS.LINE_CLEAR, {
      rows: rows.slice(),
      simultaneous: rows.length,
      colors: rowColors.slice(),
      overallColor,
      scoreDelta,
      clearType,
      isB2B,
      isPerfectClear,
      side: this._side,
    });

    // Splice the cleared rows out of every depth slice + push a fresh
    // empty row at the top of each. For 2D the outer loop runs once.
    for (const r of rows) {
      for (let d = 0; d < this._depth; d++) {
        this._board[d].splice(r, 1);
        this._board[d].push(Array(this._cols).fill(null));
      }
    }

    // PERFECT_CLEAR fires AFTER splice — at this point the board is
    // fully empty. Carries the +10 garbage info; versus's
    // onLinesCleared has already composed the actual GARBAGE_SENT.
    if (isPerfectClear) {
      this._runStats.perfectClears += 1;
      this._bus.emit(EVENTS.PERFECT_CLEAR, {
        cleared: rows.length,
        score:   pcBonus,
        garbage: 10,
        side:    this._side,
      });
    }
  }

  // ─── Hold ────────────────────────────────────────────────────────────

  holdActive() {
    if (!this._activePiece || !this._canHold || this._gameOver || this._paused) return;
    const cur = this._activePiece.key;
    if (this._holdPiece) {
      const swap = this._holdPiece;
      this._holdPiece = cur;
      this.spawnPiece(swap);
    } else {
      this._holdPiece = cur;
      this.spawnPiece();
    }
    this._canHold = false;
  }

  // ─── Garbage ─────────────────────────────────────────────────────────

  /**
   * Queue inbound garbage. Called by the bus subscription (single-sim)
   * or directly by the dual-sim host's bridge (sub-phase 7e). Beyond
   * GARBAGE_QUEUE_CAP_ROWS the additional rows are dropped on the floor
   * and the `garbageBlocked` flag flips for the badge.
   *
   * M5 (plan §12.5): each entry is stamped with `readyAt` =
   * `_modeTimeMs + _garbageDelayMs`. `_drainInboundGarbage` skips
   * entries where `readyAt > _modeTimeMs`, giving the player a
   * cancellation window. `_modeTimeMs` is pause-aware (Game.tick
   * doesn't advance it while paused), so the delay window pauses too.
   */
  applyGarbage(rows, holeColumn) {
    const r = (typeof rows === 'number') ? (rows | 0) : 0;
    if (r <= 0) return;
    if (this.queuedGarbageRows + r > GARBAGE_QUEUE_CAP_ROWS) {
      this._garbageBlocked = true;
      return;
    }
    const safeHole = (typeof holeColumn === 'number')
      ? holeColumn
      : Math.floor(this._rng() * this._cols) % this._cols;
    this._garbageQueue.push({
      rows:    r,
      holeColumn: safeHole,
      readyAt: this._modeTimeMs + this._garbageDelayMs,
    });
  }

  /**
   * Drain "ready" entries from the front of the queue (those whose
   * `readyAt` has passed). Stops at the first not-ready entry — the
   * queue is FIFO so once we hit a not-ready entry, everything behind
   * it is also not-ready.
   */
  _drainInboundGarbage() {
    if (this._garbageQueue.length === 0) return;
    while (this._garbageQueue.length > 0) {
      const front = this._garbageQueue[0];
      if (front.readyAt > this._modeTimeMs) break;
      this._garbageQueue.shift();
      this._applyGarbageToBoard(front.rows, front.holeColumn);
    }
    if (this.queuedGarbageRows < GARBAGE_QUEUE_CAP_ROWS) {
      this._garbageBlocked = false;
    }
  }

  /**
   * M5 cancellation broker. Eats `requested` rows from the front of the
   * inbound queue (regardless of readyAt — even still-pending entries
   * count as cancellable until they drain). Emits `GARBAGE_CANCELLED`
   * for the eaten amount and `GARBAGE_SENT` for the net remainder.
   */
  _processOutgoingGarbage(requested, target) {
    let toCancel = requested;
    let cancelled = 0;
    while (toCancel > 0 && this._garbageQueue.length > 0) {
      const front = this._garbageQueue[0];
      if (front.rows <= toCancel) {
        cancelled += front.rows;
        toCancel  -= front.rows;
        this._garbageQueue.shift();
      } else {
        front.rows -= toCancel;
        cancelled  += toCancel;
        toCancel = 0;
      }
    }
    if (cancelled > 0) {
      this._runStats.garbageCancelled += cancelled;
      this._bus.emit(EVENTS.GARBAGE_CANCELLED, { rows: cancelled, side: this._side });
    }
    const remaining = requested - cancelled;
    if (remaining > 0) {
      this._bus.emit(EVENTS.GARBAGE_SENT, { rows: remaining, target });
    }
    if (this.queuedGarbageRows < GARBAGE_QUEUE_CAP_ROWS) {
      this._garbageBlocked = false;
    }
  }

  _applyGarbageToBoard(rows, holeColumn) {
    const COLS = this._cols;
    const safeHole = ((holeColumn % COLS) + COLS) % COLS;
    // Garbage applies as a full Y-slab — every depth slice gets a new
    // bottom row with the same hole column, so a 3D player still
    // navigates one shared hole even though the row spans the full
    // 10×10 footprint. For 2D the outer loop runs once.
    for (let i = 0; i < rows; i++) {
      for (let d = 0; d < this._depth; d++) {
        this._board[d].pop(); // drop the top row
        const newRow = new Array(COLS).fill(GARBAGE_COLOR);
        newRow[safeHole] = null;
        this._board[d].unshift(newRow);
      }
    }
    // Notify host so the BoardView can mirror the data-side mutation on
    // the mesh side (dispose top mesh row, build cubes for the new bottom
    // garbage row, animate remaining cubes upward).
    this._bus.emit(EVENTS.GARBAGE_APPLIED, {
      rows, holeColumn: safeHole, side: this._side,
    });
  }

  /**
   * Reassign the score externally — used by the host after applying a
   * goal multiplier in endRun. Game-internal scoring (soft/hard drop,
   * line clear) doesn't need this; it's strictly for post-run sync.
   */
  setScore(s) {
    if (Number.isFinite(s)) this._score = s | 0;
  }

  // ─── Tick ────────────────────────────────────────────────────────────

  /**
   * Advance the simulation by `dtMs` milliseconds. Skips when paused or
   * after game over. `input.softDrop` accelerates the fall timer 12× to
   * match the legacy down-arrow-held behavior.
   *
   * Returns `null` on continue, or `{ reason }` when the rules pack's
   * endCondition fires (host calls endRun with that reason).
   *
   * @param {number} dtMs
   * @param {InputFrame} [input]
   */
  tick(dtMs, input) {
    if (this._gameOver || this._paused || !this._activePiece) return null;

    this._modeTimeMs += dtMs;

    const dtSec = dtMs / 1000;
    if (input && input.softDrop) {
      this._fallTimer += dtSec * 12;
    }
    this._fallTimer += dtSec;

    const interval = this._rules.fallIntervalSec(this._level);
    if (this._fallTimer > interval) {
      this._fallTimer = 0;
      if (!this.tryMove(0, -1)) this.lockPiece();
    }

    if (this._rules.onTick) {
      try { this._rules.onTick(this.getStateSnapshot(), dtMs); }
      catch (err) { console.warn('[rules] onTick threw:', err); }
    }

    let endResult = null;
    try { endResult = this._rules.endCondition(this.getStateSnapshot()); }
    catch (err) { console.warn('[rules] endCondition threw:', err); }
    if (endResult && endResult.reason) {
      // Host triggers endRun with this reason. Game stays "alive" until
      // the host explicitly forceTopOut/disposes — endCondition is
      // idempotent (same input → same result), so a subsequent tick
      // returns the same reason if the host hasn't acted yet.
      return { reason: endResult.reason };
    }
    return null;
  }

  // ─── External end / pause / reset ────────────────────────────────────

  /**
   * Force the simulation to end (forfeit, KO from external source, etc).
   * Idempotent — repeated calls fire the host callback once.
   */
  forceTopOut(reason = 'forfeit', winner) {
    this._signalEndRun({ reason, winner });
  }

  setPaused(p) { this._paused = !!p; }

  /**
   * Internal — flip gameOver, fire host callback once. The host owns the
   * stats persistence + MODE_END emission; Game just notifies.
   */
  _signalEndRun(info) {
    if (this._endRunCalled) return;
    this._endRunCalled = true;
    this._gameOver = true;
    if (this._onEndRun) {
      try { this._onEndRun(info); }
      catch (err) { console.warn('[game] onEndRun threw:', err); }
    }
  }

  /**
   * Reset to pre-first-piece initial conditions. Used by `Mode.start({
   * restart:true })` to recycle a Game instance between rounds without
   * disposing it. Spawns the first piece so the host can immediately tick.
   */
  reset() {
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) this._board[d][r][c] = null;
      }
    }
    this._activePiece = null;
    this._holdPiece   = null;
    this._nextQueue.length = 0;
    this._canHold = true;

    this._score = 0;
    this._lines = 0;
    this._level = 1;
    this._gameOver = false;
    this._paused   = false;
    this._endRunCalled = false;
    this._fallTimer = 0;
    this._modeTimeMs = 0;
    // Reset to 0 on Play-Again. Host can re-arm the wall-clock display
    // by calling `game._sessionStart = Date.now()` after reset() if the
    // legacy "session length since restart" HUD reading is desired —
    // the field is never read by gameplay logic, so this is safe.
    this._sessionStart = 0;
    this._piecesThisSession = 0;
    this._linesThisSession  = 0;

    this._garbageQueue.length = 0;
    this._garbageBlocked = false;

    this._lastAction    = null;
    this._lastKickIndex = -1;
    this._b2b           = 0;
    this._combo         = 0;

    this._runStats = {
      tspinSingles: 0, tspinDoubles: 0, tspinTriples: 0, tspinMinis: 0,
      perfectClears: 0, maxB2b: 0, maxCombo: 0, garbageCancelled: 0,
    };

    this.spawnPiece();
  }

  // ─── Serialize / restore — replay + online sync (§3.7 sub-phase 7f) ──

  /**
   * Snapshot the full simulation state to a plain JSON-friendly blob.
   * The blob is small (board + active piece + queue + counters + RNG
   * state) — typically under 1 KB. Use cases:
   *
   *   - Replay viewer: record `serialize()` at run start, then a
   *     stream of input frames; replay re-runs against `restore()`.
   *   - Online versus: each peer ships `serialize()` snapshots
   *     periodically as keyframes; rollback re-runs from the latest
   *     keyframe forward.
   *
   * The RNG state is captured ONLY when the rng is a SeededRng (has
   * a `state` property). For Math.random the field is null and
   * restore() can't perfectly reproduce piece order — which is fine
   * for save/load but breaks replay determinism. This is the
   * limitation §7f's ESLint rule prevents from regressing.
   */
  serialize() {
    return {
      v: 2,
      side: this._side,
      cols:  this._cols,
      rows:  this._rows,
      depth: this._depth,
      // 3D-shaped board: [depth][row][col]. v1 blobs serialized as 2D
      // [row][col] (the front slice only); restore() detects v1 and
      // up-converts. Keep saving v2 unconditionally so 2D modes also
      // round-trip the new shape; for depth=1 the outer array has one
      // element and the data layout is otherwise identical.
      board: this._board.map(layer => layer.map(row => row.slice())),
      activePiece: this._activePiece ? { ...this._activePiece } : null,
      nextQueue:   [...this._nextQueue],
      holdPiece:   this._holdPiece,
      canHold:     this._canHold,
      score:       this._score,
      lines:       this._lines,
      level:       this._level,
      gameOver:    this._gameOver,
      paused:      this._paused,
      endRunCalled: this._endRunCalled,
      fallTimer:   this._fallTimer,
      modeTimeMs:  this._modeTimeMs,
      sessionStart: this._sessionStart,
      piecesThisSession: this._piecesThisSession,
      linesThisSession:  this._linesThisSession,
      garbageQueue:   this._garbageQueue.map(e => ({ ...e })),
      garbageBlocked: this._garbageBlocked,
      lastAction:     this._lastAction,
      lastKickIndex:  this._lastKickIndex,
      b2b:            this._b2b,
      combo:          this._combo,
      runStats:       { ...this._runStats },
      rngState: (this._rng && typeof this._rng.state === 'number') ? this._rng.state : null,
    };
  }

  /**
   * Restore the simulation from a `serialize()` blob. Mutates this
   * instance in place — does NOT construct a new Game. Caller must
   * use a Game built with the same `cols/rows/rules` shape; the
   * blob's board dimensions must match the live ones (we throw on
   * mismatch rather than silently growing the array).
   *
   * @param {ReturnType<Game['serialize']>} blob
   */
  restore(blob) {
    if (!blob || typeof blob !== 'object') throw new Error('Game.restore: invalid blob');
    if (blob.cols !== this._cols || blob.rows !== this._rows) {
      throw new Error(`Game.restore: dimension mismatch (blob ${blob.cols}×${blob.rows}, game ${this._cols}×${this._rows})`);
    }
    // v1 blobs (pre-§2.1) serialized board as 2D `[row][col]`; v2 stores
    // 3D `[depth][row][col]`. Detect the shape by peeking at the first
    // outer entry — v1's row is `Cell[]`, v2's is `Cell[][]`. v1 blobs
    // are loaded into the front depth-slice; deeper slices stay empty
    // (they're zero-init from the constructor).
    const blobIs3D = Array.isArray(blob.board) && Array.isArray(blob.board[0])
      && Array.isArray(blob.board[0][0]);
    const blobDepth = blobIs3D ? blob.board.length : 1;
    if (blobIs3D && blob.depth != null && blob.depth !== this._depth) {
      throw new Error(`Game.restore: depth mismatch (blob ${blob.depth}, game ${this._depth})`);
    }
    // In-place mutation so external `board`/`boardLayers` references stay valid.
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        const srcRow = blobIs3D
          ? ((blob.board[d] && blob.board[d][r]) || [])
          : (d === 0 ? (blob.board[r] || []) : []);
        for (let c = 0; c < this._cols; c++) {
          this._board[d][r][c] = (c < srcRow.length) ? srcRow[c] : null;
        }
      }
    }
    void blobDepth; // keep for future 3D-blob diagnostics
    this._activePiece = blob.activePiece ? { ...blob.activePiece } : null;
    this._nextQueue.length = 0;
    if (Array.isArray(blob.nextQueue)) this._nextQueue.push(...blob.nextQueue);
    this._holdPiece = blob.holdPiece ?? null;
    this._canHold   = !!blob.canHold;
    this._score    = blob.score | 0;
    this._lines    = blob.lines | 0;
    this._level    = (blob.level | 0) || 1;
    this._gameOver = !!blob.gameOver;
    this._paused   = !!blob.paused;
    this._endRunCalled = !!blob.endRunCalled;
    this._fallTimer    = +blob.fallTimer || 0;
    this._modeTimeMs   = +blob.modeTimeMs || 0;
    this._sessionStart = +blob.sessionStart || 0;
    this._piecesThisSession = blob.piecesThisSession | 0;
    this._linesThisSession  = blob.linesThisSession | 0;
    this._garbageQueue.length = 0;
    if (Array.isArray(blob.garbageQueue)) {
      for (const e of blob.garbageQueue) this._garbageQueue.push({ ...e });
    }
    this._garbageBlocked = !!blob.garbageBlocked;
    this._lastAction     = (blob.lastAction === 'rotation' || blob.lastAction === 'move' || blob.lastAction === 'drop')
      ? blob.lastAction
      : null;
    this._lastKickIndex  = (typeof blob.lastKickIndex === 'number') ? (blob.lastKickIndex | 0) : -1;
    this._b2b            = (typeof blob.b2b === 'number') ? Math.max(0, blob.b2b | 0) : 0;
    this._combo          = (typeof blob.combo === 'number') ? Math.max(0, blob.combo | 0) : 0;
    // Per-run stats round-trip — defensively coerce each field to a
    // non-negative integer so a malformed/missing blob can't corrupt
    // the live counters.
    if (blob.runStats && typeof blob.runStats === 'object') {
      const r = blob.runStats;
      const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.max(0, v | 0) : 0;
      this._runStats.tspinSingles     = num(r.tspinSingles);
      this._runStats.tspinDoubles     = num(r.tspinDoubles);
      this._runStats.tspinTriples     = num(r.tspinTriples);
      this._runStats.tspinMinis       = num(r.tspinMinis);
      this._runStats.perfectClears    = num(r.perfectClears);
      this._runStats.maxB2b           = num(r.maxB2b);
      this._runStats.maxCombo         = num(r.maxCombo);
      this._runStats.garbageCancelled = num(r.garbageCancelled);
    }
    if (typeof blob.rngState === 'number'
        && this._rng
        && typeof this._rng.setState === 'function') {
      this._rng.setState(blob.rngState);
    }
  }

  /**
   * Tear down. Unsubscribes the GARBAGE_RECEIVED listener so a disposed
   * Game doesn't keep responding to bus traffic. Safe to call twice.
   */
  dispose() {
    if (this._unsubGarbage) {
      try { this._unsubGarbage(); } catch { /* ignore */ }
      this._unsubGarbage = null;
    }
    if (this._unsubOutgoing) {
      try { this._unsubOutgoing(); } catch { /* ignore */ }
      this._unsubOutgoing = null;
    }
  }
}

export const _GARBAGE_QUEUE_CAP_ROWS = GARBAGE_QUEUE_CAP_ROWS;
export const _GARBAGE_COLOR = GARBAGE_COLOR;
