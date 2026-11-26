// @vitest-environment jsdom
import { act, cleanup, screen, within, type BoundFunctions, type queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NavigateTarget } from '../../../shared/desktop/notifications'
import { AppHarness } from '../__mocks__/appHarness'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { agentView, chatRecord, folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { checkpointView, epicDetail, runView, savedPlan, validation } from '../epic/__mocks__/fixtures'
import { landingActions } from '../epic/landingActions'
import { initialWorkspaceState, workspaceReducer, type WorkspaceData, type WorkspaceState } from '../epic/workspaceState'
import type { EpicLanding } from './landing'

let h: AppHarness
let terminals: FakeTerminals

const AT = '2026-03-01T10:00:00.000Z'
const EPIC = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'
const MAGOS = chatRecord({ id: 'chat_magos', folder: '/a', title: 'Magos', agent: 'claude', role: 'orchestrator', epicId: EPIC, surface: 'gui', updatedAt: AT })
const PLAIN = chatRecord({ id: 'chat_plain', folder: '/a', title: 'Plain folder chat', agent: 'claude', updatedAt: AT })
const FREE = chatRecord({ id: 'chat_free', folder: null, title: 'Project-less chat', agent: 'claude', updatedAt: AT })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  terminals = new FakeTerminals()
  h.dm.terminals = terminals
  h.dm.folders = [folderView({ path: '/a', name: 'alpha' }), folderView({ path: '/b', name: 'beta' })]
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'ok' }
  h.dm.chats.chats = [MAGOS, PLAIN, FREE]
})

afterEach(cleanup)

async function mount(): Promise<void> {
  // Start on beta, so every landing below is a move away from where the person was.
  window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/b', epicId: null }))
  h.mount()
  await settle()
}

async function click(target: NavigateTarget): Promise<void> {
  act(() => h.dm.notifications.navigate(target))
  await settle()
}

const selection = (): Record<string, unknown> => JSON.parse(window.localStorage.getItem('dm.selection') ?? '{}') as Record<string, unknown>
const workspace = (): BoundFunctions<typeof queries> => within(screen.getByRole('main', { name: 'Workspace' }))
const epicLanding = (): EpicLanding | null => JSON.parse(screen.getByTestId('epic-landing').textContent ?? 'null') as EpicLanding | null

/** What the real epic workspace does with the landing it was handed, once its data has loaded. */
function landedState(landing: EpicLanding): WorkspaceState {
  const data: WorkspaceData = {
    epic: epicDetail(), saved: savedPlan(), draft: null, run: runView(), checkpoint: checkpointView(),
    savedTickets: [], draftTickets: [], validation: validation(), transfer: null
  }
  const loaded = workspaceReducer(initialWorkspaceState(), { type: 'load_succeeded', data, at: 1 })
  return landingActions(landing, data, loaded.view).reduce(workspaceReducer, loaded)
}

describe('DM-825: a clicked notification lands where it names', () => {
  it('opens an epic-bound chat on its epic’s Agent tab with the chat selected', async () => {
    await mount()
    await click({ kind: 'chat', folder: '/a', chatId: MAGOS.id })

    expect(selection()).toEqual({ folderPath: '/a', epicId: EPIC })
    expect(screen.getByTestId('epic-stub').textContent).toContain(`alpha|${EPIC}|`)
    const landing = epicLanding()
    expect(landing).toEqual({ kind: 'epicAgent', epicId: EPIC, chatId: MAGOS.id })
    expect(landedState(landing!)).toMatchObject({ layout: 'agent', agentChatId: MAGOS.id, agentThreadId: null, checkpointOpen: false })
  })

  it('opens a worker request (a thread target) on the owning chat that holds its card, with no thread', async () => {
    await mount()
    await click({ kind: 'chat', folder: '/a', chatId: MAGOS.id, threadId: 'chat_worker' })

    const landing = epicLanding()
    expect(landing).toEqual({ kind: 'epicAgent', epicId: EPIC, chatId: MAGOS.id })
    expect(landedState(landing!)).toMatchObject({ layout: 'agent', agentChatId: MAGOS.id, agentThreadId: null })
  })

  it('opens a folder chat in its folder', async () => {
    await mount()
    await click({ kind: 'chat', folder: '/a', chatId: PLAIN.id })

    expect(selection()).toEqual({ folderPath: '/a', epicId: null, chatId: PLAIN.id })
    expect(workspace().getByRole('heading', { level: 1, name: 'Plain folder chat' })).toBeTruthy()
  })

  it('opens a project-less chat on its own', async () => {
    await mount()
    await click({ kind: 'chat', folder: null, chatId: FREE.id })

    expect(selection()).toMatchObject({ epicId: null, agentPane: { kind: 'chat', chatId: FREE.id } })
    expect(workspace().getByRole('heading', { level: 1, name: 'Project-less chat' })).toBeTruthy()
  })
})

describe('DM-825: checkpoint, epic, unknown and untracked targets, and the subscription', () => {
  it('opens the checkpoint panel of a checkpoint target’s epic', async () => {
    await mount()
    await click({ kind: 'checkpoint', folder: '/a', epicId: EPIC })

    expect(selection()).toEqual({ folderPath: '/a', epicId: EPIC })
    const landing = epicLanding()
    expect(landing).toEqual({ kind: 'epicCheckpoint', epicId: EPIC })
    expect(landedState(landing!)).toMatchObject({ layout: 'graph', checkpointOpen: true, scorecardOpen: false })
  })

  it('opens the epic a failed-run target names', async () => {
    await mount()
    await click({ kind: 'epic', folder: '/a', epicId: EPIC })

    expect(selection()).toEqual({ folderPath: '/a', epicId: EPIC })
    expect(epicLanding()).toBeNull()
  })

  it('falls back to the named folder for a chat no loaded list holds', async () => {
    await mount()
    await click({ kind: 'chat', folder: '/a', chatId: 'chat_gone' })

    expect(selection()).toEqual({ folderPath: '/a', epicId: null })
    expect(workspace().getByRole('heading', { level: 1, name: 'alpha' })).toBeTruthy()
  })

  it('ignores targets for folders that are not tracked, and an unknown project-less chat', async () => {
    await mount()
    const before = window.localStorage.getItem('dm.selection')

    await click({ kind: 'chat', folder: '/untracked', chatId: 'chat_gone' })
    await click({ kind: 'chat', folder: null, chatId: 'chat_gone' })
    await click({ kind: 'checkpoint', folder: '/untracked', epicId: EPIC })
    await click({ kind: 'epic', folder: '/untracked', epicId: EPIC })

    expect(window.localStorage.getItem('dm.selection')).toBe(before)
    expect(workspace().getByRole('heading', { level: 1, name: 'beta' })).toBeTruthy()
  })

  it('subscribes once for the shell’s lifetime and removes the listener on unmount', async () => {
    const unsubscribed = vi.fn()
    const subscribe = h.dm.notifications.onNavigate.bind(h.dm.notifications)
    const onNavigate = vi.spyOn(h.dm.notifications, 'onNavigate').mockImplementation((listener) => {
      const off = subscribe(listener)
      return () => { unsubscribed(); off() }
    })
    await mount()
    await click({ kind: 'chat', folder: '/a', chatId: PLAIN.id })
    await click({ kind: 'epic', folder: '/a', epicId: EPIC })
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(unsubscribed).not.toHaveBeenCalled()

    cleanup()

    expect(unsubscribed).toHaveBeenCalledTimes(1)
    const before = window.localStorage.getItem('dm.selection')
    h.dm.notifications.navigate({ kind: 'chat', folder: '/a', chatId: PLAIN.id })
    expect(window.localStorage.getItem('dm.selection')).toBe(before)
  })
})
