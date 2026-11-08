// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const determinismBans = {
  'no-restricted-properties': [
    'error',
    {
      object: 'Math',
      property: 'random',
      message: 'Use the engine seeded RNG (determinism rule 2).',
    },
    {
      object: 'Date',
      property: 'now',
      message: 'Use the engine calendar/tick (determinism rule 2).',
    },
    {
      object: 'performance',
      property: 'now',
      message: 'No wall-clock time in the sim (determinism rule 2).',
    },
    {
      object: 'crypto',
      property: 'randomUUID',
      message: 'Use registry-issued stable IDs (determinism rule 2).',
    },
    {
      object: 'crypto',
      property: 'getRandomValues',
      message: 'Use the engine seeded RNG (determinism rule 2).',
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'Date', message: 'No wall-clock time in the sim core; derive dates from ticks.' },
    { name: 'setTimeout', message: 'Sim core is synchronous.' },
    { name: 'setInterval', message: 'Sim core is synchronous.' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'NewExpression[callee.name="Date"]',
      message: 'No wall-clock time in the sim core.',
    },
    {
      selector: 'ForInStatement',
      message: 'for-in order is hazardous; iterate sorted keys explicitly.',
    },
  ],
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'packages/sim-tests/out/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Sim core: pure, headless, deterministic.
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      ...determinismBans,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nepo/ui', '@nepo/ui/*', '**/packages/ui/**'],
              message: 'Sim core never imports UI (rule 1).',
            },
            {
              group: ['react', 'react-dom', 'vite'],
              message: 'Sim core has no UI dependencies (rule 1).',
            },
            {
              group: ['node:*', 'fs', 'path', 'os', 'child_process'],
              message: 'Sim core is platform-agnostic.',
            },
          ],
        },
      ],
    },
  },
  {
    // Only the schema owner edits packages/sim/src/schema; other sim code must not define shared types ad hoc.
    files: ['packages/sim/src/schema/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-definitions': ['error', 'interface'] },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'packages/sim-tests/**/*.ts', 'packages/tools/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
