// Moon — passes world-space normal to the fragment so surface noise can be
// sampled in object/world space (rotating with the moon, not with the
// camera). Also forwards the object-local position so the noise pattern
// stays locked to the surface even as the moon spins.
varying vec3 vNormalW;
varying vec3 vLocal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vLocal   = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
