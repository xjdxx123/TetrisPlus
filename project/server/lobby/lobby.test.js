// ELO + matchmaking tests — pure-JS, no DO / no D1.

import { describe, it, expect } from 'vitest';
import { applyMatch, expectedScore, ELO_DEFAULT, ELO_PER_MATCH_CAP } from './elo.js';
import { pairQueue } from './matchmaking.js';

describe('elo.expectedScore', () => {
  it('equal ELOs → 0.5 expected score for both', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5, 5);
  });
  it('+400 ELO ≈ 90.9% expected score (chess convention)', () => {
    expect(expectedScore(1600, 1200)).toBeCloseTo(0.909, 2);
  });
});

describe('elo.applyMatch', () => {
  it('A wins against equal-ELO B → +16 / -16', () => {
    const r = applyMatch(1200, 1200, 'A');
    expect(r.deltaA).toBe(16);
    expect(r.deltaB).toBe(-16);
    expect(r.newA).toBe(1216);
    expect(r.newB).toBe(1184);
  });

  it('A loses against equal B → -16 / +16', () => {
    const r = applyMatch(1200, 1200, 'B');
    expect(r.deltaA).toBe(-16);
    expect(r.deltaB).toBe(16);
  });

  it('draw between equal → 0 / 0', () => {
    const r = applyMatch(1200, 1200, 'draw');
    // JS signed-zero quirk: Math.round(-0.x) yields -0; normalize.
    expect(r.deltaA + 0).toBe(0);
    expect(r.deltaB + 0).toBe(0);
  });

  it('underdog upset pays more than favorite-wins', () => {
    const upset = applyMatch(1000, 1500, 'A');
    const favorite = applyMatch(1500, 1000, 'A');
    expect(upset.deltaA).toBeGreaterThan(favorite.deltaA);
  });

  it('caps |delta| at ELO_PER_MATCH_CAP', () => {
    // Massive ELO gap with the underdog winning would naturally
    // exceed K=32 but stay under the cap. Force it by faking
    // a gap > what 32 K would saturate at. With K=32, max raw
    // delta is 32 (when expected is 0 and result is 1) — under
    // the 64 cap so this test is more about defense-in-depth.
    const r = applyMatch(100, 3000, 'A');
    expect(Math.abs(r.deltaA)).toBeLessThanOrEqual(ELO_PER_MATCH_CAP);
  });

  it('rejects invalid winner', () => {
    expect(() => applyMatch(1200, 1200, 'tie')).toThrow(/winner/);
  });
});

describe('matchmaking.pairQueue — basic', () => {
  it('empty / 1-entry queue → no pairs', () => {
    expect(pairQueue([], Date.now()).pairs).toEqual([]);
    expect(pairQueue([{ userId: 'a', elo: 1200, region: 'us', enqueuedAtMs: 0 }], 1000).pairs).toEqual([]);
  });

  it('two same-region same-ELO entries → paired', () => {
    const q = [
      { userId: 'a', elo: 1200, region: 'us', enqueuedAtMs: 100 },
      { userId: 'b', elo: 1200, region: 'us', enqueuedAtMs: 200 },
    ];
    const { pairs, unmatched } = pairQueue(q, 1000);
    expect(pairs).toHaveLength(1);
    expect(unmatched).toHaveLength(0);
    const ids = pairs[0].map(p => p.userId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('cross-region entries do NOT pair (strict region match)', () => {
    const q = [
      { userId: 'a', elo: 1200, region: 'us', enqueuedAtMs: 0 },
      { userId: 'b', elo: 1200, region: 'eu', enqueuedAtMs: 0 },
    ];
    const { pairs, unmatched } = pairQueue(q, 1000);
    expect(pairs).toHaveLength(0);
    expect(unmatched).toHaveLength(2);
  });

  it('respects ELO range — distant ratings only pair after wait (within max cap)', () => {
    // 400-ELO gap is well outside initial ±75 search range BUT
    // inside the SEARCH_MAX_RANGE cap (600). Eligible after enough
    // wait expands the range past 400.
    const q = [
      { userId: 'a', elo: 1100, region: 'us', enqueuedAtMs: 0 },
      { userId: 'b', elo: 1500, region: 'us', enqueuedAtMs: 0 },
    ];
    // No wait → no pairing.
    expect(pairQueue(q, 0).pairs).toHaveLength(0);
    // 15-second wait → range expands by 15*25 = 375 → 75+375 = 450 ≥ 400 → pairs.
    expect(pairQueue(q, 15_000).pairs).toHaveLength(1);
  });

  it('caps the search range — extreme ELO gaps NEVER pair regardless of wait', () => {
    const q = [
      { userId: 'a', elo: 100,  region: 'us', enqueuedAtMs: 0 },
      { userId: 'b', elo: 2500, region: 'us', enqueuedAtMs: 0 },
    ];
    // 24-hour wait can't pair them — gap is 2400, well above the 600 cap.
    expect(pairQueue(q, 24 * 3600 * 1000).pairs).toHaveLength(0);
  });

  it('priority FIFO — older entries pair first', () => {
    const q = [
      { userId: 'a', elo: 1200, region: 'us', enqueuedAtMs: 100 },
      { userId: 'b', elo: 1200, region: 'us', enqueuedAtMs: 50 }, // oldest
      { userId: 'c', elo: 1200, region: 'us', enqueuedAtMs: 200 },
    ];
    const { pairs, unmatched } = pairQueue(q, 1000);
    expect(pairs).toHaveLength(1);
    // 'b' (oldest) should be in the first pair.
    expect(pairs[0].some(p => p.userId === 'b')).toBe(true);
    expect(unmatched).toHaveLength(1);
  });

  it('multiple viable pairs all resolve', () => {
    const q = [
      { userId: 'a', elo: 1200, region: 'us', enqueuedAtMs: 0 },
      { userId: 'b', elo: 1200, region: 'us', enqueuedAtMs: 1 },
      { userId: 'c', elo: 1200, region: 'us', enqueuedAtMs: 2 },
      { userId: 'd', elo: 1200, region: 'us', enqueuedAtMs: 3 },
    ];
    const { pairs, unmatched } = pairQueue(q, 1000);
    expect(pairs).toHaveLength(2);
    expect(unmatched).toHaveLength(0);
  });
});

describe('matchmaking.pairQueue — defaults', () => {
  it('ELO_DEFAULT sanity', () => {
    expect(ELO_DEFAULT).toBe(1200);
  });
});
