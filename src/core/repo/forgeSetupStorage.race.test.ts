import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTempRepo } from '../../test/tempRepo'
import { readForgeRecipebook, writeForgeRecipebook } from './forgeSetupStorage'

const during = vi.hoisted(() => ({ beforeRead: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined, afterFlush: undefined as (() => void) | undefined }))

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  return { ...fs,
    readSync(...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) {
      during.beforeRead?.()
      const count = fs.readSync(...args)
      during.afterRead?.()
      return count
    },
    fsyncSync(fd: number) {
      fs.fsyncSync(fd)
      during.afterFlush?.()
    }
  }
})

afterEach(() => {
  during.beforeRead = undefined
  during.afterRead = undefined
  during.afterFlush = undefined
})

const empty = { version: 1 as const, recipes: [] }

it.each(['beforeRead', 'afterRead'] as const)('refuses a recipebook changed %s without publishing a stale snapshot', (boundary) => {
  const temp = createTempRepo()
  try {
    const path = join(temp.root, 'forge-recipes.yaml')
    writeForgeRecipebook(temp.root, null, empty)
    // A real competing write at the specified filesystem boundary shortens the opened file.
    during[boundary] = () => {
      during[boundary] = undefined
      writeFileSync(path, '')
    }
    expect(() => readForgeRecipebook(temp.root)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(readFileSync(path, 'utf8')).toBe('')
  } finally { temp.cleanup() }
})

it('preserves a competing edit that arrives after the pending file is flushed', () => {
  const temp = createTempRepo()
  try {
    const path = join(temp.root, 'forge-recipes.yaml')
    const original = writeForgeRecipebook(temp.root, null, empty)
    const competing = '# Updated by a separate editor\n' + readFileSync(path, 'utf8')
    const residual = join(temp.layout.localDir, 'old-pending-file.tmp')
    writeFileSync(residual, 'older process left this file')
    during.afterFlush = () => {
      during.afterFlush = undefined
      writeFileSync(path, competing)
    }
    const book = { ...empty, recipes: [{ id: 'team', title: 'Team', kind: 'world' as const,
      description: 'Team setup', assets: [], steps: [],
      source: { repository: 'https://github.com/example/software.git', commit: 'a'.repeat(40) } }] }
    expect(() => writeForgeRecipebook(temp.root, original.sha256, book)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(readFileSync(path, 'utf8')).toBe(competing)
    expect(readdirSync(temp.layout.localDir)).toEqual(['old-pending-file.tmp'])
    expect(readFileSync(residual, 'utf8')).toBe('older process left this file')
    const observed = readForgeRecipebook(temp.root)!
    expect(writeForgeRecipebook(temp.root, observed.sha256, book)).toMatchObject({ value: book })
  } finally { temp.cleanup() }
})
