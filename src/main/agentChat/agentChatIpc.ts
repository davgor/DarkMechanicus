/**
 * The `agentChat:*` IPC channels behind `window.dm.agentChat`: each takes one untrusted payload, validated by the
 * strict contract schemas (`shared/agents/agentChat.ts`), resolves the chat's folder through the folder registry
 * (`chatFolder`), and answers a `CommandResult`. The renderer names a chat (or, for `models`, an agent) and nothing
 * else: never an executable, arguments, a cwd, an environment, or a confirmation. Stopping a live terminal for
 * `setSurface` is confirmed only by the Main-owned native dialog of that one request. `attachEvidence` turns one of a
 * folder chat's own images into an evidence comment on the epic the chat is bound to, through the folder's desktop
 * workspace (the desktop's own `uploadAttachment`, decision 0006). Events reach the window on `agentChat:event`,
 * validated.
 * Register through the sender guard (`guardIpc`), like every other channel.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import {
  AGENT_CHAT_CHANNELS,
  agentChatAnswerSchema,
  agentChatAttachEvidenceSchema,
  agentChatAttentionSchema,
  agentChatEventSchema,
  agentChatInterruptSchema,
  agentChatModelsSchema,
  agentChatSendSchema,
  agentChatSetSurfaceSchema,
  agentChatSnapshotRequestSchema,
  agentChatStageImageSchema,
  agentChatStartSchema,
  agentChatStopSchema,
  type AgentChatEvent,
  type AgentChatSnapshot,
  type AttentionItem
} from '../../shared/agents/agentChat'
import type { ChatImageRef, ChatRecord } from '../../shared/agents/chat'
import type { CommandApi } from '../../shared/domain/api'
import type { ChatModelOption } from '../../shared/agents/models'
import type { CommandResult } from '../../shared/desktop/api'
import { answer, chatFolder } from '../agents/chatHandlers'
import { sendToWindows, type ChatWindow } from '../agents/chatIpc'
import type { ChatRef, ChatStore } from '../agents/chatStore'
import type { FolderRegistry } from '../desktop/folderRegistry'
import type { AgentChatSessions } from './agentChatSessions'
import type { ChatImages } from './chatImages'
import type { OmpModels } from './ompModels'

/** The folder workspace commands `attachEvidence` uses: the desktop's own workspace (`desktopWorkspace`). */
type EvidenceWorkspace = Pick<CommandApi, 'uploadAttachment' | 'addComment' | 'listComments' | 'getRun'>

/** What `attachEvidence` reads and writes: the chat records, the chats' images and the folder's desktop workspace. */
interface EvidenceDeps {
  chats: Pick<ChatStore, 'getChat'>
  chatImages: Pick<ChatImages, 'read'>
  workspace: (folder: string) => EvidenceWorkspace
}

/** The comment and image an evidence attach made, or the ones its first request made. */
interface AttachedEvidence {
  commentId: string
  attachmentId: string
}

interface AgentChatHandlerDeps<S> {
  registry: Pick<FolderRegistry, 'resolve'>
  sessions: Pick<AgentChatSessions, 'start' | 'send' | 'interrupt' | 'stop' | 'answer' | 'setSurface' | 'snapshot' | 'attention' | 'stageImage'>
  /** The native confirmation, modal to the window that sent the request (`nativeTerminalStopConfirmation`). */
  confirmTerminalStop: (sender: S, chat: ChatRecord) => Promise<boolean>
  /** Skitarii model catalogs (`ompModels.ts`). */
  models: Pick<OmpModels, 'chatModels' | 'catalogModels'>
  evidence: EvidenceDeps
  onUnexpectedError?: (error: unknown) => void
}

interface AgentChatHandlers<S> {
  start(input: unknown): Promise<CommandResult<AgentChatSnapshot>>
  send(input: unknown): Promise<CommandResult<null>>
  interrupt(input: unknown): Promise<CommandResult<null>>
  /** Ends the chat's GUI process; its transcript and record stay. */
  stop(input: unknown): Promise<CommandResult<null>>
  answer(input: unknown): Promise<CommandResult<null>>
  /** `sender` is the requesting window's contents, which the confirmation is modal to. */
  setSurface(sender: S, input: unknown): Promise<CommandResult<AgentChatSnapshot>>
  snapshot(input: unknown): Promise<CommandResult<AgentChatSnapshot>>
  attention(input: unknown): Promise<CommandResult<AttentionItem[]>>
  /** Keeps a PNG or JPEG the person staged for the chat; the bytes cross only as plain base64. */
  stageImage(input: unknown): Promise<CommandResult<{ image: ChatImageRef }>>
  /** Attaches one of a folder chat's images, as evidence, to a comment on the epic (or its ticket) the chat is bound to. */
  attachEvidence(input: unknown): Promise<CommandResult<AttachedEvidence>>
  models(input: unknown): Promise<CommandResult<ChatModelOption[]>>
}

/** Validates a request naming one chat and resolves its tracked folder (null for a project-less chat). */
function chatRequest<T extends { folder: string | null; chatId: string }>(registry: Pick<FolderRegistry, 'resolve'>, schema: z.ZodType<T>, input: unknown): { ref: ChatRef; request: T } {
  const request = parseInput(schema, input, 'agent chat request')
  return { ref: { folder: request.folder === null ? null : chatFolder({ registry }, request.folder), id: request.chatId }, request }
}

/**
 * Whether the chat record binds the chat to the epic: its `epicId`, or a binding chats stored before it, as the epic's
 * agent panel reads them (`epicChats`): the transfer's epic, the board conversation's epic, or its run's epic.
 */
async function boundToEpic(chat: ChatRecord, epicId: string, workspace: EvidenceWorkspace): Promise<boolean> {
  if (chat.epicId === epicId || chat.transferEpicId === epicId) return true
  if (chat.conversation !== undefined && 'epicId' in chat.conversation && chat.conversation.epicId === epicId) return true
  return chat.runId !== undefined && (await workspace.getRun({ runId: chat.runId }))?.epicId === epicId
}

/**
 * Stages the chat image as an evidence attachment and claims it with one comment on the target, keyed so a repeat
 * returns the first comment. A repeat finds that comment before staging anything: the key alone would refuse it, as
 * the repeat's fresh attachment id makes it a different request.
 */
async function attachChatImage(
  workspace: EvidenceWorkspace,
  chat: ChatRecord,
  request: { imageId: string; epicId: string; ticketId?: string },
  bytes: Uint8Array
): Promise<AttachedEvidence> {
  const { imageId, epicId, ticketId } = request
  const label = `Chat image ${imageId}`
  const target = { epicId, ...(ticketId === undefined ? {} : { ticketId }) }
  for (const comment of await workspace.listComments(target)) {
    if (comment.ticketId !== (ticketId ?? null) || comment.author.role !== 'desktop') continue
    const image = comment.attachments?.find(attached => attached.label === label && attached.purpose === 'evidence')
    if (image !== undefined) return { commentId: comment.id, attachmentId: image.id }
  }
  const staged = await workspace.uploadAttachment({ data: Buffer.from(bytes).toString('base64'), label, purpose: 'evidence' })
  const comment = await workspace.addComment({
    ...target, body: `Evidence from ${chat.title} (chat image ${imageId})`, attachments: [staged.id],
    idempotencyKey: `chat-image-${imageId}-${ticketId ?? epicId}`
  })
  return { commentId: comment.id, attachmentId: staged.id }
}

/**
 * The `attachEvidence` request: the chat must be one of the folder's chats bound to the epic (else `unauthorized`), and
 * the image one of that chat's own (else `not_found`) and a PNG or JPEG, as attachments are (else `invalid_input`, before
 * anything is staged). Attaches of one image to one target run one after another, so a repeat finds the first one's
 * comment.
 */
function evidenceAttacher(registry: Pick<FolderRegistry, 'resolve'>, evidence: EvidenceDeps): (input: unknown) => Promise<AttachedEvidence> {
  const attaching = new Map<string, Promise<unknown>>()
  return async (input) => {
    const request = parseInput(agentChatAttachEvidenceSchema, input, 'agent chat evidence request')
    const folder = chatFolder({ registry }, request.folder)
    const workspace = evidence.workspace(folder)
    // A project-less chat is not in any folder's records, so naming it with a folder finds nothing.
    const chat = evidence.chats.getChat({ folder, id: request.chatId })
    if (chat === null || !(await boundToEpic(chat, request.epicId, workspace))) {
      throw new DomainError('unauthorized', 'That chat is not bound to this epic.')
    }
    const image = await evidence.chatImages.read({ folder, chatId: chat.id }, request.imageId)
    if (image === null) throw new DomainError('not_found', 'That image is not in this chat.')
    if (image.mime === 'image/webp') throw new DomainError('invalid_input', 'Only PNG and JPEG images can be attached as evidence; this one is WebP.')
    const key = JSON.stringify([folder, chat.id, request.imageId, request.ticketId ?? request.epicId])
    const attach = (attaching.get(key) ?? Promise.resolve()).catch(() => undefined)
      .then(() => attachChatImage(workspace, chat, request, image.bytes))
    attaching.set(key, attach)
    try {
      return await attach
    } finally {
      if (attaching.get(key) === attach) attaching.delete(key)
    }
  }
}

export function createAgentChatHandlers<S>(deps: AgentChatHandlerDeps<S>): AgentChatHandlers<S> {
  const { registry, sessions } = deps
  const attachEvidence = evidenceAttacher(registry, deps.evidence)
  return {
    start: input => answer(deps, async () => {
      const result = await sessions.start(chatRequest(registry, agentChatStartSchema, input).ref)
      if ('code' in result) throw new DomainError('busy_elsewhere', 'The chat is running in its terminal.')
      return result
    }),
    send: input => answer(deps, async () => {
      const { ref, request } = chatRequest(registry, agentChatSendSchema, input)
      await sessions.send(ref, { text: request.text, ...(request.imageIds === undefined ? {} : { imageIds: request.imageIds }) })
      return null
    }),
    interrupt: input => answer(deps, async () => {
      await sessions.interrupt(chatRequest(registry, agentChatInterruptSchema, input).ref)
      return null
    }),
    stop: input => answer(deps, async () => {
      await sessions.stop(chatRequest(registry, agentChatStopSchema, input).ref)
      return null
    }),
    answer: input => answer(deps, async () => {
      const { ref, request } = chatRequest(registry, agentChatAnswerSchema, input)
      const { promptId, text } = request
      const choice = 'optionIds' in request ? { optionIds: request.optionIds } : { optionId: request.optionId }
      await sessions.answer(ref, { promptId, ...choice, ...(text === undefined ? {} : { text }) })
      return null
    }),
    // The only call that passes a confirmation: an explicit request from the app window, answered in that window.
    setSurface: (sender, input) => answer(deps, () => {
      const { ref, request } = chatRequest(registry, agentChatSetSurfaceSchema, input)
      return sessions.setSurface(ref, request.surface, chat => deps.confirmTerminalStop(sender, chat))
    }),
    snapshot: input => answer(deps, () => sessions.snapshot(chatRequest(registry, agentChatSnapshotRequestSchema, input).ref)),
    attention: input => answer(deps, () => {
      const { folder } = parseInput(agentChatAttentionSchema, input, 'agent chat attention request')
      return sessions.attention(folder === null ? null : chatFolder({ registry }, folder))
    }),
    stageImage: input => answer(deps, async () => {
      const { ref, request } = chatRequest(registry, agentChatStageImageSchema, input)
      return { image: await sessions.stageImage(ref, Buffer.from(request.data, 'base64')) }
    }),
    attachEvidence: input => answer(deps, () => attachEvidence(input)),
    models: input => answer(deps, () => {
      const request = parseInput(agentChatModelsSchema, input, 'agent chat models request')
      const folder = request.folder === null ? null : chatFolder({ registry }, request.folder)
      const options = { refresh: request.refresh === true }
      return 'chatId' in request ? deps.models.chatModels({ folder, id: request.chatId }, options) : deps.models.catalogModels(request.agentId, options)
    })
  }
}

export function registerAgentChatIpc<S>(ipcMain: Pick<IpcMain, 'handle'>, handlers: AgentChatHandlers<S>, senderOf: (event: IpcMainInvokeEvent) => S): void {
  ipcMain.handle(AGENT_CHAT_CHANNELS.start, (_event, request: unknown) => handlers.start(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.send, (_event, request: unknown) => handlers.send(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.interrupt, (_event, request: unknown) => handlers.interrupt(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.stop, (_event, request: unknown) => handlers.stop(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.answer, (_event, request: unknown) => handlers.answer(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.setSurface, (event, request: unknown) => handlers.setSurface(senderOf(event), request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.snapshot, (_event, request: unknown) => handlers.snapshot(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.attention, (_event, request: unknown) => handlers.attention(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.stageImage, (_event, request: unknown) => handlers.stageImage(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.attachEvidence, (_event, request: unknown) => handlers.attachEvidence(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.models, (_event, request: unknown) => handlers.models(request))
}

/** Sends each validated agent chat event to every open window on `agentChat:event`; anything else is dropped. */
export function createAgentChatPush(windows: () => readonly ChatWindow[]): (event: AgentChatEvent) => void {
  return (event) => {
    const parsed = agentChatEventSchema.safeParse(event)
    if (parsed.success) sendToWindows(windows(), AGENT_CHAT_CHANNELS.event, parsed.data)
  }
}
