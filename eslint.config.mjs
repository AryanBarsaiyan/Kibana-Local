import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out-test/**', 'node_modules/**'] },
  { files: ['esbuild.mjs'], languageOptions: { globals: { process: 'readonly' } } },
  { files: ['samples/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', setInterval: 'readonly' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'multi-line'],
    },
  },
  {
    files: ['media/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { acquireVsCodeApi: 'readonly', window: 'readonly', document: 'readonly', requestAnimationFrame: 'readonly',
        ResizeObserver: 'readonly', CSS: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
);
