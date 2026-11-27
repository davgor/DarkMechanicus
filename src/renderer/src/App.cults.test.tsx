// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cultView, FakeCults, memberDetail, runDetail } from './__mocks__/fakeCults'
import { AppHarness } from './__mocks__/appHarness'
import { FakeTerminals } from './__mocks__/fakeTerminals'
import { chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

class NoObserver {
  observe(): void {}
  disconnect(): void {}
}

let h: AppHarness
let cults: FakeCults
let terminals: FakeTerminals

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  cults = new FakeCults()
  terminals = new FakeTerminals()
  h.dm.cults = cults
  h.dm.terminals = terminals
  vi.stubGlobal('ResizeObserver', NoObserver)
  vi.stubGlobal('IntersectionObserver', NoObserver)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const sidebar = () => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const workspace = () => within(screen.getByRole('main', { name: 'Workspace' }))

/** A running cult whose run works in `workDir`, with its member chats stored there as the launcher stores them. */
function seed(workDir: string, scope: 'folder' | 'sanctum'): void {
  cults.cults = [cultView(scope === 'folder' ? { folderPath: workDir } : { scope: 'sanctum', folderPath: null })]
  cults.runsByCult = {
    cult_1: [runDetail({ workDir }, [
      memberDetail(),
      memberDetail({ chatId: 'chat_a', role: 'acolyte', displayName: 'Acolyte Ferrum-3', joinedAt: '2026-11-27T12:01:00.000Z' })
    ])]
  }
  h.dm.chats.chats = [
    chatRecord({ id: 'chat_magos', folder: workDir, agent: 'omp', title: 'Magos Vettius', cultRunId: 'run_1', cultRole: 'magos' }),
    chatRecord({ id: 'chat_a', folder: workDir, agent: 'omp', title: 'Acolyte Ferrum-3', cultRunId: 'run_1', cultRole: 'acolyte' })
  ]
}

async function openMember(name: RegExp): Promise<void> {
  h.mount()
  await settle()
  fireEvent.click(sidebar().getByRole('button', { name: 'Runs of Shrine Builders' }))
  fireEvent.click(within(sidebar().getByRole('list', { name: 'Members' })).getByRole('button', { name }))
  await settle()
}

describe('App: a cult member clicked in the sidebar opens its terminal on the cult page', () => {
  it('opens the Magos’s interactive terminal for a folder cult, in its tracked folder', async () => {
    seed('/a', 'folder')
    await openMember(/^Magos Vettius/)
    expect(workspace().queryByText('The cult page arrives with the next ticket.')).toBeNull()
    expect(workspace().getByRole('banner', { name: 'Cult commands' })).toBeTruthy()
    expect(workspace().getByRole('tab', { name: 'Magos Vettius' }).getAttribute('aria-selected')).toBe('true')
    expect(workspace().getByRole('heading', { level: 1, name: 'Magos Vettius' })).toBeTruthy()
    expect(terminals.calls).toEqual([['/a', 'chat_magos']])
    h.terminalKit.latest().type('go')
    expect(terminals.latest().writes).toEqual(['go'])
  })

  it('opens an acolyte watch-only for a project-less cult, whose sanctum is no tracked folder', async () => {
    const sanctum = '/Users/u/Library/Application Support/dark-mechanicus/sanctums/cult_1'
    seed(sanctum, 'sanctum')
    await openMember(/^Acolyte Ferrum-3/)
    expect(workspace().getByRole('tab', { name: /Acolyte Ferrum-3/ }).getAttribute('aria-selected')).toBe('true')
    expect(workspace().getByText('Watch only')).toBeTruthy()
    expect(terminals.calls).toEqual([[sanctum, 'chat_a']])
    h.terminalKit.latest().type('x')
    expect(terminals.latest().writes).toEqual([])
    expect(sidebar().getByRole('button', { name: /^Shrine Builders/ }).getAttribute('aria-current')).toBe('true')
  })
})
