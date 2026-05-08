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
  PIECE_ROTATE:  'PIECE_ROTATE',  // { rotation, kicked: boolean }
  PIECE_LOCK:    'PIECE_LOCK',    // { cells: [{col,row}], color }

  // Drops
  HARD_DROP:     'HARD_DROP',     // { dropRows, color, ringX, ringY, minRow, cells }
  SOFT_DROP:     'SOFT_DROP',     // (no payload)

  // Line clears & scoring
  LINE_CLEAR:    'LINE_CLEAR',    // { rows: number[], simultaneous: 1..4, colors: hex[], scoreDelta }
  COMBO_START:   'COMBO_START',   // { count }   (reserved for future)
  COMBO_END:     'COMBO_END',     // { count }   (reserved for future)
  SCORE_DELTA:   'SCORE_DELTA',   // { delta, total, source: 'soft-drop'|'hard-drop'|'line-clear' }
  LEVEL_UP:      'LEVEL_UP',      // { level }

  // Terminal
  GAME_OVER:     'GAME_OVER',     // { score, lines, level }
});
