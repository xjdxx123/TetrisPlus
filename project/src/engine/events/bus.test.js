import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './bus.js';

describe('EventBus', () => {
  it('dispatches synchronously to all listeners', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('TEST', a);
    bus.on('TEST', b);
    bus.emit('TEST', { x: 1 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(a.mock.calls[0][0]).toEqual({ x: 1 });
  });

  it('freezes object payloads to prevent handler mutation', () => {
    const bus = new EventBus();
    let received;
    bus.on('TEST', (p) => { received = p; });
    bus.emit('TEST', { x: 1 });
    expect(Object.isFrozen(received)).toBe(true);
  });

  it('replays last N events to late subscribers when requested', () => {
    const bus = new EventBus({ replayBufferSize: 3 });
    bus.emit('LINE_CLEAR', { rows: 1 });
    bus.emit('LINE_CLEAR', { rows: 2 });
    bus.emit('LINE_CLEAR', { rows: 4 });
    bus.emit('LINE_CLEAR', { rows: 1 }); // pushes oldest out

    const seen = [];
    bus.on('LINE_CLEAR', (p) => seen.push(p.rows), { replay: true });
    expect(seen).toEqual([2, 4, 1]);
  });

  it('unsubscribe via returned function works mid-dispatch', () => {
    const bus = new EventBus();
    const off = bus.on('T', () => off()); // self-unsubscribes
    const after = vi.fn();
    bus.on('T', after);
    bus.emit('T', null);
    bus.emit('T', null);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('handler exceptions are caught and other handlers still run', () => {
    const bus = new EventBus();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const survivor = vi.fn();
    bus.on('T', () => { throw new Error('boom'); });
    bus.on('T', survivor);
    bus.emit('T', null);
    expect(survivor).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('records emit history for debug', () => {
    const bus = new EventBus();
    bus.emit('A', { v: 1 });
    bus.emit('B', { v: 2 });
    const hist = bus.history();
    expect(hist).toHaveLength(2);
    expect(hist[0].topic).toBe('A');
    expect(hist[1].payload.v).toBe(2);
  });
});
