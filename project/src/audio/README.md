# `audio/` — Playback & Reactive Analysis

Two distinct concerns kept apart:

## `audio/` (root) — Playback

- `playback.js` — `AudioContext`, decoded `AudioBuffer` cache, BGM `HTMLAudioElement`, gesture-gated init, ducking.
- `buses.js` — master/music/sfx/voice volume buses.

Public surface: `Audio.play(clipId, opts)`, `Audio.setBus(name, level)`, `Audio.bgm.fade(...)`. Subscribes to gameplay events to decide *what* to play (e.g., announcer voice on big line clears).

## [`audio/reactive/`](./reactive/) — Analysis

- `analyser.js` — `AnalyserNode` tap, raw FFT bins.
- `bands.js` — frequency aggregation: sub, bass, mid, high.
- `beat.js` — peak detector with refractory window, BPM estimate.
- `streams.js` — smoothed parameter streams: `bands.bass.smoothed(attackMs, decayMs)`.

## The forbidden pattern

```js
// ✗ in audio code
glassMaterial.uniforms.uBassPulse.value = bandEnergy.bass;
```

Audio publishes streams and events. It has no `three` import. Bindings to material uniforms live in [`../vfx/reactive/`](../vfx/reactive/).
