import js from '@eslint/js';

// Architectural import restrictions per document/plan_architecture.md §7.2.
// These wall off subsystem boundaries so the dependency graph stays one-way.
//
// Rules below are scaffolded but lenient until each subsystem actually exists.
// As subsystems land, tighten the patterns and remove the `// TODO` markers.
const importBoundaries = {
  // gameplay/ is the strictest — pure simulation, no graphics or DOM.
  'gameplay': {
    files: ['src/gameplay/**/*.{js,ts}'],
    forbidden: [
      { group: ['three', 'three/*'], message: 'gameplay/ must be renderer-agnostic — no three imports.' },
      { group: ['react', 'react-dom'], message: 'gameplay/ must not import React.' },
      { group: ['../rendering/*', '../world/*', '../vfx/*', '../audio/*', '../ui/*', '../camera/*', '../materials/*'],
        message: 'gameplay/ may only import engine/ and shared/.' },
    ],
  },
  // audio/ is renderer-free. Reactive bindings to materials live in vfx/reactive/.
  'audio': {
    files: ['src/audio/**/*.{js,ts}'],
    forbidden: [
      { group: ['three', 'three/*'], message: 'audio/ must not import three. Use vfx/reactive/ for material bindings.' },
      { group: ['react', 'react-dom'], message: 'audio/ must not import React.' },
    ],
  },
  // rendering/ may not reach into gameplay/ — receives data via snapshots/events.
  'rendering': {
    files: ['src/rendering/**/*.{js,ts}'],
    forbidden: [
      { group: ['../gameplay/*'], message: 'rendering/ must not import gameplay/. Use snapshots/events.' },
    ],
  },
  // shared/ and shaders/ are leaf modules.
  'shared': {
    files: ['src/shared/**/*.{js,ts}'],
    forbidden: [
      { group: ['three', 'three/*', 'react', 'react-dom', '../*'],
        message: 'shared/ is a leaf module — no outward imports.' },
    ],
  },
};

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        AudioContext: 'readonly',
        Audio: 'readonly',
        Image: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        getComputedStyle: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'warn',
    },
  },
  // Apply each subsystem's boundary rule.
  ...Object.values(importBoundaries).map(({ files, forbidden }) => ({
    files,
    rules: {
      'no-restricted-imports': ['error', { patterns: forbidden }],
    },
  })),
  // §3.7 sub-phase 7f + plan_online_versus.md §A — determinism guard.
  // `gameplay/` is the bit-for-bit-reproducible simulation: same seed
  // + same input sequence → same `Game.serialize()` blob, on every
  // device, every time. That's what unlocks Sprint replay validation,
  // Ultra leaderboard anti-cheat, and online versus rollback netcode
  // (where two clients re-derive each other's state from inputs alone).
  //
  // The rule below blocks every common source of non-determinism:
  //   - Math.random → seeded RNG required (createSeededRng)
  //   - performance.now / Date.now → time must arrive via dtMs / opts
  //   - setTimeout / setInterval → no async timers in gameplay
  //
  // Tests are exempted (they pin seeds + drive Game.tick directly with
  // controlled dtMs). Inline `eslint-disable-next-line` opt-outs are
  // permitted ONLY for documented exceptions (e.g. Date.now() as the
  // *seed* for a default offline RNG — the RNG output is still
  // deterministic given that seed).
  {
    files: ['src/gameplay/**/*.js', 'src/app/versus.js'],
    ignores: ['src/gameplay/**/*.test.js'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Math.random is banned in gameplay/ + app/versus.js — use createSeededRng() from shared/random/seeded.js so replays are deterministic.',
        },
        {
          selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
          message: 'performance.now() is banned in gameplay/ — pass time via opts.nowMs / dtMs so online rollback can re-execute past ticks identically.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Date.now() is banned in gameplay/ — pass time via opts.nowMs so online rollback can re-execute past ticks identically. (Inline eslint-disable allowed for documented seed-only uses.)',
        },
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message: 'setTimeout is banned in gameplay/ — async scheduling breaks determinism. Drive timing from the host via dtMs.',
        },
        {
          selector: "CallExpression[callee.name='setInterval']",
          message: 'setInterval is banned in gameplay/ — async scheduling breaks determinism.',
        },
      ],
    },
  },
  // The legacy monolith — exempted while it's being decomposed.
  // As subsystems get carved out into their own modules, the carved-out
  // code picks up the strict rules above; what remains here stays lenient
  // until it shrinks to zero.
  {
    files: ['src/app/main.js', 'tetris.html'],
    rules: {
      'no-restricted-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'off',
    },
  },
];
