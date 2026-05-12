import { defineConfig } from 'vite';
import { cpSync } from 'node:fs';

// Notes:
// - Audio lives under `asset/sounds/{bgm,effects}/`. BGM is loaded by the
//   playlist (src/audio/bgm-playlist.js) which sets `<audio>.src` at runtime;
//   short voice/SFX clips are fetched from src/main.js and decoded into
//   AudioBuffers. We keep the directory at the project root so the relative
//   paths resolve unchanged.
// - `publicDir: false` disables Vite's public-dir copy step (which would
//   strip the `asset/` prefix and break the runtime URL contract). Instead
//   we run a custom closeBundle plugin below that copies `asset/` into
//   `dist/asset/` with the prefix preserved — the only thing that changes
//   between dev and prod is that prod reads from `dist/asset/...` instead
//   of `asset/...` directly off disk.

/** Mirror `asset/` into `dist/asset/` post-build so static hosts (Cloudflare
 *  Pages, etc.) ship the BGM / SFX alongside the JS bundle. cpSync's
 *  recursive option lands clean on macOS / Linux / Windows. Failures
 *  bubble up rather than silently producing a broken deploy. */
function copyAssetsPlugin() {
  return {
    name: 'tetris-copy-assets',
    apply: 'build',
    closeBundle() {
      cpSync('asset', 'dist/asset', { recursive: true });
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: false,
  plugins: [copyAssetsPlugin()],
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
