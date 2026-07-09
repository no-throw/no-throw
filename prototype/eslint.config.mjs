// eslint.config.mjs — THROWAWAY spike (no-throw ticket #6)
// Wires the throwaway rule into a real ESLint flat config with type info.
import tseslint from 'typescript-eslint';
import noEscapingThrow from './rules/no-throw.mjs';

export default tseslint.config({
  files: ['fixtures/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: {
    'no-throw': { rules: { 'no-escaping-throw': noEscapingThrow } },
  },
  rules: {
    'no-throw/no-escaping-throw': 'error',
  },
});
