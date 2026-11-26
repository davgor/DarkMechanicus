// @vitest-environment jsdom
/** The run bar's link to the orchestrating chat lands in the epic's Agent tab instead of leaving the epic. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chatRecord } from '../__mocks__/fixtures'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend } from './__mocks__/fakeBackend'
import { fakeOrchestration } from './__mocks__/fakeOrchestration'
import { folder } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const FOLDER = folder().path
const orchestrator = chatRecord({ id: 'chat_orch', folder: FOLDER, role: 'orchestrator', runId: 'rn_2', epicId: 'ep_1', surface: 'gui', title: 'Orchestrator · Plan' })
const planner = chatRecord({ id: 'chat_plan', folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Planner · Plan', createdAt: '2026-03-02T10:00:00.000Z' })

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement

describe('Run bar: Orchestrated by … link', () => {
  it('shows the orchestrator chat in the Agent tab with its node selected, and navigates nowhere', async () => {
    const host = fakeOrchestration({ chats: [orchestrator, planner] })
    renderWorkspace(new FakeBackend(), { orchestration: host })
    const bar = within(await screen.findByLabelText('Run'))
    expect(bar.getByText('Orchestrated by Claude Code in')).toBeTruthy()
    // Another agent is selected first, so the link has to select the orchestrator itself.
    fireEvent.click(button('Agent'))
    const rail = within(screen.getByRole('complementary', { name: 'Epic agents' }))
    fireEvent.click(within(await rail.findByRole('treeitem', { name: 'Lexmechanic' })).getByText('Lexmechanic', { selector: '.at-name' }))
    await waitFor(() => expect(rail.getByRole('treeitem', { name: 'Lexmechanic' }).getAttribute('aria-selected')).toBe('true'))
    fireEvent.click(button('Graph'))
    expect(screen.queryByRole('region', { name: 'Agent chat' })).toBeNull()

    fireEvent.click(bar.getByRole('button', { name: 'Orchestrator · Plan' }))

    expect(button('Agent').getAttribute('aria-pressed')).toBe('true')
    const stage = screen.getByRole('region', { name: 'Agent chat' })
    const tree = within(within(stage).getByRole('complementary', { name: 'Epic agents' }))
    expect((await tree.findByRole('treeitem', { name: 'Magos' })).getAttribute('aria-selected')).toBe('true')
    expect(tree.getByRole('treeitem', { name: 'Lexmechanic' }).getAttribute('aria-selected')).toBe('false')
    expect(within(stage).getByRole('region', { name: 'Magos chat' })).toBeTruthy()
    expect(screen.getByLabelText('Epic workspace')).toBeTruthy()
    expect(host.openedChats).toEqual([])
  })
})
