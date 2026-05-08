// BPM cache — per-track offline BPM analysis with persistence.
//
// Replaces the live-capture pipeline (`audio-recorder` + windowed
// `analyzeWindow` + drift detector). The new BGM layout has one file per
// track, each with a single tempo, so the cleanest answer is to fetch the
// whole file, decode, and run the analyzer once. Result is keyed by URL,
// cached in memory, and persisted across reloads (files are immutable, so
// the cache value stays correct as long as the URL keeps pointing to the
// same encoded audio).
//
// Concurrency model: a single internal queue serializes analyses. Browsers
// run web-audio-beat-detector in a Worker, so technically we could parallel-
// analyze, but in practice each pass spikes CPU on a single core; serial is
// kinder to first-paint perf and the audio thread.
//
// Pure module. No THREE, no DOM. Caller injects: a decode function (from
// audio/playback.js), an analyzer factory (lazy import of
// web-audio-beat-detector), and a fetch function (defaults to global).

/**
 * @typedef {Object} BpmEntry
 * @property {number} bpm
 * @property {number} offset       Song-time of first beat (seconds).
 * @property {string} analyzedAt   ISO date stamp.
 */

/**
 * @typedef {Object} BpmCacheOpts
 * @property {(buf: ArrayBuffer) => Promise<AudioBuffer>} decode
 *   Decode an arrayBuffer into an AudioBuffer. Typically `audio.decode`.
 *
 * @property {() => Promise<(buf: AudioBuffer) => Promise<{bpm:number, offset:number}>>} analyzer
 *   Lazily-imported analyzer (e.g. () => import('web-audio-beat-detector').then(m => m.guess)).
 *
 * @property {() => Record<string, BpmEntry>} [load]
 *   Hydration hook — return a `{[url]: BpmEntry}` blob. Defaults to `{}`.
 *
 * @property {(blob: Record<string, BpmEntry>) => void} [save]
 *   Persistence hook — called after each analysis completes.
 *
 * @property {(url: string) => Promise<Response>} [fetchFn]
 *   Override for tests. Defaults to globalThis.fetch.
 *
 * @property {(msg: string, ...args: any[]) => void} [log]
 *   Override for tests. Defaults to console.log.
 *
 * @property {(msg: string, ...args: any[]) => void} [warn]
 *   Override for tests. Defaults to console.warn.
 */

const ISO_NOW = () => new Date().toISOString();

export function createBpmCache(opts) {
  const {
    decode,
    analyzer,
    load = () => ({}),
    save = null,
    fetchFn = (typeof globalThis !== 'undefined' && globalThis.fetch) ? globalThis.fetch.bind(globalThis) : null,
    log = (...a) => console.log(...a),
    warn = (...a) => console.warn(...a),
  } = opts || {};

  if (typeof decode !== 'function') throw new Error('bpm-cache requires a `decode` function');
  if (typeof analyzer !== 'function') throw new Error('bpm-cache requires an `analyzer` factory');

  // In-memory mirror of the persisted cache. Hydrated lazily so missing
  // localStorage in privacy mode doesn't block the constructor.
  /** @type {Record<string, BpmEntry>} */
  const memCache = { ...(load() || {}) };

  // Subscribers fired after each successful analysis.
  /** @type {Set<(url: string, entry: BpmEntry) => void>} */
  const onAnalyzedListeners = new Set();
  /** @type {Set<(url: string, err: Error) => void>} */
  const onErrorListeners = new Set();

  // Pending promises so duplicate analyze(url) calls coalesce into the same
  // single in-flight request. Cleared on completion (success OR failure).
  /** @type {Map<string, Promise<BpmEntry|null>>} */
  const pending = new Map();

  // Serial queue for analyses. We chain off this promise so concurrent
  // callers (e.g. analyzeAll([...]) plus an explicit analyze(url) call from
  // a playlist track change) interleave safely without piling work onto the
  // audio thread simultaneously.
  let queueTail = Promise.resolve();

  function fireAnalyzed(url, entry) {
    for (const fn of onAnalyzedListeners) {
      try { fn(url, entry); }
      catch (err) { console.error('[bpm-cache] onAnalyzed listener threw:', err); }
    }
  }
  function fireError(url, err) {
    for (const fn of onErrorListeners) {
      try { fn(url, err); }
      catch (err2) { console.error('[bpm-cache] onError listener threw:', err2); }
    }
  }

  async function _runAnalysis(url) {
    if (typeof fetchFn !== 'function') {
      throw new Error('bpm-cache: no fetch implementation available');
    }
    const t0 = Date.now();
    let res;
    try {
      res = await fetchFn(url);
    } catch (err) {
      throw new Error(`fetch failed for ${url}: ${err.message || err}`);
    }
    if (!res || !res.ok) {
      throw new Error(`http ${res ? res.status : '?'} for ${url}`);
    }
    const arrayBuf = await res.arrayBuffer();
    const audioBuf = await decode(arrayBuf);
    const guess = await analyzer();
    if (typeof guess !== 'function') {
      throw new Error('bpm-cache: analyzer factory did not return a function');
    }
    const result = await guess(audioBuf);
    if (!result || typeof result.bpm !== 'number' || !isFinite(result.bpm) || result.bpm <= 0) {
      throw new Error(`analyzer returned invalid bpm: ${result && result.bpm}`);
    }
    const entry = {
      bpm:        result.bpm,
      offset:     typeof result.offset === 'number' ? result.offset : 0,
      analyzedAt: ISO_NOW(),
    };
    memCache[url] = entry;
    if (save) {
      try { save({ ...memCache }); }
      catch (err) { warn('[bpm-cache] save threw:', err?.message || err); }
    }
    log(`[bpm-cache] ${url} → bpm ${entry.bpm.toFixed(2)} offset ${entry.offset.toFixed(3)}s (${Date.now() - t0}ms)`);
    return entry;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Synchronous read of the cached entry, or null if not yet analyzed.
   * @param {string} url
   * @returns {BpmEntry | null}
   */
  function get(url) {
    return memCache[url] || null;
  }

  /**
   * Has this URL been analyzed? Synchronous.
   * @param {string} url
   * @returns {boolean}
   */
  function has(url) {
    return !!memCache[url];
  }

  /**
   * Returns a promise that resolves with the entry. Re-uses the cached value
   * if present; otherwise enqueues an analysis. Multiple concurrent calls
   * for the same URL share a single in-flight request.
   *
   * @param {string} url
   * @returns {Promise<BpmEntry | null>}  null on analysis failure
   */
  function analyze(url) {
    const cached = memCache[url];
    if (cached) return Promise.resolve(cached);
    if (pending.has(url)) return pending.get(url);

    // Chain onto the queue tail.
    const task = queueTail.then(async () => {
      try {
        const entry = await _runAnalysis(url);
        fireAnalyzed(url, entry);
        return entry;
      } catch (err) {
        warn(`[bpm-cache] analysis failed for ${url}:`, err?.message || err);
        fireError(url, err);
        return null;
      } finally {
        pending.delete(url);
      }
    });
    pending.set(url, task);
    queueTail = task.then(() => {}, () => {}); // never reject the queue tail
    return task;
  }

  /**
   * Enqueue analyses for an array of URLs. Skips already-cached entries.
   * Returns a promise that resolves when the *queue* is drained (each entry
   * resolved with success-or-null). The function returns immediately for
   * fire-and-forget callers; await only if you specifically want to know
   * when the batch is done.
   *
   * @param {string[]} urls
   * @returns {Promise<Array<BpmEntry | null>>}
   */
  function analyzeAll(urls) {
    return Promise.all(urls.map(u => analyze(u)));
  }

  /**
   * Drop a cached entry and re-queue analysis. Used by the console handle
   * `__beatCache.invalidate(url)` when a file's contents have changed since
   * the cache was last written.
   * @param {string} url
   * @returns {Promise<BpmEntry | null>}
   */
  function invalidate(url) {
    delete memCache[url];
    if (save) {
      try { save({ ...memCache }); }
      catch (err) { warn('[bpm-cache] save threw:', err?.message || err); }
    }
    return analyze(url);
  }

  /**
   * Snapshot of every cached entry plus pending state. For console
   * inspection.
   * @returns {Array<{ url: string, bpm: number | null, offset: number | null, analyzedAt: string | null, pending: boolean }>}
   */
  function list() {
    const urls = new Set([...Object.keys(memCache), ...pending.keys()]);
    return [...urls].sort().map(url => {
      const entry = memCache[url];
      return {
        url,
        bpm:    entry ? entry.bpm    : null,
        offset: entry ? entry.offset : null,
        analyzedAt: entry ? entry.analyzedAt : null,
        pending: pending.has(url),
      };
    });
  }

  /**
   * Subscribe to successful analyses. Returns an unsubscribe function.
   * @param {(url: string, entry: BpmEntry) => void} fn
   */
  function onAnalyzed(fn) {
    if (typeof fn !== 'function') throw new Error('onAnalyzed requires a function');
    onAnalyzedListeners.add(fn);
    return () => onAnalyzedListeners.delete(fn);
  }

  /**
   * Subscribe to analysis failures.
   * @param {(url: string, err: Error) => void} fn
   */
  function onError(fn) {
    if (typeof fn !== 'function') throw new Error('onError requires a function');
    onErrorListeners.add(fn);
    return () => onErrorListeners.delete(fn);
  }

  return {
    get, has,
    analyze, analyzeAll,
    invalidate,
    list,
    onAnalyzed, onError,
    get pendingCount() { return pending.size; },
  };
}
