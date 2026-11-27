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
