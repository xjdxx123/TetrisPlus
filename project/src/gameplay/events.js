// Gameplay event taxonomy.
//
// These are the topics gameplay/ may emit on the engine bus. The payload
// shape for each is documented next to the constant. Visual layers, audio,
// UI, and the cinematic director subscribe to these — they are the *contract*
// between the simulation and everything else.
//
// Conventions:
//   - Topic names are SCREAMING_SNAKE_CASE strings.
//   - Payloads are plain objects, immutable after emit (the bus freezes them).
//   - Colors are hex 0xRRGGBB integers, never THREE.Color.
//   - Grid coordinates are { col, row } (col 0..COLS-1, row 0..ROWS-1).
//   - World coordinates (when included) are floats in scene units.

export const EVENTS = Object.freeze({
  // Piece lifecycle
  PIECE_SPAWN:   'PIECE_SPAWN',   // { key, color, rotation }
  PIECE_MOVE:    'PIECE_MOVE',    // { dCol, dRow }
  PIECE_ROTATE:  'PIECE_ROTATE',  // { rotation, dir, kicked: boolean, kickIndex: 0..4, dCol, dRow, side }
  PIECE_LOCK:    'PIECE_LOCK',    // { cells: [{col,row}], color }

  // Drops
  HARD_DROP:     'HARD_DROP',     // { dropRows, color, ringX, ringY, minRow, cells }
  SOFT_DROP:     'SOFT_DROP',     // (no payload)

  // Line clears & scoring
  LINE_CLEAR:    'LINE_CLEAR',    // { rows: number[], simultaneous: 1..4, colors: hex[], scoreDelta, clearType, isB2B, isPerfectClear }
  COMBO_START:   'COMBO_START',   // { count }   (reserved for future)
  COMBO_END:     'COMBO_END',     // { count }   (reserved for future)
  SCORE_DELTA:   'SCORE_DELTA',   // { delta, total, source: 'soft-drop'|'hard-drop'|'line-clear' }
  LEVEL_UP:      'LEVEL_UP',      // { level }

  // Modern-rules — T-spin classification (plan §12 M2). Fired by
  // Game.lockPiece when a T piece's last successful action was a
  // rotation and ≥3 of the 4 pivot-corner cells are filled. `kind`
  // is 'tspin' (regular) or 'mini'; `cleared` is 0..3 (a 0-line T-spin
  // still emits — the bonus score applies). Carries `side` per the
  // §3.7 dual-board routing convention.
  T_SPIN:        'T_SPIN',        // { kind: 'tspin'|'mini', cleared: 0..3, score, side }

  // Modern-rules — Back-to-Back chain (plan §12 M3). A "difficult"
  // clear is a Tetris (4-line) or any T-spin-with-clear. Two or more
  // consecutive difficult clears form a B2B chain — each chained
  // clear scores 1.5× and (in Versus) sends +1 garbage. B2B_CHAIN
  // fires when the counter increments (post-increment value);
  // B2B_BREAK fires when a non-difficult clear resets an active chain.
  B2B_CHAIN:     'B2B_CHAIN',     // { count: 1..N, side }
  B2B_BREAK:     'B2B_BREAK',     // { side }

  // Modern-rules — Perfect Clear (plan §12 M3). Fires when a clear
  // empties the board entirely. Awards a per-clear-type score bonus
  // (800/1200/1800/2000 × level for Single/Double/Triple/Tetris) and
  // sends +10 garbage in Versus. The `garbage` field is informational
  // — Versus's onLinesCleared composes the actual GARBAGE_SENT.
  PERFECT_CLEAR: 'PERFECT_CLEAR', // { cleared: 1..4, score, garbage: 10, side }

  // Terminal — fires on topout. The director still listens to GAME_OVER
  // for the cascade visuals; MODE_END is the universal terminal that
  // also covers goal completions / time-outs / forfeits (see plan §2.2).
  GAME_OVER:     'GAME_OVER',     // { score, lines, level }

  // Mode lifecycle (plan_gameplay_1.md §2.2). MODE_START fires when a fresh
  // run begins (boot or goRestart); MODE_END fires on every terminal —
  // topout, goal, time-out, forfeit. MODE_GOAL_PROGRESS reports milestone
  // crossings (lines, time, score) at coarse intervals so HUDs can pulse
  // without subscribing to every line clear.
  MODE_START:         'MODE_START',         // { key, seed, initialModeView }
  MODE_END:           'MODE_END',           // { reason: 'topout'|'goal'|'time'|'forfeit', score, lines, level, timeMs }
  MODE_GOAL_PROGRESS: 'MODE_GOAL_PROGRESS', // { kind: 'lines'|'time'|'score', value, target }

  // Zen rescue (plan_gameplay_1.md §3.5). Replaces topout in Zen — instead
  // of ending the run, the bottom N rows are removed and the stack settles
  // down. Visual layer (vfx/director.js) listens for the restorative
  // cascade preset; HUD increments shift counter.
  ZEN_RESCUE:         'ZEN_RESCUE',         // { rowsRemoved }

  // Versus garbage (plan_gameplay_1.md §3.6 + §12 M5).
  //
  // The M5 spawn-delay window adds a step BETWEEN the rules pack
  // computing outgoing garbage and the opponent receiving it. Versus's
  // `onLinesCleared` emits `GARBAGE_OUTGOING` (raw, pre-cancellation);
  // Game intercepts on the same bus, cancels against the player's own
  // pending inbound queue (front-first), then emits `GARBAGE_CANCELLED`
  // for the cancelled portion AND `GARBAGE_SENT` for the net amount
  // that actually crosses to the opponent.
  //
  // Subscribers:
  //   - HUD versus-badge listens to GARBAGE_SENT for outgoing display.
  //   - Networking layer (post-§7) sends GARBAGE_SENT over the wire.
  //   - HUD cancellation flash listens to GARBAGE_CANCELLED.
  GARBAGE_OUTGOING:   'GARBAGE_OUTGOING',   // { rows: number, target: 'opponent' } — pre-cancellation
  GARBAGE_SENT:       'GARBAGE_SENT',       // { rows: number, target: 'opponent' } — post-cancellation
  GARBAGE_CANCELLED:  'GARBAGE_CANCELLED',  // { rows: number, side: string } — amount eaten from inbound queue
  GARBAGE_RECEIVED:   'GARBAGE_RECEIVED',   // { rows: number, holeColumn: number, source: 'opponent'|'mode' }

  // Fired by Game once a queued garbage entry has been applied to the
  // board (rows pushed up, new garbage row inserted at the bottom). The
  // host's BoardView listener mirrors the data-side mutation on the mesh
  // side. Per-game; carries `side` for dual-board routing.
  GARBAGE_APPLIED:    'GARBAGE_APPLIED',    // { rows: number, holeColumn: number, side: string }

  // Pure Physics — fired by `app/physics-session.js` when the
  // connected-component layer detector identifies a clearable slab and
  // removes the bodies from the Rapier world. Replaces LINE_CLEAR for
  // physics mode (which never fires there since the grid path is
  // bypassed). Payload mirrors LINE_CLEAR's shape where it makes
  // sense — `simultaneous` = layer count cleared, `cubeCount` = total
  // cubes removed across all layers — but adds physics-specific
  // metadata (each layer's center-Y so VFX can fire bursts at the
  // correct world-space positions).
  PHYSICS_LAYER_CLEARED: 'PHYSICS_LAYER_CLEARED', // { layers: [{centerY,minY,maxY,size}], cubeCount, simultaneous, side }
});
