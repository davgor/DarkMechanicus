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
