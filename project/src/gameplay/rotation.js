// Wall-kick offsets attempted in order when rotating a piece.
//
// This is a simplified kick set (not full SRS): try the rotation in place,
// then bump 1 left, 1 right, 2 left, 2 right. The first non-colliding offset
// wins; if none fit, the rotation is rejected.
//
// Order matters — tests rely on it.
export const KICK_OFFSETS = Object.freeze([0, -1, 1, -2, 2]);

// Direction-to-rotation-delta. A `+1` direction increments rotation, `-1`
// (or any negative) decrements (modulo 4).
export function rotationDelta(direction) {
  return direction > 0 ? 1 : 3;
}

// Compute the next rotation index given current rotation and direction.
export function nextRotation(currentRotation, direction) {
  return (currentRotation + rotationDelta(direction)) % 4;
}
