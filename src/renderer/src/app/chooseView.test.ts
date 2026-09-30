import { describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import type { MainView } from './chooseView'
import { chooseView } from './chooseView'

const ready = folderView()
const setup = folderView({ initialized: false })
const missing = folderView({ available: false })

const CASES: [string, Parameters<typeof chooseView>[0], MainView][] = [
  ['folders are still loading', { loaded: false, folder: ready, epicId: null }, { kind: 'loading' }],
  ['no folder is selected', { loaded: true, folder: null, epicId: null }, { kind: 'welcome' }],
  ['the folder is gone', { loaded: true, folder: missing, epicId: null }, { kind: 'unavailable', folder: missing }],
  ['the folder is not initialized', { loaded: true, folder: setup, epicId: null }, { kind: 'onboarding', folder: setup }],
  ['an epic is selected', { loaded: true, folder: ready, epicId: 'ep_1' }, { kind: 'epic', folder: ready, epicId: 'ep_1' }],
  ['no epic is selected', { loaded: true, folder: ready, epicId: null }, { kind: 'home', folder: ready }]
]

describe('chooseView', () => {
  it.each(CASES)('shows the right view when %s', (_name, input, expected) => {
    expect(chooseView(input)).toEqual(expected)
  })

  it('ignores a stale epic on an uninitialized folder', () => {
    expect(chooseView({ loaded: true, folder: setup, epicId: 'ep_1' }).kind).toBe('onboarding')
  })

  it('ignores a stale epic on an unavailable folder', () => {
    const both = folderView({ available: false, initialized: false })
    expect(chooseView({ loaded: true, folder: both, epicId: 'ep_1' }).kind).toBe('unavailable')
  })

  it('shows loading whatever the selection until folders arrive', () => {
    expect(chooseView({ loaded: false, folder: null, epicId: null }).kind).toBe('loading')
  })
})
