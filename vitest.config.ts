import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // tsconfig sets jsx: 'preserve' for Next's own compiler, which leaves vite
  // unable to parse a .tsx a test imports. Transform it here instead, so a
  // component can be rendered to markup and asserted on rather than only
  // grepped as source text. Vitest-only — the Next build is untouched.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
