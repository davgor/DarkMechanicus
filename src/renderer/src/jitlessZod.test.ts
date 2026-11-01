import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { globalConfig } from 'zod/v4/core'
import './jitlessZod'

describe('jitlessZod', () => {
  it('turns off zod’s compiled parsers, whose probe the production CSP reports', () => {
    expect(globalConfig.jitless).toBe(true)
  })

  it('is the first module the renderer entry loads, before any schema is built', () => {
    const entry = readFileSync(join(import.meta.dirname, 'main.tsx'), 'utf8')
    expect(entry.split('\n')[0]).toBe("import './jitlessZod'")
  })
})
