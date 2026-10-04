import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    'import.meta.env.DEV': JSON.stringify(true),
    'import.meta.env.PROD': JSON.stringify(false)
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/__mocks__/**', 'out/**', 'src/test/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        lines: 97,
        branches: 95,
        functions: 96,
        statements: 97
      }
    }
  }
})
