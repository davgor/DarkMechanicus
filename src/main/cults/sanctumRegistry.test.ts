/**
 * The sanctum registry on the real disk: what a restart reads back, what `resolve` and `list` answer for a sanctum
 * that is gone or is no directory, and removing a cult that never had one.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { createSanctumRegistry } from './sanctumRegistry'

const FIRST = 'ct_01aaaaaaaaaaaaaaaaaaaaaaaa'
const SECOND = 'ct_01bbbbbbbbbbbbbbbbbbbbbbbb'

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'dm-sanctums-'))
})

afterEach(() => {
  removeScratch(userData)
})

function registryFile(): string {
  return join(realpathSync.native(userData), 'cults', 'sanctums.json')
}

describe('sanctum registry', () => {
  it('reads its sanctums back after a restart, and lists only those whose directory still exists', async () => {
    const first = await createSanctumRegistry({ userData }).create(FIRST)
    const second = await createSanctumRegistry({ userData }).create(SECOND)
    rmSync(second, { recursive: true })

    const restarted = createSanctumRegistry({ userData })
    expect(restarted.list()).toEqual([first])
    expect(restarted.resolve(first)).toBe(first)
    expect(restarted.resolve(second)).toBeNull()
  })

  it('trusts nothing from a registry file of another shape', async () => {
    const sanctum = await createSanctumRegistry({ userData }).create(FIRST)
    writeFileSync(registryFile(), JSON.stringify({ version: 2, sanctums: [FIRST] }))

    const restarted = createSanctumRegistry({ userData })
    expect(restarted.resolve(sanctum)).toBeNull()
    expect(restarted.list()).toEqual([])
  })

  it('resolves no sanctum whose path is a file, not a directory', async () => {
    const registry = createSanctumRegistry({ userData })
    const sanctum = await registry.create(FIRST)
    rmSync(sanctum, { recursive: true })
    writeFileSync(sanctum, 'not a folder')

    expect(registry.resolve(sanctum)).toBeNull()
    expect(registry.list()).toEqual([])
  })

  it('removes the directory of a cult it never registered, leaving the registry as it was', async () => {
    const registry = createSanctumRegistry({ userData })
    const kept = await registry.create(FIRST)
    const stray = registry.pathOf(SECOND)
    mkdirSync(stray)
    const before = readFileSync(registryFile(), 'utf8')

    await registry.remove(SECOND)
    expect(() => realpathSync.native(stray)).toThrow()
    expect(readFileSync(registryFile(), 'utf8')).toBe(before)
    expect(registry.list()).toEqual([kept])
  })
})
