/**
 * The `agentChat:*` IPC channels behind `window.dm.agentChat`: each takes one untrusted payload, validated by the
 * strict contract schemas (`shared/agents/agentChat.ts`), resolves the chat's folder through the folder registry
 * (`chatFolder`), and answers a `CommandResult`. The renderer names a chat (or, for `models`, an agent; for `setModel`,
 * one model and effort of the chat's own catalog) and nothing else: never an executable, arguments, a cwd, an
 * environment, or a confirmation. Stopping a live terminal for
 * `setSurface` is confirmed only by the Main-owned native dialog of that one request. Events reach the window on
 * `agentChat:event`, validated.
 * Register through the sender guard (`guardIpc`), like every other channel.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import {
  AGENT_CHAT_CHANNELS,
  agentChatAnswerSchema,
  agentChatAttentionSchema,
  agentChatEventSchema,
  agentChatInterruptSchema,
  agentChatModelsSchema,
  agentChatSendSchema,
  agentChatSetModelSchema,
  agentChatSetSurfaceSchema,
  agentChatSnapshotRequestSchema,
  agentChatStartSchema,
  type AgentChatEvent,
  type AgentChatSnapshot,
  type AttentionItem
} from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatModelOption } from '../../shared/agents/models'
import type { CommandResult } from '../../shared/desktop/api'
import { answer, chatFolder } from '../agents/chatHandlers'
import { sendToWindows, type ChatWindow } from '../agents/chatIpc'
import type { ChatRef } from '../agents/chatStore'
import type { FolderRegistry } from '../desktop/folderRegistry'
import type { AgentChatSessions } from './agentChatSessions'
import type { OmpModels } from './ompModels'

interface AgentChatHandlerDeps<S> {
  registry: Pick<FolderRegistry, 'resolve'>
  sessions: Pick<AgentChatSessions, 'start' | 'send' | 'interrupt' | 'answer' | 'setSurface' | 'snapshot' | 'attention' | 'setModel'>
  /** The native confirmation, modal to the window that sent the request (`nativeTerminalStopConfirmation`). */
  confirmTerminalStop: (sender: S, chat: ChatRecord) => Promise<boolean>
  /** Skitarii model catalogs (`ompModels.ts`). */
  models: Pick<OmpModels, 'chatModels' | 'catalogModels'>
  onUnexpectedError?: (error: unknown) => void
}

interface AgentChatHandlers<S> {
  start(input: unknown): Promise<CommandResult<AgentChatSnapshot>>
  send(input: unknown): Promise<CommandResult<null>>
  interrupt(input: unknown): Promise<CommandResult<null>>
  answer(input: unknown): Promise<CommandResult<null>>
  /** `sender` is the requesting window's contents, which the confirmation is modal to. */
  setSurface(sender: S, input: unknown): Promise<CommandResult<AgentChatSnapshot>>
  snapshot(input: unknown): Promise<CommandResult<AgentChatSnapshot>>
  attention(input: unknown): Promise<CommandResult<AttentionItem[]>>
  models(input: unknown): Promise<CommandResult<ChatModelOption[]>>
  setModel(input: unknown): Promise<CommandResult<AgentChatSnapshot>>
}

/** Validates a request naming one chat and resolves its tracked folder (null for a project-less chat). */
function chatRequest<T extends { folder: string | null; chatId: string }>(registry: Pick<FolderRegistry, 'resolve'>, schema: z.ZodType<T>, input: unknown): { ref: ChatRef; request: T } {
  const request = parseInput(schema, input, 'agent chat request')
  return { ref: { folder: request.folder === null ? null : chatFolder({ registry }, request.folder), id: request.chatId }, request }
}

export function createAgentChatHandlers<S>(deps: AgentChatHandlerDeps<S>): AgentChatHandlers<S> {
  const { registry, sessions } = deps
  return {
    start: input => answer(deps, async () => {
      const result = await sessions.start(chatRequest(registry, agentChatStartSchema, input).ref)
      if ('code' in result) throw new DomainError('busy_elsewhere', 'The chat is running in its terminal.')
      return result
    }),
    send: input => answer(deps, async () => {
      const { ref, request } = chatRequest(registry, agentChatSendSchema, input)
      await sessions.send(ref, { text: request.text })
      return null
    }),
    interrupt: input => answer(deps, async () => {
      await sessions.interrupt(chatRequest(registry, agentChatInterruptSchema, input).ref)
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
    models: input => answer(deps, () => {
      const request = parseInput(agentChatModelsSchema, input, 'agent chat models request')
      const folder = request.folder === null ? null : chatFolder({ registry }, request.folder)
      const options = { refresh: request.refresh === true }
      return 'chatId' in request ? deps.models.chatModels({ folder, id: request.chatId }, options) : deps.models.catalogModels(request.agentId, options)
    }),
    // The catalog is the chat's current one, asked only after main knows the chat is a Skitarii chat.
    setModel: input => answer(deps, () => {
      const { ref, request } = chatRequest(registry, agentChatSetModelSchema, input)
      const { provider, modelId, effort } = request
      return sessions.setModel(ref, { provider, modelId, ...(effort === undefined ? {} : { effort }) }, () => deps.models.chatModels(ref))
    })
  }
}

export function registerAgentChatIpc<S>(ipcMain: Pick<IpcMain, 'handle'>, handlers: AgentChatHandlers<S>, senderOf: (event: IpcMainInvokeEvent) => S): void {
  ipcMain.handle(AGENT_CHAT_CHANNELS.start, (_event, request: unknown) => handlers.start(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.send, (_event, request: unknown) => handlers.send(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.interrupt, (_event, request: unknown) => handlers.interrupt(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.answer, (_event, request: unknown) => handlers.answer(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.setSurface, (event, request: unknown) => handlers.setSurface(senderOf(event), request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.snapshot, (_event, request: unknown) => handlers.snapshot(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.attention, (_event, request: unknown) => handlers.attention(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.models, (_event, request: unknown) => handlers.models(request))
  ipcMain.handle(AGENT_CHAT_CHANNELS.setModel, (_event, request: unknown) => handlers.setModel(request))
}

/** Sends each validated agent chat event to every open window on `agentChat:event`; anything else is dropped. */
export function createAgentChatPush(windows: () => readonly ChatWindow[]): (event: AgentChatEvent) => void {
  return (event) => {
    const parsed = agentChatEventSchema.safeParse(event)
    if (parsed.success) sendToWindows(windows(), AGENT_CHAT_CHANNELS.event, parsed.data)
  }
}
