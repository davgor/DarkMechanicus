// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FakeChats } from '../__mocks__/fakeChats'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { draftPlan, epicDetail, runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  localStorage.clear()
})

async function panelToggle(): Promise<HTMLButtonElement> {
  return screen.findByRole('button', { name: 'Orchestrator messages' })
}

describe('Orchestrator messages', () => {
  it('is collapsed by default and remembers expansion', async () => {
    const backend = new FakeBackend()
    const first = renderWorkspace(backend)
    const toggle = await panelToggle()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(localStorage.getItem('dm.orchestratorMessages.open')).toBe('true'))
    first.unmount()
    renderWorkspace(backend)
    expect((await panelToggle()).getAttribute('aria-expanded')).toBe('true')
  })

  it('follows Attempts in saved view and Validation in draft view', async () => {
    const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() }))
    renderWorkspace(backend)
    const panel = (await panelToggle()).closest('section') as HTMLElement
    const attempts = screen.getByRole('button', { name: 'Attempts' }).closest('section') as HTMLElement
    expect(attempts.nextElementSibling).toBe(panel)
    fireEvent.click(screen.getByRole('button', { name: 'View draft' }))
    const validation = await screen.findByLabelText('Draft validation')
    expect(validation.nextElementSibling).toBe(panel)
  })

  it('sends to the epic-only target', async () => {
    const backend = new FakeBackend()
    renderWorkspace(backend)
    fireEvent.click(await panelToggle())
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'Status please' } })
    const send = screen.getByRole('button', { name: 'Send' })
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false))
    fireEvent.click(send)
    await waitFor(() => expect(backend.state.comments).toHaveLength(1))
    expect(backend.state.comments[0]).toMatchObject({ epicId: 'ep_1', body: 'Status please' })
    // FakeBackend installs this concrete chat fake behind the production ChatsApi boundary.
    const chats = backend.chats as FakeChats
    const request = chats.callsOf('sendConversationMessage')[0]?.[0]
    expect(request).toMatchObject({ target: { epicId: 'ep_1' } })
    expect(request).toBeTruthy()
    if (request !== null && typeof request === 'object' && 'target' in request) {
      expect(request.target).not.toHaveProperty('ticketId')
    }
  })

  it('does not offer Send for a completed epic', async () => {
    renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ status: 'completed' }), run: runView({ state: 'completed' }) })))
    fireEvent.click(await panelToggle())
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })
})
