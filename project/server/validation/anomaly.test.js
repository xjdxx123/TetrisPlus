// Anomaly detection tests.

import { describe, it, expect } from 'vitest';
import {
  checkPlayerHealth,
  _DEFAULT_FAILURE_RATE_FLAG, _DEFAULT_MIN_MATCHES_TO_FLAG,
} from './anomaly.js';

function makeHistory(count, failureRate) {
  const failureCount = Math.round(count * failureRate);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ validated: i >= failureCount, endedAtMs: 1000 - i });
  }
  return out;
}

describe('checkPlayerHealth — defaults', () => {
  it('handles a missing / non-array history gracefully', () => {
    const r = checkPlayerHealth(null);
    expect(r.status).toBe('ok');
    expect(r.stats.recent).toBe(0);
  });

  it('OK on a perfect record', () => {
    const r = checkPlayerHealth(makeHistory(100, 0));
    expect(r.status).toBe('ok');
    expect(r.stats.failed).toBe(0);
  });

  it('OK below the minimum sample size, even with high failure rate', () => {
    // 10 matches, 5 failures = 50% rate — but sample size below
    // _DEFAULT_MIN_MATCHES_TO_FLAG = 20.
    const r = checkPlayerHealth(makeHistory(10, 0.5));
    expect(r.status).toBe('ok');
  });

  it('OK at exactly the threshold', () => {
    // 100 matches, 1 failure → 1% rate. Default threshold is 1%
    // (rate > flagRate, NOT ≥, so 1% is OK).
    const r = checkPlayerHealth(makeHistory(100, 0.01));
    expect(r.status).toBe('ok');
  });

  it('flags above the threshold', () => {
    // 100 matches, 5 failures → 5% rate.
    const r = checkPlayerHealth(makeHistory(100, 0.05));
    expect(r.status).toBe('flag');
    expect(r.reason).toMatch(/5\.00%/);
  });
});

describe('checkPlayerHealth — windowing', () => {
  it('only counts the most recent N matches', () => {
    // Build 200 matches: first 100 are clean, last 100 are 100% failure.
    const clean = makeHistory(100, 0);
    const dirty = makeHistory(100, 1).map(m => ({ ...m, endedAtMs: m.endedAtMs - 1000 }));
    // history is sorted desc by endedAtMs (most recent first); put
    // the clean batch first so the window only sees clean.
    const history = [...clean, ...dirty];
    const r = checkPlayerHealth(history, { windowSize: 100 });
    expect(r.status).toBe('ok');
    expect(r.stats.recent).toBe(100);
    expect(r.stats.failed).toBe(0);
  });
});

describe('checkPlayerHealth — overrides', () => {
  it('respects custom failureRateFlag', () => {
    const r = checkPlayerHealth(makeHistory(100, 0.005), { failureRateFlag: 0.001 });
    expect(r.status).toBe('flag');
  });

  it('exposes default constants', () => {
    expect(_DEFAULT_FAILURE_RATE_FLAG).toBe(0.01);
    expect(_DEFAULT_MIN_MATCHES_TO_FLAG).toBe(20);
  });
});
