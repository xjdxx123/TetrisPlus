// Nebula sky vertex shader.
// Sphere centered at world origin; the local-space position direction is
// also the world-space view direction. Camera orbit reveals different parts
// of the nebula — exactly what we want.
varying vec3 vWorldDir;
void main() {
  vWorldDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
