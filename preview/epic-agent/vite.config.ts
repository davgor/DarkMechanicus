import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The epic test fixtures reach `core/canonical.ts`, which hashes with `node:crypto`; a page cannot load it.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'node:crypto': fileURLToPath(new URL('./nodeCrypto.ts', import.meta.url)) } }
})
