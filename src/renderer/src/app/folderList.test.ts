import { describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import { upsertFolder } from './folderList'

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
