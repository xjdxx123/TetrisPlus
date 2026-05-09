// Tests for the input intents module (plan_gameplay_1.md §3.7 sub-phase 7c).

import { describe, it, expect } from 'vitest';
import {
  InputRouter,
  KEYMAP_PRESETS,
  EMPTY_FRAME,
  INTENT_ACTIONS,
  buildCodeIndex,
  findKeymapConflicts,
} from './intents.js';

/**
 * Lightweight EventTarget-shaped fake. We only need add/remove
 * EventListener and a way to dispatch synthetic events.
 */
function makeFakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn)    {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, payload) {
      const event = {
        code: payload.code,
        preventDefault() { this.defaultPrevented = true; },
        defaultPrevented: false,
      };
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of set) fn(event);
      return event;
    },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}

describe('intents — keymap presets', () => {
  it('exposes player + opponent presets', () => {
    expect(KEYMAP_PRESETS.player).toBeTruthy();
    expect(KEYMAP_PRESETS.opponent).toBeTruthy();
    for (const action of INTENT_ACTIONS) {
      expect(Array.isArray(KEYMAP_PRESETS.player[action])).toBe(true);
    }
  });

  it('player + opponent keymaps do not conflict', () => {
    const conflicts = findKeymapConflicts(KEYMAP_PRESETS.player, KEYMAP_PRESETS.opponent);
    expect(conflicts).toEqual([]);
  });

  it('findKeymapConflicts surfaces overlapping codes', () => {
    const a = { left: ['ArrowLeft'], right: [] };
    const b = { left: [], right: ['ArrowLeft'] };
    expect(findKeymapConflicts(a, b)).toEqual(['ArrowLeft']);
  });
});

describe('intents — buildCodeIndex', () => {
  it('flattens action → codes map into code → action lookup', () => {
    const idx = buildCodeIndex({ left: ['ArrowLeft'], rotateCW: ['ArrowUp', 'KeyX'] });
    expect(idx.get('ArrowLeft')).toBe('left');
    expect(idx.get('ArrowUp')).toBe('rotateCW');
    expect(idx.get('KeyX')).toBe('rotateCW');
    expect(idx.has('KeyZ')).toBe(false);
  });

  it('handles missing keymap entries safely', () => {
    expect(buildCodeIndex(null).size).toBe(0);
    expect(buildCodeIndex({}).size).toBe(0);
    expect(buildCodeIndex({ left: undefined }).size).toBe(0);
  });
});

describe('InputRouter — held inputs (left / right / softDrop)', () => {
  it('tracks held state across frame() calls', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    expect(r.frame()).toEqual(EMPTY_FRAME);

    t.dispatch('keydown', { code: 'ArrowLeft' });
    expect(r.frame().left).toBe(true);
    // Still held next frame — held intents persist across frames.
    expect(r.frame().left).toBe(true);

    t.dispatch('keyup', { code: 'ArrowLeft' });
    expect(r.frame().left).toBe(false);

    r.dispose();
  });

  it('multiple held keys coexist', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    t.dispatch('keydown', { code: 'ArrowRight' });
    t.dispatch('keydown', { code: 'ArrowDown' });
    const f = r.frame();
    expect(f.right).toBe(true);
    expect(f.softDrop).toBe(true);
    r.dispose();
  });
});

describe('InputRouter — discrete inputs (rotate / hardDrop / hold / pause)', () => {
  it('hardDrop fires once per keydown', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    t.dispatch('keydown', { code: 'Space' });
    expect(r.frame().hardDrop).toBe(true);
    // Subsequent frames: false (latched, then cleared)
    expect(r.frame().hardDrop).toBe(false);
    r.dispose();
  });

  it('held discrete keys do NOT auto-repeat', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    // Browsers fire keydown repeatedly while held. The router
    // suppresses repeats by checking the held-action set.
    t.dispatch('keydown', { code: 'KeyZ' });
    t.dispatch('keydown', { code: 'KeyZ' });
    t.dispatch('keydown', { code: 'KeyZ' });
    expect(r.frame().rotateCCW).toBe(true);
    expect(r.frame().rotateCCW).toBe(false);
    // Release + repress fires again.
    t.dispatch('keyup',   { code: 'KeyZ' });
    t.dispatch('keydown', { code: 'KeyZ' });
    expect(r.frame().rotateCCW).toBe(true);
    r.dispose();
  });

  it('rotateCW alias keys (ArrowUp + KeyX) both fire the same intent', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    t.dispatch('keydown', { code: 'ArrowUp' });
    expect(r.frame().rotateCW).toBe(true);
    t.dispatch('keyup',   { code: 'ArrowUp' });
    t.dispatch('keydown', { code: 'KeyX' });
    expect(r.frame().rotateCW).toBe(true);
    r.dispose();
  });
});

describe('InputRouter — preventDefault', () => {
  it('calls preventDefault on matched codes by default', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    const event = t.dispatch('keydown', { code: 'ArrowLeft' });
    expect(event.defaultPrevented).toBe(true);
    r.dispose();
  });

  it('skips preventDefault when opt-out', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t, preventDefault: false });
    const event = t.dispatch('keydown', { code: 'ArrowLeft' });
    expect(event.defaultPrevented).toBe(false);
    r.dispose();
  });

  it('ignores unmapped codes', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    const event = t.dispatch('keydown', { code: 'F1' });
    expect(event.defaultPrevented).toBe(false);
    expect(r.frame()).toEqual(EMPTY_FRAME);
    r.dispose();
  });
});

describe('InputRouter — opponent preset (P2)', () => {
  it('A/D/S map to left/right/softDrop on the opponent keymap', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t, side: 'opponent' });
    t.dispatch('keydown', { code: 'KeyA' });
    t.dispatch('keydown', { code: 'KeyS' });
    const f = r.frame();
    expect(f.left).toBe(true);
    expect(f.softDrop).toBe(true);
    r.dispose();
  });

  it('player keys (ArrowLeft) are ignored on opponent router', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t, side: 'opponent' });
    t.dispatch('keydown', { code: 'ArrowLeft' });
    expect(r.frame()).toEqual(EMPTY_FRAME);
    r.dispose();
  });
});

describe('InputRouter — clear / setKeymap / dispose', () => {
  it('clear() drops held + fired state', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    t.dispatch('keydown', { code: 'ArrowLeft' });
    t.dispatch('keydown', { code: 'Space' });
    r.clear();
    expect(r.frame()).toEqual(EMPTY_FRAME);
    r.dispose();
  });

  it('setKeymap rebinds and clears held state', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    t.dispatch('keydown', { code: 'ArrowLeft' });
    r.setKeymap({ left: ['KeyA'], right: [] });
    expect(r.frame().left).toBe(false);
    t.dispatch('keydown', { code: 'KeyA' });
    expect(r.frame().left).toBe(true);
    r.dispose();
  });

  it('dispose removes the listeners', () => {
    const t = makeFakeTarget();
    const r = new InputRouter({ target: t });
    expect(t.listenerCount('keydown')).toBe(1);
    r.dispose();
    expect(t.listenerCount('keydown')).toBe(0);
    expect(t.listenerCount('keyup')).toBe(0);
  });
});
