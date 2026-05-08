import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPunchZoom } from './punch-zoom.js';

describe('punch-zoom', () => {
  const camPos = () => new THREE.Vector3(0, 0, 10);
  const target = () => new THREE.Vector3(0, 0, 0);

  it('starts inactive with zero offset', () => {
    const pz = createPunchZoom();
    expect(pz.active).toBe(false);
    expect(pz.offset.length()).toBe(0);
  });

  it('trigger() activates and produces offset on next update', () => {
    const pz = createPunchZoom();
    pz.trigger(4, 1);
    expect(pz.active).toBe(true);
    pz.update(0.1, camPos(), target());
    expect(pz.offset.length()).toBeGreaterThan(0);
  });

  it('amount scales with rowCount and shatterPower', () => {
    const a = createPunchZoom();
    const b = createPunchZoom();
    a.trigger(2, 1);
    b.trigger(4, 1);
    a.update(0.05, camPos(), target());
    b.update(0.05, camPos(), target());
    expect(b.offset.length()).toBeGreaterThan(a.offset.length());

    const c = createPunchZoom();
    c.trigger(2, 2);
    c.update(0.05, camPos(), target());
    expect(c.offset.length()).toBeGreaterThan(a.offset.length());
  });

  it('deactivates after duration elapses', () => {
    const pz = createPunchZoom();
    pz.trigger(2, 1);
    pz.update(10, camPos(), target()); // way past dur
    expect(pz.active).toBe(false);
  });

  it('inactive update zeros offset', () => {
    const pz = createPunchZoom();
    pz.update(0.1, camPos(), target());
    expect(pz.offset.length()).toBe(0);
  });
});
