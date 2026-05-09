// Settings + stats persistence (plan_UI_1.md §3.1).
//
// Two versioned localStorage keys; settings save debounced 250 ms; stats
// flush immediately on game-over. Wraps reads/writes in try/catch — in
// privacy mode or when quota is exhausted we silently fall back to an
// in-memory shadow so the game never crashes on a storage failure.
//
// No THREE, no DOM. Pure JS — runs in tests under Node by stubbing
// `globalThis.localStorage` (see storage.test.js).

const KEY_SETTINGS = 'tetrisplus.settings.v1';
const KEY_STATS    = 'tetrisplus.stats.v1';
// BPM cache lives in its own key so it doesn't bloat the settings blob —
// settings are rewritten on every slider commit, and a 14-track BPM table
// has no business riding that hot path. Shape: `{[url]: {bpm, offset, analyzedAt}}`.
const KEY_BPM      = 'tetrisplus.bpm.v1';

// Authored defaults — copied into freshly-loaded blobs. Adding a field
// here automatically backfills it on every load (deep-merge, see below).
const SETTINGS_DEFAULTS = Object.freeze({
  effects: {
    shatterPower:    2.5,
    bloom:           0.7,
    shakeMul:        1.0,
    slowmoMul:       1.0,
    trailMul:        1.0,
    rimGlowMul:      1.0,
    mood:            'void',
    particleQuality: 'mid',
    vignette:        true,
  },
  audio: {
    muted: false,
    bgm:   0.32,
    voice: 0.95,
    sfx:   0.55,
    // BGM playlist position — index into the tracks array maintained by
    // src/audio/bgm-playlist.js. Hydrated at boot so the player resumes on
    // the same track they last heard. New saves backfill missing fields,
    // so existing players default to track 0.
    bgmTrackIndex: 0,
  },
  mode: 'classic',
  // Versus AI opponent strength (§3.7 sub-phase 7e polish). Forwarded
  // to BotController on Mode.start({key:'versus'}). 'casual' (default)
  // uses the heuristic at 8 actions/sec; 'random' is the dumber pre-
  // heuristic strategy retained for tutorial stand-in; 'mirror' echoes
  // the player's piece position (sparring partner). Settings panel
  // surfaces this as a select when the active mode is versus.
  versus: {
    botStrength: 'casual',
  },
  // panel.hidden defaults to FALSE — the settings panel is the primary UI
  // surface (plan_UI_1.md §2.0); making it discoverable on first launch
  // matters more than the slight visual clutter on a fresh install. The
  // close button + O key let the player hide it whenever they want, and
  // that hidden state is persisted alongside the pose.
  panel: { x: 0, y: 0, z: 6, yaw: 0, pitch: 0, hidden: false },
});

// Modern-rules per-mode best slots (plan §13 next-moves item 2).
// Mixed in to every mode that records a meaningful run — `bestB2bChain`
// (longest Back-to-Back chain reached), `bestCombo` (longest combo step
// reached), `perfectClears` (cumulative count across all attempts),
// `tspinClears` (cumulative count of T-spin clears, regular + mini, with
// at least one cleared row).
//
// Forward-compatible: storage's deep-merge backfills missing keys on
// load, so any save written before §12 silently gains zero-defaults
// for these on the first read.
const MODERN_RULES_DEFAULTS = Object.freeze({
  bestB2bChain:  0,
  bestCombo:     0,
  perfectClears: 0,
  tspinClears:   0,
});

const STATS_DEFAULTS = Object.freeze({
  highScore: 0,
  modeBests: {
    // `attempts` is bumped at every MODE_END (regardless of reason), so a
    // player who tops out in the first 5 seconds still contributes to the
    // count. Existing pre-refactor blobs backfill this to 0 via deep-merge.
    classic:  { score: 0, lines: 0, level: 1, attempts: 0,                                                  ...MODERN_RULES_DEFAULTS },
    // Marathon adds `completed` (whether the player has *ever* cleared
    // 150 lines) and `bestTimeMs` (fastest completion). null bestTimeMs
    // sentinel means no completion on record yet — distinct from 0ms which
    // would be a real (impossible) duration.
    marathon: { score: 0, lines: 0, level: 1, attempts: 0, completed: false, bestTimeMs: null,              ...MODERN_RULES_DEFAULTS },
    // Sprint records ONLY bestTimeMs + attempts + completed — score is
    // always 0 so the score/lines/level fields never receive meaningful
    // writes. They're kept for shape uniformity with the deep-merge.
    // Modern-rules: only `bestCombo` is tunable in Sprint (T-spin score
    // is gated to 0 by the rules pack, but combo length is still real).
    sprint:   { score: 0, lines: 0, level: 1, attempts: 0, completed: false, bestTimeMs: null, bestCombo: 0 },
    ultra:    { score: 0, lines: 0, level: 1, attempts: 0,                                                  ...MODERN_RULES_DEFAULTS },
    // Zen's "best" is the longest session, not score. `totalLines` is
    // a CUMULATIVE counter across all Zen sessions — Zen is the slow-
    // burn mode (plan §3.5 #5). The score/lines/level fields stay for
    // shape uniformity but are never written to.
    zen:      { score: 0, lines: 0, level: 1, attempts: 0, longestSessionMs: 0, totalLines: 0,              ...MODERN_RULES_DEFAULTS },
    // Versus tracks wins/losses (+ ELO reserved for online — plan §3.6 #5).
    // The score/lines/level fields stay for shape uniformity; the score-
    // based default best-update path is skipped (resetsHighScoreSlot:false
    // in the rules pack) so they're never written to. `bestGarbageCancelled`
    // is the highest single-round cancellation tally — a versus-only metric.
    versus:   { score: 0, lines: 0, level: 1, attempts: 0, wins: 0, losses: 0, draws: 0, eloMmr: 1200,
                bestGarbageCancelled: 0,                                                                   ...MODERN_RULES_DEFAULTS },
    // Pure Physics (plan v2 §2.3) — score is layers × 100, no level
    // multiplier. `bestLayersCleared` is the run-record metric;
    // `totalLayersCleared` is a Zen-style cumulative counter that
    // Physics shares. Modern-rules slots are intentionally absent
    // — physics doesn't recognize T-spin / B2B / PC.
    physics:  { score: 0, lines: 0, level: 1, attempts: 0, bestLayersCleared: 0, totalLayersCleared: 0 },
  },
  totals: {
    linesCleared:  0,
    piecesPlaced:  0,
    playTimeMs:    0,
  },
  lastUpdated: null,
});

// Deep-clone a frozen-source default tree so callers can mutate freely.
function cloneDefaults(src) {
  if (Array.isArray(src)) return src.map(cloneDefaults);
  if (src && typeof src === 'object') {
    const out = {};
    for (const k of Object.keys(src)) out[k] = cloneDefaults(src[k]);
    return out;
  }
  return src;
}

// Recursive merge — `incoming` fields override `base`, but anything missing
// from `incoming` stays at its default. This is what lets us add a new
// settings field tomorrow without breaking a player's existing save blob.
function deepMerge(base, incoming) {
  if (incoming == null) return base;
  if (Array.isArray(base) || typeof base !== 'object') return incoming;
  if (typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const out = { ...base };
  for (const k of Object.keys(incoming)) {
    if (k in base) out[k] = deepMerge(base[k], incoming[k]);
    else           out[k] = incoming[k];
  }
  return out;
}

function safeStorage() {
  try {
    return (typeof globalThis !== 'undefined' && globalThis.localStorage) || null;
  } catch {
    return null; // privacy mode / sandboxed iframe
  }
}

// In-memory fallback so getters/setters always succeed even without
// localStorage. Shape mirrors the localStorage API we use.
const _memShadow = new Map();
function readKey(key) {
  const ls = safeStorage();
  if (ls) {
    try { return ls.getItem(key); }
    catch { /* fallthrough */ }
  }
  return _memShadow.has(key) ? _memShadow.get(key) : null;
}
function writeKey(key, value) {
  _memShadow.set(key, value);
  const ls = safeStorage();
  if (!ls) return;
  try { ls.setItem(key, value); }
  catch { /* quota exceeded — keep the in-memory copy */ }
}

function parseOrNull(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); }
  catch { return null; } // corrupt blob — fall back to defaults
}

/**
 * Load + merge the settings blob. Always returns a fresh object the
 * caller can mutate; missing fields are filled from SETTINGS_DEFAULTS.
 */
export function loadSettings() {
  const incoming = parseOrNull(readKey(KEY_SETTINGS));
  return deepMerge(cloneDefaults(SETTINGS_DEFAULTS), incoming);
}

/** Same shape for stats. */
export function loadStats() {
  const incoming = parseOrNull(readKey(KEY_STATS));
  return deepMerge(cloneDefaults(STATS_DEFAULTS), incoming);
}

// Debounced settings save. Flushes early on visibilitychange=hidden so
// the player doesn't lose their last tweak when they quickly close the
// tab. The flush hook is registered lazily — tests in pure Node don't
// need it.
let _settingsTimer = null;
let _settingsPending = null;
let _flushHookInstalled = false;

function installFlushHook() {
  if (_flushHookInstalled) return;
  if (typeof document === 'undefined') return;
  _flushHookInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSettings();
  });
}

function flushSettings() {
  if (_settingsTimer != null) {
    clearTimeout(_settingsTimer);
    _settingsTimer = null;
  }
  if (_settingsPending != null) {
    writeKey(KEY_SETTINGS, JSON.stringify(_settingsPending));
    _settingsPending = null;
  }
}

/**
 * Save settings (whole blob). Debounced 250 ms; rapid slider drags coalesce
 * into one write. Pass `{ flush: true }` to write synchronously.
 */
export function saveSettings(settings, opts = {}) {
  installFlushHook();
  _settingsPending = settings;
  if (opts.flush) {
    flushSettings();
    return;
  }
  if (_settingsTimer == null) {
    _settingsTimer = setTimeout(flushSettings, 250);
  }
}

/**
 * Stats save — also debounced 250 ms but flushes immediately on game-over
 * by passing `{ flush: true }` (see plan §3.1).
 */
let _statsTimer = null;
let _statsPending = null;
function flushStats() {
  if (_statsTimer != null) {
    clearTimeout(_statsTimer);
    _statsTimer = null;
  }
  if (_statsPending != null) {
    writeKey(KEY_STATS, JSON.stringify(_statsPending));
    _statsPending = null;
  }
}
export function saveStats(stats, opts = {}) {
  installFlushHook();
  _statsPending = stats;
  if (opts.flush) {
    flushStats();
    return;
  }
  if (_statsTimer == null) {
    _statsTimer = setTimeout(flushStats, 250);
  }
}

// BPM cache — a flat `{[url]: {bpm, offset, analyzedAt}}` blob. Unlike the
// settings/stats persisters, BPM cache writes are infrequent (once per track
// the very first time it's ever played on a device) so debounce isn't needed.
// Wrapped in try/catch so an unparseable blob (manual edit, schema change)
// degrades to "re-analyze everything next session" rather than crashing.

/** Returns `{}` if nothing saved or parse failed. */
export function loadBpmCache() {
  const incoming = parseOrNull(readKey(KEY_BPM));
  if (!incoming || typeof incoming !== 'object') return {};
  return incoming;
}

/** Replace the on-disk cache. Whole-blob writes — caller manages the merge. */
export function saveBpmCache(blob) {
  if (!blob || typeof blob !== 'object') return;
  writeKey(KEY_BPM, JSON.stringify(blob));
}

/** Test-only: wipe both keys + in-memory shadow. */
export function _resetForTests() {
  _memShadow.clear();
  if (_settingsTimer) { clearTimeout(_settingsTimer); _settingsTimer = null; }
  if (_statsTimer) { clearTimeout(_statsTimer); _statsTimer = null; }
  _settingsPending = null;
  _statsPending = null;
  const ls = safeStorage();
  if (ls) {
    try { ls.removeItem(KEY_SETTINGS); ls.removeItem(KEY_STATS); ls.removeItem(KEY_BPM); }
    catch { /* ignore */ }
  }
}

export const STORAGE_KEYS = Object.freeze({ settings: KEY_SETTINGS, stats: KEY_STATS, bpm: KEY_BPM });
export const _DEFAULTS = Object.freeze({ settings: SETTINGS_DEFAULTS, stats: STATS_DEFAULTS });
