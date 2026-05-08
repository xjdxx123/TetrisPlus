import { defineConfig } from 'vite';

// Notes:
// - `tetris.html` references audio under `asset/sounds/...` via both <audio>
//   tags (line 335) and dynamic `fetch()` from src/main.js. We keep the
//   directory at the project root so those relative paths resolve unchanged.
// - `publicDir: false` disables Vite's public-dir copy step (which would
//   strip the `asset/` prefix). The dev server serves files from the project
//   root, so `asset/sounds/foo.wav` resolves directly from disk.
// - Production bundling for the dynamically-fetched audio files is deferred;
//   add `?url` imports to src/main.js when we ship a real build.
export default defineConfig({
  root: '.',
  publicDir: false,
  server: {
    open: '/tetris.html',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        tetris: 'tetris.html',
      },
    },
  },
  assetsInclude: ['**/*.glsl'],
});
