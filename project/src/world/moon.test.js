import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createMoon } from './moon.js';

describe('moon', () => {
  it('builds a group with disc + halo at the requested position + radius', () => {
    const m = createMoon({ position: [10, 20, -30], radius: 8, segments: 16 });
    expect(m.group).toBeInstanceOf(THREE.Group);
    // Position is on the parent group (so disc + halo move together).
    expect(m.group.position.x).toBe(10);
    expect(m.group.position.y).toBe(20);
    expect(m.group.position.z).toBe(-30);
    expect(m.mesh.geometry.parameters.radius).toBe(8);
    // Group contains exactly two children: disc + halo.
    expect(m.group.children).toHaveLength(2);
    m.dispose();
  });

  it('disc material is NOT bloom-eligible; halo material IS (§1.3 attention discipline)', () => {
    const m = createMoon({ segments: 8 });
    expect(m.material.userData.enableBloom).toBe(false);
    expect(m.haloMaterial.userData.enableBloom).toBe(true);
    m.dispose();
  });

  it('disc self-rotation accumulates with dt; halo stays unrotated', () => {
    const m = createMoon({ segments: 8, spinSpeed: 0.5 });
    const discBefore = m.mesh.quaternion.clone();
    const haloBefore = m.halo.quaternion.clone();
    m.update(2.0);
    expect(m.mesh.quaternion.equals(discBefore)).toBe(false);
    // Halo is camera-billboarded in the vertex shader, so its mesh quaternion
    // never rotates here — the shader handles facing.
    expect(m.halo.quaternion.equals(haloBefore)).toBe(true);
    m.dispose();
  });

  it('setIntensity clamps to [0, 2] and scales both disc + halo coherently', () => {
    const m = createMoon({ segments: 8, haloIntensity: 1.0 });
    m.setIntensity(0.5);
    expect(m.material.uniforms.uIntensity.value).toBeCloseTo(0.5, 5);
    expect(m.haloMaterial.uniforms.uIntensity.value).toBeCloseTo(0.5, 5);
    m.setIntensity(-1);
    expect(m.material.uniforms.uIntensity.value).toBe(0);
    expect(m.haloMaterial.uniforms.uIntensity.value).toBe(0);
    m.setIntensity(10);
    expect(m.material.uniforms.uIntensity.value).toBe(2);
    expect(m.haloMaterial.uniforms.uIntensity.value).toBe(2);
    m.dispose();
  });

  it('setVisible toggles the parent group', () => {
    const m = createMoon({ segments: 8 });
    m.setVisible(false);
    expect(m.group.visible).toBe(false);
    m.setVisible(true);
    expect(m.group.visible).toBe(true);
    m.dispose();
  });

  it('halo size is the moon diameter scaled by haloSizeMul', () => {
    const m = createMoon({ segments: 8, radius: 10, haloSizeMul: 3.0 });
    expect(m.haloMaterial.uniforms.uSize.value).toBe(30);
    m.dispose();
  });
});
