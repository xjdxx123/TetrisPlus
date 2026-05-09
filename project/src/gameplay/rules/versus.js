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

  // Combo tracking — closure-captured per-pack instance. The host builds
  // a fresh pack on every Mode.start, so a new round resets the combo.
  // We bump `combo` on multi-line clears (≥2) and reset on a single-line
  // clear or a non-clearing lock (the host doesn't notify on the latter,
  // but the simple "≥2-line clears extend combo" model is plan-aligned).
  let combo = 0;

  return Object.freeze({
    key:               'versus',
    lineScore:         (rowCount, level) => lineClearScore(rowCount, level),
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
    // event the opponent listens for. Combo bonus accrues on consecutive
    // multi-line clears; a 1-line clear or non-clear resets combo.
    onLinesCleared: (state, rowsCleared) => {
      const r = rowsCleared | 0;
      // Combo sequencing.
      if (r >= 2) combo += 1;
      else        combo = 0;

      const sent = garbageForLineCount(r, Math.max(0, combo - 1));
      if (sent > 0 && bus) {
        bus.emit(EVENTS.GARBAGE_SENT, { rows: sent, target: 'opponent' });
      }
      // Reset combo right after a 1-line clear — the conditional above
      // already did the math; this is purely a safety re-state in case a
      // future caller threads the combo through differently.
      if (r === 1) combo = 0;

      void state;
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

    // Test / introspection accessor. The current combo isn't part of
    // state.snapshot so a closure read is the only way for tests to
    // verify the in-progress combo count.
    _comboInternal: () => combo,
  });
}
