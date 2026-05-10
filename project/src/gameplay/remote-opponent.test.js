// RemoteOpponent tests — same surface as BotController; adds wire-
// receive entry point + diagnostic counters.

import { describe, it, expect } from 'vitest';
import { EMPTY_FRAME } from '../input/intents.js';
import { RemoteOpponent } from './remote-opponent.js';

const FRAME_LEFT      = { ...EMPTY_FRAME, left: true };
const FRAME_RIGHT     = { ...EMPTY_FRAME, right: true };
const FRAME_HARD_DROP = { ...EMPTY_FRAME, hardDrop: true };

describe('RemoteOpponent — basic surface', () => {
  it('initializes with EMPTY_FRAME held + tick=0', () => {
    const ro = new RemoteOpponent();
    expect(ro.currentTick).toBe(0);
    expect(ro.bufferedCount).toBe(0);
    expect(ro.tick(16.67)).toEqual(EMPTY_FRAME);
    expect(ro.currentTick).toBe(1); // advanced by tick()
  });

  it('returns the frame at the matching tick when the wire delivered it', () => {
    const ro = new RemoteOpponent();
    ro.receiveFrame(0, FRAME_LEFT);
    ro.receiveFrame(1, FRAME_RIGHT);
    expect(ro.tick(16.67)).toEqual(FRAME_LEFT);
    expect(ro.tick(16.67)).toEqual(FRAME_RIGHT);
  });

  it('holds the last received frame across gaps in delivery', () => {
    const ro = new RemoteOpponent();
    ro.receiveFrame(0, FRAME_LEFT);
    // Tick 1, 2, 3 have no arriving frame — RemoteOpponent must
    // hold FRAME_LEFT instead of dropping to EMPTY_FRAME (the wire's
    // "send only on change" pattern means absence = state unchanged).
    expect(ro.tick(16.67)).toEqual(FRAME_LEFT);
    expect(ro.tick(16.67)).toEqual(FRAME_LEFT);
    expect(ro.tick(16.67)).toEqual(FRAME_LEFT);
    expect(ro.tick(16.67)).toEqual(FRAME_LEFT);
  });

  it('reset clears buffer + held frame + tick counter', () => {
    const ro = new RemoteOpponent();
    ro.receiveFrame(0, FRAME_LEFT);
    ro.tick(16.67);
    ro.receiveFrame(10, FRAME_RIGHT);
    expect(ro.currentTick).toBe(1);
    expect(ro.bufferedCount).toBe(1); // future frame still queued
    ro.reset();
    expect(ro.currentTick).toBe(0);
    expect(ro.bufferedCount).toBe(0);
    expect(ro.tick(16.67)).toEqual(EMPTY_FRAME);
  });
});

describe('RemoteOpponent — defensive', () => {
  it('rejects non-integer / negative ticks on receiveFrame', () => {
    const ro = new RemoteOpponent();
    ro.receiveFrame(-1, FRAME_LEFT);
    ro.receiveFrame(1.5, FRAME_LEFT);
    ro.receiveFrame(NaN, FRAME_LEFT);
    expect(ro.bufferedCount).toBe(0);
  });

  it('rejects null/undefined frames on receiveFrame', () => {
    const ro = new RemoteOpponent();
    ro.receiveFrame(0, null);
    ro.receiveFrame(0, undefined);
    expect(ro.bufferedCount).toBe(0);
  });

  it('drops re-deliveries of already-consumed ticks (transport may dup under retry)', () => {
    const ro = new RemoteOpponent();
    ro.receiveFrame(0, FRAME_LEFT);
    ro.tick(16.67); // consumes tick 0
    expect(ro.currentTick).toBe(1);
    // A late re-delivery for tick 0 must NOT replay the past.
    ro.receiveFrame(0, FRAME_HARD_DROP);
    expect(ro.bufferedCount).toBe(0);
  });

  it('defensive-copies the frame so the caller can mutate post-receive', () => {
    const ro = new RemoteOpponent();
    const live = { ...FRAME_LEFT };
    ro.receiveFrame(0, live);
    live.left = false; // caller mutates AFTER handing over
    live.right = true;
    expect(ro.tick(16.67).left).toBe(true); // unaffected
    expect(ro.tick(16.67).left).toBe(true); // (held — no new frame)
  });
});

describe('RemoteOpponent — diagnostics', () => {
  it('hitRate = 1.0 when every tick has an arriving frame', () => {
    const ro = new RemoteOpponent();
    for (let t = 0; t < 10; t++) ro.receiveFrame(t, FRAME_LEFT);
    for (let t = 0; t < 10; t++) ro.tick(16.67);
    expect(ro.hitCount).toBe(10);
    expect(ro.holdCount).toBe(0);
    expect(ro.hitRate).toBe(1.0);
  });

  it('hitRate degrades as the wire drops frames', () => {
    const ro = new RemoteOpponent();
    // Receive only every other frame (50% loss simulation).
    for (let t = 0; t < 10; t += 2) ro.receiveFrame(t, FRAME_LEFT);
    for (let t = 0; t < 10; t++) ro.tick(16.67);
    expect(ro.hitCount).toBe(5);
    expect(ro.holdCount).toBe(5);
    expect(ro.hitRate).toBeCloseTo(0.5, 2);
  });

  it('hitRate = 1.0 (defensive) when no ticks have run yet', () => {
    const ro = new RemoteOpponent();
    expect(ro.hitRate).toBe(1.0);
  });
});

describe('RemoteOpponent — interface parity with BotController', () => {
  it('exposes tick(dtMs) returning an InputFrame + reset()', () => {
    const ro = new RemoteOpponent();
    expect(typeof ro.tick).toBe('function');
    expect(typeof ro.reset).toBe('function');
    const frame = ro.tick(16.67);
    // Returned shape has all 8 InputFrame fields.
    for (const key of ['left','right','softDrop','hardDrop','rotateCW','rotateCCW','hold','pause']) {
      expect(typeof frame[key]).toBe('boolean');
    }
  });
});
