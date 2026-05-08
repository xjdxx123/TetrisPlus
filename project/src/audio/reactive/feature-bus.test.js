import { describe, it, expect, vi } from 'vitest';
import { createFeatureBus, ONSET_NAMES } from './feature-bus.js';

// Build a minimal AnalyserNode-shaped stub. The FeatureBus only calls
// getByteFrequencyData and reads frequencyBinCount + fftSize.
function makeAnalyserStub({ fftSize = 1024, sampleRate = 48000 } = {}) {
  const binCount = fftSize / 2;
  const bins = new Uint8Array(binCount);
  return {
    fftSize,
    frequencyBinCount: binCount,
    getByteFrequencyData(out) { out.set(bins); },
    // Test helper — set a fixed energy across a frequency band.
    _setBand(loHz, hiHz, value0to255) {
      const binWidth = sampleRate / fftSize;
      const lo = Math.floor(loHz / binWidth);
      const hi = Math.ceil(hiHz / binWidth);
      for (let i = lo; i < hi && i < binCount; i++) bins[i] = value0to255;
    },
    _zero() { for (let i = 0; i < binCount; i++) bins[i] = 0; },
  };
}

function makeAudioStub(analyser, sampleRate = 48000) {
  return {
    get analyser() { return analyser; },
    get sampleRate() { return sampleRate; },
  };
}

// Run N frames of tick(); returns the feature instance.
function tickN(feature, n, dtSec = 1 / 60) {
  for (let i = 0; i < n; i++) feature.tick(dtSec);
}

describe('FeatureBus — onset channels', () => {
  it('exposes the documented onset channel names', () => {
    expect(ONSET_NAMES).toEqual(['kick', 'snare', 'generic']);
  });

  it('exposes feature.onsets.on / unsubscribe / names', () => {
    const analyser = makeAnalyserStub();
    const feature = createFeatureBus({ audio: makeAudioStub(analyser) });
    expect(typeof feature.onsets.on).toBe('function');
    expect(feature.onsets.names).toEqual(['kick', 'snare', 'generic']);
    const fn = vi.fn();
    const off = feature.onsets.on('kick', fn);
    expect(typeof off).toBe('function');
    off();
  });

  it('throws on unknown onset channel', () => {
    const analyser = makeAnalyserStub();
    const feature = createFeatureBus({ audio: makeAudioStub(analyser) });
    expect(() => feature.onsets.on('clap', () => {})).toThrow();
    expect(() => feature.onsets.on('kick', null)).toThrow();
  });

  it('does not fire onsets before the analyser binds', () => {
    // Analyser missing — tick should be a safe no-op.
    const feature = createFeatureBus({ audio: { analyser: null, sampleRate: 0 } });
    const fn = vi.fn();
    feature.onsets.on('kick', fn);
    tickN(feature, 60);
    expect(fn).not.toHaveBeenCalled();
    expect(feature.isBound).toBe(false);
  });

  it('fires onsets.kick when bass-band flux spikes after warmup', () => {
    const analyser = makeAnalyserStub();
    const feature = createFeatureBus({ audio: makeAudioStub(analyser) });
    const fn = vi.fn();
    feature.onsets.on('kick', fn);

    // Warmup: 30 quiet frames so the detector window fills with zeros.
    analyser._zero();
    tickN(feature, 30);
    expect(fn).not.toHaveBeenCalled();

    // Drop a sharp bass-band spike — single loud frame.
    analyser._setBand(60, 200, 230);
    feature.tick(1 / 60);
    // Quiet again so the rising edge ends.
    analyser._zero();
    tickN(feature, 4);

    expect(fn).toHaveBeenCalled();
    // Strength is in [0,1].
    const strength = fn.mock.calls[0][0];
    expect(strength).toBeGreaterThan(0);
    expect(strength).toBeLessThanOrEqual(1);
  });

  it('telemetry records last fire time + strength', () => {
    const analyser = makeAnalyserStub();
    const feature = createFeatureBus({ audio: makeAudioStub(analyser) });
    feature.onsets.on('kick', () => {});

    analyser._zero();
    tickN(feature, 30);
    expect(feature.onsets.telemetry('kick').lastFireAtSec).toBe(-Infinity);

    analyser._setBand(60, 200, 230);
    feature.tick(1 / 60);
    analyser._zero();
    feature.tick(1 / 60);

    const tele = feature.onsets.telemetry('kick');
    expect(tele.lastFireAtSec).toBeGreaterThan(0);
    expect(tele.lastFireAtSec).toBeLessThanOrEqual(feature.totalSec);
    expect(tele.lastStrength).toBeGreaterThan(0);
  });

  it('isolates channels — a snare-band hit does not fire kick', () => {
    const analyser = makeAnalyserStub();
    const feature = createFeatureBus({ audio: makeAudioStub(analyser) });
    const onKick  = vi.fn();
    const onSnare = vi.fn();
    feature.onsets.on('kick',  onKick);
    feature.onsets.on('snare', onSnare);

    analyser._zero();
    tickN(feature, 30);

    // Hit the snare band only (500–2000 Hz).
    analyser._zero();
    analyser._setBand(500, 2000, 230);
    feature.tick(1 / 60);
    analyser._zero();
    tickN(feature, 4);

    expect(onSnare).toHaveBeenCalled();
    expect(onKick).not.toHaveBeenCalled();
  });

  it('unsubscribed handlers do not fire', () => {
    const analyser = makeAnalyserStub();
    const feature = createFeatureBus({ audio: makeAudioStub(analyser) });
    const fn = vi.fn();
    const off = feature.onsets.on('kick', fn);

    analyser._zero();
    tickN(feature, 30);
    off();

    analyser._setBand(60, 200, 230);
    feature.tick(1 / 60);
    analyser._zero();
    tickN(feature, 4);

    expect(fn).not.toHaveBeenCalled();
  });

  it('a throwing handler does not block sibling handlers', () => {
    const analyser = makeAnalyserStub();
    const feature = createFeatureBus({ audio: makeAudioStub(analyser) });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    feature.onsets.on('kick', bad);
    feature.onsets.on('kick', good);

    analyser._zero();
    tickN(feature, 30);
    analyser._setBand(60, 200, 230);
    feature.tick(1 / 60);
    analyser._zero();
    tickN(feature, 4);

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
