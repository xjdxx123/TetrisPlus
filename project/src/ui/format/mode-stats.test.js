import { describe, it, expect } from 'vitest';
import {
  formatCount,
  formatTimePrecise,
  formatTimeFriendly,
  formatModeBestPrimary,
  formatModeBestSecondary,
  formatModeBestModern,
  formatModeBestSummary,
  formatModeGoalAndDuration,
  _DEFAULT_DASH,
} from './mode-stats.js';

describe('formatCount', () => {
  it('formats positive integers with locale separators', () => {
    expect(formatCount(1000)).toBe((1000).toLocaleString());
    expect(formatCount(287_400)).toBe((287_400).toLocaleString());
  });

  it('returns the dash for null / undefined / NaN / Infinity', () => {
    expect(formatCount(null)).toBe(_DEFAULT_DASH);
    expect(formatCount(undefined)).toBe(_DEFAULT_DASH);
    expect(formatCount(NaN)).toBe(_DEFAULT_DASH);
    expect(formatCount(Infinity)).toBe(_DEFAULT_DASH);
  });

  it('returns the dash for 0 by default (fresh-install slot)', () => {
    expect(formatCount(0)).toBe(_DEFAULT_DASH);
  });

  it('treats 0 as a real value when `zeroIsReal: true`', () => {
    expect(formatCount(0, { zeroIsReal: true })).toBe('0');
  });
});

describe('formatTimePrecise (m:ss.mmm)', () => {
  it('formats whole seconds + millis with leading zeros', () => {
    expect(formatTimePrecise(0)).toBe('0:00.000');
    expect(formatTimePrecise(53_412)).toBe('0:53.412');
    expect(formatTimePrecise(60_000)).toBe('1:00.000');
    expect(formatTimePrecise(125_007)).toBe('2:05.007');
  });

  it('returns the dash on null / NaN / negative', () => {
    expect(formatTimePrecise(null)).toBe(_DEFAULT_DASH);
    expect(formatTimePrecise(NaN)).toBe(_DEFAULT_DASH);
    expect(formatTimePrecise(-1)).toBe(_DEFAULT_DASH);
    expect(formatTimePrecise(undefined)).toBe(_DEFAULT_DASH);
  });

  it('floors fractional milliseconds', () => {
    expect(formatTimePrecise(53_412.9)).toBe('0:53.412');
  });
});

describe('formatTimeFriendly (Hh Mm / Mm Ss / Ss)', () => {
  it('uses h:m when ≥1 hour', () => {
    expect(formatTimeFriendly(3_600_000)).toBe('1h 0m');
    expect(formatTimeFriendly(3_900_000)).toBe('1h 5m');
    expect(formatTimeFriendly(7_500_000)).toBe('2h 5m');
  });

  it('uses m:s when ≥1 minute and <1 hour', () => {
    expect(formatTimeFriendly(60_000)).toBe('1m 0s');
    expect(formatTimeFriendly(125_000)).toBe('2m 5s');
  });

  it('uses s when <1 minute', () => {
    expect(formatTimeFriendly(0)).toBe('0s');
    expect(formatTimeFriendly(45_000)).toBe('45s');
  });

  it('returns dash on bad input', () => {
    expect(formatTimeFriendly(null)).toBe(_DEFAULT_DASH);
    expect(formatTimeFriendly(NaN)).toBe(_DEFAULT_DASH);
    expect(formatTimeFriendly(-1)).toBe(_DEFAULT_DASH);
  });
});

describe('formatModeBestPrimary', () => {
  it('classic / marathon / ultra → score with locale separators', () => {
    expect(formatModeBestPrimary('classic',  { score: 12_345 })).toBe((12_345).toLocaleString());
    expect(formatModeBestPrimary('marathon', { score: 100_000 })).toBe((100_000).toLocaleString());
    expect(formatModeBestPrimary('ultra',    { score: 50_000 })).toBe((50_000).toLocaleString());
  });

  it('sprint → bestTimeMs (precise)', () => {
    expect(formatModeBestPrimary('sprint', { bestTimeMs: 53_412 })).toBe('0:53.412');
    expect(formatModeBestPrimary('sprint', {})).toBe(_DEFAULT_DASH); // no completion yet
  });

  it('zen → longestSessionMs (friendly)', () => {
    expect(formatModeBestPrimary('zen', { longestSessionMs: 60_000 })).toBe('1m 0s');
    expect(formatModeBestPrimary('zen', { longestSessionMs: 0 })).toBe(_DEFAULT_DASH);
  });

  it('versus → W-L', () => {
    expect(formatModeBestPrimary('versus', { wins: 12, losses: 7 })).toBe('12W–7L');
    expect(formatModeBestPrimary('versus', { wins: 0, losses: 0 })).toBe(_DEFAULT_DASH);
    expect(formatModeBestPrimary('versus', { wins: 1, losses: 0 })).toBe('1W–0L');
  });

  it('falls back to score-based for unknown modes', () => {
    expect(formatModeBestPrimary('garbage-mode', { score: 99 })).toBe('99');
  });

  it('physics → score (layers × 100; falls back to dash on fresh)', () => {
    expect(formatModeBestPrimary('physics', { score: 1500 })).toBe((1500).toLocaleString());
    expect(formatModeBestPrimary('physics', {})).toBe(_DEFAULT_DASH);
  });

  it('safe against undefined best', () => {
    expect(formatModeBestPrimary('classic')).toBe(_DEFAULT_DASH);
    expect(formatModeBestPrimary('zen', undefined)).toBe(_DEFAULT_DASH);
  });
});

describe('formatModeBestSecondary', () => {
  it('marathon shows best time + completion status when completed', () => {
    const s = formatModeBestSecondary('marathon', {
      score: 100_000, attempts: 14, completed: true, bestTimeMs: 462_000,
    });
    expect(s).toContain('best time');
    expect(s).toContain('14 attempts');
    expect(s).toContain('completed');
  });

  it('marathon returns null on a fresh slot (no attempts)', () => {
    expect(formatModeBestSecondary('marathon', {})).toBeNull();
    expect(formatModeBestSecondary('marathon', { attempts: 0 })).toBeNull();
  });

  it('sprint shows attempts + completed/no-completions', () => {
    const a = formatModeBestSecondary('sprint', { attempts: 3, completed: true });
    expect(a).toBe('3 attempts, completed');
    const b = formatModeBestSecondary('sprint', { attempts: 1, completed: false });
    expect(b).toBe('1 attempt, no completions');
  });

  it('ultra shows lines on best run when ≥1', () => {
    expect(formatModeBestSecondary('ultra', { lines: 42 })).toBe('42 lines on best run');
    expect(formatModeBestSecondary('ultra', { lines: 0 })).toBeNull();
    expect(formatModeBestSecondary('ultra', {})).toBeNull();
  });

  it('zen shows total lines', () => {
    expect(formatModeBestSecondary('zen', { totalLines: 1234 })).toBe('1,234 lines total');
    expect(formatModeBestSecondary('zen', { totalLines: 0 })).toBeNull();
  });

  it('versus shows ELO once the player has played at least one match', () => {
    expect(formatModeBestSecondary('versus', { wins: 1, losses: 0, eloMmr: 1234 })).toBe('ELO 1234');
    expect(formatModeBestSecondary('versus', { wins: 0, losses: 0, eloMmr: 1200 })).toBeNull();
    expect(formatModeBestSecondary('versus', { wins: 0, losses: 1 })).toBe('ELO 1200'); // default elo
  });

  it('classic shows lines + level when there is a record', () => {
    expect(formatModeBestSecondary('classic', { lines: 42, level: 5 })).toBe('42 lines, level 5');
    expect(formatModeBestSecondary('classic', {})).toBeNull();
  });

  it('physics shows best-run + total layers when both have records', () => {
    const s = formatModeBestSecondary('physics', { bestLayersCleared: 12, totalLayersCleared: 47 });
    expect(s).toBe('best run 12 layers · 47 layers total');
  });

  it('physics with only one metric shows just that one', () => {
    expect(formatModeBestSecondary('physics', { bestLayersCleared: 5 }))
      .toBe('best run 5 layers');
    expect(formatModeBestSecondary('physics', { totalLayersCleared: 100 }))
      .toBe('100 layers total');
  });

  it('physics returns null on a fresh slot', () => {
    expect(formatModeBestSecondary('physics', {})).toBeNull();
  });
});

describe('formatModeBestSummary', () => {
  it('combines primary + secondary with " · "', () => {
    const s = formatModeBestSummary('classic', { score: 99_999, lines: 42, level: 5 });
    expect(s).toBe(`${(99_999).toLocaleString()} · 42 lines, level 5`);
  });

  it('returns "No record yet" when there is no primary metric', () => {
    expect(formatModeBestSummary('classic', {})).toBe('No record yet');
    expect(formatModeBestSummary('sprint',  {})).toBe('No record yet');
    expect(formatModeBestSummary('versus',  { wins: 0, losses: 0 })).toBe('No record yet');
  });

  it('returns primary alone when no secondary is meaningful', () => {
    // Marathon with score but no attempts data → primary only.
    expect(formatModeBestSummary('marathon', { score: 1000 })).toBe((1000).toLocaleString());
  });
});

describe('formatModeBestModern (plan_gameplay_2.md §1.1)', () => {
  it('returns null on a fresh slot (all zeros)', () => {
    expect(formatModeBestModern('classic',  {})).toBeNull();
    expect(formatModeBestModern('marathon', {})).toBeNull();
    expect(formatModeBestModern('sprint',   {})).toBeNull();
    expect(formatModeBestModern('ultra',    {})).toBeNull();
    expect(formatModeBestModern('zen',      {})).toBeNull();
    expect(formatModeBestModern('versus',   {})).toBeNull();
  });

  it('classic: B2B / combo / PC / T-spin clears in declaration order', () => {
    const s = formatModeBestModern('classic', {
      bestB2bChain: 4, bestCombo: 9, perfectClears: 12, tspinClears: 47,
    });
    expect(s).toBe('best B2B ×4 · best combo ×9 · 12 perfect clears · 47 T-spin clears');
  });

  it('classic: only renders fields with > 0 values', () => {
    expect(formatModeBestModern('classic', { bestB2bChain: 3 })).toBe('best B2B ×3');
    expect(formatModeBestModern('classic', { perfectClears: 2 })).toBe('2 perfect clears');
    expect(formatModeBestModern('classic', { tspinClears: 1 })).toBe('1 T-spin clear');
  });

  it('singular vs plural for perfect clears + T-spin clears', () => {
    const a = formatModeBestModern('classic', { perfectClears: 1, tspinClears: 1 });
    expect(a).toBe('1 perfect clear · 1 T-spin clear');
    const b = formatModeBestModern('classic', { perfectClears: 2, tspinClears: 5 });
    expect(b).toBe('2 perfect clears · 5 T-spin clears');
  });

  it('sprint: only bestCombo (other modern fields are intentionally absent)', () => {
    const s = formatModeBestModern('sprint', {
      bestB2bChain: 4, bestCombo: 8, perfectClears: 12, tspinClears: 47,
    });
    expect(s).toBe('best combo ×8');
  });

  it('sprint with no combo record returns null', () => {
    expect(formatModeBestModern('sprint', { bestCombo: 0 })).toBeNull();
  });

  it('versus: includes bestGarbageCancelled in addition to common fields', () => {
    const s = formatModeBestModern('versus', {
      bestB2bChain: 5, bestCombo: 7, perfectClears: 3, tspinClears: 14,
      bestGarbageCancelled: 28,
    });
    expect(s).toBe('best B2B ×5 · best combo ×7 · 3 perfect clears · 14 T-spin clears · 28 cancelled best');
  });

  it('versus: cancelled-best alone surfaces as a single chip', () => {
    expect(formatModeBestModern('versus', { bestGarbageCancelled: 9 })).toBe('9 cancelled best');
  });

  it('Marathon / Ultra / Zen share the classic formatter', () => {
    const stats = { bestB2bChain: 2, perfectClears: 1 };
    const expected = 'best B2B ×2 · 1 perfect clear';
    expect(formatModeBestModern('marathon', stats)).toBe(expected);
    expect(formatModeBestModern('ultra',    stats)).toBe(expected);
    expect(formatModeBestModern('zen',      stats)).toBe(expected);
  });

  it('safe against undefined best', () => {
    expect(formatModeBestModern('classic')).toBeNull();
    expect(formatModeBestModern('sprint', undefined)).toBeNull();
  });

  it('uses locale separators on large counts', () => {
    expect(formatModeBestModern('classic', { tspinClears: 1234 })).toBe('1,234 T-spin clears');
  });

  it('coerces malformed inputs defensively (NaN→0, neg→filtered, str→int)', () => {
    // `| 0` rules:
    //   NaN  → 0          (filtered by > 0 gate)
    //   -3   → -3         (filtered by > 0 gate)
    //   '4'  → 4          (string coerced to int — rendered)
    //   1.7  → 1          (truncated — rendered as "1 T-spin clear")
    // The function never throws on bad input; bad fields silently
    // disappear, valid ones still render.
    expect(formatModeBestModern('classic', {
      bestB2bChain: NaN, bestCombo: -3, perfectClears: '4', tspinClears: 1.7,
    })).toBe('4 perfect clears · 1 T-spin clear');
  });
});

describe('formatModeGoalAndDuration', () => {
  it('returns the goal + a duration string when configured', () => {
    const r = formatModeGoalAndDuration('marathon', {
      goalLabel: '150 lines (1.5× bonus)',
      estimatedDurationMin: 8,
    });
    expect(r.goal).toBe('150 lines (1.5× bonus)');
    expect(r.duration).toBe('~8 min');
  });

  it('returns duration: null for endless modes', () => {
    const r = formatModeGoalAndDuration('classic', {
      goalLabel: 'Endless',
      estimatedDurationMin: null,
    });
    expect(r.duration).toBeNull();
  });

  it('falls back to dash on missing config', () => {
    const r = formatModeGoalAndDuration('classic', null);
    expect(r.goal).toBe('—');
    expect(r.duration).toBeNull();
  });
});
