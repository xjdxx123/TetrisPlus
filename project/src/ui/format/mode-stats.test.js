import { describe, it, expect } from 'vitest';
import {
  formatCount,
  formatTimePrecise,
  formatTimeFriendly,
  formatModeBestPrimary,
  formatModeBestSecondary,
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
