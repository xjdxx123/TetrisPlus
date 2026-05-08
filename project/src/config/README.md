# `config/` — Tweaks, Moods, Persistence

Single source of truth for live-editable parameters. Anyone reading config goes through `Config.get` / `Config.subscribe`; no module reads tweaks from globals.

## Planned files

- `tweaks.js` — live config registry, schema, defaults. Replaces today's `TWEAKS` global at [`../../tetris.html`](../../tetris.html) line 373.
- `moods.js` — preset bundles (today's `MOOD_PRESETS` at lines 376+).
- `persistence.js` — transports: `localStorage`, `postMessage` (host editor compatibility), query string.

## API

```js
Config.get('gravity');
Config.subscribe('mood', (next, prev) => { /* ... */ });
Config.set('shatterPower', 3.1);   // emits to subscribers + persists
```

## Mood presets

Today's `neon` / `icy` / `ember` / `void` mood bundles graduate from "object literal in main file" to a registry under `moods.js`. Adding a mood is a data file, not a code edit elsewhere.
