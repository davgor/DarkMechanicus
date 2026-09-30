import { describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import type { MainView } from './chooseView'
import { chooseView } from './chooseView'

const ready = folderView()

const CASES: [string, Parameters<typeof chooseView>[0], MainView][] = [
  ['folders are still loading', { loaded: false, folder: ready, epicId: null }, 'loading'],
  ['no folder is selected', { loaded: true, folder: null, epicId: null }, 'welcome'],
  ['the folder is gone', { loaded: true, folder: folderView({ available: false }), epicId: null }, 'unavailable'],
  ['the folder is not initialized', { loaded: true, folder: folderView({ initialized: false }), epicId: null }, 'onboarding'],
  ['an epic is selected', { loaded: true, folder: ready, epicId: 'ep_1' }, 'epic'],
  ['no epic is selected', { loaded: true, folder: ready, epicId: null }, 'home']
]

describe('chooseView', () => {
  it.each(CASES)('shows the right view when %s', (_name, input, expected) => {
    expect(chooseView(input)).toBe(expected)
  })

  it('ignores a stale epic on an uninitialized folder', () => {
    const folder = folderView({ initialized: false })
    expect(chooseView({ loaded: true, folder, epicId: 'ep_1' })).toBe('onboarding')
  })

  it('ignores a stale epic on an unavailable folder', () => {
    const folder = folderView({ available: false, initialized: false })
    expect(chooseView({ loaded: true, folder, epicId: 'ep_1' })).toBe('unavailable')
  })
})
