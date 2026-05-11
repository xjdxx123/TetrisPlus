# Tetris+ Audio Interaction Plan

**Date:** 2026-05-11 · **Reference doc:** [`audio_and_vfx.md`](audio_and_vfx.md)
· **Parent:** [`plan_v3.md`](plan_v3.md) §2

The audio chapter grew unplanned from a single "can we visualise the
BGM" question into a substantial system: 6-band FeatureBus, live beat
tracker, scene-embedded Muon-style spiral, external tab capture,
game-event hooks, debug overlays. ~25 commits since `4a3062c`.

This plan covers what comes next. Two horizons: **medium-term** (weeks
of focused work, each item ships independently) and **long-term**
(months / strategic moves, each requires a real spike before
committing). A short **speculative** section parks ideas that aren't on
the table but are worth recording so they're not re-invented from
scratch.

The architectural floor — `bindings.js` is the only place audio writes
visual state, `audio/` never imports `three`, FeatureBus follows the
active analyser via thunk — is **load-bearing** for everything below.
Every M / L item must preserve it.

---

## 0. Status

Current shipped state (latest as of commit `63cf90f`):

| Surface | What it does | Reactive to |
|---|---|---|
| `selectiveBloom` | Bloom scale follows highMid energy + sub/bass kick (max-merge) | FB bands + kick envelopes |
| `chromaticPass` | CA strength follows air norm + anticipation | FB bands + live tracker |
| `nebula.intensity` | Slow breathing with bass | FB bands |
| `ambientField.flow` | Speed scales with lowMid | FB bands |
| `activePieceEdges` | Edge intensity scales with bass | FB bands |
| Spiral visualizer | Wave amplitude + Z displacement + colour cycle | FB bands or Muon-native audioProcessing (toggleable) |
| Spiral opacity pulse | 120 ms gsap flash on sub+bass kick rising edge | Direct envelope read (8 ms latency) |
| Spiral preset morph | gsap-tween `radiusMultiplier` to next preset | Game events (LINE_CLEAR / TETRIS / LEVEL_UP / PERFECT_CLEAR / T_SPIN / B2B) |
| Spiral anticipation | Pre-beat lean-in via `liveBeat.anticipation` | Live tracker output |

Detailed architecture lives in [`audio_and_vfx.md`](audio_and_vfx.md).

Known weak points that motivate the next work:

1. **BPM accuracy** — our `live-beat-tracker.js` is naive (median of last
   8 kick intervals). Misses on songs with weak kicks or stylistic
   variation. Anticipation ramp lands wrong when BPM is wrong.
2. **No per-track personalisation** — every song gets the same default
   `bgZ` / `bgScale` / `colorSpectrum` / spiral preset cycle. A quiet
   piano piece looks the same as a dance banger.
3. **Spiral only reacts to drums** — colour / shape don't follow
   harmony, key, or texture. Anything non-percussive (ambient,
   classical) reads as "the spiral is doing its thing regardless".
4. **No spawned visuals on beat** — kick fires opacity pulse but no
   one-shot emitter spawns particles, fires shockwaves, etc. The dust
   that exists is continuous, not impulse-driven.

---

## 1. Medium-term (weeks)

Six concrete items. Each ships independently. Effort estimates assume
one focused session.

### M-1. Swap `live-beat-tracker` internals to `realtime-bpm-analyzer`

**Status.** Open. Recommended next step.

**Why.** Our median-of-intervals BPM estimator was the right MVP but
has known limits: 3-kick warm-up, single-bad-onset poisons the median,
adapts slowly to tempo changes. The community library
[realtime-bpm-analyzer](https://www.realtime-bpm-analyzer.com/) (Apache
2.0, active 2026) uses AudioWorklet + chunk-ID probabilistic
accumulation. Accuracy ±1–2 BPM with similar latency.

**Approach.**
- `pnpm add realtime-bpm-analyzer`.
- Rewrite `src/audio/reactive/live-beat-tracker.js` so it consumes the
  library's `getCurrentTempo()` instead of medianing FB onsets.
- **Keep the public API** (`.bpm`, `.anticipation`, `.phase`,
  `.isAnalyzed`) — spiral and debug overlay shouldn't notice.
- Anticipation projection logic stays ours (the library outputs BPM, not
  a ramp; we derive the 250 ms lookahead from `lastKick + 60/BPM`).

**Effort.** 1–2 hours.

**Risk.** Low. Library is single-purpose, well-tested, no native deps.
Worst case it doesn't help and we revert.

**Verification.** Beat lab strip chart's white-tick alignment with the
red kick-onset ticks is the visual contract; aligned = working.

### M-2. Per-BGM visual presets

**Status.** Open.

**Why.** Different songs deserve different defaults. A piano-only piece
shouldn't fire the same 5× Tetris flash as a dubstep drop; a slow
ambient track wants a different spiral preset cycle than a chiptune
banger. Current single-default-everywhere reads as "the visualiser is
indifferent to what's playing."

**Approach.**
1. Define ~4 named presets in a new `src/vfx/visualizers/muon-original/presets.js`:
   - `quiet` — low maxPoints, mono-blue, low opacity, no morph
   - `melodic` — mid maxPoints, full colour cycle, moderate morph
   - `energetic` — high maxPoints, fast colour cycle, frequent morph
   - `intense` — max maxPoints, mono with hot accent, every-kick morph
2. Augment `bpm-cache.js` to also store a preset name per track URL
   (same `localStorage` slot, additional `preset` field). Default `null`
   = use system preset.
3. On BGM change, look up cached preset; if hit, `gsap.to(spiralWave.params, presetObject, { duration: 1.5 })` for a smooth handoff.
4. Settings → Spiral gets a "Preset" segmented control bound to the
   current track's slot.

**Effort.** 4–6 hours.

**Risk.** Medium. Preset definitions are subjective — needs playtest.

**Decision points.**
- Auto-classify song into preset by BPM/energy on first play, OR ask
  user to tag? Start with manual tag in Settings → Spiral; add auto-classify
  as L-3 follow-up.
- Should external tab capture get the same preset machinery? Probably
  not for v1 (we don't know what's playing). Hard-code "external" =
  one specific preset.

### M-3. Conditional HARD_DROP reaction

**Status.** Open.

**Why.** HARD_DROP fires on every piece — too frequent to react every
time without strobing. But a *long* hard drop (board near empty, piece
falls 18+ rows) is a satisfying moment that currently goes
unrewarded in the spiral.

**Approach.** In the `bus.on(EVENTS.HARD_DROP, …)` block we previously
left empty, gate on the payload's `dropRows`:

```js
bus.on(EVENTS.HARD_DROP, ({ dropRows = 0 } = {}) => {
  if (dropRows >= 14) {
    spiralWave.pulseOpacity(1.5 + dropRows * 0.04, 200);
  }
});
```

**Effort.** 30 minutes.

**Risk.** Low.

**Tuning.** Threshold value (14 rows) and pulse magnitude need playtest.

### M-4. Phase-driven spiral rotation

**Status.** Open.

**Why.** The spiral group currently has no autonomous motion — only
camera-driven rotation. A slow self-rotation locked to BPM phase would
read as "the spiral is dancing with the music" instead of "the spiral
is the background of the music."

**Approach.** In `muon-original/index.js` tick:

```js
if (beatGrid && beatGrid.isAnalyzed) {
  const bpm = beatGrid.bpm;                       // e.g. 120
  const radPerSec = (bpm / 60) * Math.PI * 2 / 16; // one revolution / 16 beats
  spiralGroup.rotation.z += radPerSec * timeDelta;
}
```

Expose toggle + speed multiplier in Settings → Spiral → Beat sync section.

**Effort.** 1 hour including UI.

**Risk.** Low. Worth gating behind a setting in case it conflicts with
particleMirror's existing rotation.

### M-5. Pre-beat hue shift

**Status.** Open.

**Why.** Currently anticipation drives amplitude and opacity. Adding a
**hue shift** (5–10° prior to beat, snapping back at beat) would push
the "predictive" feel further — colour itself anticipates.

**Approach.** In muon's `hueControl` integration, blend the
fixed-by-time hue with an anticipation-modulated offset:

```js
const baseHue = CoreControls.hueControl(_delta * timeDelta / 2);
const hueOffset = antic * 0.05;   // up to 5° (0.05 / 360 * 360)
const liveHue = (baseHue + hueOffset) % 1;
```

**Effort.** 30 minutes.

**Risk.** Low. May read as "colour glitches randomly" if too aggressive
— start subtle.

### M-6. Onset → dust burst emitter

**Status.** Open. Requires emitter wiring.

**Why.** The dust system in muon's vendored `ParticleEmitter` is
*continuous* — particles spawn each frame based on `beatScalerFactor`,
fade over `lifespan`. There's no "fire 50 particles on this exact
beat" code path. Adding one gives the spiral a true impulse-driven
particle stream.

**Approach.**
- Subscribe to `feature.onsets.on('kick')` inside the spiral
  initialisation (or pass through main.js).
- On each kick, push `N = strength * 20` particles to the
  `emittedParticleSystem` at randomised angles within a 30° arc.
- Reuse the existing buffer geometry — just write to next-available
  slots in the ring buffer.

**Caveat.** The dust ring buffer is full at 600 particles; need to
think about how to overwrite oldest vs queue. Easier to reset N slots
on each kick than to track free slots.

**Effort.** 3–4 hours.

**Risk.** Medium. Touching the vendored emitter is delicate; consider
forking it as `dust-burst-emitter.js` rather than modifying Muon's
original.

### M-7. (parking) Tune pulse multipliers from playtest data

**Status.** Open, low priority.

**Why.** Current values (LINE_CLEAR ×4 = 5.0×, PERFECT_CLEAR = 6.0×)
were picked from HDR-multiply intuition, not playtested. Worth a
post-deploy adjust.

**Approach.** Play through 20 BGM tracks at various Modes, record
where pulses feel "right vs overkill". Cut down to 3 multiplier tiers
instead of the current 5.

**Effort.** ~1 hour of play + 30 min of edits.

**Risk.** Low.

---

## 2. Long-term (months)

Five strategic moves. Each is genuinely multi-day work, requires
spike before committing.

### L-1. Harmonic-reactive colour via Meyda

**Status.** Open. Speculative until spiked.

**Why.** The single biggest gap in the current system: *colour doesn't
follow musical content beyond brightness*. A song in C-major and the
same arrangement transposed to F-minor look identical. Meyda exposes:

- `chroma` — 12-element pitch-class energy vector (key detection)
- `mfcc` — 13-coefficient timbral signature
- `spectralCentroid` — "brightness" of the timbre
- `perceptualSpread` / `perceptualSharpness`

**Approach.**
1. `pnpm add meyda`. Pure-JS, ~50 KB, MIT.
2. Add a Meyda analyser on the *same* analyser FeatureBus uses (cheap
   double-read), running every 4 frames (15 Hz is plenty for chroma).
3. Map chroma dominant pitch class → hue (12 hues evenly spaced).
4. Map spectralCentroid → saturation.
5. Map MFCC[1] (overall timbre brightness) → lightness floor.
6. Combine with existing `hueControl` time-based rotation
   multiplicatively (slow time drift × pitch-aware bias).

**Effort.** 1–2 days for a working spike. Probably another 1 day of
tuning before it ships.

**Risk.** High. The mapping is *opinionated* — chroma → hue is one
of many possible. Need playtest to know if "songs in C-major are
red, songs in D# are yellow" reads as "intelligent" or "arbitrary."

**Verification.** Visual: play 4 songs of different keys back-to-back,
verify the spiral's dominant hue actually changes. Console: log
chroma[] each second, verify dominant index matches what music theory
says about the track.

### L-2. Audio-source-aware Settings

**Status.** Open.

**Why.** When user pipes external tab audio (e.g. live DJ stream), the
defaults tuned for TetrisPlus BGM may not fit. A YouTube acoustic
session needs different sensitivity than a Spotify dance playlist.

**Approach.**
1. Detect audio source mode (BGM / external) — already known via
   `_captureHandle != null`.
2. Store **two parallel parameter slots** in `localStorage`:
   `visualizer.bgm.*` and `visualizer.external.*`.
3. On source switch, fade params from one slot to the other over 1 s.
4. Settings → Spiral displays which slot you're editing; "Save as
   default for BGM/external" buttons.

**Effort.** 1 day.

**Risk.** Medium-low. Adds complexity to persistence layer; might
need a v2 migration.

### L-3. Multi-visualizer system

**Status.** Open. Speculative — needs UX research first.

**Why.** muon spiral is one of many possible visualizers. We've
vendored its source in `src/vfx/visualizers/muon-original/`. If we
want to *also* offer e.g. a particle field, a butterfly-style
projector, an oscilloscope ring — we need a framework, not a hard-coded
single instance.

**Approach (sketch).**
1. Abstract `Visualizer` interface: `{ init(scene, audio, feature),
   tick(dt), setMode(mode), setParams(params), dispose() }`.
2. Refactor `muon-original` to implement this interface.
3. Build 1–2 alternative visualizers as proof:
   - Simple particle galaxy (fewer pieces moving, cleaner read)
   - Frequency-bar ring (more on-the-nose)
4. Settings → Spiral gets "Visualizer" segmented control.
5. Only one active at a time (memory + perf).

**Effort.** 3–4 days for framework + one alt visualizer; another 2–3
days per additional visualizer.

**Risk.** Medium. We end up with three half-finished visualizers
instead of one polished one if scope creeps.

**Decision point.** Don't start this unless someone genuinely wants a
second style. The "one visualizer well-tuned" path is also valid.

### L-4. Per-track persisted parameters

**Status.** Open. Depends on M-1.

**Why.** After M-1's BPM accuracy fix and M-2's per-BGM preset, the
next logical move is: every track has its own remembered
state — its BPM (from realtime-bpm-analyzer accumulated history), its
preset, its custom user overrides if any.

**Approach.**
1. Extend `bpm-cache.js` to a generic `track-cache.js` with schema:
   ```js
   { bpm, offset, preset, customParams, keyHueBias, lastPlayed }
   ```
2. On every BGM change, write the current state when leaving (debounced).
3. On replay of a known track, hydrate everything in one go.

**Effort.** ~1 day.

**Risk.** Low. Storage schema migration is straightforward — old slots
just have null fields.

### L-5. ML beat tracker exploration

**Status.** Open. Research spike only.

**Why.** Tempo / beat detection is fundamentally a probabilistic
problem. Classical (Bello et al.) approaches have a structural latency
floor (~50–100 ms even at best). ML models (madmom, BTrack neural
variants) can *predict* beats — anticipate where the next one will be
based on the recent pattern, with effectively zero latency.

**Approach.** Spike, not commit:
1. Investigate available WASM ports — most are too large (>100 MB
   model weights). The realistic options:
   - madmom: pure-Python, no WASM port that's web-ready
   - aubio's neural tempo extension: doesn't exist
   - Custom WASM compile of a tiny pre-trained beat tracker?
2. If none viable, document the finding and move on.

**Effort.** 1–2 days for spike + decision.

**Risk.** High likelihood of "nothing usable exists yet". Document
findings either way.

---

## 3. Speculative (parking lot)

Not on the roadmap. Recorded so we don't re-investigate from scratch.

### S-1. Genre classification → visual style auto-switch

Use chroma + MFCC + tempo features to feed a small classifier (k-NN
over labelled tracks?) that picks a preset automatically. Subsumes M-2
once L-4 is in.

Probably needs a labelled dataset of ~20 tracks per genre × 5 genres,
then iterative tuning. Significant effort for unclear UX win.

### S-2. Lyric-aware effects

If the BGM track has LRC-format synchronised lyrics (some sources
expose them), emit a pulse on each lyric line; word-by-word for
karaoke-style.

Blocked on lyric source — most TetrisPlus BGM is instrumental anyway.
Maybe relevant only for external tab capture (YouTube has timed
captions).

### S-3. Real-time stem separation

Demucs / Spleeter run inference on audio to separate drums / bass /
vocals / other. Drums-only stream would give perfect kick detection
with no false positives from bassline.

WASM-feasibility: model sizes 50-500 MB. Even with int8 quantisation,
running real-time in a browser tab while playing Tetris is unproven.
Wait for someone to ship a 10 MB usable model before considering.

### S-4. Procedural shader from audio features

Instead of tuning shader uniforms with audio-derived scalars,
*generate* the shader from the audio analysis. A small ML model
emitting GLSL based on track style. Far future; might never make
sense.

---

## 4. Open questions / decisions needed

These come up repeatedly in conversations and should be settled when
we touch each related item.

**Q-1: realtime-bpm-analyzer's warm-up time.** Library claims < 5 s
to first stable BPM. Verify on actual BGM playlist before
committing M-1. If it's slower than our naive median tracker,
hybrid (median bootstrap → library steady-state) is needed.

**Q-2: Should `bindings.js` move spiral-related bindings inside it?**
The spiral currently reads FeatureBus directly and writes its own
uniforms — technically violates the "single integration point" rule.
*Arguable*: the spiral's uniforms aren't external scene state, they're
its own scene-graph state. Probably keep the spiral self-contained
but document the exception in `bindings.js`.

**Q-3: External capture quality of life.** Right now it prompts every
session (browser policy). If we go heavy on M-2/L-4 (per-track presets),
external capture gets stuck with one default. Either build a "guess
the source" heuristic (which is itself the start of S-1), or accept
that external mode = one preset and document it.

**Q-4: Settings panel info density.** The Spiral tab is already long
(Mode / Placement / Opacity / Beat sync / Audio source / Geometry /
Dust / Color). Adding M-2's Preset segmented and L-1's harmonic
toggles risks pushing it past usable. Need a "more…" disclosure or
sub-tabs.

**Q-5: How aggressive should preset switches be?** When BGM changes,
should the visual snap (jarring but synchronised with the music
change), or tween over 1–2 s (smoother but creates a "settling"
period)? L-2 says 1 s; revisit after playtest.

---

## 5. Final word

The audio-reactive chapter has *more remaining surface area than v3
itself*. That's a signal: the area is rich. Pick one M item at a
time, ship it, observe in playtest, decide whether the next one
follows.

Strong gut order (subject to user priority):
1. **M-1** (BPM accuracy) — highest-leverage fix; everything else
   downstream depends on accurate BPM.
2. **M-3** (HARD_DROP conditional) — 30 minutes for a real game-feel
   reward.
3. **M-5** (pre-beat hue shift) — 30 minutes, makes anticipation
   genuinely visible.
4. **M-2** (per-BGM presets) — bigger, but the "songs feel different"
   payoff is large.
5. (L-1 if any of M land well; revisit speculative items only after
    L-1's chroma spike either shipped or formally killed.)

The long-term and speculative items are *deliberately not estimated to
a date*. Audio-reactivity polish is a forever frontier; one ships when
inspired, not when scheduled.

---

*End of audio plan. Reference architecture in `audio_and_vfx.md`.
Parent roadmap in `plan_v3.md`.*
