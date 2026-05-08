# `vfx/` — Effects Architecture

The presentation layer. Subscribes to gameplay events and audio-reactive streams; emits particles, screen flashes, camera impulses.

## The director pattern

`gameplay/` emits `LINE_CLEAR`. The director decides what cinematic events fire:

```js
on('LINE_CLEAR', (e) => {
  if (e.rows.length === 4) {
    emit('CAMERA_IMPACT', { magnitude: 1.4, axis: 'y', decayMs: 600 });
    emit('SLOW_MO',       { scale: 0.35, durationMs: 220 });
    emit('FLASH',         { color: 0xffffff, intensity: 0.6, decayMs: 400 });
    VFX.spawn(TETRIS_SHATTER, { rows: e.rows, colors: e.colors });
  }
});
```

> Gameplay describes the world. The director describes the show.

Tuning game-feel becomes editing one file.

## Submodules

- `director.js` — gameplay → cinematic translation. THE place game-feel decisions live.
- [`presets/`](./presets/) — declarative effect descriptions (count, lifetime, velocity curves, color rules). Authoring effects is data, not code.
- [`emitters/`](./emitters/) — pooled particle implementations. Today: instanced shards, instanced sparkles, CPU billboards, ring overlays, veil planes.
- `pool.js` — unified free-slot allocator. Replaces today's two parallel implementations at [`../../tetris.html`](../../tetris.html) lines 811–1104 and 1919–2166.
- [`reactive/`](./reactive/) — declarative bindings from `audio/reactive` streams to material uniforms. The *only* place audio touches shaders.

## Effect categories

| Category | Trigger source | Examples |
|---|---|---|
| Gameplay VFX | `gameplay/` events | shatter, sparkle ring, hard-drop dust |
| Ambient VFX | always-on | 500-particle drift field |
| Cinematic VFX | director events | flash, shockwave, attention dim |
| Music-reactive VFX | `audio/reactive` streams | bass-driven bloom pulse, beat-driven glow |
| UI VFX | UI events | score popups, panel jitter |
