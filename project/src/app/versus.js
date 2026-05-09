// Versus composition root — builds two Games + two BoardViews + the
// garbage bridge between them (plan_gameplay_1.md §3.7 sub-phase 7e).
//
// This is the FOUNDATION for dual-board Versus. The current main.js
// path still uses single-sim with an abstract bot for Versus mode; this
// module is what a future PR will swap in to flip it to true dual-sim.
// The seams it covers:
//
//   1. Two `Game` instances with separate buses → so emissions from
//      Game1 don't accidentally arrive at Game2's GARBAGE_RECEIVED
//      subscription. Each Game gets its own bus.
//   2. Two `BoardView` instances mounted under DualBoard's left + right
//      anchors so meshes don't overlap.
//   3. Garbage bridge: Game1's GARBAGE_SENT routes to Game2.applyGarbage
//      via Game2's per-game bus, and vice versa. The bridge is the
//      ONLY cross-Game wiring; pieces, scoring, end-conditions are
//      strictly local to each side.
//   4. Per-side InputRouter — P1 plays via the player keymap, the
//      opponent side either consumes a BotController's frame or
//      another InputRouter (for local 2P).
//
// What this file does NOT yet handle:
//   - Wiring into Mode._wireLifecycle (host-level integration deferred).
//   - HUD per-side routing (current versus-badge reads main.js's single
//     game; dual-side HUD requires badge refactor).
//   - Win/loss arbitration (left as a TODO comment below; the current
//     single-sim flow uses winner='player'|'opponent' on endRun, the
//     bridge here would translate Game._signalEndRun → router decision).
//
// Pure module beyond construction-time side-effects (DualBoard
// instantiation). Tested in pure Node with a fake bus + fake game.

import { Game } from '../gameplay/game.js';
import { BoardView } from '../world/board-view.js';
import { BotController } from '../gameplay/bot-controller.js';
import { DualBoard } from '../world/dual-board.js';
import { InputRouter, KEYMAP_PRESETS, EMPTY_FRAME } from '../input/intents.js';
import { EVENTS } from '../gameplay/events.js';
import { EventBus } from '../engine/events/bus.js';
import { buildRules } from '../gameplay/rules.js';

/**
 * @typedef {Object} VersusOpts
 * @property {THREE.Object3D} parent           Where to mount the DualBoard.
 * @property {Object}  rendererDeps            Host-owned helpers passed through to BoardView:
 *                                              `{ cellToWorld, makeCube, shatter, animateCubeTo, startLockAnim, playSfx }`.
 * @property {Object}  [opponentMode]          'bot' (default) or 'local' (second InputRouter).
 * @property {string}  [opponentStrength]      Forwarded to BotController (default 'casual').
 * @property {EventTarget} [inputTarget]       Default globalThis.
 * @property {() => number} [rngP1]            Seeded PRNG for player 1; default Math.random.
 * @property {() => number} [rngP2]            Seeded PRNG for opponent;  default Math.random.
 * @property {(reason:string, side:string) => void} [onSideEnd]
 *   Called when one side terminates. The composition root determines
 *   the match-level winner from the per-side reason + side; the spec
 *   for that arbitration lives outside this module.
 */

export class VersusSession {
  /** @param {VersusOpts} opts */
  constructor(opts) {
    if (!opts || !opts.parent) throw new Error('VersusSession requires { parent }');
    if (!opts.rendererDeps) throw new Error('VersusSession requires { rendererDeps }');

    this._opts = opts;
    this._opponentMode = opts.opponentMode || 'bot';

    this.dualBoard = new DualBoard({ parent: opts.parent });

    // Per-game buses — keep emissions local to one side. The garbage
    // bridge below is the only cross-bus traffic.
    const busP1 = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const busP2 = new EventBus({ replayBufferSize: 0, recorderSize: 0 });

    const rulesP1 = buildRules('versus', { bus: busP1 });
    const rulesP2 = buildRules('versus', { bus: busP2 });

    this.gameP1 = new Game({
      rules: rulesP1,
      bus: busP1,
      side: 'player',
      rng: opts.rngP1,
      onEndRun: ({ reason }) => this._handleSideEnd(reason, 'player'),
    });
    this.gameP2 = new Game({
      rules: rulesP2,
      bus: busP2,
      side: 'opponent',
      rng: opts.rngP2,
      onEndRun: ({ reason }) => this._handleSideEnd(reason, 'opponent'),
    });

    this.viewP1 = new BoardView({
      game: this.gameP1, bus: busP1,
      parent: this.dualBoard.anchorFor('player'),
      side: 'player',
      ...opts.rendererDeps,
    });
    this.viewP2 = new BoardView({
      game: this.gameP2, bus: busP2,
      parent: this.dualBoard.anchorFor('opponent'),
      side: 'opponent',
      ...opts.rendererDeps,
    });

    // Inputs: P1 always uses the player keymap. P2 is either a bot or
    // a second human (local 2P mode).
    this.routerP1 = new InputRouter({
      side: 'player',
      keymap: KEYMAP_PRESETS.player,
      target: opts.inputTarget,
    });
    if (this._opponentMode === 'local') {
      this.routerP2 = new InputRouter({
        side: 'opponent',
        keymap: KEYMAP_PRESETS.opponent,
        target: opts.inputTarget,
      });
      this.bot = null;
    } else {
      this.routerP2 = null;
      this.bot = new BotController({
        game: this.gameP2,
        strength: opts.opponentStrength || 'casual',
        rng: opts.rngP2,
      });
    }

    // Garbage bridge — each side's GARBAGE_SENT becomes the OTHER
    // side's GARBAGE_RECEIVED. Game's constructor subscribes to
    // GARBAGE_RECEIVED on its OWN bus, so we synthesize that emit on
    // the opposite bus. (Calling game.applyGarbage directly would also
    // work; using the bus path keeps the side-effect observable to any
    // future subscribers that want to log the cross-side traffic.)
    this._unsubP1Sent = busP1.on(EVENTS.GARBAGE_SENT, (e) => {
      busP2.emit(EVENTS.GARBAGE_RECEIVED, {
        rows: e.rows,
        holeColumn: e.holeColumn,
        source: 'opponent',
      });
    });
    this._unsubP2Sent = busP2.on(EVENTS.GARBAGE_SENT, (e) => {
      busP1.emit(EVENTS.GARBAGE_RECEIVED, {
        rows: e.rows,
        holeColumn: e.holeColumn,
        source: 'opponent',
      });
    });

    // Match terminal state — first side to top out loses; if both
    // signal in the same tick the host's onSideEnd is called twice and
    // the resolution is up to the caller.
    this._sidesEnded = new Set();
  }

  /**
   * Spawn the first piece on each side and start ticking. Mirrors
   * Mode.start({restart:false}) for solo modes.
   */
  start() {
    if (!this.gameP1.activePiece) this.gameP1.spawnPiece();
    if (!this.gameP2.activePiece) this.gameP2.spawnPiece();
    if (this.bot) this.bot.reset();
  }

  /**
   * Per-frame tick — host calls this once per `requestAnimationFrame`.
   * Pulls input frames from both routers / bot, dispatches discrete
   * actions, advances both Games.
   *
   * @param {number} dtMs
   */
  tick(dtMs) {
    const fP1 = this.routerP1 ? this.routerP1.frame() : { ...EMPTY_FRAME };
    const fP2 = this.routerP2
      ? this.routerP2.frame()
      : (this.bot ? this.bot.tick(dtMs) : { ...EMPTY_FRAME });
    this._dispatchSide(this.gameP1, fP1, dtMs);
    this._dispatchSide(this.gameP2, fP2, dtMs);
  }

  /** Tear down both sides + the bridge + the routers. */
  dispose() {
    if (this._unsubP1Sent) this._unsubP1Sent();
    if (this._unsubP2Sent) this._unsubP2Sent();
    if (this.routerP1) this.routerP1.dispose();
    if (this.routerP2) this.routerP2.dispose();
    if (this.viewP1)   this.viewP1.dispose();
    if (this.viewP2)   this.viewP2.dispose();
    if (this.gameP1)   this.gameP1.dispose();
    if (this.gameP2)   this.gameP2.dispose();
    if (this.dualBoard) this.dualBoard.dispose();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  _dispatchSide(game, frame, dtMs) {
    if (game.gameOver || game.paused) return;
    // Discrete intents fire first (rotate/hold/drop) — they may queue
    // up state Game.tick depends on (e.g. rotation changes the piece
    // before gravity falls).
    if (frame.rotateCW)  game.tryRotate(1);
    if (frame.rotateCCW) game.tryRotate(-1);
    if (frame.hold)      game.holdActive();
    // Held movement — single-step per frame; the host's DAS layer would
    // call tryMove repeatedly under sustained holds. v1 keeps it simple.
    if (frame.left)      game.tryMove(-1, 0);
    if (frame.right)     game.tryMove(1, 0);
    if (frame.hardDrop) {
      const result = game.hardDrop();
      if (result) game.lockPiece();
    }
    if (frame.pause)     game.setPaused(!game.paused);
    // Soft-drop input is signalled into game.tick which accelerates
    // the fall timer 12×.
    game.tick(dtMs, { softDrop: !!frame.softDrop });
  }

  _handleSideEnd(reason, side) {
    if (this._sidesEnded.has(side)) return;
    this._sidesEnded.add(side);
    if (typeof this._opts.onSideEnd === 'function') {
      try { this._opts.onSideEnd(reason, side); }
      catch (err) { console.warn('[versus] onSideEnd threw:', err); }
    }
    // First side to topout loses → if the other side hasn't ended yet,
    // synthesize a forfeit on it so MODE_END fires there too.
    if (reason === 'topout' && this._sidesEnded.size === 1) {
      const otherSide = side === 'player' ? 'opponent' : 'player';
      const otherGame = side === 'player' ? this.gameP2 : this.gameP1;
      // Guard against re-entrancy if otherGame already topped out
      // mid-tick. forceTopOut is idempotent inside Game.
      if (!otherGame.gameOver) {
        otherGame.forceTopOut('opponent_topout', otherSide);
      }
    }
  }
}
