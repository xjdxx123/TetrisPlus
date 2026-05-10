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
import { RemoteOpponent } from '../gameplay/remote-opponent.js';
import { DualBoard } from '../world/dual-board.js';
import { InputRouter, KEYMAP_PRESETS, EMPTY_FRAME } from '../input/intents.js';
import { EVENTS } from '../gameplay/events.js';
import { EventBus } from '../engine/events/bus.js';
import { buildRules } from '../gameplay/rules.js';
import { applyFrameToGame } from '../gameplay/replay/apply-frame.js';

/**
 * @typedef {Object} VersusOpts
 * @property {THREE.Object3D} parent           Where to mount the DualBoard.
 * @property {Object}  rendererDeps            Host-owned helpers passed through to BoardView:
 *                                              `{ cellToWorld, makeCube, shatter, animateCubeTo, startLockAnim, playSfx }`.
 * @property {Object}  [opponentMode]          'bot' (default), 'local' (second InputRouter),
 *                                              or 'remote' (online — `getOpponent()` returns a
 *                                              RemoteOpponent the transport layer fills).
 * @property {string}  [opponentStrength]      Forwarded to BotController (default 'casual'). Ignored when opponentMode != 'bot'.
 * @property {string}  [playerInputMode]       'router' (default) — VersusSession owns an InputRouter for P1.
 *                                             'host'   — host (e.g. main.js) drives gameP1 directly via
 *                                             game.tryMove / hardDrop / etc; VersusSession only ticks the bot.
 * @property {EventTarget} [inputTarget]       Default globalThis.
 * @property {import('../engine/events/bus.js').EventBus} [busP1]
 *   Bus to use for player-side gameplay events. Defaults to a fresh
 *   per-session bus (full isolation). When the host wants its global-
 *   bus subscribers (HUD / cinematic FX / audio) to fire on the
 *   player's events, pass the global bus here. Opponent always gets a
 *   private bus regardless — that's how cross-bus garbage stays one-way.
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
    this._playerInputMode = opts.playerInputMode || 'router';

    this.dualBoard = new DualBoard({ parent: opts.parent });

    // Per-side buses. Player side accepts a host-supplied bus so the
    // host's global subscribers (versus-badge, cinematic FX, audio)
    // fire on the player's events without an extra bridge. Opponent
    // is always isolated on a private bus — that's what keeps the
    // garbage bridge one-way (a global subscriber for GARBAGE_RECEIVED
    // would otherwise see both sides' incoming queues).
    const busP1 = opts.busP1 || new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const busP2 = new EventBus({ replayBufferSize: 0, recorderSize: 0 });

    const rulesP1 = buildRules('versus', { bus: busP1 });
    const rulesP2 = buildRules('versus', { bus: busP2 });

    // nowMs — host-supplied wall clock for the HUD "session length"
    // timer. gameplay/ stays performance.now()-free per the online
    // determinism rule (plan_online_versus.md §A); this value is
    // cosmetic and never read by simulation logic, so the wall-clock
    // read is at the composition root, not inside Game.
    // eslint-disable-next-line no-restricted-syntax
    const nowMs = Date.now();
    this.gameP1 = new Game({
      rules: rulesP1,
      bus: busP1,
      side: 'player',
      rng: opts.rngP1,
      nowMs,
      onEndRun: ({ reason }) => this._handleSideEnd(reason, 'player'),
    });
    this.gameP2 = new Game({
      rules: rulesP2,
      bus: busP2,
      side: 'opponent',
      rng: opts.rngP2,
      nowMs,
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

    // Inputs: P1 either uses VersusSession's InputRouter or is host-
    // driven (main.js's existing keyboard handlers). P2 is either a
    // bot or a second human (local 2P mode).
    if (this._playerInputMode === 'host') {
      this.routerP1 = null;
    } else {
      this.routerP1 = new InputRouter({
        side: 'player',
        keymap: KEYMAP_PRESETS.player,
        target: opts.inputTarget,
      });
    }
    // Opponent input source — branch on opponentMode.
    //   'bot'    → BotController plans + emits frames each tick
    //   'local'  → second InputRouter reading from a keyboard preset
    //   'remote' → RemoteOpponent reads frames from a buffer that
    //              the transport layer fills (online versus, plan
    //              §D). The "opponent input" interface is identical
    //              for all three so VersusSession's tickOpponent
    //              doesn't need to branch.
    this.routerP2 = null;
    this.bot = null;
    this.remote = null;
    if (this._opponentMode === 'local') {
      this.routerP2 = new InputRouter({
        side: 'opponent',
        keymap: KEYMAP_PRESETS.opponent,
        target: opts.inputTarget,
      });
    } else if (this._opponentMode === 'remote') {
      this.remote = new RemoteOpponent();
    } else {
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
    if (this.bot)    this.bot.reset();
    if (this.remote) this.remote.reset();
  }

  /**
   * Per-frame tick — host calls this once per `requestAnimationFrame`.
   * Pulls input frames from both routers / bot, dispatches discrete
   * actions, advances both Games.
   *
   * In `playerInputMode: 'host'`, the player side is NOT advanced here
   * — the host (e.g. main.js) is expected to drive `gameP1` directly
   * via tryMove / hardDrop / game.tick. Calling `tick()` in that mode
   * forwards to `tickOpponent()` for symmetry.
   *
   * @param {number} dtMs
   */
  tick(dtMs) {
    if (this._playerInputMode !== 'host') {
      const fP1 = this.routerP1 ? this.routerP1.frame() : { ...EMPTY_FRAME };
      this._dispatchSide(this.gameP1, fP1, dtMs);
    }
    this.tickOpponent(dtMs);
  }

  /**
   * Advance only the opponent side. Use this when the host drives the
   * player side itself (the §3.7-7e dual-board host integration: main.js
   * still manages keyboard input + `game.tick(dtMs)` for the player;
   * VersusSession is responsible for the bot/P2 game).
   *
   * @param {number} dtMs
   */
  tickOpponent(dtMs) {
    let fP2;
    if      (this.routerP2) fP2 = this.routerP2.frame();
    else if (this.remote)   fP2 = this.remote.tick(dtMs);
    else if (this.bot)      fP2 = this.bot.tick(dtMs);
    else                    fP2 = { ...EMPTY_FRAME };
    this._dispatchSide(this.gameP2, fP2, dtMs);
  }

  /**
   * Online versus only — the RemoteOpponent the transport layer
   * pushes wire-arrived InputFrames into. Returns null in 'bot' /
   * 'local' modes.
   */
  getRemoteOpponent() {
    return this.remote;
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
    // The dispatch logic moved to gameplay/replay/apply-frame.js so
    // VersusSession + replay/player.js + the future online RemoteOpponent
    // all share ONE source of truth. Drift between the live path and
    // the replay-validation path would silently desync online matches;
    // a single helper means a fix here automatically updates every
    // re-execution surface.
    applyFrameToGame(game, frame, dtMs);
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
