import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.dependency-cruiser.cjs',
      '**/dist/**',
      '**/node_modules/**',
      'plan/**',
      'docs/**',
      'sessions/**',
      'coverage/**',
      '.run/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': 'off',
    },
  },
  {
    // A guard's refusal trips it, and nothing catches one to carry on (plan, §9): no catch names
    // the guard's error, and no catch around an action swallows what the action threw.
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['**/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CatchClause Identifier[name='GuardError']",
          message: 'A guard error is never caught: it trips the guard and ends the run.',
        },
        {
          selector: "CallExpression[callee.property.name='catch'] Identifier[name='GuardError']",
          message: 'A guard error is never caught: it trips the guard and ends the run.',
        },
        {
          selector:
            'TryStatement:has(CallExpression[callee.name=/^(click|type|typeSecret|choose|press)$/]) > CatchClause:not(:has(ThrowStatement))',
          message:
            'A catch around an action rethrows what it does not handle: it may hold a guard error.',
        },
      ],
    },
  },
  {
    // Plain Node scripts run outside the workspaces (the plan renderer, in the tools image).
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // The identity extension's script runs in a web page, before the page's own scripts.
    files: ['packages/screen/extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        Navigator: 'readonly',
        Screen: 'readonly',
        DOMException: 'readonly',
      },
    },
  },
);
