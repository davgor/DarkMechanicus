import { describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { reconcileFolders, upsertFolder } from './folderList'

const alpha = folderView({ path: '/a', name: 'a' })
const beta = folderView({ path: '/b', name: 'b' })

describe('upsertFolder', () => {
  it('appends a folder that is not yet listed', () => {
    expect(upsertFolder([alpha], beta)).toEqual([alpha, beta])
  })

  it('replaces a listed folder in place, keeping the order', () => {
    const updated = folderView({ path: '/a', name: 'a', initialized: false })
    expect(upsertFolder([alpha, beta], updated)).toEqual([updated, beta])
  })

  it('does not mutate the input list', () => {
    const list = [alpha]
    upsertFolder(list, beta)
    expect(list).toEqual([alpha])
  })
})

const copy = (folder: TrackedFolderView, patch: Partial<TrackedFolderView> = {}): TrackedFolderView => ({
  ...folder,
  ...patch
})

describe('reconcileFolders', () => {
  it('keeps the previous array when nothing changed', () => {
    const previous = [alpha, beta]
    expect(reconcileFolders(previous, [copy(alpha), copy(beta)])).toBe(previous)
  })

  it('reuses unchanged folder objects and replaces changed ones', () => {
    const changed = copy(beta, { initialized: false })
    const result = reconcileFolders([alpha, beta], [copy(alpha), changed])
    expect(result[0]).toBe(alpha)
    expect(result[1]).toBe(changed)
  })

  it.each<[string, Partial<TrackedFolderView>]>([
    ['name', { name: 'renamed' }],
    ['display path', { displayPath: '~/elsewhere' }],
    ['initialized flag', { initialized: false }],
    ['availability', { available: false }],
    ['added time', { addedAt: '2030-01-01T00:00:00.000Z' }]
  ])('treats a different %s as a change', (_field, patch) => {
    const next = copy(alpha, patch)
    expect(reconcileFolders([alpha], [next])[0]).toBe(next)
  })

  it('treats a different path as a different folder', () => {
    const other = copy(alpha, { path: '/other' })
    expect(reconcileFolders([alpha], [other])).toEqual([other])
  })

  it('picks up added and removed folders', () => {
    expect(reconcileFolders([alpha], [alpha, beta])).toEqual([alpha, beta])
    expect(reconcileFolders([alpha, beta], [beta])).toEqual([beta])
    expect(reconcileFolders([alpha, beta], [])).toEqual([])
  })

  it('follows the order of the new list', () => {
    const result = reconcileFolders([alpha, beta], [beta, alpha])
    expect(result).toEqual([beta, alpha])
    expect(result[0]).toBe(beta)
  })
})
