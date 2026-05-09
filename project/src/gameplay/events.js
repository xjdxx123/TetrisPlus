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
  LINE_CLEAR:    'LINE_CLEAR',    // { rows: number[], simultaneous: 1..4, colors: hex[], scoreDelta, clearType: 'normal'|'tspin'|'mini' }
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

  // Versus garbage (plan_gameplay_1.md §3.6). GARBAGE_SENT is fired by the
  // active rules pack's onLinesCleared when the player clears multiple
  // rows; the opponent (a bot in v1, a remote sim in v2) receives the
  // signal and grows its incoming queue. GARBAGE_RECEIVED is fired by the
  // opponent when sending garbage *to* this player; the host queues it
  // and applies between piece locks.
  GARBAGE_SENT:       'GARBAGE_SENT',       // { rows: number, target: 'opponent' }
  GARBAGE_RECEIVED:   'GARBAGE_RECEIVED',   // { rows: number, holeColumn: number, source: 'opponent'|'mode' }

  // Fired by Game once a queued garbage entry has been applied to the
  // board (rows pushed up, new garbage row inserted at the bottom). The
  // host's BoardView listener mirrors the data-side mutation on the mesh
  // side. Per-game; carries `side` for dual-board routing.
  GARBAGE_APPLIED:    'GARBAGE_APPLIED',    // { rows: number, holeColumn: number, side: string }
});
