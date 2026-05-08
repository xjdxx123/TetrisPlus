import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../engine/events/bus.js';
import { createStageController, STAGE_EVENTS } from './stage-controller.js';
import { STAGE_NAMES, DEFAULT_STAGE } from '../config/stages.js';

describe('stage-controller', () => {
  it('starts on the default stage', () => {
    const bus = new EventBus();
    const sc = createStageController({ bus });
    expect(sc.current).toBe(DEFAULT_STAGE);
    expect(sc.spec).toBeDefined();
  });

  it('honors initial stage if provided', () => {
    const bus = new EventBus();
    const sc = createStageController({ bus, initial: 'ember-rise' });
    expect(sc.current).toBe('ember-rise');
  });

  it('falls back to DEFAULT_STAGE if initial is unknown', () => {
    const bus = new EventBus();
    const sc = createStageController({ bus, initial: 'no-such-stage' });
    expect(sc.current).toBe(DEFAULT_STAGE);
  });

  it('set() emits STAGE_CHANGE with from/to/spec', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(STAGE_EVENTS.STAGE_CHANGE, handler);
    const sc = createStageController({ bus, initial: 'cyan-void' });
    sc.set('aurora');
    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.from).toBe('cyan-void');
    expect(payload.to).toBe('aurora');
    expect(payload.spec).toBeDefined();
    expect(payload.spec.nebulaPalette).toBe('aurora');
  });

  it('set() to current stage is a no-op', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(STAGE_EVENTS.STAGE_CHANGE, handler);
    const sc = createStageController({ bus, initial: 'cyan-void' });
    sc.set('cyan-void');
    expect(handler).not.toHaveBeenCalled();
  });

  it('set() to unknown stage warns and is a no-op', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.on(STAGE_EVENTS.STAGE_CHANGE, handler);
    const sc = createStageController({ bus });
    sc.set('no-such-stage');
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('cycle() advances through STAGE_NAMES round-robin', () => {
    const bus = new EventBus();
    const sc = createStageController({ bus });
    const seen = [sc.current];
    for (let i = 0; i < STAGE_NAMES.length + 1; i++) {
      sc.cycle();
      seen.push(sc.current);
    }
    // After N cycles we should be back at the start.
    expect(seen[0]).toBe(seen[STAGE_NAMES.length]);
    // And we should have visited each unique stage at least once.
    expect(new Set(seen).size).toBe(STAGE_NAMES.length);
  });
});
