import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBgmPlaylist, defaultVaporwaveTracks } from './bgm-playlist.js';

// Minimal fake of the bits of HTMLAudioElement we touch. EventTarget gives
// us add/remove/dispatchEventListener for free; we use defineProperty for
// the live getters/setters because Object.assign would evaluate the getters
// at copy-time and capture stale snapshots instead of installing accessors.
function makeFakeBgmEl() {
  const target = new EventTarget();
  const internals = {
    src: null,
    paused: true,
    currentTime: 0,
    readyState: 4, // HAVE_ENOUGH_DATA — skip waitForCanPlay() in tests
    loop: false,
  };
  Object.defineProperties(target, {
    src: {
      configurable: true,
      get() { return internals.src; },
      set(v) { internals.src = v; target.dispatchEvent(new Event('loadstart')); },
    },
    paused:      { configurable: true, get() { return internals.paused; } },
    currentTime: {
      configurable: true,
      get() { return internals.currentTime; },
      set(v) { internals.currentTime = v; },
    },
    readyState:  { configurable: true, get() { return internals.readyState; } },
    loop: {
      configurable: true,
      get() { return internals.loop; },
      set(v) { internals.loop = !!v; },
    },
  });
  target.getAttribute = (k) => (k === 'src' ? internals.src : null);
  target.setAttribute = (k, v) => { if (k === 'src') target.src = v; };
  target.play = () => {
    internals.paused = false;
    target.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
  target.pause = () => {
    if (internals.paused) return;
    internals.paused = true;
    target.dispatchEvent(new Event('pause'));
  };
  // Helpers for tests:
  target._fireEnded = () => target.dispatchEvent(new Event('ended'));
  target._setReadyState = (rs) => { internals.readyState = rs; };
  return target;
}

const TEST_TRACKS = [
  { url: 'asset/sounds/bgm/bgm_01.m4a', name: 'Vaporwave 01' },
  { url: 'asset/sounds/bgm/bgm_02.m4a', name: 'Vaporwave 02' },
  { url: 'asset/sounds/bgm/bgm_03.m4a', name: 'Vaporwave 03' },
];

describe('bgm-playlist — boot', () => {
  it('returns a stubbed disabled API when given no tracks', () => {
    const p = createBgmPlaylist({ bgmEl: makeFakeBgmEl(), tracks: [] });
    expect(p.tracks()).toEqual([]);
    expect(p.current().index).toBe(-1);
    expect(p.playing).toBe(false);
    p.next(); p.prev(); p.play(); p.pause(); // no throw
  });

  it('loads the initial track on boot', () => {
    const bgmEl = makeFakeBgmEl();
    const p = createBgmPlaylist({ bgmEl, tracks: TEST_TRACKS, initialIndex: 1 });
    expect(p.current().index).toBe(1);
    expect(bgmEl.src).toBe('asset/sounds/bgm/bgm_02.m4a');
  });

  it('clamps initialIndex with wrap-around', () => {
    const p = createBgmPlaylist({ bgmEl: makeFakeBgmEl(), tracks: TEST_TRACKS, initialIndex: 7 });
    expect(p.current().index).toBe(1); // 7 % 3 = 1
  });

  it('disables looping when more than one track is in the rotation', () => {
    const bgmEl = makeFakeBgmEl();
    bgmEl.loop = true;
    createBgmPlaylist({ bgmEl, tracks: TEST_TRACKS });
    expect(bgmEl.loop).toBe(false);
  });

  it('forces looping for single-track rotations', () => {
    const bgmEl = makeFakeBgmEl();
    bgmEl.loop = false;
    createBgmPlaylist({ bgmEl, tracks: [TEST_TRACKS[0]] });
    expect(bgmEl.loop).toBe(true);
  });
});

describe('bgm-playlist — transport', () => {
  let bgmEl, onTrackChange, onPlayingChange, fadeEnvelope, p;

  beforeEach(() => {
    bgmEl = makeFakeBgmEl();
    onTrackChange = vi.fn();
    onPlayingChange = vi.fn();
    fadeEnvelope = vi.fn(() => Promise.resolve());
    p = createBgmPlaylist({
      bgmEl,
      tracks: TEST_TRACKS,
      fadeEnvelope,
      onTrackChange,
      onPlayingChange,
      fadeMs: 0, // skip the setTimeout wait in tests
    });
  });

  it('next() advances and fires onTrackChange', async () => {
    await p.next();
    expect(p.current().index).toBe(1);
    expect(bgmEl.src).toBe('asset/sounds/bgm/bgm_02.m4a');
    expect(onTrackChange).toHaveBeenCalledWith(1, TEST_TRACKS[1]);
    // Fade out then fade in: two envelope calls.
    expect(fadeEnvelope).toHaveBeenCalledTimes(2);
    expect(fadeEnvelope.mock.calls[0][0]).toBe(0);
    expect(fadeEnvelope.mock.calls[1][0]).toBe(1);
  });

  it('prev() wraps around at index 0', async () => {
    await p.prev();
    expect(p.current().index).toBe(2);
    expect(bgmEl.src).toBe('asset/sounds/bgm/bgm_03.m4a');
  });

  it('next() wraps around at the last index', async () => {
    await p.setTrack(2);
    await p.next();
    expect(p.current().index).toBe(0);
  });

  it('setTrack() jumps to an arbitrary track', async () => {
    await p.setTrack(2);
    expect(p.current().index).toBe(2);
    expect(bgmEl.src).toBe('asset/sounds/bgm/bgm_03.m4a');
    expect(onTrackChange).toHaveBeenLastCalledWith(2, TEST_TRACKS[2]);
  });

  it('pause()/play() reflect via onPlayingChange', async () => {
    await p.play();
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);
    expect(p.playing).toBe(true);
    p.pause();
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    expect(p.playing).toBe(false);
  });

  it('stop() pauses and rewinds to 0', async () => {
    await p.play();
    bgmEl._setReadyState(4);
    bgmEl.currentTime = 42;
    p.stop();
    expect(p.playing).toBe(false);
    expect(bgmEl.currentTime).toBe(0);
  });

  it('a natural ended event auto-advances to the next track', async () => {
    bgmEl._fireEnded();
    // ended → advance(+1) is async; flush microtasks.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(p.current().index).toBe(1);
  });
});

describe('bgm-playlist — coalescing concurrent next()', () => {
  it('coalesces a rapid second next() into the in-flight transition', async () => {
    const bgmEl = makeFakeBgmEl();
    let resolveFirstFade;
    const fadeEnvelope = vi.fn().mockImplementationOnce(
      () => new Promise(r => { resolveFirstFade = r; }),
    ).mockImplementation(() => Promise.resolve());
    const onTrackChange = vi.fn();
    const p = createBgmPlaylist({
      bgmEl, tracks: TEST_TRACKS, fadeEnvelope, onTrackChange, fadeMs: 0,
    });
    const t1 = p.next(); // 0 → 1, gated by the long fade
    const t2 = p.next(); // queued — should land on 2
    resolveFirstFade();
    await Promise.all([t1, t2]);
    expect(p.current().index).toBe(2);
    // Two transitions happened, each with its own onTrackChange.
    expect(onTrackChange).toHaveBeenCalledTimes(2);
  });
});

describe('bgm-playlist — defaultVaporwaveTracks', () => {
  it('returns 14 tracks under asset/sounds/bgm/', () => {
    const tracks = defaultVaporwaveTracks();
    expect(tracks).toHaveLength(14);
    expect(tracks[0]).toEqual({ url: 'asset/sounds/bgm/bgm_01.m4a', name: 'Vaporwave · 01' });
    expect(tracks[13]).toEqual({ url: 'asset/sounds/bgm/bgm_14.m4a', name: 'Vaporwave · 14' });
  });
});
