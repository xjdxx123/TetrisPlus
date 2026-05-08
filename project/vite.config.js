import { defineConfig } from 'vite';

// Notes:
// - Audio lives under `asset/sounds/{bgm,effects}/`. BGM is loaded by the
//   playlist (src/audio/bgm-playlist.js) which sets `<audio>.src` at runtime;
//   short voice/SFX clips are fetched from src/main.js and decoded into
//   AudioBuffers. We keep the directory at the project root so the relative
//   paths resolve unchanged.
// - `publicDir: false` disables Vite's public-dir copy step (which would
//   strip the `asset/` prefix). The dev server serves files from the project
//   root, so `asset/sounds/effects/foo.wav` resolves directly from disk.
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
