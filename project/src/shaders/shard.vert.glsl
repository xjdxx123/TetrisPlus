// Instanced shatter shards. CPU writes per-shard origin/velocity/angVel/etc.
// once at spawn; the vertex shader handles ballistic position, angular
// rotation, lifetime fade, and floor clamping — no CPU-side per-frame work.
attribute vec3  aOrigin;
attribute vec3  aVelocity;
attribute vec3  aAngVel;
attribute vec3  aColor;
attribute float aSpawnTime;
attribute float aMaxLife;
attribute float aScale;

uniform float uTime;
uniform vec3  uGravity;
uniform float uFloorY;

varying vec3  vColor;
varying float vAlpha;

mat3 axisRot(vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  float t = 1.0 - c;
  return mat3(
    t*axis.x*axis.x + c,        t*axis.x*axis.y - s*axis.z, t*axis.x*axis.z + s*axis.y,
    t*axis.x*axis.y + s*axis.z, t*axis.y*axis.y + c,        t*axis.y*axis.z - s*axis.x,
    t*axis.x*axis.z - s*axis.y, t*axis.y*axis.z + s*axis.x, t*axis.z*axis.z + c
  );
}

void main() {
  float age = uTime - aSpawnTime;
  // Cull expired or unspawned slots by collapsing them to zero
  if (age < 0.0 || age > aMaxLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space
    vAlpha = 0.0;
    return;
  }

  // Rotate the local vertex by integrated angular velocity
  vec3 axis = aAngVel;
  float aLen = length(axis);
  vec3 nAxis = aLen > 1e-4 ? axis / aLen : vec3(0.0, 1.0, 0.0);
  vec3 local = position * aScale;
  local = axisRot(nAxis, aLen * age) * local;

  // Ballistic position: origin + v*t + 0.5*g*t² (no drag/bounce — visual diff is minor)
  vec3 worldPos = aOrigin + aVelocity * age + 0.5 * uGravity * age * age;
  // Soft floor clamp so shards "settle" at the floor instead of falling through
  worldPos.y = max(worldPos.y, uFloorY);

  // Lifetime fade — last 0.4s ramps alpha+scale to 0
  float fadeStart = max(0.0, aMaxLife - 0.4);
  float fade = 1.0 - smoothstep(fadeStart, aMaxLife, age);
  vAlpha = fade;
  // Apply fade to scale too (prevents popping on cull)
  local *= fade;

  vColor = aColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos + local, 1.0);
}
