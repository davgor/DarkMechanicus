import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONTRACT_TESTS } from './contractTests.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('contract test selection', () => {
  it('names only test files that exist', () => {
    expect(CONTRACT_TESTS.filter((path) => !existsSync(join(ROOT, path)))).toEqual([])
  })

  it('includes every inventory test that caught a post-merge regression', () => {
    expect(CONTRACT_TESTS).toEqual(
      expect.arrayContaining([
        'src/mcp/roles.test.ts',
        'src/core/authz.test.ts',
        'src/mcp/skills.test.ts',
        'src/main/desktop/ipc.test.ts',
        'src/test/scorecardWorldRecorder.test.ts'
      ])
    )
  })
})
