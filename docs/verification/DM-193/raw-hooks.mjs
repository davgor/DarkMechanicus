// Lets `tsx` load the `?raw` text imports Vite resolves in the app build (the skill sources the MCP server bundles).
// Run: node --import ./docs/verification/DM-193/raw-hooks.mjs --import tsx <script.ts>
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.endsWith('?raw')) return next(specifier, context)
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
  },
  load(url, context, next) {
    if (!url.endsWith('?raw')) return next(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'commonjs', source: `module.exports = { __esModule: true, default: ${JSON.stringify(text)} }`, shortCircuit: true }
  }
})
