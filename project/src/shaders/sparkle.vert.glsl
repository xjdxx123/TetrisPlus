// Line-clear sparkle ring particles. GPU-driven ballistic motion + lifetime
// fade; CPU only writes spawn/velocity/color/life on emit and never touches
// per-particle state again.
attribute vec3  aVelocity;
attribute vec3  aColor;
attribute float aSpawnTime;
attribute float aLife;

uniform float uTime;
uniform float uGravity;
uniform float uSize;

varying vec3  vColor;
varying float vAlpha;

void main() {
  float age = uTime - aSpawnTime;
  if (age < 0.0 || age > aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }

  vec3 worldPos = position + aVelocity * age + vec3(0.0, 0.5 * uGravity * age * age, 0.0);
  vec4 mvPos = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPos;
  gl_PointSize = uSize / max(0.1, -mvPos.z);

  vAlpha = 1.0 - clamp(age / aLife, 0.0, 1.0);
  vColor = aColor;
}
