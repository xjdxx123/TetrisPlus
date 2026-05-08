// The single requestAnimationFrame driver. Every per-frame update in the
// engine should register through onRenderTick / onFixedTick — no subsystem
// starts its own rAF.
//
// Two cadences:
//   - render tick: once per displayed frame, variable dt clamped to maxDtSec.
//   - fixed tick:  fixed-step dt (default 60 Hz), may run 0..N times per frame
//                  via accumulator. Use for deterministic gameplay simulation.
//
// Listeners receive (dtSec, totalSec). totalSec is monotonic since start().

export class Clock {
  constructor({ maxDtSec = 0.05, fixedHz = 60 } = {}) {
    this._maxDt = maxDtSec;
    this._fixedDt = 1 / fixedHz;
    this._renderListeners = new Set();
    this._fixedListeners = new Set();
    this._fixedAccum = 0;
    this._totalSec = 0;
    this._lastNow = 0;
    this._rafId = 0;
    this._running = false;
    this._tick = this._tick.bind(this);
  }

  onRenderTick(fn) {
    this._renderListeners.add(fn);
    return () => this._renderListeners.delete(fn);
  }

  onFixedTick(fn) {
    this._fixedListeners.add(fn);
    return () => this._fixedListeners.delete(fn);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastNow = performance.now();
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  get totalSec() {
    return this._totalSec;
  }

  // Test hook: drive the clock manually without rAF. Tests pass in a
  // `now` value (ms) and the clock advances exactly as if rAF had fired.
  step(nowMs) {
    this._advance(nowMs);
  }

  _tick(now) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(this._tick);
    this._advance(now ?? performance.now());
  }

  _advance(now) {
    const rawDt = (now - this._lastNow) / 1000;
    const dt = Math.min(this._maxDt, Math.max(0, rawDt));
    this._lastNow = now;
    this._totalSec += dt;

    // Fixed-step accumulator. While there are no fixed listeners, we still
    // accumulate so subscribers added later don't see a giant first dt.
    if (this._fixedListeners.size > 0) {
      this._fixedAccum += dt;
      // Cap accumulator drift to prevent spiral-of-death on long stalls.
      const maxAccum = this._fixedDt * 5;
      if (this._fixedAccum > maxAccum) this._fixedAccum = maxAccum;
      while (this._fixedAccum >= this._fixedDt) {
        this._fixedAccum -= this._fixedDt;
        for (const fn of this._fixedListeners) fn(this._fixedDt, this._totalSec);
      }
    }

    for (const fn of this._renderListeners) fn(dt, this._totalSec);
  }
}
