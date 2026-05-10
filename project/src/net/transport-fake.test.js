// FakeTransport tests — pair, deliver, fault injection.

import { describe, it, expect, vi } from 'vitest';
import { FakeTransport, pair } from './transport-fake.js';
import { encodeInput } from './protocol.js';
import { EMPTY_FRAME } from '../input/intents.js';

describe('FakeTransport', () => {
  it('pair() — anything one side sends, the other receives', () => {
    const [a, b] = pair();
    const got = vi.fn();
    b.onMessage(got);
    a.send(encodeInput(0, EMPTY_FRAME));
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0][0].t).toBe('in');
    expect(got.mock.calls[0][0].tick).toBe(0);
  });

  it('outbound[] captures every send for assertions', () => {
    const t = new FakeTransport();
    t.send(encodeInput(0, EMPTY_FRAME));
    t.send(encodeInput(1, EMPTY_FRAME));
    expect(t.outbound).toHaveLength(2);
    expect(t.outbound[0].tick).toBe(0);
    expect(t.outbound[1].tick).toBe(1);
  });

  it('deliver() — manually push a msg into the local handler', () => {
    const t = new FakeTransport();
    const got = vi.fn();
    t.onMessage(got);
    t.deliver(encodeInput(42, EMPTY_FRAME));
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0][0].tick).toBe(42);
  });

  it('JSON-roundtrips on send so the receiver gets a fresh object', () => {
    const [a, b] = pair();
    const captured = [];
    b.onMessage(m => captured.push(m));
    const msg = { t: 'in', tick: 0, frame: { ...EMPTY_FRAME } };
    a.send(msg);
    // Mutating the original after send should NOT affect the
    // received object.
    msg.tick = 999;
    expect(captured[0].tick).toBe(0);
  });

  it('close() drops the peer + handler so subsequent sends go nowhere', () => {
    const [a, b] = pair();
    const got = vi.fn();
    b.onMessage(got);
    a.close();
    a.send(encodeInput(0, EMPTY_FRAME));
    expect(got).not.toHaveBeenCalled();
  });
});

describe('FakeTransport — fault injection', () => {
  it('latency=N delays delivery by N advanceTick() calls', () => {
    const [a, b] = pair();
    a.setFault({ latencyTicks: 3 });
    const got = vi.fn();
    b.onMessage(got);
    a.send(encodeInput(0, EMPTY_FRAME));
    expect(got).not.toHaveBeenCalled();
    a.advanceTick(); expect(got).not.toHaveBeenCalled();
    a.advanceTick(); expect(got).not.toHaveBeenCalled();
    a.advanceTick(); expect(got).toHaveBeenCalledTimes(1);
  });

  it('loss=1 drops every msg (then schedules a retry burst, eventually delivers)', () => {
    const [a, b] = pair();
    a.setFault({ loss: 1, latencyTicks: 1, jitterTicks: 0 });
    const got = vi.fn();
    b.onMessage(got);
    a.send(encodeInput(0, EMPTY_FRAME));
    // Initial delivery suppressed; retry scheduled at delay*2 = 2.
    a.advanceTick();
    expect(got).not.toHaveBeenCalled();
    a.advanceTick();
    // Retry delivered.
    expect(got).toHaveBeenCalledTimes(1);
  });

  it('loss=0 + latency=0 + no jitter = synchronous delivery', () => {
    const [a, b] = pair();
    a.setFault({}); // explicit empty — all defaults to 0
    const got = vi.fn();
    b.onMessage(got);
    a.send(encodeInput(0, EMPTY_FRAME));
    expect(got).toHaveBeenCalledTimes(1);
  });
});
