// Audio playback — Web Audio voice playback + procedural SFX synth + BGM.
//
// Two channels:
//   - Voices (announcer clips): decoded into AudioBuffers up-front, played
//     through a BufferSource so the previous voice can be canceled when the
//     next fires (no overlap).
//   - SFX (move/rotate/drop/clear): synthesized at runtime via Web Audio.
//     Each sound is built from up to two voices: a tonal oscillator with a
//     frequency sweep + envelope, and a band-pass filtered noise burst with
//     its own envelope.
//   - BGM: streamed via HTMLAudioElement to avoid keeping the whole decoded
//     PCM (~50 MB for the vaporwave track) in memory.
//
// Browsers gate AudioContext + media playback until the first user gesture,
// so init() is called from the first keydown/pointerdown and from the
// audio-toggle button click.
//
// This module imports nothing visual — no THREE, no React. All DOM contact
// is through the AudioContext + the optional bgmEl element passed in.

const DEFAULT_VOLUMES = { voice: 0.95, bgm: 0.32, sfx: 0.55 };

// Per-name minimum gap (seconds) between consecutive plays. Stops DAS-held
// arrows from firing the move tick at full ARR rate (~22/s) and turning into
// a buzz; rotate/drop/clear are user-paced so don't need a throttle.
const SFX_THROTTLE = { move: 0.04 };

const SFX_SPECS = {
  move: () => {
    // Subtle low square tick, slight pitch wobble so a stream of ticks
    // doesn't sound robotic.
    const wobble = (Math.random() - 0.5) * 30;
    return { osc: { type: 'square', f0: 230 + wobble, f1: 200 + wobble, dur: 0.035, gain: 0.14 } };
  },
  rotate: () => ({
    // Bright upward chirp — reads as "pivot."
    osc: { type: 'triangle', f0: 540, f1: 880, dur: 0.075, gain: 0.22 },
  }),
  drop: () => ({
    // Hard drop: a fast downward sawtooth swoop layered with a low thud.
    osc:   { type: 'sawtooth', f0: 420, f1: 70, dur: 0.18, gain: 0.32 },
    noise: { dur: 0.14, center: 180, Q: 1.4, filter: 'lowpass', gain: 0.22 },
  }),
  clear: (arg) => {
    // Eliminate: glassy shatter — bright triangle sweep + bandpass noise
    // burst. Scales modestly with row count so a Tetris is bigger than a
    // single. arg is the number of cleared rows.
    const rows = Math.max(1, arg | 0);
    const sizeBoost = 1 + (rows - 1) * 0.18;
    return {
      osc:   { type: 'triangle', f0: 700 + 80 * (rows - 1), f1: 180,
               dur: 0.28 + 0.04 * (rows - 1), gain: 0.22 * sizeBoost },
      noise: { dur: 0.34 + 0.05 * (rows - 1), center: 4800, Q: 0.7,
               gain: 0.22 * sizeBoost },
    };
  },
};

export function createAudioPlayback({ voices = {}, bgmEl = null, volumes = {} } = {}) {
  const vol = { ...DEFAULT_VOLUMES, ...volumes };
  const state = {
    ctx: null,
    master: null,
    voiceGain: null,
    sfxGain: null,
    decoded: Object.create(null),  // name -> AudioBuffer
    currentVoice: null,
    bgmEl,
    ready: false,
    muted: false,
    lastSfxAt: Object.create(null),
  };

  async function init() {
    if (state.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    state.ctx = new Ctx();
    state.master = state.ctx.createGain();
    state.master.gain.value = state.muted ? 0 : 1;
    state.master.connect(state.ctx.destination);

    state.voiceGain = state.ctx.createGain();
    state.voiceGain.gain.value = vol.voice;
    state.voiceGain.connect(state.master);

    // Synth bus is created synchronously so playSfx() works immediately, even
    // while voice clips are still being decoded asynchronously below.
    state.sfxGain = state.ctx.createGain();
    state.sfxGain.gain.value = vol.sfx;
    state.sfxGain.connect(state.master);

    // Decode all voice clips in parallel; tolerate individual failures.
    await Promise.all(Object.entries(voices).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('http ' + res.status);
        const buf = await res.arrayBuffer();
        state.decoded[name] = await state.ctx.decodeAudioData(buf);
      } catch (e) {
        console.warn('[audio] failed to load', name, e);
      }
    }));
    state.ready = true;

    // BGM via HTMLAudioElement — caller's element configures loop / preload.
    if (state.bgmEl) {
      state.bgmEl.volume = state.muted ? 0 : vol.bgm;
      state.bgmEl.play().catch(() => {
        // gesture may still be required on some browsers
      });
    }
  }

  function playVoice(name) {
    if (!state.ready || state.muted || !state.decoded[name]) return;
    if (state.ctx.state === 'suspended') state.ctx.resume();
    if (state.currentVoice) {
      try { state.currentVoice.stop(); } catch { /* already finished */ }
      state.currentVoice = null;
    }
    const src = state.ctx.createBufferSource();
    src.buffer = state.decoded[name];
    src.connect(state.voiceGain);
    src.onended = () => { if (state.currentVoice === src) state.currentVoice = null; };
    src.start();
    state.currentVoice = src;
  }

  function _synth(spec) {
    if (!state.sfxGain || state.muted) return;
    const ctx = state.ctx;
    const t0 = ctx.currentTime;
    const dest = state.sfxGain;
    if (spec.osc) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = spec.osc.type || 'sine';
      o.frequency.setValueAtTime(spec.osc.f0, t0);
      if (spec.osc.f1 !== undefined) {
        // Exponential ramp gives the satisfying chirp/whoosh shape; clamp the
        // target away from 0 because exponentialRampToValueAtTime forbids it.
        o.frequency.exponentialRampToValueAtTime(Math.max(0.0001, spec.osc.f1), t0 + spec.osc.dur);
      }
      const peak = spec.osc.gain != null ? spec.osc.gain : 0.3;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.osc.dur);
      o.connect(g).connect(dest);
      o.start(t0);
      o.stop(t0 + spec.osc.dur + 0.05);
    }
    if (spec.noise) {
      const len = Math.max(1, Math.ceil(ctx.sampleRate * spec.noise.dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = spec.noise.filter || 'bandpass';
      filt.frequency.value = spec.noise.center || 4000;
      filt.Q.value = spec.noise.Q != null ? spec.noise.Q : 1.0;
      const g = ctx.createGain();
      const peak = spec.noise.gain != null ? spec.noise.gain : 0.25;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.noise.dur);
      src.connect(filt).connect(g).connect(dest);
      src.start(t0);
      src.stop(t0 + spec.noise.dur + 0.05);
    }
  }

  function playSfx(name, arg) {
    if (!state.sfxGain || state.muted) return;
    const now = state.ctx.currentTime;
    const minGap = SFX_THROTTLE[name];
    if (minGap && now - (state.lastSfxAt[name] || 0) < minGap) return;
    state.lastSfxAt[name] = now;
    if (state.ctx.state === 'suspended') state.ctx.resume();
    const specFn = SFX_SPECS[name];
    if (specFn) _synth(specFn(arg));
  }

  function setMuted(b) {
    state.muted = !!b;
    if (state.master) state.master.gain.value = state.muted ? 0 : 1;
    if (state.bgmEl)  state.bgmEl.volume = state.muted ? 0 : vol.bgm;
  }

  return {
    init,
    playVoice,
    playSfx,
    setMuted,
    get muted() { return state.muted; },
    get ready() { return state.ready; },
    get hasContext() { return !!state.ctx; },
  };
}
