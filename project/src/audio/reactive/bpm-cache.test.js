import { describe, it, expect, vi } from 'vitest';
import { createBpmCache } from './bpm-cache.js';

// Helper: build a cache with controllable fetch + analyzer + storage hooks.
function makeCache({
  load = () => ({}),
  // The analyzer factory returns a guess() function. Default: bpm 120 / offset 0.
  guess = vi.fn(async (buf) => ({ bpm: buf?._bpm || 120, offset: buf?._offset || 0 })),
  // Fetch returns a fake response with arrayBuffer() yielding a tagged "bytes".
  fetchImpl = vi.fn(async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => ({ _url: url }),
  })),
  // Decode forwards URL tags into the audio buffer so the analyzer can echo
  // per-URL BPMs in tests.
  decode = vi.fn(async (ab) => ({ duration: 100, _url: ab && ab._url })),
  save = vi.fn(),
} = {}) {
  return {
    cache: createBpmCache({
      decode,
      analyzer: async () => guess,
      load,
      save,
      fetchFn: fetchImpl,
      log: () => {},     // silence test output
      warn: () => {},
    }),
    guess, fetchImpl, decode, save,
  };
}

describe('bpm-cache — boot', () => {
  it('throws when decode is missing', () => {
    expect(() => createBpmCache({ analyzer: async () => () => {} })).toThrow();
  });

  it('throws when analyzer factory is missing', () => {
    expect(() => createBpmCache({ decode: async () => ({}) })).toThrow();
  });

  it('hydrates the in-memory mirror from the load callback', () => {
    const { cache } = makeCache({
      load: () => ({
        'a.m4a': { bpm: 110, offset: 0.1, analyzedAt: '2026-05-08' },
      }),
    });
    expect(cache.has('a.m4a')).toBe(true);
    expect(cache.get('a.m4a').bpm).toBe(110);
    expect(cache.has('b.m4a')).toBe(false);
  });
});

describe('bpm-cache — analyze', () => {
  it('returns the cached entry without re-fetching when present', async () => {
    const { cache, fetchImpl } = makeCache({
      load: () => ({ 'a.m4a': { bpm: 100, offset: 0, analyzedAt: 'iso' } }),
    });
    const entry = await cache.analyze('a.m4a');
    expect(entry.bpm).toBe(100);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches + decodes + analyzes on first miss, then caches the result', async () => {
    const { cache, guess, fetchImpl, decode, save } = makeCache();
    const entry = await cache.analyze('track.m4a');
    expect(entry.bpm).toBe(120);
    expect(entry.offset).toBe(0);
    expect(typeof entry.analyzedAt).toBe('string');
    expect(fetchImpl).toHaveBeenCalledWith('track.m4a');
    expect(decode).toHaveBeenCalledTimes(1);
    expect(guess).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    // Subsequent analyze() calls should be cache hits.
    await cache.analyze('track.m4a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls for the same URL into one analysis', async () => {
    const { cache, fetchImpl, guess } = makeCache();
    const p1 = cache.analyze('a.m4a');
    const p2 = cache.analyze('a.m4a');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(guess).toHaveBeenCalledTimes(1);
  });

  it('serializes analyses across distinct URLs (fetch order matches call order)', async () => {
    const order = [];
    const fetchImpl = vi.fn(async (url) => {
      order.push(`fetch:${url}`);
      return { ok: true, status: 200, arrayBuffer: async () => ({ _url: url }) };
    });
    const { cache } = makeCache({ fetchImpl });
    await Promise.all([
      cache.analyze('1.m4a'),
      cache.analyze('2.m4a'),
      cache.analyze('3.m4a'),
    ]);
    expect(order).toEqual(['fetch:1.m4a', 'fetch:2.m4a', 'fetch:3.m4a']);
  });

  it('returns null on fetch failure and fires onError', async () => {
    const onErr = vi.fn();
    const { cache } = makeCache({
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    cache.onError(onErr);
    const result = await cache.analyze('missing.m4a');
    expect(result).toBeNull();
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(onErr.mock.calls[0][0]).toBe('missing.m4a');
    // Failed entries are NOT cached — a subsequent call retries.
    expect(cache.has('missing.m4a')).toBe(false);
  });

  it('returns null when the analyzer rejects bpm', async () => {
    const { cache } = makeCache({
      guess: async () => ({ bpm: NaN, offset: 0 }),
    });
    const result = await cache.analyze('weird.m4a');
    expect(result).toBeNull();
    expect(cache.has('weird.m4a')).toBe(false);
  });
});

describe('bpm-cache — analyzeAll', () => {
  it('processes all URLs and resolves with the cached entries', async () => {
    const { cache, save } = makeCache();
    const urls = ['a.m4a', 'b.m4a', 'c.m4a'];
    const results = await cache.analyzeAll(urls);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.bpm).toBe(120);
    // save called once per analysis.
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('skips URLs already in the cache', async () => {
    const { cache, fetchImpl } = makeCache({
      load: () => ({ 'a.m4a': { bpm: 100, offset: 0, analyzedAt: 'iso' } }),
    });
    await cache.analyzeAll(['a.m4a', 'b.m4a']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('b.m4a');
  });
});

describe('bpm-cache — invalidate + list', () => {
  it('invalidate() removes the cache entry and re-runs analysis', async () => {
    let bpm = 100;
    const { cache, fetchImpl } = makeCache({
      guess: async () => ({ bpm: bpm++, offset: 0 }),
    });
    const first = await cache.analyze('a.m4a');
    expect(first.bpm).toBe(100);
    const re = await cache.invalidate('a.m4a');
    expect(re.bpm).toBe(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('list() returns all cached + pending entries sorted by URL', async () => {
    const { cache } = makeCache({
      load: () => ({
        'b.m4a': { bpm: 110, offset: 0, analyzedAt: 'iso' },
        'a.m4a': { bpm: 100, offset: 0, analyzedAt: 'iso' },
      }),
    });
    const rows = cache.list();
    expect(rows.map(r => r.url)).toEqual(['a.m4a', 'b.m4a']);
    expect(rows[0].pending).toBe(false);
  });
});

describe('bpm-cache — onAnalyzed', () => {
  it('fires once per successful analysis with the URL + entry', async () => {
    const { cache } = makeCache();
    const fn = vi.fn();
    cache.onAnalyzed(fn);
    await cache.analyze('a.m4a');
    await cache.analyze('b.m4a');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][0]).toBe('a.m4a');
    expect(fn.mock.calls[1][0]).toBe('b.m4a');
    expect(fn.mock.calls[0][1].bpm).toBe(120);
  });

  it('unsubscribe stops further notifications', async () => {
    const { cache } = makeCache();
    const fn = vi.fn();
    const off = cache.onAnalyzed(fn);
    await cache.analyze('a.m4a');
    off();
    await cache.analyze('b.m4a');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
