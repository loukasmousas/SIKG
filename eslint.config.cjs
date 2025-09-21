// ESLint v9 flat config (CommonJS)
const js = require('@eslint/js');
const pluginImport = require('eslint-plugin-import');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'output/**',
      'models/**',
      '*.pht',
      'Report/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
    plugins: { import: pluginImport },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Allow console for this project (change to 'warn' later if desired)
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'import/no-unresolved': 'error',
      'no-irregular-whitespace': 'error',
    },
  },
  // Test overrides: allow console output in tests for clarity
  {
    files: ['tests/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
];
