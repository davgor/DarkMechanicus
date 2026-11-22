import { describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import { activeChatPaths, activeFolderPaths } from './activePaths'

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

it('loads Forge root chats separately and respects both world and project disclosure state', () => {
  const world = folderView({ path: '/world', initialized: false, forgeWorld: { version: 1, owner: 'codex', projects: [], syncMinutes: 5 } })
  const member = folderView({ path: '/world/a', forgeParent: world.path })
  const folders = [world, member, a]
  expect(activeFolderPaths(folders, null, () => true)).toEqual(['/world/a', '/a'])
  expect(activeChatPaths(folders, null, () => true)).toEqual(['/world', '/world/a', '/a'])
  expect(activeFolderPaths(folders, null, path => path !== member.path)).toEqual(['/a'])
  expect(activeChatPaths(folders, null, path => path !== world.path)).toEqual(['/a'])
  expect(activeChatPaths(folders, world.path, () => false)).toEqual(['/world'])
  expect(activeFolderPaths(folders, member.path, () => false)).toEqual(['/world/a'])
})
