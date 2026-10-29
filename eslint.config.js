import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', { selector: "JSXOpeningElement[name.name='select']", message: 'Dùng Select của Ant Design, không dùng <select> thuần.' }],
    },
  },
);
