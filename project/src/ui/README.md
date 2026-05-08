# `ui/` — HUD, Menus, Tweaks

React-based UI. Reads gameplay state via snapshots; never writes it directly.

## Submodules

- `App.jsx` — React root.
- [`HUD/`](./HUD/) — score panel, next queue, hold panel, callouts (level-up, line-clear), audio toggle.
- [`tweaks/`](./tweaks/) — live tweaks panel. The home of [`TweaksPanel.jsx`](./tweaks/TweaksPanel.jsx) (relocated from `project/tweaks-panel.jsx`).
- [`menu/`](./menu/) — main menu, game-over.
- `store.js` — read-only view over `Game.snapshot()` + `engine/events` subscriptions.

## CSS3D 3D HUD

UI elements anchored in 3D world space (the existing CSS3DRenderer overlay) are a separate `ui/3d/` submodule with the same contract: read snapshots, render, never mutate gameplay.

## Imports

May import React, may *read* `gameplay` snapshots through `ui/store`, may *not* import gameplay mutators or `three` (3D HUD excepted).

## Tweaks panel transport

The existing `__activate_edit_mode` / `__edit_mode_set_keys` `postMessage` protocol becomes one transport in `config/persistence.js`. Direct access for in-app tweaks goes through `Config.subscribe` instead.
