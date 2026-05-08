// BGM Playlist — track list, transport controls, transitions.
//
// Owns the rotation through the BGM tracks under `asset/sounds/bgm/`. Wraps
// a single `<audio id="bgmAudio">` element (the same one the audio/playback
// module's MediaElementSource taps for the analyser); writes `src` and
// schedules transitions, never creates new <audio> elements (that would
// duplicate the analyser tap which can only be created once per element).
//
// Transitions are clean fades, not true crossfades — at the cost of ~500ms
// of slight attenuation between tracks we keep the existing single-element
// analyser tap intact. For Vaporwave-style rotations of the same album the
// listener barely notices.
//
// Pure JS. No THREE, no React. Imports nothing else from `src/`. Persistence
// of currentIndex is the caller's job (via onTrackChange).

const DEFAULT_FADE_MS = 250;

/**
 * @typedef {Object} BgmTrack
 * @property {string} url          Absolute or root-relative URL.
 * @property {string} name         Display name shown in the playlist UI.
 */

/**
 * @typedef {Object} BgmPlaylistOpts
 * @property {HTMLAudioElement} bgmEl     The single <audio> tag the playlist drives.
 * @property {BgmTrack[]} tracks          Ordered list. Empty list disables the playlist.
 * @property {number} [initialIndex=0]    Starting index (clamped to range).
 * @property {boolean} [autoPlay=false]   Begin playback after load? (Browsers usually require a user gesture; the playlist starts paused if the call is rejected.)
 * @property {number} [fadeMs=250]        Each side of the fade-out/fade-in pair.
 *
 * @property {(target: number, durationSec: number) => Promise<void>} [fadeEnvelope]
 *   Optional envelope hook (typically `audio.fadeBgmEnvelope`). When provided
 *   the playlist rides this for fades; without it falls back to writing
 *   bgmEl.volume directly and restoring afterwards.
 *
 * @property {(idx: number, track: BgmTrack) => void} [onTrackChange]
 *   Fires AFTER the new src is set and play() has been invoked. Receives the
 *   new index and the track payload. Caller can persist the index here.
 *
 * @property {(playing: boolean) => void} [onPlayingChange]
 *   Fires on play/pause toggles (including when a track ends without
 *   auto-advance configured).
 */

export function createBgmPlaylist(opts) {
  const {
    bgmEl,
    tracks = [],
    initialIndex = 0,
    autoPlay = false,
    fadeMs = DEFAULT_FADE_MS,
    fadeEnvelope = null,
    onTrackChange = null,
    onPlayingChange = null,
  } = opts || {};

  if (!bgmEl || !Array.isArray(tracks) || tracks.length === 0) {
    return _disabledStub();
  }

  // Internal state.
  const state = {
    index: clampIndex(initialIndex, tracks.length),
    // `transitioning` guards against rapid next/prev spam. Deltas accumulate
    // (so two next() calls mid-fade jump +2, not +1); an explicit setTrack
    // call replaces the queue with an absolute target.
    transitioning: false,
    /** @type {null | { kind: 'delta', value: number } | { kind: 'index', value: number }} */
    pending: null,
    playing: false,
    fadeMs,
  };

  // The bgmEl might already have its `loop` attribute set by HTML markup. We
  // want playlist auto-advance, which means `loop=false` and an `ended`
  // listener. Single-track playlists DO loop (re-applied below).
  bgmEl.loop = (tracks.length === 1);

  // Initial load (no fade — we're at silence already).
  applySrc(state.index);

  // 'ended' is the auto-advance signal. Browsers fire it after natural
  // end-of-stream OR after we set src='' — we guard against the latter by
  // only handling ended events when we're not currently transitioning.
  const onEnded = () => {
    if (state.transitioning) return;
    if (tracks.length === 1) {
      // bgmEl.loop should already be true, so we shouldn't get here, but if
      // a browser quirk lets `ended` fire on a looping element, reset to 0.
      bgmEl.currentTime = 0;
      bgmEl.play().catch(() => {});
      return;
    }
    advance(+1);
  };
  bgmEl.addEventListener('ended', onEnded);

  // Track playing state for the UI.
  const onPlay  = () => { if (!state.playing) { state.playing = true;  emitPlaying(); } };
  const onPause = () => { if (state.playing)  { state.playing = false; emitPlaying(); } };
  bgmEl.addEventListener('play',  onPlay);
  bgmEl.addEventListener('pause', onPause);

  // -----------------------------------------------------------------------
  // Internal helpers.
  // -----------------------------------------------------------------------
  function clampIndex(i, n) {
    if (!Number.isFinite(i)) return 0;
    const k = ((i % n) + n) % n; // wrap negatives
    return k;
  }

  function applySrc(idx) {
    const track = tracks[idx];
    if (!track) return;
    // Setting `src` to the same value would trigger a reload — guard.
    const target = track.url;
    if (bgmEl.getAttribute('src') === target) return;
    bgmEl.src = target;
    // Reset to the head; some browsers preserve currentTime across src swaps.
    try { bgmEl.currentTime = 0; } catch { /* mid-load src reset can throw */ }
  }

  // Fade envelope wrapper that gracefully no-ops if the envelope hook isn't
  // wired (e.g. the AudioContext hasn't been resumed yet — in that case we
  // just skip the fade).
  function fade(to, ms) {
    if (fadeEnvelope) return fadeEnvelope(to, ms / 1000);
    return Promise.resolve();
  }

  // Wait for the element to be playable. `canplay` fires when the browser
  // has enough data to start playback; before then `.play()` may stall.
  function waitForCanPlay(timeoutMs = 4000) {
    if (bgmEl.readyState >= 3 /* HAVE_FUTURE_DATA */) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
      const cleanup = () => {
        bgmEl.removeEventListener('canplay',     finish);
        bgmEl.removeEventListener('canplaythrough', finish);
        bgmEl.removeEventListener('error',       finish);
      };
      bgmEl.addEventListener('canplay',        finish, { once: true });
      bgmEl.addEventListener('canplaythrough', finish, { once: true });
      bgmEl.addEventListener('error',          finish, { once: true });
      // Hard timeout in case the element gets stuck (offline, slow disk).
      setTimeout(finish, timeoutMs);
    });
  }

  // queued: either `{ kind: 'delta', value: ±N }` or `{ kind: 'index', value: I }`.
  // Deltas accumulate (`next()` x2 → jump +2); `setTrack` replaces the queue
  // with an absolute target. Either way, exactly one transition runs per
  // queue flush — we never schedule overlapping fades.
  async function runTransition(initialRequest, { autoPlay: ap = true } = {}) {
    if (state.transitioning) {
      // A transition is already in flight — fold this request into the queue.
      mergeRequest(initialRequest);
      return;
    }
    state.transitioning = true;
    let request = initialRequest;
    try {
      while (request) {
        const target = resolveTarget(request);

        // Fade out.
        await fade(0, state.fadeMs);

        // Swap src.
        applySrc(target);
        state.index = target;

        // Wait for the new track to be ready to play.
        await waitForCanPlay();

        // Begin playback (browsers may reject if no user gesture has fired —
        // catch and stay paused; UI reflects state via the pause listener).
        if (ap) {
          try { await bgmEl.play(); }
          catch { /* will surface as paused via the pause event */ }
        }

        // Fade in.
        await fade(1, state.fadeMs);

        // Notify caller (persistence + UI).
        if (onTrackChange) {
          try { onTrackChange(state.index, tracks[state.index]); }
          catch (err) { console.error('[bgm-playlist] onTrackChange threw:', err); }
        }

        // Drain any queued request that arrived during the fade.
        request = state.pending;
        state.pending = null;
      }
    } finally {
      state.transitioning = false;
    }
  }

  function resolveTarget(request) {
    if (request.kind === 'delta') {
      return clampIndex(state.index + request.value, tracks.length);
    }
    return clampIndex(request.value, tracks.length);
  }

  function mergeRequest(request) {
    // No queue yet → store as-is.
    if (!state.pending) { state.pending = request; return; }
    // Absolute index always wins (replace any pending delta).
    if (request.kind === 'index') { state.pending = request; return; }
    // Two deltas pending — sum them so two rapid next() clicks jump +2.
    if (state.pending.kind === 'delta') {
      state.pending = { kind: 'delta', value: state.pending.value + request.value };
      return;
    }
    // Pending is an absolute index, incoming is a delta — apply the delta
    // to that absolute target so a setTrack(2) followed by next() lands on 3.
    state.pending = { kind: 'index', value: state.pending.value + request.value };
  }

  function advance(delta) {
    return runTransition({ kind: 'delta', value: delta }, { autoPlay: true });
  }

  function emitPlaying() {
    if (!onPlayingChange) return;
    try { onPlayingChange(state.playing); }
    catch (err) { console.error('[bgm-playlist] onPlayingChange threw:', err); }
  }

  // -----------------------------------------------------------------------
  // Public API.
  // -----------------------------------------------------------------------
  async function play() {
    // If src isn't loaded yet, applySrc was called at boot; just call play.
    try { await bgmEl.play(); }
    catch { /* paused state will surface via the pause listener */ }
  }

  function pause() {
    bgmEl.pause();
  }

  function stop() {
    bgmEl.pause();
    try { bgmEl.currentTime = 0; } catch { /* ignore */ }
  }

  function next() { return advance(+1); }
  function prev() { return advance(-1); }

  function setTrack(idx) {
    const i = clampIndex(idx, tracks.length);
    if (i === state.index && !state.transitioning) {
      // Same-track tap — just (re)start playback.
      try { bgmEl.currentTime = 0; } catch { /* ignore */ }
      return play();
    }
    return runTransition({ kind: 'index', value: i });
  }

  function current() {
    return { index: state.index, track: tracks[state.index] };
  }

  function getTracks() {
    return tracks.slice();
  }

  function isPlaying() {
    // Don't trust state.playing alone — the element's paused property is
    // the source of truth (e.g. browsers can pause us programmatically).
    return !bgmEl.paused;
  }

  function dispose() {
    bgmEl.removeEventListener('ended', onEnded);
    bgmEl.removeEventListener('play',  onPlay);
    bgmEl.removeEventListener('pause', onPause);
    state.pending = null;
  }

  // Auto-play attempt at boot — only if the caller asked. Browsers usually
  // reject this without a user gesture; we silence the rejection. The user's
  // first interaction (key press, button click) wakes the AudioContext and
  // a subsequent play() succeeds.
  if (autoPlay) {
    play();
  }

  return {
    play, pause, stop,
    next, prev,
    setTrack,
    current, tracks: getTracks,
    get index()   { return state.index; },
    get playing() { return isPlaying(); },
    dispose,
  };
}

function _disabledStub() {
  // The disabled stub matches the public API so callers don't have to
  // null-check before every method. Unused tracks → silent no-op object.
  return {
    play() {}, pause() {}, stop() {},
    next() { return Promise.resolve(); },
    prev() { return Promise.resolve(); },
    setTrack() { return Promise.resolve(); },
    current() { return { index: -1, track: null }; },
    tracks() { return []; },
    get index() { return -1; },
    get playing() { return false; },
    dispose() {},
  };
}

// Default track list for the vaporwave split (asset/sounds/bgm/bgm_01.m4a …
// bgm_14.m4a). Names use the file basename — the UI shows "bgm_01" etc.
// Callers can override by passing their own `tracks` array.
export function defaultVaporwaveTracks() {
  const out = [];
  for (let i = 1; i <= 14; i++) {
    const k = String(i).padStart(2, '0');
    out.push({ url: `asset/sounds/bgm/bgm_${k}.m4a`, name: `Vaporwave · ${k}` });
  }
  return out;
}
