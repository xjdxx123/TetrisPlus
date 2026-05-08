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
