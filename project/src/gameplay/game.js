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
import { KICK_OFFSETS, nextRotation } from './rotation.js';
import { createSeededRng } from '../shared/random/seeded.js';

const DEFAULT_COLS = 10;
const DEFAULT_ROWS = 20;
const GARBAGE_QUEUE_CAP_ROWS = 20;
const GARBAGE_COLOR = 0x808080;

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
    this._cols     = opts.cols || DEFAULT_COLS;
    this._rows     = opts.rows || DEFAULT_ROWS;
    // RNG default: seeded by Date.now() so a fresh Game without an
    // explicit `rng` is *reproducible from its seed* for replay/online
    // (§3.7 sub-phase 7f). Hosts that want a specific seed pass
    // `rng: createSeededRng(myMatchId)`. Hosts that genuinely want
    // non-determinism (legacy single-sim) pass `rng: Math.random`.
    this._rng      = opts.rng || createSeededRng((Date.now() | 0) >>> 0);
    this._onEndRun = opts.onEndRun || null;

    // Board: `_rows × _cols`. board[0] is the BOTTOM row; matches main.js's
    // existing convention. Cell stores piece color (hex int) or null.
    this._board = Array.from({ length: this._rows }, () => Array(this._cols).fill(null));

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
    this._sessionStart = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._piecesThisSession = 0;
    this._linesThisSession  = 0;

    /** @type {Array<{rows:number, holeColumn:number}>} */
    this._garbageQueue = [];
    this._garbageBlocked = false;

    // Subscribe to inbound garbage. v1 single-bus: bot's emission lands
    // here. v2 dual-sim: per-game bus + host bridge calls applyGarbage()
    // directly, but this subscription remains harmless (no other emitters).
    this._unsubGarbage = this._bus.on(EVENTS.GARBAGE_RECEIVED, (e) => {
      if (!e || typeof e.rows !== 'number' || e.rows <= 0) return;
      this.applyGarbage(e.rows, e.holeColumn);
    });
  }

  // ─── Public read-only accessors ──────────────────────────────────────

  get rules()             { return this._rules; }
  get bus()               { return this._bus; }
  get side()              { return this._side; }
  get cols()              { return this._cols; }
  get rows()              { return this._rows; }
  get board()             { return this._board; }
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

  // ─── State snapshots ─────────────────────────────────────────────────

  /**
   * Minimal state shape consumed by the rules engine (plan_gameplay_1 §2.1).
   */
  getStateSnapshot() {
    return {
      score:        this._score,
      lines:        this._lines,
      level:        this._level,
      linesCleared: this._lines,
      timeMs:       this._modeTimeMs,
    };
  }

  /**
   * Full frozen snapshot for views/HUDs. Per §3.7.3.
   */
  snapshot() {
    return Object.freeze({
      side:     this._side,
      board:    this._board.map(row => Object.freeze([...row])),
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
    const bag = [...PIECE_KEYS];
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
   * Cells occupied by `piece` at rotation `rot`. col/row are board-space.
   * Mirrors main.js's getPieceCells exactly (top-down shape rows, flipped
   * to bottom-origin board rows).
   */
  getPieceCells(piece, rot = piece.rot) {
    const shape = PIECES[piece.key][rot];
    const cells = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (shape[r][c]) {
          cells.push({ col: piece.col + c, row: piece.row + (3 - r) });
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
    for (const { col: c, row: r } of cells) {
      if (c < 0 || c >= COLS) return true;
      if (r < 0) return true;
      if (r >= ROWS + 4) continue;
      if (r < ROWS && this._board[r][c]) return true;
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
    const p = {
      key: forcedKey || this.nextPieceKey(),
      rot: 0,
      col: 3,
      row: this._rows - 2,
    };
    p.color = PIECE_COLORS[p.key];
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
    for (let i = 0; i < n; i++) {
      this._board.splice(0, 1);
      this._board.push(Array(this._cols).fill(null));
    }
  }

  // ─── Movement / rotation ─────────────────────────────────────────────

  /**
   * Move the active piece by (dCol, dRow). Returns true on success. Emits
   * PIECE_MOVE on every successful move so the host can rebuild the
   * piece + ghost mesh from one subscriber instead of duplicating the
   * rebuild call after every wrapper. The host filters on `dCol !== 0`
   * to play sfx (silent on gravity / soft drop / hard drop).
   */
  tryMove(dCol, dRow) {
    if (!this._activePiece || this._gameOver || this._paused) return false;
    const nc = this._activePiece.col + dCol;
    const nr = this._activePiece.row + dRow;
    if (this.collides(this._activePiece, nc, nr, this._activePiece.rot)) return false;
    this._activePiece.col = nc;
    this._activePiece.row = nr;
    this._bus.emit(EVENTS.PIECE_MOVE, { dCol, dRow, side: this._side });
    return true;
  }

  /**
   * Rotate the active piece. `dir` is +1 (CW) or -1 (CCW). Tries each
   * KICK_OFFSETS in order; first non-colliding offset wins. Returns
   * `{ rotated, kicked }`; on success, emits PIECE_ROTATE.
   */
  tryRotate(dir) {
    if (!this._activePiece || this._gameOver || this._paused) {
      return { rotated: false, kicked: 0 };
    }
    const nrot = nextRotation(this._activePiece.rot, dir);
    for (const k of KICK_OFFSETS) {
      const nc = this._activePiece.col + k;
      if (!this.collides(this._activePiece, nc, this._activePiece.row, nrot)) {
        this._activePiece.col = nc;
        this._activePiece.rot = nrot;
        this._bus.emit(EVENTS.PIECE_ROTATE, { rotation: nrot, kicked: k !== 0, dir, side: this._side });
        return { rotated: true, kicked: k };
      }
    }
    return { rotated: false, kicked: 0 };
  }

  // ─── Drops ───────────────────────────────────────────────────────────

  /**
   * One soft-drop tick. If the piece can fall, +softDropPerCell points;
   * otherwise it locks. Emits SCORE_DELTA on success.
   */
  softDrop() {
    if (!this._activePiece || this._gameOver || this._paused) return;
    if (!this.tryMove(0, -1)) {
      this.lockPiece();
      return;
    }
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

    const cells = this.getPieceCells(this._activePiece);
    let minRow = Infinity;
    for (const cell of cells) if (cell.row < minRow) minRow = cell.row;
    const color = this._activePiece.color;
    const summary = {
      dropRows: dropped,
      cells: cells.map(({ col, row }) => ({ col, row })),
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
    for (const { col, row } of cells) {
      if (row >= this._rows) {
        // Locked above the playfield — terminal condition.
        this._signalEndRun({ reason: 'topout' });
        return;
      }
      this._board[row][col] = lockColor;
    }

    // Count full rows BEFORE emitting so the host's PIECE_LOCK subscriber
    // can route to announceLineClear vs noteNoClearLock without waiting
    // for LINE_CLEAR to (or not to) follow.
    const fullRows = [];
    for (let r = 0; r < this._rows; r++) {
      if (this._board[r].every(c => c !== null)) fullRows.push(r);
    }

    this._bus.emit(EVENTS.PIECE_LOCK, {
      cells: cells.map(({ col, row }) => ({ col, row })),
      color:    lockColor,
      side:     this._side,
      cleared:  fullRows.length,
    });

    if (fullRows.length > 0) this.clearLines(fullRows);

    // Garbage application — between piece locks, after any clears resolve.
    this._drainInboundGarbage();

    this.spawnPiece();
  }

  /**
   * Clear `rows` (board-space row indices), shift remaining stack down,
   * update score/lines/level, emit LINE_CLEAR/LEVEL_UP/SCORE_DELTA.
   * `rows` may arrive in any order — sorted top-down internally.
   */
  clearLines(rowsArg) {
    const rows = rowsArg.slice().sort((a, b) => b - a);
    const scoreDelta = this._rules.lineScore(rows.length, this._level);
    this._score += scoreDelta;
    this._lines += rows.length;
    this._linesThisSession += rows.length;

    this._bus.emit(EVENTS.SCORE_DELTA, {
      delta: scoreDelta, total: this._score, source: 'line-clear', side: this._side,
    });

    if (this._rules.onLinesCleared) {
      try { this._rules.onLinesCleared(this.getStateSnapshot(), rows.length); }
      catch (err) { console.warn('[rules] onLinesCleared threw:', err); }
    }

    const newLevel = this._rules.levelForLines(this._lines);
    if (newLevel > this._level) {
      this._level = newLevel;
      this._bus.emit(EVENTS.LEVEL_UP, { level: newLevel, side: this._side });
    }

    const rowColors = rows.map(r => avgRowColor(this._board[r]));
    const overallColor = meanColor(rowColors);
    this._bus.emit(EVENTS.LINE_CLEAR, {
      rows: rows.slice(),
      simultaneous: rows.length,
      colors: rowColors.slice(),
      overallColor,
      scoreDelta,
      side: this._side,
    });

    for (const r of rows) {
      this._board.splice(r, 1);
      this._board.push(Array(this._cols).fill(null));
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
    this._garbageQueue.push({ rows: r, holeColumn: safeHole });
  }

  _drainInboundGarbage() {
    if (this._garbageQueue.length === 0) return;
    while (this._garbageQueue.length > 0) {
      const { rows, holeColumn } = this._garbageQueue.shift();
      this._applyGarbageToBoard(rows, holeColumn);
    }
    this._garbageBlocked = false;
  }

  _applyGarbageToBoard(rows, holeColumn) {
    const COLS = this._cols;
    const safeHole = ((holeColumn % COLS) + COLS) % COLS;
    for (let i = 0; i < rows; i++) {
      this._board.pop(); // drop the top row
      const newRow = new Array(COLS).fill(GARBAGE_COLOR);
      newRow[safeHole] = null;
      this._board.unshift(newRow);
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
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) this._board[r][c] = null;
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
    this._sessionStart = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._piecesThisSession = 0;
    this._linesThisSession  = 0;

    this._garbageQueue.length = 0;
    this._garbageBlocked = false;

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
      v: 1,
      side: this._side,
      cols: this._cols,
      rows: this._rows,
      board: this._board.map(row => row.slice()),
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
    // In-place row mutation so external `board` references stay valid.
    for (let r = 0; r < this._rows; r++) {
      const src = blob.board[r] || [];
      for (let c = 0; c < this._cols; c++) {
        this._board[r][c] = (c < src.length) ? src[c] : null;
      }
    }
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
  }
}

export const _GARBAGE_QUEUE_CAP_ROWS = GARBAGE_QUEUE_CAP_ROWS;
export const _GARBAGE_COLOR = GARBAGE_COLOR;
