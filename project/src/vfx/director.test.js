import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';
import { registerDirector } from './director.js';

const stubApi = () => ({
  impactRing: vi.fn(),
  hardDropTrail: vi.fn(),
  sfx: vi.fn(),
  levelUpFx: vi.fn(),
});

describe('director', () => {
  it('translates HARD_DROP into ring + trail + sfx', () => {
    const bus = new EventBus();
    const api = stubApi();
    registerDirector(bus, api);

    const cells = [{ col: 3, row: 1 }];
    bus.emit(EVENTS.HARD_DROP, {
      ringX: 1.5, ringY: -2, color: 0x22e6ff, cells, dropRows: 7, minRow: 1,
    });

    expect(api.impactRing).toHaveBeenCalledWith(1.5, -2, 0x22e6ff);
    expect(api.hardDropTrail).toHaveBeenCalledWith(cells, 7, 0x22e6ff);
    expect(api.sfx).toHaveBeenCalledWith('drop');
  });

  it('translates LEVEL_UP into levelUpFx', () => {
    const bus = new EventBus();
    const api = stubApi();
    registerDirector(bus, api);

    bus.emit(EVENTS.LEVEL_UP, { level: 5 });

    expect(api.levelUpFx).toHaveBeenCalledWith(5);
    expect(api.impactRing).not.toHaveBeenCalled();
  });

  it('does not respond to events it does not subscribe to', () => {
    const bus = new EventBus();
    const api = stubApi();
    registerDirector(bus, api);

    bus.emit(EVENTS.SCORE_DELTA, { delta: 100, total: 100, source: 'line-clear' });
    bus.emit(EVENTS.PIECE_LOCK, { cells: [], color: 0 });

    expect(api.impactRing).not.toHaveBeenCalled();
    expect(api.hardDropTrail).not.toHaveBeenCalled();
    expect(api.sfx).not.toHaveBeenCalled();
    expect(api.levelUpFx).not.toHaveBeenCalled();
  });

  it('returned stop() detaches all handlers', () => {
    const bus = new EventBus();
    const api = stubApi();
    const stop = registerDirector(bus, api);

    stop();

    bus.emit(EVENTS.HARD_DROP, { ringX: 0, ringY: 0, color: 0, cells: [], dropRows: 1 });
    bus.emit(EVENTS.LEVEL_UP, { level: 2 });

    expect(api.impactRing).not.toHaveBeenCalled();
    expect(api.levelUpFx).not.toHaveBeenCalled();
  });

  it('runs in pure Node — no THREE / no DOM imports', () => {
    // Implicit test: this file imports director.js. If director leaked a
    // THREE or DOM dependency, the test would crash at import time. The
    // assertion below just makes the intent visible.
    expect(typeof registerDirector).toBe('function');
  });
});
