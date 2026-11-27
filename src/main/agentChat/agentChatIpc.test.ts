/**
 * The `agentChat:*` channels: exactly the contract's, every one behind the sender guard, each payload validated by the
 * strict schemas and its folder resolved through the registry before the session manager is reached; the push sends
 * only validated events. `attachEvidence` runs against a real temp folder workspace.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../core/errors'
import { AGENT_CHAT_CHANNELS, type AgentChatEvent } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import type { CommandResult } from '../../shared/desktop/api'
import type { AttachmentView, CommentView } from '../../shared/domain/views'
import { webpBytes } from '../../test/images'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { ChatWindow } from '../agents/chatIpc'
import { createChatStore } from '../agents/chatStore'
import { guardIpc } from '../ipcGuard'
import { createAgentChatHandlers, createAgentChatPush, registerAgentChatIpc } from './agentChatIpc'
import type { AgentChatSessions } from './agentChatSessions'
import { createChatImages } from './chatImages'
import type { OmpModels } from './ompModels'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const REPO = '/work/repo'
const INVOKED = Object.values(AGENT_CHAT_CHANNELS).filter(channel => channel !== AGENT_CHAT_CHANNELS.event).sort()
const frame = (url: string, parent: object | null = null) => ({ url, parent, detached: false, isDestroyed: () => false })
const TRUSTED = { sender: {}, senderFrame: frame(`${APP_URL}/`) } as unknown as IpcMainInvokeEvent
const SNAPSHOT = { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] } as const
const SWATCH = readFileSync(fileURLToPath(new URL('./__fixtures__/images/swatch.png', import.meta.url)))
const IMAGE = { id: `ci_${'0'.repeat(26)}`, mime: 'image/png', width: 64, height: 64, bytes: SWATCH.length } as const

/** A valid request for each invoked channel. */
const REQUESTS: Record<string, Record<string, unknown>> = {
  [AGENT_CHAT_CHANNELS.start]: { folder: REPO, chatId: 'chat_1' },
  [AGENT_CHAT_CHANNELS.send]: { folder: REPO, chatId: 'chat_1', text: 'Hello' },
  [AGENT_CHAT_CHANNELS.interrupt]: { folder: REPO, chatId: 'chat_1' },
  [AGENT_CHAT_CHANNELS.answer]: { folder: REPO, chatId: 'chat_1', promptId: 'p1', optionId: 'allow_once' },
  [AGENT_CHAT_CHANNELS.setSurface]: { folder: REPO, chatId: 'chat_1', surface: 'gui' },
  [AGENT_CHAT_CHANNELS.snapshot]: { folder: REPO, chatId: 'chat_1' },
  [AGENT_CHAT_CHANNELS.attention]: { folder: REPO },
  [AGENT_CHAT_CHANNELS.stageImage]: { folder: REPO, chatId: 'chat_1', data: SWATCH.toString('base64') },
  [AGENT_CHAT_CHANNELS.attachEvidence]: { folder: REPO, chatId: 'chat_1', imageId: IMAGE.id, epicId: 'ep_1' },
  [AGENT_CHAT_CHANNELS.models]: { folder: REPO, chatId: 'chat_1' }
}

function rig() {
  const calls: unknown[][] = []
  const record = (name: string, result: unknown) => vi.fn(async (...args: unknown[]) => { calls.push([name, ...args]); return result })
  const sessions = {
    start: record('start', SNAPSHOT), send: record('send', undefined), interrupt: record('interrupt', undefined),
    answer: record('answer', undefined), setSurface: record('setSurface', SNAPSHOT), snapshot: vi.fn((...args: unknown[]) => { calls.push(['snapshot', ...args]); return SNAPSHOT }),
    attention: vi.fn((...args: unknown[]) => { calls.push(['attention', ...args]); return [] }),
    stageImage: record('stageImage', IMAGE)
  } as unknown as AgentChatSessions
  const confirmTerminalStop = vi.fn(async () => false)
  const listeners = new Map<string, Listener>()
  const refused: string[] = []
  const guarded = guardIpc({
    handle: (channel, listener) => {
      if (listeners.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      listeners.set(channel, listener)
    }
  }, { appUrl: APP_URL, onRefused: channel => { refused.push(channel) } })
  const models = { chatModels: record('chatModels', []), catalogModels: record('catalogModels', []) } as unknown as OmpModels
  // The evidence path's own tests use a real workspace (below); here only the chat lookup is recorded.
  const evidence = {
    chats: { getChat: (ref: unknown) => { calls.push(['getChat', ref]); return { id: 'chat_1', folder: REPO, title: 'Chat', epicId: 'ep_1' } as ChatRecord } },
    chatImages: { read: async () => ({ bytes: SWATCH, mime: 'image/png' as const }) },
    workspace: () => ({
      listComments: async () => [], getRun: async () => null,
      uploadAttachment: async () => ({ id: 'im_1' }) as AttachmentView,
      addComment: async () => ({ id: 'cm_1' }) as CommentView
    })
  }
  const handlers = createAgentChatHandlers({ registry: { resolve: path => (path === REPO ? REPO : null) }, sessions, confirmTerminalStop, models, evidence })
  registerAgentChatIpc(guarded, handlers, event => event.sender)
  const invoke = async (channel: string, request: unknown, event = TRUSTED) => (await listeners.get(channel)!(event, request)) as CommandResult<unknown>
  return { calls, sessions, confirmTerminalStop, listeners, refused, invoke }
}

const codeOf = (result: CommandResult<unknown>) => (result.ok ? 'ok' : result.error.code)

describe('agent chat IPC registration', () => {
  it('registers exactly the invoked agentChat channels, each once, and no chats:* name', () => {
    const channels = [...rig().listeners.keys()].sort()
    expect(channels).toEqual(INVOKED)
    expect(channels.every(channel => channel.startsWith('agentChat:'))).toBe(true)
  })

  it('answers each channel for the app page and reaches the session manager with the resolved chat or folder', async () => {
    const state = rig()
    for (const channel of INVOKED) expect(codeOf(await state.invoke(channel, REQUESTS[channel]))).toBe('ok')
    // `INVOKED` is sorted by channel name, so the manager is reached in that order.
    const ref = { folder: REPO, id: 'chat_1' }
    expect(state.calls.map(call => [call[0], call[1]])).toEqual([
      ['answer', ref], ['getChat', ref], ['attention', REPO], ['interrupt', ref], ['chatModels', ref], ['send', ref], ['setSurface', ref], ['snapshot', ref], ['stageImage', ref], ['start', ref]
    ])
  })

  it('registers agentChat:attention behind the guard and answers the folder’s items or a project-less list', async () => {
    const state = rig()
    expect(state.listeners.has(AGENT_CHAT_CHANNELS.attention)).toBe(true)
    const item = { chatId: 'chat_1', promptId: 'p1', kind: 'approval', threadId: null, callsign: null, arbitration: 'escalated', title: 'Run', shown: true }
    vi.mocked(state.sessions.attention).mockReturnValueOnce([item as never])
    expect(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: REPO })).toEqual({ ok: true, data: [item] })
    expect(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: null })).toEqual({ ok: true, data: [] })
    // The one-shot return stands in for the recording implementation, so the mock's own calls are the record.
    expect(vi.mocked(state.sessions.attention).mock.calls).toEqual([[REPO], [null]])
    const untrusted = { sender: {}, senderFrame: frame('https://example.com/') } as unknown as IpcMainInvokeEvent
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: REPO }, untrusted))).toBe('unauthorized')
    expect(state.refused).toEqual([AGENT_CHAT_CHANNELS.attention])
  })

  it('refuses agentChat:attention for an unknown folder before reaching the session manager', async () => {
    const state = rig()
    for (const folder of ['/elsewhere', '/work/repo/../other']) {
      expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder }))).toBe('unauthorized')
    }
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: REPO, chatId: 'chat_1' }))).toBe('invalid_input')
    expect(state.calls).toEqual([])
  })
})

describe('agent chat models IPC', () => {
  it('serves agentChat:models for a chat or, before one starts, an agent, passing only refresh', async () => {
    const state = rig()
    expect(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: null, chatId: 'chat_1', refresh: true })).toEqual({ ok: true, data: [] })
    expect(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO, agentId: 'omp' })).toEqual({ ok: true, data: [] })
    expect(state.calls).toEqual([['chatModels', { folder: null, id: 'chat_1' }, { refresh: true }], ['catalogModels', 'omp', { refresh: false }]])
  })

  it('refuses an agentChat:models request naming both a chat and an agent, neither, or an untracked folder', async () => {
    const state = rig()
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO, chatId: 'chat_1', agentId: 'omp' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO, agentId: '../omp' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: '/elsewhere', agentId: 'omp' }))).toBe('unauthorized')
    expect(state.calls).toEqual([])
  })
})

describe('agent chat IPC behind the sender guard', () => {
  for (const [label, event] of [
    ['another page', { sender: {}, senderFrame: frame('https://example.com/') }],
    ['a subframe of the app page', { sender: {}, senderFrame: frame(`${APP_URL}/`, {}) }],
    ['no frame', { sender: {}, senderFrame: null }]
  ] as const) it(`answers unauthorized to ${label} and never reaches a handler`, async () => {
    const state = rig()
    for (const channel of INVOKED) expect(codeOf(await state.invoke(channel, REQUESTS[channel], event as unknown as IpcMainInvokeEvent))).toBe('unauthorized')
    expect(state.calls).toEqual([])
    expect(state.confirmTerminalStop).not.toHaveBeenCalled()
    expect(state.refused.sort()).toEqual(INVOKED)
  })
})

describe('agent chat IPC requests a renderer cannot shape', () => {
  it('refuses unknown keys on every channel, including launch fields and a confirmation', async () => {
    const state = rig()
    for (const channel of INVOKED) {
      for (const extra of [{ executable: '/bin/sh' }, { args: ['-c'] }, { cwd: '/' }, { env: { A: '1' } }, { confirmed: true }, { force: true }]) {
        expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], ...extra }))).toBe('invalid_input')
      }
    }
    expect(state.calls).toEqual([])
    expect(state.confirmTerminalStop).not.toHaveBeenCalled()
  })

  it('refuses a missing or malformed payload', async () => {
    const state = rig()
    for (const channel of INVOKED) {
      expect(codeOf(await state.invoke(channel, undefined))).toBe('invalid_input')
      expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], chatId: '../escape' }))).toBe('invalid_input')
    }
    expect(state.calls).toEqual([])
  })

  it('refuses a folder outside the registry before reaching the session manager', async () => {
    const state = rig()
    for (const channel of INVOKED) expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], folder: '/elsewhere' }))).toBe('unauthorized')
    expect(state.calls).toEqual([])
  })

  it('passes a project-less chat with a null folder', async () => {
    const state = rig()
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.snapshot, { folder: null, chatId: 'chat_1' }))).toBe('ok')
    expect(state.calls).toEqual([['snapshot', { folder: null, id: 'chat_1' }]])
  })

  it('passes setSurface the Main-owned confirmation for this request’s sender only', async () => {
    const state = rig()
    const sender = { id: 'requesting window' }
    await state.invoke(AGENT_CHAT_CHANNELS.setSurface, REQUESTS[AGENT_CHAT_CHANNELS.setSurface], { ...TRUSTED, sender } as unknown as IpcMainInvokeEvent)
    const confirm = state.calls[0][3] as (chat: unknown) => Promise<boolean>
    expect(state.calls[0].slice(0, 3)).toEqual(['setSurface', { folder: REPO, id: 'chat_1' }, 'gui'])
    await confirm({ id: 'chat_1' })
    expect(state.confirmTerminalStop).toHaveBeenCalledExactlyOnceWith(sender, { id: 'chat_1' })
  })

  it('answers a GUI start refused for a live terminal as busy_elsewhere', async () => {
    const state = rig()
    vi.mocked(state.sessions.start).mockResolvedValueOnce({ code: 'busy_elsewhere' })
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.start, REQUESTS[AGENT_CHAT_CHANNELS.start]))).toBe('busy_elsewhere')
  })
})

describe('agent chat images over IPC', () => {
  it('stages an image behind the guard: the decoded bytes reach the manager for the resolved chat, and its ref is answered', async () => {
    const state = rig()
    expect(state.listeners.has(AGENT_CHAT_CHANNELS.stageImage)).toBe(true)
    expect(await state.invoke(AGENT_CHAT_CHANNELS.stageImage, REQUESTS[AGENT_CHAT_CHANNELS.stageImage])).toEqual({ ok: true, data: { image: IMAGE } })
    expect(state.calls).toHaveLength(1)
    const [name, ref, bytes] = state.calls[0]
    expect([name, ref]).toEqual(['stageImage', { folder: REPO, id: 'chat_1' }])
    expect(Buffer.compare(bytes as Buffer, SWATCH)).toBe(0)
  })

  it('refuses an untrusted sender, an unknown key and a data URL before the manager', async () => {
    const state = rig(), request = REQUESTS[AGENT_CHAT_CHANNELS.stageImage]
    const untrusted = { sender: {}, senderFrame: frame('https://example.com/') } as unknown as IpcMainInvokeEvent
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.stageImage, request, untrusted))).toBe('unauthorized')
    expect(state.refused).toEqual([AGENT_CHAT_CHANNELS.stageImage])
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.stageImage, { ...request, mime: 'image/png' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.stageImage, { ...request, data: `data:image/png;base64,${request.data as string}` }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.stageImage, { ...request, folder: '/elsewhere' }))).toBe('unauthorized')
    expect(state.calls).toEqual([])
  })

  it('answers the manager’s not_found for a chat that does not exist', async () => {
    const state = rig()
    vi.mocked(state.sessions.stageImage).mockRejectedValueOnce(new DomainError('not_found', 'The chat no longer exists.'))
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.stageImage, REQUESTS[AGENT_CHAT_CHANNELS.stageImage]))).toBe('not_found')
  })

  it('forwards a send’s image ids with its text, and leaves them out of a text-only send', async () => {
    const state = rig()
    await state.invoke(AGENT_CHAT_CHANNELS.send, { ...REQUESTS[AGENT_CHAT_CHANNELS.send], text: '', imageIds: [IMAGE.id] })
    await state.invoke(AGENT_CHAT_CHANNELS.send, REQUESTS[AGENT_CHAT_CHANNELS.send])
    expect(state.calls).toEqual([
      ['send', { folder: REPO, id: 'chat_1' }, { text: '', imageIds: [IMAGE.id] }],
      ['send', { folder: REPO, id: 'chat_1' }, { text: 'Hello' }]
    ])
  })
})

let harness: Harness | undefined
let userData: string | undefined
afterEach(() => {
  harness?.cleanup()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
  harness = userData = undefined
})

/** A saved epic with one ticket in a temp repository, its desktop workspace, and the app's chat and image stores. */
async function evidenceRig() {
  const h = harness = createHarness()
  const data = userData = mkdtempSync(join(tmpdir(), 'dm-evidence-'))
  const orchestrator = h.open('orchestrator')
  await orchestrator.initializeRepository({ name: 'evidence-repo' })
  const epic = await orchestrator.createEpic({ title: 'Sign-in' })
  const draft = await orchestrator.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'Fix the form' } }] })
  await orchestrator.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const ticketId = draft.refMap['one'] ?? ''
  const desktop = h.open('desktop', { transport: 'desktop' })
  const upload = vi.spyOn(desktop, 'uploadAttachment')
  const chatImages = createChatImages({ root: join(data, 'chat-images') })
  const store = createChatStore({ root: join(data, 'chats'), images: chatImages })
  const folder = h.root
  const handlers = createAgentChatHandlers({
    registry: { resolve: path => (path === folder ? folder : null) },
    sessions: {} as AgentChatSessions, confirmTerminalStop: async () => false, models: {} as OmpModels,
    evidence: { chats: store, chatImages, workspace: path => { expect(path).toBe(folder); return desktop } }
  })
  const listeners = new Map<string, Listener>()
  registerAgentChatIpc(guardIpc({ handle: (channel, listener) => void listeners.set(channel, listener) }, { appUrl: APP_URL }), handlers, event => event.sender)
  const attach = async (request: Record<string, unknown>) => (await listeners.get(AGENT_CHAT_CHANNELS.attachEvidence)!(TRUSTED, request)) as CommandResult<{ commentId: string; attachmentId: string }>
  const chat = (fields: Partial<ChatRecord> = {}): ChatRecord =>
    store.createChat({ folder, agent: 'omp', model: null, role: 'worker', allowSave: false, title: 'Sign-in review', ...fields })
  const image = async (owner: ChatRecord) => (await chatImages.put({ folder: owner.folder, chatId: owner.id }, SWATCH)).id
  const toolImage = async (owner: ChatRecord, bytes: Buffer) => (await chatImages.putToolImage({ folder: owner.folder, chatId: owner.id }, bytes)).id
  return { desktop, upload, folder, epicId: epic.id, ticketId, attach, chat, image, toolImage }
}

describe('agentChat:attachEvidence on a real folder workspace', () => {
  it('stores the image as one evidence attachment claimed by one comment on the bound ticket; a repeat returns that comment', async () => {
    const r = await evidenceRig()
    const bound = r.chat({ epicId: r.epicId })
    const imageId = await r.image(bound)
    const request = { folder: r.folder, chatId: bound.id, imageId, epicId: r.epicId, ticketId: r.ticketId }
    const first = await r.attach(request)
    expect(first).toEqual({ ok: true, data: { commentId: expect.stringMatching(/^cm_/), attachmentId: expect.stringMatching(/^im_/) } })
    // A repeat after it, and two at once, all answer the first comment and stage nothing more.
    expect(await r.attach(request)).toEqual(first)
    expect(await Promise.all([r.attach(request), r.attach(request)])).toEqual([first, first])
    expect(r.upload).toHaveBeenCalledTimes(1)
    if (!first.ok) throw new Error(first.error.message)
    const { commentId, attachmentId } = first.data
    const comments = await r.desktop.listComments({ epicId: r.epicId })
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      id: commentId, ticketId: r.ticketId, author: { role: 'desktop' }, body: `Evidence from Sign-in review (chat image ${imageId})`,
      attachments: [{ id: attachmentId, mime: 'image/png', width: 64, height: 64, bytes: SWATCH.length, label: `Chat image ${imageId}`, purpose: 'evidence' }]
    })
    expect(await r.desktop.getAttachment({ attachmentId, as: 'metadata' })).toMatchObject({ owner: { kind: 'comment', id: commentId } })
  })

  it('comments on the epic itself without a ticket, and accepts a chat bound before epicId by its transfer', async () => {
    const r = await evidenceRig()
    const legacy = r.chat({ transferEpicId: r.epicId })
    const imageId = await r.image(legacy)
    const attached = await r.attach({ folder: r.folder, chatId: legacy.id, imageId, epicId: r.epicId })
    expect(attached.ok).toBe(true)
    const [comment] = await r.desktop.listComments({ epicId: r.epicId })
    expect(comment).toMatchObject({ ticketId: null, attachments: [{ label: `Chat image ${imageId}`, purpose: 'evidence' }] })
  })
})

describe('agentChat:attachEvidence refusals', () => {
  it('refuses an unbound epic, a project-less chat and another chat’s image, attaching nothing', async () => {
    const r = await evidenceRig()
    const bound = r.chat({ epicId: r.epicId })
    const elsewhere = r.chat({ epicId: 'ep_other' })
    const unbound = r.chat()
    const projectless = r.chat({ folder: null, epicId: r.epicId })
    const foreign = await r.image(elsewhere)
    const ask = (chat: ChatRecord, imageId: string) => r.attach({ folder: r.folder, chatId: chat.id, imageId, epicId: r.epicId, ticketId: r.ticketId })
    expect(codeOf(await ask(elsewhere, foreign))).toBe('unauthorized')
    expect(codeOf(await ask(unbound, await r.image(unbound)))).toBe('unauthorized')
    // A project-less chat is in no folder: named with this one it is not found, and a null folder is no request.
    expect(codeOf(await ask(projectless, await r.image(projectless)))).toBe('unauthorized')
    expect(codeOf(await r.attach({ folder: null, chatId: projectless.id, imageId: foreign, epicId: r.epicId }))).toBe('invalid_input')
    expect(codeOf(await ask(bound, foreign))).toBe('not_found')
    expect(r.upload).not.toHaveBeenCalled()
    expect(await r.desktop.listComments({ epicId: r.epicId })).toEqual([])
  })

  it('refuses a WebP tool image as invalid_input before staging anything', async () => {
    const r = await evidenceRig()
    const bound = r.chat({ epicId: r.epicId })
    const webp = await r.toolImage(bound, webpBytes(64, 64))
    const refused = await r.attach({ folder: r.folder, chatId: bound.id, imageId: webp, epicId: r.epicId, ticketId: r.ticketId })
    expect(refused).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid_input', message: 'Only PNG and JPEG images can be attached as evidence; this one is WebP.' }) })
    expect(r.upload).not.toHaveBeenCalled()
    expect(await r.desktop.listComments({ epicId: r.epicId })).toEqual([])
  })
})

describe('agent chat push', () => {
  function window(): ChatWindow & { sent: unknown[][] } {
    const sent: unknown[][] = []
    return { sent, isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, ...args) => { sent.push([channel, ...args]) } } }
  }

  it('sends validated events on agentChat:event and drops anything else', () => {
    const open = window()
    const push = createAgentChatPush(() => [open])
    const event: AgentChatEvent = { type: 'status', folder: REPO, chatId: 'chat_1', status: 'idle' }
    push(event)
    push({ ...event, raw: '{"type":"system"}' } as unknown as AgentChatEvent)
    push({ type: 'line', folder: REPO, chatId: 'chat_1', text: 'raw CLI line' } as unknown as AgentChatEvent)
    expect(open.sent).toEqual([[AGENT_CHAT_CHANNELS.event, event]])
  })
})
