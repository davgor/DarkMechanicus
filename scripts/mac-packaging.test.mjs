import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { build } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('package.json macOS build config', () => {
  it('ad-hoc signs the whole app bundle so Gatekeeper does not report it as damaged', () => {
    expect(build.mac.identity).toBe('-')
  })

  it('disables hardened runtime, which fails library validation on ad-hoc signed apps', () => {
    expect(build.mac.hardenedRuntime).toBe(false)
  })
})

describe('package.json node-pty packaging config', () => {
  it('unpacks node-pty from the asar, so spawn-helper is a real file that can be executed', () => {
    expect(build.asarUnpack).toContain('node_modules/node-pty/**')
  })

  it('never rebuilds native modules, so node-pty ships its prebuild and no build needs a compiler', () => {
    expect(build.npmRebuild).toBe(false)
  })

  it('re-applies the helper execute bit after packing, with the install script', () => {
    expect(build.afterPack).toBe('./scripts/ptyHelperMode.mjs')
  })
})
