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
    bgmGain: null,                 // gain stage for BGM through Web Audio
    bgmSource: null,               // MediaElementAudioSourceNode (one per element)
    analyser: null,                // AnalyserNode tap for audio/reactive
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

    // Browsers create AudioContext in "suspended" state under autoplay
    // policy. Without an explicit resume(), the graph processes nothing —
    // BGM through MediaElementSource would route to silence even though
    // playback "started." playSfx/playVoice already resume on demand, but
    // BGM-only sessions never hit those paths.
    if (state.ctx.state === 'suspended') {
      state.ctx.resume().catch(() => { /* gesture may still be required */ });
    }

    // BGM tap (Stage 5 — plan_particle_2.md). Routes the HTMLAudioElement
    // through Web Audio so the analyser can read its spectrum every frame.
    //   <audio> → MediaElementSource → bgmGain → analyser → master → destination
    // BGM volume is still controlled by bgmEl.volume (not bgmGain) so the
    // existing setMuted() semantics keep working unchanged. createMediaElement
    // Source can only be called once per element — wrapped in try/catch in
    // case init() runs twice (HMR, re-entrant boot).
    //
    // *** crossorigin="anonymous" on the <audio> element is REQUIRED ***
    // Without it, the captured audio is silent (analyser reads zeros) even
    // though the element plays normally to the speakers. See tetris.html.
    if (state.bgmEl) {
      state.bgmGain = state.ctx.createGain();
      state.bgmGain.gain.value = 1.0;
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 1024;          // 512 frequency bins
      state.analyser.smoothingTimeConstant = 0; // we do our own smoothing in audio/reactive
      try {
        state.bgmSource = state.ctx.createMediaElementSource(state.bgmEl);
        state.bgmSource.connect(state.bgmGain);
        state.bgmGain.connect(state.analyser);
        state.analyser.connect(state.master);
        console.log('[audio] BGM tap online — analyser bound, fftSize=' + state.analyser.fftSize);
      } catch (e) {
        console.warn('[audio] BGM Web-Audio tap unavailable:', e?.message || e);
        state.analyser = null;  // signal no analyser available
      }
    }

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

  // Stage 5b — exposed so the beat-grid can decode the BGM into an
  // AudioBuffer for offline BPM/downbeat analysis. Null when called before
  // init(); caller must await audio.init() first.
  function decode(arrayBuffer) {
    if (!state.ctx) return Promise.reject(new Error('audio context not ready'));
    return state.ctx.decodeAudioData(arrayBuffer);
  }

  // Stage 5b live-capture path. Builds an AudioRecorder bound to this
  // module's AudioContext and adds it as a PARALLEL tap off bgmGain:
  //
  //                             ┌──► analyser ──► master ──► destination  (audible)
  //                             │
  //   bgm → MediaElement → bgmGain
  //                             │
  //                             └──► recorder ──► sinkGain(g=0) ──► destination  (silent capture)
  //
  // We deliberately do NOT splice in series — a ScriptProcessor returns
  // silence on its output by default (we never write to e.outputBuffer
  // because we only capture), so an in-series splice would mute the BGM.
  // The recorder's internal sinkGain→destination keeps the processor
  // "live" so onaudioprocess fires, without adding to the mix.
  //
  // Returns the recorder + detach() that removes the parallel connection
  // and frees the recorder's internal nodes. Null if init() hasn't run or
  // the BGM tap isn't online.
  async function createBgmRecorder({ durationSec = 20 } = {}) {
    if (!state.ctx || !state.bgmGain) return null;
    let createAudioRecorder;
    try {
      ({ createAudioRecorder } = await import('./reactive/audio-recorder.js'));
    } catch (e) {
      console.warn('[audio] recorder module load failed:', e?.message || e);
      return null;
    }
    let rec;
    try {
      rec = createAudioRecorder({ context: state.ctx, durationSec });
    } catch (e) {
      console.warn('[audio] recorder construction failed:', e?.message || e);
      return null;
    }
    state.bgmGain.connect(rec.node);
    const detach = () => {
      try { state.bgmGain.disconnect(rec.node); } catch { /* ignore */ }
      rec.stop();
    };
    return { recorder: rec, detach };
  }

  return {
    init,
    playVoice,
    playSfx,
    setMuted,
    decode,
    createBgmRecorder,
    get muted() { return state.muted; },
    // Stage 5 — BGM tap for audio/reactive. Null until init() runs (and may
    // remain null if MediaElementSource creation failed). Subscribers must
    // gracefully handle the null case during the first user-gesture window.
    get analyser() { return state.analyser; },
    get sampleRate() { return state.ctx ? state.ctx.sampleRate : 0; },
    get currentTime() { return state.ctx ? state.ctx.currentTime : 0; },
    get ready() { return state.ready; },
    get hasContext() { return !!state.ctx; },
  };
}
