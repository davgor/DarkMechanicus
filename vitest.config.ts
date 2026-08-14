import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    'import.meta.env.DEV': JSON.stringify(true),
    'import.meta.env.PROD': JSON.stringify(false)
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 15_000
  }
})
