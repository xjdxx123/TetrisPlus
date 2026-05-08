# `camera/` — Camera Rig

Owns the `PerspectiveCamera`, OrbitControls, and additive impulse layers.

## Planned files

- `camera-rig.js` — base camera + framing logic.
- `orbit.js` — OrbitControls integration.
- `shake.js` — coherent multi-frequency sine sum (today inline at [`../../tetris.html`](../../tetris.html) lines 2928–3018).

## Public surface

```js
Camera.update(dt);
Camera.applyImpulse(ImpulseDescriptor);   // additive; multiple stack
Camera.three;                             // PerspectiveCamera handle (read-only for renderer)
```

## Impulses

Camera shakes/punches are *layered impulses*, not direct camera mutations:

```js
on('CAMERA_IMPACT', (e) => Camera.applyImpulse({
  kind: 'shake', magnitude: e.magnitude, axis: e.axis, decayMs: e.decayMs,
}));
```

Multiple impulses compose without coordination. The camera does not know what fired them.
