// ELO update — standard chess-style with K=32 cap.
// Pure module; reused by the matchmaking service (Phase G) and by
// the replay-validation cron (Phase H — only validated matches
// move ELO).

export const ELO_DEFAULT       = 1200;
export const ELO_K_FACTOR      = 32;
export const ELO_PER_MATCH_CAP = 64; // |delta| ≤ 64 — anti-bot ceiling

/**
 * Expected score for player A given (eloA, eloB). Returns 0..1.
 * Standard ELO formula: 1 / (1 + 10^((eloB - eloA) / 400)).
 */
export function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

/**
 * @param {number} eloA   current ELO of player A
 * @param {number} eloB   current ELO of player B
 * @param {'A'|'B'|'draw'} winner
 * @returns {{ deltaA:number, deltaB:number, newA:number, newB:number }}
 */
export function applyMatch(eloA, eloB, winner) {
  if (!Number.isFinite(eloA) || !Number.isFinite(eloB)) {
    throw new Error('applyMatch: eloA + eloB must be finite numbers');
  }
  if (winner !== 'A' && winner !== 'B' && winner !== 'draw') {
    throw new Error(`applyMatch: winner must be 'A' / 'B' / 'draw' (got ${winner})`);
  }
  const eA = expectedScore(eloA, eloB);
  const sA = winner === 'A' ? 1 : (winner === 'B' ? 0 : 0.5);
  let deltaA = Math.round(ELO_K_FACTOR * (sA - eA));
  // Cap per-match swing so a streak of cheats can't blast a player's
  // ELO before anti-cheat kicks in.
  if      (deltaA >  ELO_PER_MATCH_CAP) deltaA =  ELO_PER_MATCH_CAP;
  else if (deltaA < -ELO_PER_MATCH_CAP) deltaA = -ELO_PER_MATCH_CAP;
  const deltaB = -deltaA;
  return {
    deltaA, deltaB,
    newA: eloA + deltaA,
    newB: eloB + deltaB,
  };
}
