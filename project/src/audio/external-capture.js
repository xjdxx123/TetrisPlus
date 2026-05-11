// External audio capture — getDisplayMedia tab audio → AnalyserNode.
//
// Lets the spiral visualizer react to audio playing in another browser
// tab (YouTube, Bilibili, Spotify Web, SoundCloud, etc.) instead of
// TetrisPlus's own BGM. The captured stream is analysed in our existing
// AudioContext but NOT connected to destination — the user is already
// hearing the audio from its source tab, we don't double-play.
//
// Limitations of this API:
//   - User must pick a tab from the browser's share dialog each time
//     (no persistent permission).
//   - User must check "Share audio" in the dialog. Without it the stream
//     has no audio track and we throw a clear error.
//   - macOS: only tab audio works (not window/screen — Chrome limitation).
//   - Windows: tab + system audio both work.
//   - Track ends if user clicks "Stop sharing" in the browser bar; the
//     `onEnded` callback fires so the caller can revert the UI.

const ANALYSER_FFT_SIZE = 1024;             // match the project's BGM analyser

export function isTabCaptureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

/**
 * Prompts the user to pick a browser tab, captures its audio, and returns
 * an AnalyserNode reading the live stream.
 *
 * @param {Object} opts
 * @param {AudioContext} opts.audioCtx  Shared audio context to attach the
 *                                       analyser to (reuses the project's
 *                                       existing context — no second AC).
 * @returns {Promise<{
 *   stream: MediaStream,
 *   analyser: AnalyserNode,
 *   dispose: () => void,
 *   onEnded: (cb: () => void) => void,
 * }>}
 */
export async function startTabAudioCapture({ audioCtx }) {
  if (!isTabCaptureSupported()) {
    throw new Error('Tab audio capture not supported in this browser');
  }
  if (!audioCtx) {
    throw new Error('startTabAudioCapture requires audioCtx');
  }

  // Spec requires video:true even if we only want audio. We discard it
  // immediately to free the underlying resources.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });

  // Strip video — it'd otherwise keep encoding/transferring frames for no
  // reason and show the green "sharing" indicator in some browsers more
  // prominently. Track must be stopped *and* removed from the stream.
  for (const track of stream.getVideoTracks()) {
    stream.removeTrack(track);
    track.stop();
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    // Most common failure: user forgot "Share audio" checkbox.
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio in the shared tab — make sure the "Share audio" / "Share tab audio" checkbox was checked in the dialog.');
  }

  // AudioContext might be suspended (Chrome autoplay policy) until the
  // user gesture that triggered this capture finishes resolving. Resume
  // so analyser data starts flowing immediately.
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* non-fatal */ }
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  // INTENTIONAL: do NOT connect analyser to destination. Audio is already
  // audible from the source tab; routing here would double-play it.

  // Forward "stream ended" (user clicked Stop sharing) to a caller-set
  // callback so it can flip the UI back to BGM.
  let onEndedCb = null;
  const handleEnded = () => {
    if (onEndedCb) onEndedCb();
  };
  for (const track of audioTracks) {
    track.addEventListener('ended', handleEnded);
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { source.disconnect(); } catch { /* noop */ }
    stream.getTracks().forEach((t) => t.stop());
  };

  return {
    stream,
    analyser,
    dispose,
    onEnded(cb) { onEndedCb = cb; },
  };
}
