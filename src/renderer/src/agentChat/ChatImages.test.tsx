// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { chatImageUrl } from '../../../shared/agents/chatImageUrl'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ChatTranscript } from '../agents/ChatTranscript'
import { AgentChat } from './AgentChat'
import { agentChatScenarios, missingChatImageId } from './__mocks__/agentChatScenario'

afterEach(cleanup)

const FOLDER_KEY = '0123456789abcdef0123456789abcdef'
const CHAT_ID = 'fixture-chat'
const items = agentChatScenarios['image-result'].snapshot.items
const url = (id: string): string => chatImageUrl(FOLDER_KEY, CHAT_ID, id)

/**
 * The image-result scenario in a project GUI chat: a sent message with two images, one gone, and a Read that returned one.
 * The idle chat folds the ended turn's Read behind its `Worked for` row, which is opened here.
 */
async function mountImageResult(): Promise<FakeAgentChat> {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: agentChatScenarios['image-result'].snapshot }
  render(<AgentChat folder="/repo" folderKey={FOLDER_KEY} chatId={CHAT_ID} agentLabel="Magos" api={api} scheduler={new ManualScheduler()} />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: /^Worked for/ }))
  return api
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: /./ })

describe('ChatImages thumbnails', () => {
  it('renders the person’s and the tool’s images as lazy dm-chat-image thumbnails named by sender and size', async () => {
    await mountImageResult()
    const yours = within(screen.getByRole('list', { name: 'Your images' }))
    const you = yours.getByRole('img', { name: 'Image from you, 1280x800' }) as HTMLImageElement
    expect(you.getAttribute('src')).toBe(url('ci_01m8e000000000000000000011'))
    expect(you.getAttribute('loading')).toBe('lazy')
    expect(you.getAttribute('src')?.startsWith('dm-chat-image://')).toBe(true)
    // Under the person's bubble, inside their message row.
    expect(you.closest('.chat-msg-user')?.querySelector('article')?.getAttribute('aria-label')).toBe('You')

    const tool = screen.getByRole('listitem', { name: 'Tool call: Read' })
    const agent = within(tool).getByRole('img', { name: 'Image from agent, 1440x900' }) as HTMLImageElement
    expect(agent.getAttribute('src')).toBe(url('ci_01m8e000000000000000000012'))
    expect(agent.getAttribute('loading')).toBe('lazy')
    expect(within(tool).getByRole('list', { name: 'Images from the agent' })).toBeTruthy()
  })

  it('shows the broken placeholder for an image whose file is gone', async () => {
    await mountImageResult()
    const missing = screen.getByRole('img', { name: 'Image from you, 1024x768' }) as HTMLImageElement
    expect(missing.getAttribute('src')).toBe(url(missingChatImageId))
    fireEvent.error(missing)
    const placeholder = screen.getByRole('img', { name: 'Image from you, 1024x768 (image missing)' })
    expect(within(placeholder).getByText('Image missing')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Image from you, 1024x768' })).toBeNull()
  })

  it('leaves terminal transcripts, which pass no image source, without images', () => {
    render(<ChatTranscript agentName="Claude Code" folder="/repo" entries={items} />)
    expect(screen.queryAllByRole('img')).toHaveLength(0)
    expect(screen.queryByRole('list', { name: 'Your images' })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Images from the agent' })).toBeNull()
    expect(screen.getByText('The sign-in screen breaks at this width.')).toBeTruthy()
  })

  it('shows nothing extra for items without images', () => {
    const plain: ChatItem[] = [{ id: 'u', at: '2026-11-24T08:00:00.000Z', kind: 'user_message', text: 'No pictures.' }]
    render(<ChatTranscript agentName="Magos" folder="/repo" entries={plain} imageSrc={(ref) => url(ref.id)} />)
    expect(screen.queryByRole('list', { name: 'Your images' })).toBeNull()
  })
})

describe('ChatImages lightbox', () => {
  it('opens the shared lightbox with the full image on a click', async () => {
    await mountImageResult()
    fireEvent.click(screen.getByRole('button', { name: 'Open Image from agent, 1440x900' }))
    const open = dialog()
    expect(open.getAttribute('aria-label')).toBe('Image from agent, 1440x900')
    const full = within(open).getByRole('img', { name: 'Image from agent, 1440x900' }) as HTMLImageElement
    expect(full.getAttribute('src')).toBe(url('ci_01m8e000000000000000000012'))
    expect(full.classList.contains('attachment-lightbox-image')).toBe(true)
    expect(within(open).getByText('1 / 1')).toBeTruthy()
  })

  it('steps between one message’s images, the missing one as a placeholder', async () => {
    await mountImageResult()
    fireEvent.click(screen.getByRole('button', { name: 'Open Image from you, 1280x800' }))
    expect(within(dialog()).getByText('1 / 2')).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next image' }))
    expect(within(dialog()).getByText('2 / 2')).toBeTruthy()
    fireEvent.error(within(dialog()).getByRole('img', { name: 'Image from you, 1024x768' }))
    expect(within(dialog()).getByRole('img', { name: 'Image from you, 1024x768 (image missing)' })).toBeTruthy()
  })

  it('closes on Escape, returns focus to the thumbnail, and does not stop a busy turn', async () => {
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: { ...agentChatScenarios['image-result'].snapshot, status: 'busy' } }
    render(<AgentChat folder="/repo" folderKey={FOLDER_KEY} chatId={CHAT_ID} agentLabel="Magos" api={api} scheduler={new ManualScheduler()} />)
    await settle()
    const thumb = screen.getByRole('button', { name: 'Open Image from you, 1280x800' })
    thumb.focus()
    fireEvent.click(thumb)
    const close = within(dialog()).getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Escape' })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(thumb)
    expect(api.callsOf('interrupt')).toHaveLength(0)
  })
})

const stampFor = (ticketKey: string, ticketVerified: boolean) => ({ role: 'Acolyte' as const, ticketKey, ordinal: null, purpose: null, ticketVerified })
const shot = (id: string) => [{ id, mime: 'image/png' as const, width: 800, height: 600, bytes: 4_096 }]
/** A busy chat (no `Worked for` fold): the person's image, a capture in a thread bound to DM-7, and one in a thread only labelled DM-8. */
const epicItems: ChatItem[] = [
  { id: 'ask', at: '2026-11-24T08:00:00.000Z', kind: 'user_message', text: 'Here is the bug.', images: shot('ci_01m8e000000000000000000021') },
  { id: 'spawn-7', at: '2026-11-24T08:00:01.000Z', kind: 'tool_call', name: 'Task', input: { description: 'Fix the form' }, status: 'running', resultSummary: null },
  { id: 'th-7', at: '2026-11-24T08:00:02.000Z', kind: 'thread', parentItemId: 'spawn-7', label: 'Acolyte:DM-7 Fix the form', state: 'running', callsign: stampFor('DM-7', true) },
  { id: 'shot-7', at: '2026-11-24T08:00:03.000Z', kind: 'tool_call', threadId: 'th-7', name: 'Screenshot', input: {}, status: 'completed', resultSummary: 'Captured', images: shot('ci_01m8e000000000000000000022') },
  { id: 'spawn-8', at: '2026-11-24T08:00:04.000Z', kind: 'tool_call', name: 'Task', input: { description: 'Look around' }, status: 'running', resultSummary: null },
  { id: 'th-8', at: '2026-11-24T08:00:05.000Z', kind: 'thread', parentItemId: 'spawn-8', label: 'Acolyte:DM-8 Look around', state: 'running', callsign: stampFor('DM-8', false) },
  { id: 'shot-8', at: '2026-11-24T08:00:06.000Z', kind: 'tool_call', threadId: 'th-8', name: 'Screenshot', input: {}, status: 'completed', resultSummary: 'Captured', images: shot('ci_01m8e000000000000000000023') }
]
const TICKETS = [{ id: 'tk_7', key: 'DM-7' }, { id: 'tk_8', key: 'DM-8' }]

/** The chat above, inside an epic (or not), with both threads opened; the toasts it confirmed are collected. */
async function mountEpicChat(epic: boolean): Promise<{ api: FakeAgentChat; toasts: string[] }> {
  const api = new FakeAgentChat()
  const toasts: string[] = []
  api.snapshotResult = { ok: true, data: { ...agentChatScenarios['image-result'].snapshot, status: 'busy', items: epicItems } }
  render(<AgentChat folder="/repo" folderKey={FOLDER_KEY} chatId={CHAT_ID} agentLabel="Magos" api={api} scheduler={new ManualScheduler()}
    {...(epic ? { epic: { epicId: 'ep_1', tickets: TICKETS, confirm: (text: string) => { toasts.push(text) } } } : {})} />)
  await settle()
  for (const name of ['Thread: Acolyte:DM-7', 'Thread: Acolyte:DM-8']) {
    const toggle = within(screen.getByRole('listitem', { name })).getAllByRole('button')[0]
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  }
  return { api, toasts }
}

describe('ChatImages Attach as evidence', () => {
  it('is absent outside an epic, beside thumbnails that still open', async () => {
    await mountEpicChat(false)
    expect(screen.getAllByRole('button', { name: /^Open Image from/ }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /as evidence/ })).toBeNull()
  })

  it('sends a bound thread’s image to its ticket and confirms with the ticket key', async () => {
    const { api, toasts } = await mountEpicChat(true)
    fireEvent.click(screen.getByRole('button', { name: 'Attach Image from agent, 800x600 as evidence to DM-7' }))
    await settle()
    expect(api.callsOf('attachEvidence')).toEqual([[{ folder: '/repo', chatId: CHAT_ID, imageId: 'ci_01m8e000000000000000000022', epicId: 'ep_1', ticketId: 'tk_7' }]])
    expect(toasts).toEqual(['Attached the image to DM-7 as evidence.'])
  })

  it('sends the person’s image and an unverified thread’s image to the epic', async () => {
    const { api } = await mountEpicChat(true)
    fireEvent.click(screen.getByRole('button', { name: 'Attach Image from you, 800x600 as evidence to the epic' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach Image from agent, 800x600 as evidence to the epic' }))
    await settle()
    expect(api.callsOf('attachEvidence')).toEqual([
      [{ folder: '/repo', chatId: CHAT_ID, imageId: 'ci_01m8e000000000000000000021', epicId: 'ep_1' }],
      [{ folder: '/repo', chatId: CHAT_ID, imageId: 'ci_01m8e000000000000000000023', epicId: 'ep_1' }]
    ])
  })

  it('shows a refusal inline under its thumbnail and confirms nothing', async () => {
    const { api, toasts } = await mountEpicChat(true)
    api.attachEvidenceResult = { ok: false, error: { code: 'unauthorized', message: 'That chat is not bound to this epic.' } }
    const button = screen.getByRole('button', { name: 'Attach Image from agent, 800x600 as evidence to DM-7' })
    fireEvent.click(button)
    await settle()
    expect(within(button.closest('li')!).getByRole('alert').textContent).toBe('That chat is not bound to this epic.')
    expect(toasts).toEqual([])
  })
})
