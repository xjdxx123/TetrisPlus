import { describe, it, expect, vi } from 'vitest';
import { Clock } from './clock.js';

describe('Clock', () => {
  it('drives render listeners with monotonic totalSec', () => {
    const clock = new Clock();
    const seen = [];
    clock.onRenderTick((dt, total) => seen.push({ dt, total }));
    clock._lastNow = 0;
    clock._running = true;
    clock.step(16);
    clock.step(33);
    clock.step(50);
    expect(seen).toHaveLength(3);
    expect(seen[0].dt).toBeCloseTo(0.016, 3);
    expect(seen[2].total).toBeGreaterThan(seen[0].total);
  });

  it('clamps dt to maxDtSec to survive long stalls', () => {
    const clock = new Clock({ maxDtSec: 0.05 });
    let lastDt = 0;
    clock.onRenderTick((dt) => { lastDt = dt; });
    clock._lastNow = 0;
    clock._running = true;
    clock.step(2000); // 2-second stall
    expect(lastDt).toBeCloseTo(0.05, 5);
  });

  it('runs fixed listeners at the configured rate via accumulator', () => {
    const clock = new Clock({ fixedHz: 60 });
    const fixed = vi.fn();
    clock.onFixedTick(fixed);
    clock._lastNow = 0;
    clock._running = true;
    // Feed 6 render frames @ 16.67ms each (~ real 60Hz rAF).
    // Each frame's dt stays under maxDtSec, so the accumulator is unclamped.
    for (let i = 1; i <= 6; i++) clock.step(i * 16.67);
    // 6 * 16.67 = 100.02ms; at 1/60 = 16.67ms per fixed tick, that's 6 ticks.
    expect(fixed).toHaveBeenCalledTimes(6);
  });

  it('clamps fixed accumulator to prevent spiral-of-death after stalls', () => {
    const clock = new Clock({ fixedHz: 60, maxDtSec: 1 });
    const fixed = vi.fn();
    clock.onFixedTick(fixed);
    clock._lastNow = 0;
    clock._running = true;
    // 1-second stall: would be 60 ticks unclamped. Cap is 5 fixed-dt of catch-up.
    clock.step(1000);
    expect(fixed).toHaveBeenCalledTimes(5);
  });

  it('unsubscribe stops further callbacks', () => {
    const clock = new Clock();
    const fn = vi.fn();
    const off = clock.onRenderTick(fn);
    clock._lastNow = 0;
    clock._running = true;
    clock.step(16);
    off();
    clock.step(32);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
