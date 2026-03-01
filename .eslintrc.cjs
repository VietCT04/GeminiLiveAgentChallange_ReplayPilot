module.exports = {
  root: true,
  ignorePatterns: ['dist', 'node_modules', '.vite'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  overrides: [
    {
      files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts'],
      env: {
        es2022: true,
        node: true,
      },
    },
    {
      files: ['apps/controller/**/*.{ts,tsx}'],
      env: {
        browser: true,
        es2022: true,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      plugins: ['react-hooks', 'react-refresh'],
      extends: ['plugin:react-hooks/recommended'],
      rules: {
        'react-refresh/only-export-components': [
          'warn',
          { allowConstantExport: true },
        ],
      },
    },
  ],
};
