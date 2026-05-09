// Versus rules pack — competitive 1v1 with garbage exchange
// (plan_gameplay_1.md §3.6).
//
// In v1 (this file), the "opponent" is a simple bot subsystem inside the
// host process; in v2 (online — plan §7), the opponent is another player
// over the wire. The rules pack is identical in both cases: it just
// emits `GARBAGE_SENT` on outgoing line clears and exposes an
// `onGarbageReceived` hook for the host to call when garbage arrives.
// The host (main.js / future app/versus.js) decides who the opponent is
// and how garbage flows through the bus.
//
// Topout is handled by the host, NOT by `endCondition` — Versus is "last
// standing wins", which is a runtime concept the rules engine doesn't
// model directly. Likewise the Zen no-topout rescue is explicitly NOT
// opted into here; in Versus we *want* topout to end the round.
//
// Pure module. No THREE, no DOM. Tested in pure Node.

import { lineClearScore, levelForLines, SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL } from '../scoring.js';
import { EVENTS } from '../events.js';
import { garbageForLineCount } from '../garbage.js';

const DEFAULT_FALL_INTERVAL = (level, gravityScalar = 1.0) =>
  Math.max(0.04, (0.85 * Math.pow(0.85, level - 1)) / gravityScalar);

/**
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]
 *   Optional. When provided, `onLinesCleared` emits `GARBAGE_SENT` events
 *   the host (or networking layer) routes to the opponent.
 */
export function buildVersusRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);
  const bus           = opts.bus           || null;

  // Combo tracking moved into Game (plan §12 M4) — the rules pack reads
  // `state.combo` from the snapshot. Kept for backwards-compat with
  // `_comboInternal()` accessors that some tests use; mirrors Game's
  // value when consulted.
  let lastObservedCombo = 0;

  return Object.freeze({
    key:               'versus',
    lineScore:         (rowCount, level, clearType) => lineClearScore(rowCount, level, clearType),
    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,
    fallIntervalSec:   (level) => DEFAULT_FALL_INTERVAL(level, gravityScalar()),
    levelForLines:     levelForLines,
    resetsHighScoreSlot: false, // Versus has its own wins/losses metric
    goalMultiplier:    1.0,

    // Topout-ends-the-round is the host's domain (not the rules engine's).
    // No goal end-condition either — Versus rounds end on someone topping
    // out (or a forfeit / time-out the host owns).
    endCondition:      () => null,

    // Compute outgoing garbage from the player's clear and emit the bus
    // event the opponent listens for.
    //
    // Modern-rules (plan §12 M3 + M4):
    //   - Base from the per-row table; combo bonus from `state.combo`
    //     (Game-managed; plan §12 M4 lifts combo out of this closure).
    //   - +1 garbage row when this clear extends an active B2B chain.
    //   - +10 garbage rows on Perfect Clear.
    //   All stack on top of the standard table value.
    onLinesCleared: (state, rowsCleared, info) => {
      const r = rowsCleared | 0;
      // Game has already incremented `_combo` for this clear by the
      // time onLinesCleared fires; the "combo step" is one less.
      const comboStep = Math.max(0, ((state && state.combo) | 0) - 1);
      lastObservedCombo = (state && state.combo) | 0;

      let sent = garbageForLineCount(r, comboStep);
      if (info && info.isB2B)          sent += 1;
      if (info && info.isPerfectClear) sent += 10;
      if (sent > 0 && bus) {
        bus.emit(EVENTS.GARBAGE_SENT, { rows: sent, target: 'opponent' });
      }
    },

    onTick: null,

    // Optional rules-side hook for received garbage. v1's host applies
    // garbage directly via gameplay/garbage.js; this hook is exposed so
    // future modes (Co-op? Boss-rush?) can transform incoming garbage
    // before application. Returns the (possibly-modified) row count.
    // null = no transform.
    onGarbageReceived: null,

    initialModeView: Object.freeze({
      kind:           'versus',
      opponentScore:  0,
      latencyMs:      0,
      garbageInbound: 0,
    }),

    // Test / introspection accessor — kept for back-compat with tests
    // that predate the M4 combo-into-Game migration. Mirrors the most
    // recent Game.combo observed via onLinesCleared. New code should
    // read `game.getStateSnapshot().combo` directly.
    _comboInternal: () => lastObservedCombo,
  });
}
