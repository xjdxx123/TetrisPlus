# Audio 与 VFX 集成架构

本文档详细描述 TetrisPlus 中音频从"声音"变成"视觉"的完整数据流：从浏览器 Web Audio
API 的 AnalyserNode，到 6 频带分析、节拍检测、事件总线，最终落到 Three.js shader
uniform 与 spiral 可视化器。同时也是排查"音乐响了但 spiral 没反应"这类问题时
的对照表。

适用范围：截至 `9dbb983`（live beat tracker / external capture 集成完成）之后的架构。

---

## 1. 总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Web Audio Graph                                │
│                                                                       │
│  HTMLAudio                                                            │
│    │                                                                  │
│    └─► MediaElementSource ─► bgmGain ─┐                              │
│                                       │                               │
│  SFX synth ─► sfxGain ────────────────┤                              │
│  Voice    ─► voiceGain ───────────────┼─► master ─► destination       │
│                                       │                               │
│                          AnalyserNode ◄─┘   ← spiral & FeatureBus    │
│                          (BGM 抽头)         读这里                    │
│                                                                       │
│  ┌─ external capture (getDisplayMedia) ─────────────────────────────┐│
│  │  MediaStream ─► MediaStreamSource ─► AnalyserNode (capture-only)││
│  │                                                  ↑               ││
│  │                                  feature.getAnalyser() 切到这    ││
│  │                                  之后 FB 整条管线跟着走           ││
│  └────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                       Reactive Analysis Layer                         │
│                                                                       │
│  AnalyserNode (active)                                                │
│       │                                                               │
│       ▼                                                               │
│  AnalyserSampler ── 每帧缓存一次 getByteFrequencyData，避免重复读     │
│       │                                                               │
│       ▼                                                               │
│  Bands (6 band log split)                                             │
│       │  sub / bass / lowMid / mid / highMid / air                    │
│       ▼                                                               │
│  per-band stateful processors:                                        │
│    ├─ Envelope (asym attack/release)                                  │
│    ├─ Normalizer (AGC, ~30s 半衰期 peak)                              │
│    ├─ Flux (half-wave rectified d/dt, transient only)                 │
│    └─ Kick envelope (impulse follower)                                │
│       │                                                               │
│       ▼                                                               │
│  FeatureBus ── 统一出口                                               │
│   .bands.X.{value, env, norm, flux, kick}                             │
│   .onsets.on('kick'/'snare'/'generic', strength => …)                 │
│   .totalSec, .isBound                                                 │
│       │                                                               │
│       ├──► LiveBeatTracker (实时 BPM + anticipation)                  │
│       │                                                               │
│       ▼                                                               │
│  Bindings.tick() (vfx/reactive/bindings.js)                           │
│   ← 唯一允许写视觉的地方                                              │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                     Visual / VFX consumers                            │
│                                                                       │
│  Bindings writes to:                                                  │
│    selectiveBloom.scale         ← highMid kick                        │
│    chromaticPass.uAmount        ← air norm + anticipation             │
│    ambientField.flow            ← lowMid norm                         │
│    activePieceEdges.intensity   ← bass norm                           │
│    nebula.intensity             ← bass norm                           │
│                                                                       │
│  Spiral visualizer (muon-original, scene-embedded):                   │
│    reads AnalyserNode directly (Muon mode) OR FeatureBus (FB mode)    │
│    + live tracker anticipation                                        │
│    + game-event hooks (LINE_CLEAR / TETRIS / LEVEL_UP …)             │
└──────────────────────────────────────────────────────────────────────┘
```

**核心原则**

1. **单一上下文**：整个项目共用一个 `AudioContext`（在 playback.js 里），所有节点
   都挂在它上面。external capture 创建第二个 `AnalyserNode` 但仍挂在同一个 context。
2. **架构铁律**：`audio/` 不能 import `three`。所有"音频写视觉"必须经过
   `vfx/reactive/bindings.js`。这条规则在两个 README 里都明确写了。
3. **AnalyserNode 源可切换**：BGM ↔ external tab capture。通过 FeatureBus 的
   `getAnalyser` thunk 实现，下游所有 6 band / onset / kick / BPM 都自动跟。
4. **离散事件 + 连续信号双通道**：FeatureBus 既暴露每帧采样的 `.bands.X.norm`，
   也暴露 `.onsets.on('kick', …)` 离散事件。两种 hook 各有用途。

---

## 2. 播放层 (`src/audio/playback.js`)

唯一一个真正"播放"声音的模块。其他所有 audio 文件都只是"分析"已经在播的声音。

### 2.1 启动

`createAudioPlayback({ voices, bgmEl, volumes })` 返回一个对象，但**所有内部资源
延迟到第一次用户手势才创建**——浏览器自动播放策略禁止脚本启动 `AudioContext`。

```js
audio.init();  // 在第一次 keydown/pointerdown 调，幂等
```

`init()` 之后 `audio.analyser` 才非 null。FeatureBus 在它 null 时 tick 是 no-op，
不会崩。

### 2.2 BGM 接入图

```
<audio id="bgmAudio">  ← HTML 元素，src 由 BGM playlist 切换
    │
    ▼
MediaElementSource     ← 把 HTML <audio> 接进 Web Audio
    │
    ▼
bgmGain (GainNode)     ← 用户音量 + 自动 ducking（语音播报时 BGM 自动降）
    │
    ├──► analyser (AnalyserNode, fftSize=1024, smoothingTC=0)
    │       ↑
    │       └── 这是 FeatureBus + spiral 抽头的位置
    │
    └──► master ── destination
```

**为什么 `smoothingTimeConstant = 0`**：FeatureBus 自己有更精细的 envelope follower
和 AGC normalizer 做平滑，不需要 AnalyserNode 那个简单的指数平均。这条决定在
[playback.js:124](../project/src/audio/playback.js) 里有注释解释。

### 2.3 SFX 与 voice

- `playSfx(name, arg)` ── 程序化合成短音效（每次按键、消行、硬下落、level up 等
  瞬时音）。SFX 不经过 BGM 的 analyser，分析层看不到。
- `playVoice(name)` ── 预解码的喊话片段（"TETRIS!" / "PERFECT CLEAR!"）。
  会触发 ducking——播放期间 BGM 被压低 ~6 dB，结束后 fade 回来。

---

## 3. 反应分析层 (`src/audio/reactive/`)

整层只读 AnalyserNode，不播放任何东西。

### 3.1 AnalyserSampler (`analyser.js`)

把 `getByteFrequencyData` 包了一层 per-frame 缓存。第一次调用 `sample(frameId)`
时读 analyser 填 Uint8Array，同一 frameId 后续调用复用结果。多个消费者（bands、
spiral、debug overlay）共享一次实际读取，避免每帧 N 次原生调用。

接受 `getAnalyser` thunk 而不是 AnalyserNode 实例——因为：
- BGM 路径下 audio.analyser 在 init 前是 null
- external capture 路径下 analyser 会动态切

```js
const sampler = createAnalyserSampler({ getAnalyser: () => activeAnalyser });
```

### 3.2 Bands (`bands.js`) — 6 个对数频带

把 512 个 FFT bin 按对数频率范围聚合成 6 个有人耳含义的频带：

| 名称 | 频率范围 (Hz) | 物理含义 |
|---|---|---|
| `sub` | 20–60 | 极低频 / 鼓底 |
| `bass` | 60–200 | kick drum body |
| `lowMid` | 200–500 | 男声 / 贝斯 |
| `mid` | 500–2000 | 主旋律 / snare crack |
| `highMid` | 2000–6000 | 吉他 / 镲 / 人声齿音 |
| `air` | 6000–16000 | hi-hat / 环境亮度 |

每帧 `integrate(binsNorm)` 把当前帧的 512 个归一化 bin 在每个带内平均，得到
`{sub, bass, …, air}.norm` ∈ [0, 1]。

### 3.3 Envelope follower (`envelope.js`)

每个频带都包一个非对称的 attack/release 平滑器：

```
attack tau (ms):   8     ← 上升快，捕捉 transient
release tau (ms):  60–220 ← 下降慢，维持 glow
```

`env` 信号比 `value` 平滑，适合驱动持续性效果（bloom intensity、ambient flow）。

### 3.4 Normalizer (`normalizer.js`) — AGC

跟踪每个带的"近期峰值"，用衰减时间常数 ~30 秒。把 `env / peak` 归一到 [0, 1]：

```
norm = env / running_peak       ← AGC 归一化
running_peak *= 0.9995          ← 慢慢遗忘，让安静段也能"满刻度"
```

效果：响和小声的曲子都能给视觉**接近 1 的满刻度信号**，bloom 永远在合理强度。
这是 spiral 走 FeatureBus 模式时表现稳定的原因。

### 3.5 Flux (`flux`) 与 kick impulse

- `flux` = 半波整流的 `env` 时间导数。**只有上升沿才有值**，下降时为 0。
  用来检测瞬态。
- `kick` = `flux` 再过一个 fast attack / fast release 的 envelope follower。
  视觉上是"鼓点冲击"的连续信号——drum hit 时跳到 1，~80ms 内回 0。

每个频带都有自己的 `kick`，下游可以选：
- `bass.kick` ── 鼓底冲击（最常用于驱动光晕、形变）
- `air.kick` ── 镲 / 高频突起
- `highMid.kick` ── snare 的脆响

### 3.6 Onset detector (`onset.js`)

基于 Bello et al. 2005 的自适应阈值算法：
1. 滚动窗口（24 帧）记录 `flux` 最近值
2. 阈值 = 窗口中位数 × 1.5 + offset
3. 当前 flux 跨越阈值且不在 refractory 内 → 触发离散 onset 事件

输出三个独立通道，每个绑到一个频带：

| 通道 | 源频带 | 用途 |
|---|---|---|
| `kick` | bass | 鼓底节拍 |
| `snare` | mid | 军鼓 / 击掌 |
| `generic` | air | 镲 / 沙锤 / 高频任意瞬态 |

```js
feature.onsets.on('kick', (strength) => { /* 离散触发 */ });
```

`strength` ∈ [0, 1]，代表这次 onset 的强度（用于按击强度分级反应）。

`feature.onsets.telemetry('kick')` 返回 `{ lastFireAtSec, lastStrength }`，
debug overlay 用这个绘制 fading dots。

### 3.7 FeatureBus (`feature-bus.js`) — 统一出口

把以上所有处理器组装起来，per-tick 计算并缓存所有信号：

```js
feature.tick()  // 在主 render loop 调一次
feature.bands.bass.norm    // 0..1, AGC 归一化后的能量
feature.bands.bass.kick    // 0..1, 冲击 envelope
feature.bands.bass.env     // 0..1, 平滑（pre-AGC）
feature.bands.bass.flux    // 0..1, 瞬态信号
feature.bands.bass.value   // 0..1, 原始能量
feature.onsets             // EventEmitter 风格
feature.totalSec           // 累积 tick 秒数
feature.isBound            // analyser 已绑定（init 后为 true）
```

**接受 `getAnalyser` 可选参数**（最近加的）：

```js
const featureBus = createFeatureBus({
  audio,
  getAnalyser: () => activeCaptureAnalyser ?? audio.analyser,
});
```

不传就用 audio.analyser（BGM）。传了就跟着 thunk 走——external capture 切换
audio 源时**整条管线自动跟随**（bands / envelopes / AGC / onsets / kicks 全部）。

### 3.8 BPM 检测：两条并行路径

#### A. Offline (`beat-grid.js` + `bpm-cache.js`) — 历史路径

- 对每首 BGM 跑一次 `web-audio-beat-detector.guess(audioBuffer)`
- 拿到 `{ bpm, offset }`，存进 localStorage（per-track key）
- 之后 beat-grid 用这个固定 BPM 实时投影出 `anticipation` ramp（拍前 250ms 0→1）
  和 `phase`（拍周期内 sawtooth）

**优点**：BGM 确定的话非常精确，跨会话缓存。  
**缺点**：
- 只能处理预解码的 AudioBuffer。**外部 tab capture 没法用**。
- 某些曲子分析失败（half/double tempo，弱 kick，节奏变化）。
- 一次性的，整首歌固定 BPM。

#### B. Live (`live-beat-tracker.js`) — 当前主路径

- 订阅 `feature.onsets.on('kick', …)`
- 维护最近 8 次 kick 的时间戳
- BPM = 60 / median(连续 kick 间隔)（过滤到 30–300 BPM 范围）
- anticipation = `1 - timeToNext / 250ms`，时间投影自最近 kick + median 间隔

**优点**：
- 任何音源都能用（BGM、external capture、未来的 microphone）
- 自适应节奏变化
- 不需要离线 buffer

**缺点**：
- 需要 ~3 个 kick 才稳定（~1-3 秒 warm-up）
- 完全依赖 FB 的 onset 检测质量——onset 检测不到 kick 就抓不到节拍

**两条路径并存**：offline beat-grid 还在 main.js 里 tick + 接 bpmCache，可能给
未来的功能留着用。spiral 和 debug overlay 都已切到 live 路径。

### 3.9 BPM cache (`bpm-cache.js`)

`web-audio-beat-detector` 分析是异步且耗时的（每首 ~5 秒）。bpmCache 包了一层：
- 第一次播某曲：decode → `analyzer.guess(audioBuffer)` → 存 `{bpm, offset}`
- 之后：直接命中 cache，立即喂给 beat-grid

只服务 offline 路径，live tracker 不经过它。

---

## 4. External Audio Capture (`src/audio/external-capture.js`)

允许 spiral 反应另一个 tab 在播的音频（YouTube / Spotify Web / B 站 / SoundCloud
等）而不是 TetrisPlus 自己的 BGM。

### 4.1 Browser API

```js
const stream = await navigator.mediaDevices.getDisplayMedia({
  audio: true,
  video: true,   // 规范要求，立刻丢
});
```

用户在浏览器选择对话框里挑要分享的 tab，**必须勾选 "Share audio" 复选框**——
否则返回的 stream 没有 audio track。

### 4.2 接入 Web Audio

```js
const source = audioCtx.createMediaStreamSource(stream);
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 1024;
analyser.smoothingTimeConstant = 0;
source.connect(analyser);
// 故意不连 destination ── 避免重播（用户本来就在源 tab 听）
```

### 4.3 切换流程

```
user clicks "Capture browser tab"
    │
    ▼
getDisplayMedia → stream → analyser
    │
    ▼
spiralWave.setExternalAnalyser(newAnalyser)
    │     ↑ muon-original 内部 wavesurfer mock 切到新源
    │
    ▼
_captureHandle = cap
    │
    ▼
featureBus 下次 tick 时通过 getAnalyser thunk 拿到新 analyser
    │     ↑ 整条管线（bands/envelopes/onsets/kicks/BPM）自动跟着切
    │
    ▼
liveBeat 通过 FB onsets 自动跟着切
```

### 4.4 限制

- 用户必须每次手动授权（浏览器隐私策略，不能持久化）
- macOS：只支持 tab 模式带 audio，window/screen audio 在 Chrome 不可用
- 浏览器顶上"Stop sharing"会自动 fallback 到 BGM（通过 track.ended 事件）

---

## 5. Audio → VFX 集成：架构铁律

整个系统最重要的一条规则，来自 [vfx/README.md](../project/src/vfx/README.md)：

> **音频 publish 流和事件。视觉 subscribe 这些流。**
>
> `audio/` 没有 `three` import。所有从音频信号写到 material uniform 的桥
> 都在 `vfx/reactive/bindings.js`。

### 5.1 反例（禁止）

```js
// ✗ 在 audio/ 里
glassMaterial.uniforms.uBassPulse.value = bandEnergy.bass;
```

### 5.2 正例（vfx/reactive/bindings.js）

`createBindings({ feature, targets, beatGrid })` 返回一个 bindings 列表，每条是
`{ get, apply }`：

```js
bindings.push({
  name: 'highMid.{norm,kick} → selectiveBloom.scale',
  get: () => 0.15 * feature.bands.highMid.norm
           + 0.85 * feature.bands.highMid.kick,
  apply: (v) => { targets.selectiveBloom.setBloomScale(lerp(0.7, 2.6, v)); },
});
```

`bindings.tick()` 每帧把所有 get-apply 跑一遍。**这是整个项目里"音频→视觉"的
唯一入口**。

### 5.3 当前注册的 bindings

| 源信号 | 写到哪里 | 视觉效果 |
|---|---|---|
| `highMid.norm + highMid.kick` | `selectiveBloom.setBloomScale` | 镲与亮高频驱动光晕扩大 |
| `air.norm` | `chromaticPass.uAmount` | air 能量推 chromatic aberration |
| `lowMid.norm` | `ambientField.flowSpeed` | 背景流场速度 |
| `bass.norm` | `activePieceEdges.intensity` | 落子描边随 bass 呼吸 |
| `bass.norm` | `nebula.intensity` | 星云亮度 |
| `beatGrid.anticipation` × 上面所有 | 拍前 250ms 放大乘数 | "蓄力 → 释放"感 |

所有 binding 都是**乘法 / 加法叠加**，不是覆盖。意味着 selectiveBloom 还可以同时
接受游戏事件的 `event_modifier`（比如 level-up flash），两条路径不打架。

---

## 6. Spiral Visualizer (`src/vfx/visualizers/muon-original/`)

最近做的"游戏背景音乐可视化"，从 najafmohammed/muon-music-visualizer (MIT) vendor 过来的。

### 6.1 架构：scene-embedded

不是独立 canvas，而是**直接挂进游戏 Three.js scene**：

```
gameScene
  ├─ 棋盘 / 方块 / nebula / …（游戏正常内容）
  └─ spiralGroup (Object3D, position.z = -200, scale = 3.3)
        ├─ particles  (Muon 主螺旋, 5400 点)
        ├─ particles2 (镜像旋转 -90°)
        └─ emittedParticleSystem (curl-noise dust, 600 粒子)
```

好处：
- 自动跟游戏相机旋转 → "Tetris Effect 宇宙背景"感
- 自动享受游戏的 selectiveBloom / vignette / chromatic post-process
- 不需要双 WebGL context 不需要 canvas opacity hack
- 棋盘块通过 depthTest 自然遮挡 spiral

### 6.2 音频路径：两种模式

`muon-original` 维护自己的 fake wavesurfer mock，让 Muon 原版 audioProcessing 跑得动：

```js
const wavesurfer = {
  isPlaying: () => !!activeAnalyser(),
  backend: { get analyser() { return activeAnalyser(); } },
};

const activeAnalyser = () =>
    _externalAnalyser     // 优先 external capture
 ?? audio?.analyser       // fallback BGM
 ?? null;
```

`_externalAnalyser` 通过 `spiralWave.setExternalAnalyser(node)` 切。

**audioFeats 分两条**（params.useFeatureBus 控制）：

```
useFeatureBus = false (Muon native)
   ↓
audioProcessing(dataArray) ── Muon 自己的简陋平均 + 指数曲线
   ↓
exponentialBassScaler ≈ bass 平均 / 200 (max 0.1)
exponentialTrebleScaler ≈ 同
coreScaler ≈ 1 + bass * distortion * 4

useFeatureBus = true (TetrisPlus FB)
   ↓
feature.bands.bass.norm × 0.1 → exponentialBassScaler
feature.bands.air.norm × 0.1 → exponentialTrebleScaler
1 + feature.bands.bass.kick × 5 → coreScaler
feature.onsets.on('kick') → 同步触发 morph
```

两种都喂给同一组 shader uniform，所以 Muon 视觉算法本身没变，只是音频数值
"质感"不同——FB 模式 AGC 让响度跨曲稳定，Muon 模式跟着原始能量起伏。

### 6.3 Mode 系统

`params.mode` 有两个值：
- `'off'`：spiralGroup 从 scene 移除 → 完全不渲染
- `'background'`：spiralGroup 添加到 scene → 当作背景

V 键在两者之间切。

历史上还有 `'theater'`（独立 canvas 全屏覆盖），重构成 scene-embedded 之后删了。

### 6.4 anticipation 接入

每帧 tick 里：

```js
const antic = (beatGrid && params.enableBeatAntic)
    ? Math.max(0, Math.min(1, beatGrid.anticipation))
    : 0;
const anticBoostScaler  = 1 + (params.beatAnticBoost ?? 0) * antic;  // 默认 0.35
const anticOpacityBoost = 1 + (params.beatAnticGlow  ?? 0) * antic;  // 默认 0.14

// 把 anticipation 烤进 sineWavePropagation 的 bass/treble 输入
sineWavePropagation(
  wavesurfer, particles, particles2, sineCounter, dataArray, params,
  exponentialBassScaler  * anticBoostScaler,    // ← 拍前放大
  exponentialTrebleScaler * anticBoostScaler,   // ← 拍前放大
  prevParams,
);

// opacity 也跟着轻微脉冲
const _opacityLive = params.opacity * _pulseRef.value * anticOpacityBoost;
particles.material.uniforms.color.value.setHSL(hue, 0.7, 0.5).multiplyScalar(_opacityLive);
```

`beatGrid` 参数实际指向 `liveBeat`（live tracker），不是 offline 的 beat-grid。

### 6.5 游戏事件 hooks

main.js 订阅事件总线，调 spiral 的两个公开方法：

```js
bus.on(EVENTS.LINE_CLEAR, ({ simultaneous = 1 }) => {
  if (simultaneous >= 4) {
    spiralWave.pulseOpacity(5.0, 800);   // ← gsap-tweened 临时亮度
    spiralWave.triggerMorph();           // ← 同步合成 _delta，触发 preset 切换
  }
  // ...
});
```

`pulseOpacity(mult, durationMs)`：
- 用 gsap 把 `_pulseRef.value` 从 mult tween 回 1.0
- 每帧 `_opacityLive = baseOpacity × _pulseRef.value` ── 用户 opacity 永远不被覆盖
- additive blending 下值 > 1 会被 tone mapping 压回可见，制造"闪"

`triggerMorph()`：
- 设置 `_morphPulse = true`
- 下一帧 tick 把 `_delta` 强行拉到 > deltaResponseLimit
- Muon 的 `wavePresetController` 看到大 delta，gsap-tween radiusMultiplier 到下个 preset
- 视觉上 spiral 形态切换

事件强度表（详见 main.js 注释）：

| 事件 | opacity pulse | trigger morph |
|---|---|---|
| LINE_CLEAR ×1 | 1.8× 350ms | — |
| LINE_CLEAR ×2 | 2.5× 450ms | — |
| LINE_CLEAR ×3 | 3.5× 600ms | ✓ |
| LINE_CLEAR ×4 (Tetris) | **5.0× 800ms** | ✓ |
| T_SPIN | 3.0× 550ms | ✓ |
| LEVEL_UP | 3.5× 900ms | ✓ |
| **PERFECT_CLEAR** | **6.0× 1400ms** | ✓ + ✓ (双 morph) |
| B2B_CHAIN ×N | (2 + 0.5N)× 600ms | — |
| HARD_DROP | 故意不接（每块都触发太密）| — |

### 6.6 UI

**Settings → Spiral 标签**（panel-shared 风格的"3D UI"）：

- Mode segmented: Off / On
- Placement: Distance slider (-1000..-50) + Scale slider (1..10)
- Opacity slider (0..1 → 直接乘到 setHSL 的 lightness)
- Beat sync: enable toggle + Strength slider
- Audio source: useFeatureBus toggle + "Capture browser tab" 按钮
- Geometry: maxPoints / colorSpectrum / aperture / spacing 等

所有调整都通过 `_persistSettingsSnapshot()` 持久化到 localStorage。

**lil-gui dev panel**（默认不显示）：

```js
window.__spiralWave.gui.show()   // 暴露完整参数面，开发用
```

包含 Geometry / Morph / Dust / Color / Placement 等更细致的旋钮。

---

## 7. 调试工具

### 7.1 Audio spectrum 面板（按 F）

`src/audio/reactive/debug-overlay.js`。

```
┌─ Audio spectrum ────────────────┐
│ status: bound · ctx ready       │
│                                  │
│ Spectrum                         │
│ ▓▓▓▓▒▒▒░░░░░░░░░░░░░░░░         │  ← 96 条 log-spaced FFT bars
│ source: BGM                      │  ← 自动跟 active analyser
│                                  │
│ Beat lab                         │
│ ▁▂▄▆█ ↘ │ │  ▁▂▄▆█ ↘ │ │       │  ← 3s 时间轴 strip chart
│ ● antic  │ beat  │ kick         │
│                                  │
│ Onsets                           │
│ ● kick  ● snare  ● generic      │  ← 三色 fading dots
│                                  │
│ Beat-grid       127.3 bpm        │
│ phase: ████████░░░░ 65%          │  ← live tracker 输出
│ antic: █░░░░░░░░░░░  5%          │
└──────────────────────────────────┘
```

每个区块的意义：
- **Spectrum**：当前 analyser 的实时 FFT，log-spaced（低频不挤），cyan→pink
  渐变映射响度。直接告诉你音频在响不响。
- **Beat lab**：3 秒历史。cyan 区是 anticipation ramp，白竖线是 live tracker
  预测的 beat 时刻，红竖线是 FB 实测 kick onset。理想状态：cyan 在红线前升起，
  红线和白线对齐。
- **Onsets**：kick (pink) / snare (yellow) / generic (cyan) 各自的脉冲指示，
  fade 250ms。这是 FB onset detector 实时输出。
- **Beat-grid**：live tracker 的 BPM 估计 + 当前 phase + anticipation 数字。

### 7.2 Console 句柄

```js
// 主要 handle
window.__feature          // FeatureBus 实例
window.__liveBeat         // live beat tracker
window.__bindings         // 当前 bindings 列表
window.__spiralWave       // spiral visualizer 实例
window.__audio            // playback 实例

// 常用诊断
__feature.totalSec                              // FB 总 tick 秒数
__feature.bands.bass.norm                       // 实时 bass AGC 归一值
__feature.onsets.telemetry('kick')              // { lastFireAtSec, lastStrength }
__liveBeat.bpm                                  // 当前 BPM 估计（0 = 没准备好）
__liveBeat.historyCount                         // 已记录的 kick 数（>=3 才出 BPM）
__liveBeat.anticipation                         // 当前 antic 值

__spiralWave.params                             // spiral 所有参数
__spiralWave.spiralGroup.position.z             // 当前位置
__spiralWave.setMode('background' | 'off')      // 手动切模式
__spiralWave.pulseOpacity(5, 800)               // 模拟 Tetris 大闪
__spiralWave.triggerMorph()                     // 模拟 morph
__spiralWave.gui.show()                         // 显示完整开发面板

__audio.analyser                                // BGM AnalyserNode
__audio.analyser.smoothingTimeConstant          // 应该是 0
```

### 7.3 typical diagnostics

**"音乐响了但 spiral 没反应"**
1. `__feature.isBound` → false 说明 analyser 没 init（手势没触发）
2. `__feature.bands.bass.norm` → 长期为 0 说明 analyser 没拿到数据（流断了）
3. `__spiralWave.getMode()` → 'off' 说明 V 没开
4. `__spiralWave.params.opacity` → 太低看不到

**"BPM 一直 analyzing"**
1. `__feature.onsets.telemetry('kick').lastFireAtSec` → 没涨说明 FB 没检测到 kick
2. `__liveBeat.historyCount` → < 3 说明还在攒样本
3. `__liveBeat.historyCount` > 3 但 `__liveBeat.bpm` === 0 说明 interval 出 30-300 BPM 范围

**"External capture 不响应"**
1. 浏览器选 tab 时**勾了 "Share audio" 复选框**没？
2. `__feature` 的 spectrum 在动吗？没动 → capture 没接到 analyser
3. spiralWave 切了 audio 但 FB 没切 → 检查 createFeatureBus 的 getAnalyser 是否传了

---

## 8. 快速参考

### 8.1 热键

| 键 | 行为 |
|---|---|
| F | 切换 Audio spectrum 面板 |
| V | 切换 Spiral 模式 (off ↔ background) |
| O | 切换 Settings 面板 (3D) |

### 8.2 添加一个新的 "音频驱动效果" 的步骤

假设你要做"高频驱动一个新的 shader uniform `uSparkle`"：

1. **不要**在 audio 里改任何东西。
2. 在 `vfx/reactive/bindings.js` 加一条：
   ```js
   bindings.push({
     name: 'air.norm → sparkle.uniform',
     get: () => feature.bands.air.norm,
     apply: (v) => { targets.sparkleMesh.material.uniforms.uSparkle.value = v; },
   });
   ```
3. 在 main.js 创建 sparkleMesh 时把它加到 `createBindings({ targets })` 的 targets 对象。
4. 完成。bindings.tick() 每帧自动驱动它。

### 8.3 添加一个新的 "游戏事件 → spiral" 反应

```js
// main.js 找到 // === Gameplay event → Spiral hooks === 那段
bus.on(EVENTS.MY_NEW_EVENT, ({ intensity = 1 } = {}) => {
  spiralWave.pulseOpacity(2 * intensity, 500);
  if (intensity > 0.7) spiralWave.triggerMorph();
});
```

### 8.4 关键文件索引

| 路径 | 角色 |
|---|---|
| `src/audio/playback.js` | Web Audio 总入口 + BGM/SFX/voice 路由 |
| `src/audio/bgm-playlist.js` | BGM 曲目轮换 |
| `src/audio/external-capture.js` | getDisplayMedia tab 抓取 |
| `src/audio/reactive/feature-bus.js` | 6-band + onset + envelope + AGC 总汇 |
| `src/audio/reactive/live-beat-tracker.js` | FB onset 驱动的实时 BPM + anticipation |
| `src/audio/reactive/beat-grid.js` | offline BPM 路径（历史，仍存活） |
| `src/audio/reactive/bpm-cache.js` | offline 分析结果 localStorage 缓存 |
| `src/audio/reactive/debug-overlay.js` | Audio spectrum / Beat lab / Onsets 面板 |
| `src/vfx/reactive/bindings.js` | **唯一**音频写视觉的位置 |
| `src/vfx/visualizers/muon-original/` | Spiral 可视化器（vendored Muon） |
| `src/vfx/director.js` | 游戏事件 → 影院效果（LINE_CLEAR 等的 callout / flash） |

---

## 9. 已知问题 / 未来工作

- **Offline beat-grid 仍在 main.js 跑**但只 bpmCache 触发 setBpm；spiral 和 debug
  overlay 都已切到 live。可以考虑彻底移除 offline 路径。
- **External capture 的 audio context 是 BGM 的同一个**——technically 没问题，
  但如果 BGM 在 init 之前用户先点 Capture，audioCtx 还没创建会失败（main.js 里有
  fallback 检查）。
- **Live beat tracker BPM 偏移**：median 估计了周期但没考虑 phase 偏移。如果
  refactor，可以加 cross-correlation 或类似的相位校准。
- **HSL clamp**：spiral opacity > 1 走 HDR + tonemapping 这条路虽然 work 但
  非常 frame-rate 敏感。低帧率下"闪"看起来突兀。
- **Hard drop 没接 spiral**：用户决定每个 piece 都触发太密。可以改成"hard drop
  落地高度 > N 才触发"。

---

*文档版本：写于 `9dbb983` 之后，最新结构。后续 audio / vfx 重大改动请同步更新
本文档。*
