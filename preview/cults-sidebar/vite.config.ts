import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer fakes reach `core/canonical.ts`, which hashes with `node:crypto`; reuse the epic preview's stand-in.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'node:crypto': fileURLToPath(new URL('../epic-agent/nodeCrypto.ts', import.meta.url)) } }
})
