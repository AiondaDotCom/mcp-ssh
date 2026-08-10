import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // dist/ is generated; the .js/.mjs files at the root (bin wrapper, tool
    // configs) are plain ESM outside the TypeScript program, so type-aware
    // linting cannot parse them.
    ignores: [
      'dist/**',
      'coverage/**',
      'build/**',
      'node_modules/**',
      'bin/**',
      '*.config.mjs',
    ],
  },
  eslint.configs.recommended,
  // Type-aware linting: needs the program, so it only applies to src/.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The codebase deliberately uses `_password` and `_spawn`-style names for
      // internal fields, and `_` prefixes for intentionally unused catch params.
      '@typescript-eslint/naming-convention': 'off',

      // `??` is NOT equivalent to `||` for environment variables: a stripped
      // launcher environment reports an *empty string*, not undefined (that is
      // exactly what issue #10 describes), and an empty %ProgramData% must fall
      // through to the default. Switching these to `??` would silently reinstate
      // the bug, so string primitives are exempt.
      // Also exempt numbers: `args.timeout || DEFAULT` treats 0 as "not set",
      // which is what the tool contract promises. `??` would forward a
      // zero-millisecond timeout to ssh.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true, number: true } },
      ],

      // process.pid and friends in template literals are unambiguous.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // Empty catch blocks are load-bearing here: resolveExecutable() probes
      // PATH entries that mostly do not exist, and the askpass cleanup runs
      // during shutdown when the file may already be gone. Both are commented.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Non-null assertions are used in a handful of places where an invariant
      // guarantees the value (e.g. String.split always yields one element) and
      // the alternative would be unreachable fallback code that can never be
      // covered by a test.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Tests mock, cast and poke at internals; type-aware strictness there costs
    // more than it returns.
    files: ['src/**/*.test.ts', 'src/test-helpers.ts'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      // Spread first: our overrides below extend the disable set rather than
      // replacing it, which would leave type-aware rules active without a program.
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Tests add and remove environment variables by computed key on purpose.
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },
);
