// Translate + rotate gesture for a CSS3DObject (plan_UI_1.md §3.2).
//
// Generalizes the existing `makeDraggable` (which only translates) so a
// settings panel can also be rotated. Two gestures, kept exclusive via a
// single `gesture` state machine:
//
//   left click + drag on body          → translate
//   right click + drag on body         → rotate (yaw from dx, pitch from dy)
//   left click + drag on `[data-grab="rotate"]` element → rotate (touch-friendly)
//   double-click on header             → reset to default position + orientation
//
// Pitch / yaw are clamped so the panel can't tumble face-down. Roll is
// never applied — text rotated sideways is unreadable.
//
// Pure DOM + THREE math; no scene, no renderer reach-in. Returns a
// `dispose()` so it tears down cleanly during hot-reload.

import * as THREE from 'three';

/**
 * @typedef {Object} DraggableRotatableOpts
 * @property {{ enabled: boolean }} [controls]   OrbitControls — disabled during gestures.
 * @property {THREE.Camera} camera               Used to project pointer onto a drag plane.
 * @property {{ x:number,y:number,z:number,yaw?:number,pitch?:number }} [defaultPose]
 *   For double-click-to-reset. Defaults to the object's pose at registration time.
 * @property {number} [pitchClamp=Math.PI/6]     ±30°
 * @property {number} [yawClamp=Math.PI/2]       ±90°
 * @property {number} [rotateSensitivity=0.005]  rad / pixel
 * @property {(pose: { x:number, y:number, z:number, yaw:number, pitch:number }) => void} [onChange]
 *   Called on every translate/rotate frame and on reset; throttle/debounce in the consumer.
 */

const _v3 = new THREE.Vector3();
const _camDir = new THREE.Vector3();

export function makeDraggableRotatable(el, obj, {
  controls = null,
  camera,
  defaultPose,
  pitchClamp = Math.PI / 6,
  yawClamp   = Math.PI / 2,
  rotateSensitivity = 0.005,
  onChange = null,
} = {}) {
  if (!camera) throw new Error('makeDraggableRotatable requires a camera');

  // Snapshot the current pose as the default if the caller didn't pass one.
  const _default = {
    x:     defaultPose?.x     ?? obj.position.x,
    y:     defaultPose?.y     ?? obj.position.y,
    z:     defaultPose?.z     ?? obj.position.z,
    yaw:   defaultPose?.yaw   ?? obj.rotation.y,
    pitch: defaultPose?.pitch ?? obj.rotation.x,
  };

  // Single source of truth for "what gesture is active." Re-entrant gesture
  // bugs (drag while still rotating, etc.) all funnel through here.
  let gesture = null;
  // Shape: { kind: 'translate'|'rotate', startX, startY, startObjPos, startEuler, plane?, offset? }

  // Reset-pose tween — populated by `resetPose()` (and the dblclick
  // handler), advanced by `update(dt)` from the consumer's animate loop.
  // 300 ms ease per plan §3.2; eases out cubic so the rest period dominates.
  let resetTween = null;
  const RESET_DUR_SEC = 0.30;

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function emit() {
    if (!onChange) return;
    onChange({
      x:     obj.position.x,
      y:     obj.position.y,
      z:     obj.position.z,
      yaw:   obj.rotation.y,
      pitch: obj.rotation.x,
    });
  }

  function setMouseFromEvent(e) {
    mouse.x = (e.clientX / window.innerWidth)  *  2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  function beginTranslate(e) {
    const plane = new THREE.Plane();
    camera.getWorldDirection(_camDir);
    plane.setFromNormalAndCoplanarPoint(_camDir, obj.position);
    setMouseFromEvent(e);
    raycaster.setFromCamera(mouse, camera);
    const hit = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, hit);
    gesture = {
      kind: 'translate',
      plane,
      offset: obj.position.clone().sub(hit),
    };
  }

  function beginRotate(e) {
    gesture = {
      kind: 'rotate',
      startX: e.clientX,
      startY: e.clientY,
      startYaw:   obj.rotation.y,
      startPitch: obj.rotation.x,
    };
  }

  function endGesture(e) {
    if (!gesture) return;
    gesture = null;
    el.style.cursor = 'grab';
    if (controls) controls.enabled = true;
    try { el.releasePointerCapture(e.pointerId); } catch { /* not all events have pointerId */ }
  }

  // Suppress browser context menu so right-drag can rotate without
  // popping a menu mid-gesture.
  function onContextMenu(e) {
    e.preventDefault();
  }

  // Selectors that must NEVER initiate a drag — clicking these has to
  // pass through to the control's own click handler (slider, button,
  // toggle, dropdown, etc.). Without this gate, setPointerCapture() on
  // the panel root would steal the pointerup, and no `click` event ever
  // fires on the child control.
  const INTERACTIVE_SELECTOR =
    'input, button, select, textarea, label, ' +
    '.tp-toggle, .tp-toggle__thumb, .tp-segmented__btn, .tp-tab, ' +
    '.tp-slider, .tp-hue-slider, .tp-button, .tp-panel__close';

  function isInteractiveTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(INTERACTIVE_SELECTOR);
  }

  function onPointerDown(e) {
    // Left-click on an interactive control → let the control handle it.
    // Right-click rotates regardless of target (the user explicitly
    // wanted a rotate gesture; right-click on a slider thumb shouldn't
    // accidentally drag the slider).
    if (e.button !== 2 && isInteractiveTarget(e.target)) return;

    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (controls) controls.enabled = false;
    el.style.cursor = 'grabbing';

    // Right-click → rotate; left-click on a [data-grab="rotate"] target
    // → rotate (touch fallback); otherwise translate.
    const wantsRotate =
      e.button === 2 ||
      (e.target.closest && e.target.closest('[data-grab="rotate"]'));
    if (wantsRotate) {
      beginRotate(e);
    } else {
      beginTranslate(e);
    }
  }

  function onPointerMove(e) {
    if (!gesture) return;
    if (gesture.kind === 'translate') {
      setMouseFromEvent(e);
      raycaster.setFromCamera(mouse, camera);
      const hit = _v3;
      if (raycaster.ray.intersectPlane(gesture.plane, hit)) {
        obj.position.copy(hit).add(gesture.offset);
        emit();
      }
    } else if (gesture.kind === 'rotate') {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      // Yaw from horizontal drag, pitch from vertical. No roll.
      const yaw   = THREE.MathUtils.clamp(gesture.startYaw   + dx * rotateSensitivity, -yawClamp,   yawClamp);
      const pitch = THREE.MathUtils.clamp(gesture.startPitch + dy * rotateSensitivity, -pitchClamp, pitchClamp);
      obj.rotation.set(pitch, yaw, 0);
      emit();
    }
  }

  function onPointerUp(e)     { endGesture(e); }
  function onPointerCancel(e) { endGesture(e); }
  function onLostCapture(e)   { endGesture(e); }

  function onDoubleClick(e) {
    // Only reset when the dblclick lands on the header (or whatever the
    // caller styled with `data-grab="header"`). Avoids surprise resets
    // when double-clicking on a control inside the panel body.
    const wantsReset = e.target.closest && e.target.closest('[data-grab="header"]');
    if (!wantsReset) return;
    e.preventDefault();
    // Tween rather than snap — see plan §3.2.
    resetTween = {
      fromPos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      toPos:   { x: _default.x, y: _default.y, z: _default.z },
      fromPitch: obj.rotation.x,
      fromYaw:   obj.rotation.y,
      toPitch:   _default.pitch,
      toYaw:     _default.yaw,
      t: 0,
      dur: RESET_DUR_SEC,
    };
  }

  el.addEventListener('contextmenu',       onContextMenu);
  el.addEventListener('pointerdown',       onPointerDown);
  el.addEventListener('pointermove',       onPointerMove);
  el.addEventListener('pointerup',         onPointerUp);
  el.addEventListener('pointercancel',     onPointerCancel);
  el.addEventListener('lostpointercapture', onLostCapture);
  el.addEventListener('dblclick',          onDoubleClick);

  function update(dt) {
    if (!resetTween) return;
    resetTween.t += dt;
    const k = Math.min(1, resetTween.t / resetTween.dur);
    const eased = 1 - Math.pow(1 - k, 3); // easeOutCubic
    obj.position.x = resetTween.fromPos.x + (resetTween.toPos.x - resetTween.fromPos.x) * eased;
    obj.position.y = resetTween.fromPos.y + (resetTween.toPos.y - resetTween.fromPos.y) * eased;
    obj.position.z = resetTween.fromPos.z + (resetTween.toPos.z - resetTween.fromPos.z) * eased;
    obj.rotation.x = resetTween.fromPitch + (resetTween.toPitch - resetTween.fromPitch) * eased;
    obj.rotation.y = resetTween.fromYaw   + (resetTween.toYaw   - resetTween.fromYaw)   * eased;
    emit();
    if (k >= 1) resetTween = null;
  }

  return {
    /** Per-frame tick. Drives the reset-pose tween only — translate/rotate
     *  are pointer-event driven and don't need tick. */
    update,
    /** Reset pose to the configured default. Tweens over 300 ms (plan §3.2);
     *  subsequent calls during a tween snap forward to the new endpoint. */
    resetPose() {
      resetTween = {
        fromPos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        toPos:   { x: _default.x, y: _default.y, z: _default.z },
        fromPitch: obj.rotation.x,
        fromYaw:   obj.rotation.y,
        toPitch:   _default.pitch,
        toYaw:     _default.yaw,
        t: 0,
        dur: RESET_DUR_SEC,
      };
    },
    /** Snap to a specific pose (e.g. restoring from saved settings). */
    setPose({ x, y, z, yaw = 0, pitch = 0 }) {
      obj.position.set(x, y, z);
      obj.rotation.set(
        THREE.MathUtils.clamp(pitch, -pitchClamp, pitchClamp),
        THREE.MathUtils.clamp(yaw,   -yawClamp,   yawClamp),
        0,
      );
      resetTween = null;       // any in-flight tween is invalidated
      emit();
    },
    dispose() {
      el.removeEventListener('contextmenu',       onContextMenu);
      el.removeEventListener('pointerdown',       onPointerDown);
      el.removeEventListener('pointermove',       onPointerMove);
      el.removeEventListener('pointerup',         onPointerUp);
      el.removeEventListener('pointercancel',     onPointerCancel);
      el.removeEventListener('lostpointercapture', onLostCapture);
      el.removeEventListener('dblclick',          onDoubleClick);
    },
  };
}
