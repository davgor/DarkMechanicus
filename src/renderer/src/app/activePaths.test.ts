import { describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import { activeFolderPaths } from './activePaths'

const a = folderView({ path: '/a' })
const b = folderView({ path: '/b' })
const c = folderView({ path: '/c' })
const setup = folderView({ path: '/setup', initialized: false })
const gone = folderView({ path: '/gone', available: false })

describe('activeFolderPaths', () => {
  it('includes expanded folders in list order', () => {
    expect(activeFolderPaths([a, b, c], null, () => true)).toEqual(['/a', '/b', '/c'])
  })

  it('leaves out collapsed folders', () => {
    expect(activeFolderPaths([a, b, c], null, (path) => path !== '/b')).toEqual(['/a', '/c'])
  })

  it('always includes the selected folder, even when collapsed', () => {
    expect(activeFolderPaths([a, b], '/b', () => false)).toEqual(['/b'])
  })

  it('never includes folders that cannot hold epics', () => {
    expect(activeFolderPaths([a, setup, gone], '/setup', () => true)).toEqual(['/a'])
  })

  it('is empty without folders', () => {
    expect(activeFolderPaths([], null, () => true)).toEqual([])
  })
})
