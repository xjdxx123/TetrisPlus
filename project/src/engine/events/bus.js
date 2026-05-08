// Synchronous, single-threaded pub/sub. JS is single-threaded; there is no
// reason to queue. Handlers run inline during emit().
//
// Conventions:
//   - Topics are SCREAMING_SNAKE_CASE strings: 'LINE_CLEAR', 'MUSIC_BEAT'.
//   - Payloads are plain objects, frozen by the bus before dispatch — handlers
//     must not mutate them. If they need a working copy, they clone first.
//   - on() returns an unsubscribe function. Always prefer that to off().
//
// Late subscribers can opt into a small replay of the most recent payloads
// per topic (configurable via replayBufferSize). The recorder ring buffer is
// used by the debug overlay (planned in step 10) for inspecting recent
// dispatches without instrumenting every handler.

export class EventBus {
  constructor({ replayBufferSize = 4, recorderSize = 256 } = {}) {
    this._listeners = new Map();
    this._replay = new Map();
    this._replayBufferSize = replayBufferSize;
    this._recorder = [];
    this._recorderSize = recorderSize;
  }

  on(topic, fn, { replay = false } = {}) {
    let set = this._listeners.get(topic);
    if (!set) {
      set = new Set();
      this._listeners.set(topic, set);
    }
    set.add(fn);

    if (replay) {
      const buf = this._replay.get(topic);
      if (buf) for (const p of buf) fn(p);
    }

    return () => {
      const s = this._listeners.get(topic);
      if (s) s.delete(fn);
    };
  }

  off(topic, fn) {
    this._listeners.get(topic)?.delete(fn);
  }

  emit(topic, payload) {
    const frozen =
      payload && typeof payload === 'object' && !Object.isFrozen(payload)
        ? Object.freeze(payload)
        : payload;

    if (this._recorderSize > 0) {
      this._recorder.push({ topic, payload: frozen, t: performance.now() });
      if (this._recorder.length > this._recorderSize) this._recorder.shift();
    }

    if (this._replayBufferSize > 0) {
      let buf = this._replay.get(topic);
      if (!buf) {
        buf = [];
        this._replay.set(topic, buf);
      }
      buf.push(frozen);
      if (buf.length > this._replayBufferSize) buf.shift();
    }

    const set = this._listeners.get(topic);
    if (!set || set.size === 0) return;
    // Snapshot to allow handlers to safely unsubscribe during dispatch.
    const handlers = [...set];
    for (const fn of handlers) {
      try {
        fn(frozen);
      } catch (err) {
        console.error(`[bus] handler for "${topic}" threw:`, err);
      }
    }
  }

  history() {
    return this._recorder.slice();
  }

  clear() {
    this._listeners.clear();
    this._replay.clear();
    this._recorder.length = 0;
  }
}

// App-wide singleton. Subsystems import { bus } and call bus.on/.emit.
// Tests can construct their own EventBus instances.
export const bus = new EventBus();
