import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';
import { registerDirector, createLineClearOrchestrator } from './director.js';

const stubApi = (overrides = {}) => ({
  impactRing: vi.fn(),
  hardDropTrail: vi.fn(),
  sfx: vi.fn(),
  levelUpFx: vi.fn(),
  ...overrides,
});

const stubLayers = () => ({
  sparkle:   vi.fn(),
  flash:     vi.fn(),
  shockwave: vi.fn(),
  veil:      vi.fn(),
});

// Mirrors the shape exported by config/stages.js so the orchestrator's
// spec-shape coupling is exercised end-to-end without pulling in real stages.
const stubStage = (recipe) => ({
  spec: { clearRecipe: recipe },
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

  it('skips LINE_CLEAR wiring when stage/layer api is absent', () => {
    // Old call sites without stage controller still get HARD_DROP/LEVEL_UP
    // but emitting LINE_CLEAR is a no-op (no throw, no spawn).
    const bus = new EventBus();
    const api = stubApi();
    registerDirector(bus, api);
    expect(() => {
      bus.emit(EVENTS.LINE_CLEAR, {
        rows: [0, 1, 2, 3], simultaneous: 4, colors: [0, 0, 0, 0], overallColor: 0xffffff, scoreDelta: 800,
      });
    }).not.toThrow();
  });

  it('runs in pure Node — no THREE / no DOM imports', () => {
    // Implicit test: this file imports director.js. If director leaked a
    // THREE or DOM dependency, the test would crash at import time. The
    // assertion below just makes the intent visible.
    expect(typeof registerDirector).toBe('function');
  });
});

describe('LineClearOrchestrator', () => {
  it('throws if stageController or layers missing', () => {
    expect(() => createLineClearOrchestrator({})).toThrow();
    expect(() => createLineClearOrchestrator({ stageController: stubStage({}) })).toThrow();
    expect(() => createLineClearOrchestrator({ lineClearLayers: stubLayers() })).toThrow();
  });

  it('on tetris with all flags true, fires every layer once', () => {
    const layers = stubLayers();
    const stage = stubStage({
      tetris: { sparkle: true, flash: true, shockwave: true, veil: true },
    });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers });

    orch.onClear({
      rows: [3, 2, 1, 0], simultaneous: 4,
      colors: [0xff0000, 0x00ff00, 0x0000ff, 0xffff00],
      overallColor: 0x808080,
    });

    expect(layers.sparkle).toHaveBeenCalledTimes(1);
    expect(layers.flash).toHaveBeenCalledTimes(1);
    expect(layers.shockwave).toHaveBeenCalledTimes(1);
    expect(layers.veil).toHaveBeenCalledTimes(1);

    // Sparkle and flash get the per-row colors
    expect(layers.sparkle).toHaveBeenCalledWith([3, 2, 1, 0], [0xff0000, 0x00ff00, 0x0000ff, 0xffff00]);
    expect(layers.flash).toHaveBeenCalledWith([3, 2, 1, 0], [0xff0000, 0x00ff00, 0x0000ff, 0xffff00]);
    // Shockwave gets overall color + row count
    expect(layers.shockwave).toHaveBeenCalledWith([3, 2, 1, 0], 0x808080, 4);
    // Veil gets just the row count
    expect(layers.veil).toHaveBeenCalledWith(4);
  });

  it('on a single (recipe: sparkle only) gates flash/shockwave/veil OFF', () => {
    const layers = stubLayers();
    const stage = stubStage({
      single: { sparkle: true, flash: false, shockwave: false, veil: false },
    });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers });

    orch.onClear({ rows: [5], simultaneous: 1, colors: [0x6cf0ff], overallColor: 0x6cf0ff });

    expect(layers.sparkle).toHaveBeenCalledTimes(1);
    expect(layers.flash).not.toHaveBeenCalled();
    expect(layers.shockwave).not.toHaveBeenCalled();
    expect(layers.veil).not.toHaveBeenCalled();
  });

  it('on a triple (recipe: sparkle + shockwave) skips flash + veil', () => {
    const layers = stubLayers();
    const stage = stubStage({
      triple: { sparkle: true, flash: false, shockwave: true, veil: false },
    });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers });

    orch.onClear({ rows: [7, 6, 5], simultaneous: 3, colors: [1, 2, 3], overallColor: 0x6cf0ff });

    expect(layers.sparkle).toHaveBeenCalledTimes(1);
    expect(layers.shockwave).toHaveBeenCalledTimes(1);
    expect(layers.flash).not.toHaveBeenCalled();
    expect(layers.veil).not.toHaveBeenCalled();
  });

  it('falls back to white when overallColor missing on a shockwave-firing tier', () => {
    const layers = stubLayers();
    const stage = stubStage({
      tetris: { sparkle: false, flash: false, shockwave: true, veil: false },
    });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers });

    orch.onClear({ rows: [3, 2, 1, 0], simultaneous: 4, colors: [0, 0, 0, 0] });

    expect(layers.shockwave).toHaveBeenCalledWith([3, 2, 1, 0], 0xffffff, 4);
  });

  it('no-ops cleanly when the recipe has no entry for the tier', () => {
    const layers = stubLayers();
    // Only "single" defined — a tetris should hit the missing-recipe early-return.
    const stage = stubStage({
      single: { sparkle: true, flash: false, shockwave: false, veil: false },
    });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers });

    expect(() =>
      orch.onClear({ rows: [3, 2, 1, 0], simultaneous: 4, colors: [0, 0, 0, 0], overallColor: 0xffffff })
    ).not.toThrow();
    expect(layers.sparkle).not.toHaveBeenCalled();
  });

  it('no-ops cleanly when individual layer callbacks are missing', () => {
    const stage = stubStage({
      tetris: { sparkle: true, flash: true, shockwave: true, veil: true },
    });
    // Only sparkle is wired — the orchestrator must not throw on the others.
    const partialLayers = { sparkle: vi.fn() };
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: partialLayers });

    expect(() =>
      orch.onClear({ rows: [3, 2, 1, 0], simultaneous: 4, colors: [0, 0, 0, 0], overallColor: 0x808080 })
    ).not.toThrow();
    expect(partialLayers.sparkle).toHaveBeenCalled();
  });

  it('wires through registerDirector → bus → orchestrator end-to-end', () => {
    const bus = new EventBus();
    const layers = stubLayers();
    const stage = stubStage({
      tetris: { sparkle: true, flash: true, shockwave: true, veil: true },
      single: { sparkle: true, flash: false, shockwave: false, veil: false },
    });
    registerDirector(bus, stubApi({ stageController: stage, lineClearLayers: layers }));

    bus.emit(EVENTS.LINE_CLEAR, {
      rows: [0], simultaneous: 1, colors: [0xaee7ff], overallColor: 0xaee7ff, scoreDelta: 100,
    });
    expect(layers.sparkle).toHaveBeenCalledTimes(1);
    expect(layers.flash).not.toHaveBeenCalled();

    bus.emit(EVENTS.LINE_CLEAR, {
      rows: [3, 2, 1, 0], simultaneous: 4, colors: [1, 2, 3, 4], overallColor: 0x808080, scoreDelta: 800,
    });
    expect(layers.sparkle).toHaveBeenCalledTimes(2);
    expect(layers.flash).toHaveBeenCalledTimes(1);
    expect(layers.shockwave).toHaveBeenCalledTimes(1);
    expect(layers.veil).toHaveBeenCalledTimes(1);
  });
});

// ===================================================================
// Beat-quantized scheduling. The orchestrator routes the peripheral
// layers (flash/shockwave/veil/envReaction) through `beatGrid.scheduleAt`
// when the next beat is within the quantization window. Sparkle always
// fires immediately because it's coupled to the cleared-row cascade.
// ===================================================================
describe('LineClearOrchestrator — beat quantization', () => {
  // Minimal beat-grid stub — exposes the four properties the orchestrator
  // reads. `scheduleAt` records calls; we manually invoke pending callbacks
  // in tests to simulate the beat firing.
  const stubBeatGrid = ({ analyzed = true, secondsUntilNextBeat = 0.10 } = {}) => {
    const pending = [];
    return {
      get isAnalyzed() { return analyzed; },
      secondsUntilNextBeat,
      nextBeatTimeSec: 100 + secondsUntilNextBeat,
      scheduleAt: vi.fn((_at, fn) => pending.push(fn)),
      _firePending() { for (const fn of pending) fn(); pending.length = 0; },
    };
  };

  it('schedules flash/shockwave/veil to the next beat when in-window', () => {
    const layers = stubLayers();
    layers.envReaction = vi.fn();
    const stage = {
      spec: {
        accentHex: 0x6cf0ff,
        clearRecipe: { tetris: { sparkle: true, flash: true, shockwave: true, veil: true, envReaction: true } },
      },
    };
    const beatGrid = stubBeatGrid({ secondsUntilNextBeat: 0.10 });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers, beatGrid });

    orch.onClear({ rows: [3, 2, 1, 0], simultaneous: 4, colors: [1, 2, 3, 4], overallColor: 0x808080 });

    // Sparkle fires immediately (cascade-coupled).
    expect(layers.sparkle).toHaveBeenCalledTimes(1);
    // Peripheral layers are scheduled, not fired yet.
    expect(layers.flash).not.toHaveBeenCalled();
    expect(layers.shockwave).not.toHaveBeenCalled();
    expect(layers.veil).not.toHaveBeenCalled();
    expect(layers.envReaction).not.toHaveBeenCalled();
    expect(beatGrid.scheduleAt).toHaveBeenCalledTimes(4);

    // Simulating the beat firing dispatches all four scheduled callbacks.
    beatGrid._firePending();
    expect(layers.flash).toHaveBeenCalledTimes(1);
    expect(layers.shockwave).toHaveBeenCalledTimes(1);
    expect(layers.veil).toHaveBeenCalledTimes(1);
    expect(layers.envReaction).toHaveBeenCalledTimes(1);
    // Color routing is preserved through the schedule wrapper.
    expect(layers.envReaction).toHaveBeenCalledWith([3, 2, 1, 0], 0x6cf0ff, 4);
  });

  it('falls back to immediate firing when next beat is outside the window', () => {
    const layers = stubLayers();
    const stage = stubStage({
      tetris: { sparkle: true, flash: true, shockwave: true, veil: true },
    });
    // 350ms is past the 200ms quantize window — should fire now, not defer.
    const beatGrid = stubBeatGrid({ secondsUntilNextBeat: 0.35 });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers, beatGrid });

    orch.onClear({ rows: [3, 2, 1, 0], simultaneous: 4, colors: [1, 2, 3, 4], overallColor: 0x808080 });

    expect(beatGrid.scheduleAt).not.toHaveBeenCalled();
    expect(layers.flash).toHaveBeenCalledTimes(1);
    expect(layers.shockwave).toHaveBeenCalledTimes(1);
    expect(layers.veil).toHaveBeenCalledTimes(1);
  });

  it('falls back to immediate firing when beat-grid is unanalyzed', () => {
    const layers = stubLayers();
    const stage = stubStage({
      tetris: { sparkle: true, flash: true, shockwave: true, veil: true },
    });
    const beatGrid = stubBeatGrid({ analyzed: false, secondsUntilNextBeat: 0.05 });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers, beatGrid });

    orch.onClear({ rows: [3, 2, 1, 0], simultaneous: 4, colors: [1, 2, 3, 4], overallColor: 0x808080 });

    expect(beatGrid.scheduleAt).not.toHaveBeenCalled();
    expect(layers.flash).toHaveBeenCalledTimes(1);
    expect(layers.shockwave).toHaveBeenCalledTimes(1);
  });

  it('still works without a beatGrid argument (legacy call sites)', () => {
    const layers = stubLayers();
    const stage = stubStage({
      tetris: { sparkle: true, flash: true, shockwave: true, veil: true },
    });
    const orch = createLineClearOrchestrator({ stageController: stage, lineClearLayers: layers });

    orch.onClear({ rows: [3, 2, 1, 0], simultaneous: 4, colors: [1, 2, 3, 4], overallColor: 0x808080 });

    expect(layers.flash).toHaveBeenCalledTimes(1);
    expect(layers.shockwave).toHaveBeenCalledTimes(1);
    expect(layers.veil).toHaveBeenCalledTimes(1);
  });
});
