// Glass / fresnel vertex shader. Shared by:
//   - active-piece glow shell (additive)
//   - ghost-piece outline
//   - case walls / bottom (with glass-case.frag.glsl)
// Outputs world-space normal and view direction so the fragment can compute
// fresnel without an env map.
varying vec3 vNormalW;
varying vec3 vViewDirW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewDirW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
