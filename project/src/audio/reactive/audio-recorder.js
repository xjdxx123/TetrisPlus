// Rolling audio recorder — Stage 5b extension for multi-track BGM.
//
// Captures the most-recent N seconds of audio flowing through a chosen tap
// point (typically bgmGain) into a circular sample buffer. On demand, the
// buffer is materialized as an AudioBuffer suitable for offline BPM
// analysis (web-audio-beat-detector's `guess`).
//
// Why this exists: a 50-minute BGM file with multiple tracks each at a
// different BPM can't be analyzed once at boot — the global average is
// wrong everywhere. Live-capture lets us re-analyze the *currently playing*
// region without re-decoding the entire file (which would peak at >1 GB
// of PCM and OOM on mobile).
//
// Tradeoffs:
//   - We use a ScriptProcessor, not an AudioWorklet. Worklets are the
//     modern path but require a separate registered module file and Vite
//     bundling configuration. For an opportunistic feature like this,
//     the deprecated-but-functional ScriptProcessor avoids that surface
//     area. Migrate to a worklet later if main-thread cost becomes an
//     issue under load.
//   - Mono. We sum L+R into a single channel because: (a) BPM detection
//     doesn't benefit from stereo, (b) memory halves, (c) analysis runs
//     half as long.
//
// The recorder must be inserted *into* the audio graph (its output
// connected somewhere downstream that ultimately reaches the destination)
// or the browser will optimize the ScriptProcessor away — its
// `onaudioprocess` callback won't fire.

/**
 * @typedef {Object} AudioRecorder
 * @property {AudioNode}  node       Insert this between bgmGain and the next stage.
 * @property {() => { buffer: AudioBuffer, endRealTime: number, durationSec: number } | null} snapshot
 *           Returns the most-recent N seconds as a mono AudioBuffer, plus the
 *           AudioContext currentTime at the recording's end. null until the
 *           ring buffer has filled at least once.
 * @property {() => boolean} isReady  True once the ring buffer is full.
 * @property {number}     durationSec  Window length in seconds.
 * @property {() => void} stop       Detach + free resources.
 */

/**
 * @param {Object} opts
 * @param {AudioContext} opts.context
 * @param {number}       [opts.durationSec=20]   Length of the rolling window.
 * @param {number}       [opts.processorBufferSize=4096]  ScriptProcessor block size.
 * @returns {AudioRecorder}
 */
export function createAudioRecorder({ context, durationSec = 20, processorBufferSize = 4096 } = {}) {
  if (!context) throw new Error('audio-recorder requires an AudioContext');
  if (durationSec <= 0) throw new Error('durationSec must be > 0');

  const sampleRate = context.sampleRate;
  // Round up so the ring covers at least durationSec.
  const ringSize = Math.ceil(durationSec * sampleRate);
  const ring = new Float32Array(ringSize);
  let writeIdx = 0;
  let totalWritten = 0;          // unbounded; used to know when ring is full
  let endRealTimeAtLastWrite = 0;

  // ScriptProcessor takes input → mixes to mono → writes to ring buffer.
  // The output is silence — we don't pass audio through this node. The
  // *caller* is responsible for keeping the parallel graph
  //   bgmGain → analyser → master
  // intact so audio still reaches the destination. We ALSO connect this
  // recorder to a zero-gain node downstream of the destination so the
  // browser actually invokes onaudioprocess.
  const processor = context.createScriptProcessor(processorBufferSize, 2, 1);
  // Mute the processor's output — we don't want to add silence to the master mix.
  // A zero-gain "sink" connected to destination is enough to keep the node alive.
  const sinkGain = context.createGain();
  sinkGain.gain.value = 0;
  processor.connect(sinkGain);
  sinkGain.connect(context.destination);

  processor.onaudioprocess = (e) => {
    const inputL = e.inputBuffer.getChannelData(0);
    const inputR = e.inputBuffer.numberOfChannels > 1
      ? e.inputBuffer.getChannelData(1)
      : inputL;
    const blockLen = inputL.length;
    // Sum-to-mono and write into the ring. Indexing with a manually
    // wrapped cursor avoids allocating a temp array per block.
    for (let i = 0; i < blockLen; i++) {
      ring[writeIdx] = (inputL[i] + inputR[i]) * 0.5;
      writeIdx++;
      if (writeIdx >= ringSize) writeIdx = 0;
    }
    totalWritten += blockLen;
    endRealTimeAtLastWrite = context.currentTime;
  };

  function isReady() {
    return totalWritten >= ringSize;
  }

  /**
   * Materialize the ring as a mono AudioBuffer covering durationSec seconds
   * ending at the moment of the last block written. Returns null if the
   * ring hasn't filled at least once.
   */
  function snapshot() {
    if (!isReady()) return null;
    const out = context.createBuffer(1, ringSize, sampleRate);
    const channel = out.getChannelData(0);
    // The oldest sample is at writeIdx (next position to overwrite); newest
    // is at writeIdx - 1. Linearize from oldest → newest.
    const tail = ringSize - writeIdx;
    channel.set(ring.subarray(writeIdx, ringSize), 0);
    if (writeIdx > 0) channel.set(ring.subarray(0, writeIdx), tail);
    return {
      buffer: out,
      endRealTime: endRealTimeAtLastWrite,
      durationSec,
    };
  }

  function stop() {
    try { processor.onaudioprocess = null; } catch { /* ignore */ }
    try { processor.disconnect(); } catch { /* ignore */ }
    try { sinkGain.disconnect(); } catch { /* ignore */ }
  }

  return {
    node: processor,
    snapshot,
    isReady,
    durationSec,
    stop,
  };
}
