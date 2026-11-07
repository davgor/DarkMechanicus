/**
 * The behavior behind the `chats:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Every argument arrives from the renderer and is untrusted: it is validated
 * here, folders must be tracked and still lead to the folder that was tracked (one replaced by a
 * symlink to another directory is refused before any chat is looked up), and requests are strict
 * objects, so a renderer can name chats, agent ids, models, roles and titles but never an executable
 * or MCP arguments. Agent ids are checked against the agent registry (`not_found` for one that is not
 * connected) before anything runs. Answers are `CommandResult`s, like `dm:command`, so the UI gets the
 * error code and message.
 */
import { z } from 'zod'
import { DomainError, toErrorShape } from '../../core/errors'
import { commentBody, LIMITS, parseInput, stableId } from '../../core/schemas'
import { CHAT_ROLES, chatIdSchema, type ChatRecord } from '../../shared/agents/chat'
import type {
  BoundThread,
  ChatPushEvent,
  ChatReadView,
  KickBackKanbanCardResult,
  StartKanbanCardResult,
  StartOrchestratorResult,
  StartTransferChatResult,
  SubmitPromptResult
} from '../../shared/agents/chatApi'
import { agentIdSchema } from '../../shared/desktop/agentKinds'
import type { CommandResult } from '../../shared/desktop/api'
import { connectedAgent } from '../desktop/agentHandlers'
import type { AgentRegistry } from '../desktop/agentRegistry'
import type { FolderRegistry } from '../desktop/folderRegistry'
import { kickBackKanbanCard, startKanbanCard, type KanbanCards } from '../kanban/startKanbanCard'
import type { BoundTarget } from './boundThreads'
import type { ChatRecords } from './chatRecords'
import type { ChatRef } from './chatStore'
import { refuseSwappedFolder } from './launchFolder'
import { startOrchestratorRun, type OrchestratorRuns } from './orchestratorStart'
import { findTransferChat, startTransferChat, transferPrompt, type TransferReads } from './transferStart'
import type { TerminalSessions } from '../terminals/terminalSessions'

/** Windows long-path maximum; bounds path strings from the renderer. */
const MAX_PATH_LENGTH = 32_767
const MAX_MODEL_LENGTH = 200

/** A folder as the renderer names it; bounded by the Windows long-path maximum. */
export const folderSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const modelSchema = z.string().min(1).max(MAX_MODEL_LENGTH)
const refShape = { folder: folderSchema, chatId: chatIdSchema }

const createSchema = z.strictObject({
  folder: folderSchema,
  agent: agentIdSchema,
  role: z.enum(CHAT_ROLES),
  model: modelSchema.nullable().optional(),
  allowSave: z.boolean().optional(),
  title: z.string().max(LIMITS.title).optional()
})
/** Only an epic, an agent and its model, for an orchestrator or a transfer chat: the role, Allow save, title, kickoff message and what the chat records are decided in main. */
const startOrchestratorSchema = z.strictObject({
  folder: folderSchema,
  epicId: stableId,
  agent: agentIdSchema,
  model: modelSchema.nullable().optional()
})
const transferChatSchema = z.strictObject({ folder: folderSchema, epicId: stableId })
const refSchema = z.strictObject(refShape)
/** A whole id of the kind: a claim token (`<attempt id>.<secret>`) or any other text is not one. */
const attemptIdSchema = stableId.regex(/^at_/)
const runIdSchema = stableId.regex(/^rn_/)
const cardIdSchema = stableId.regex(/^kc_/)
/** An attempt or a run, never both and never anything else. */
const boundThreadsSchema = z.union([z.strictObject({ folder: folderSchema, attemptId: attemptIdSchema }), z.strictObject({ folder: folderSchema, runId: runIdSchema })])
/** Only a card, an agent and its model: the role, Allow save, title, kickoff and what the chat records are decided in main. */
const startKanbanCardSchema = z.strictObject({ folder: folderSchema, cardId: cardIdSchema, agent: agentIdSchema, model: modelSchema.nullable().optional() })
const kickBackKanbanCardSchema = z.strictObject({ folder: folderSchema, cardId: cardIdSchema, comment: commentBody })
const renameSchema = z.strictObject({ ...refShape, title: z.string().trim().min(1).max(LIMITS.title) })
const promptSchema = z.strictObject({ ...refShape, text: z.string().min(1).max(65_536).refine((text) => text.trim().length > 0, 'Prompt must not be blank') })

/** Finds the id of the chat of a (canonical) folder that an attempt or a run is bound to by grant; null when none is. */
export type BoundTerminalLookup = (folder: string, target: BoundTarget) => Promise<string | null>

interface ChatHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  /** The connected agents; a request naming any other agent is refused before anything runs. */
  agents: Pick<AgentRegistry, 'get'>
  /** The chat records; deleting a chat through them also ends its terminal (`endingTerminals`). */
  chats: ChatRecords
  /** The chat terminals: Start run and Play start their chat's terminal before they answer; Kick back pastes into the card's. */
  terminals: Pick<TerminalSessions, 'start' | 'paste'>
  /** The desktop's run commands, for starting an orchestrator. */
  runs: OrchestratorRuns
  /** The desktop's transfer reads, for starting a transfer chat and for its prompt. */
  transfers: TransferReads
  /** The desktop's Kanban commands, for Play and Kick back. */
  kanban: KanbanCards
  /** The threads of old chats bound to an attempt or a run among the chats of a (canonical) folder; without it nothing is bound. */
  boundThreads?: (folder: string, target: BoundTarget) => BoundThread[]
  /** The chat of a (canonical) folder an attempt or a run is bound to by grant (`grantBindings.ts`); without it none is. */
  boundTerminal?: BoundTerminalLookup
  /** Told that a chat was created, renamed or deleted, so every window can list the folder's chats again; without it nothing is pushed. */
  push?: (event: ChatPushEvent) => void
  /** Told about failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface ChatHandlers {
  list(folder: unknown): Promise<CommandResult<ChatRecord[]>>
  create(request: unknown): Promise<CommandResult<ChatRecord>>
  startOrchestrator(request: unknown): Promise<CommandResult<StartOrchestratorResult>>
  startTransferChat(request: unknown): Promise<CommandResult<StartTransferChatResult>>
  startKanbanCard(request: unknown): Promise<CommandResult<StartKanbanCardResult>>
  kickBackKanbanCard(request: unknown): Promise<CommandResult<KickBackKanbanCardResult>>
  findTransferChat(request: unknown): Promise<CommandResult<ChatRecord | null>>
  transferPrompt(request: unknown): Promise<CommandResult<string>>
  /** The chat and its stored transcript, read-only: nothing is started or stored. */
  read(request: unknown): Promise<CommandResult<ChatReadView>>
  boundThreads(request: unknown): Promise<CommandResult<BoundThread[]>>
  /** The id of the chat whose terminal the attempt or run is bound to by grant, or null. */
  boundTerminal(request: unknown): Promise<CommandResult<string | null>>
  rename(request: unknown): Promise<CommandResult<ChatRecord>>
  submitPrompt(request: unknown): Promise<CommandResult<SubmitPromptResult>>
  delete(request: unknown): Promise<CommandResult<null>>
}

/** The canonical path of a tracked folder; anything else is unauthorized, with a refusal naming the folder like `launchFolder`'s. */
function trackedFolder(deps: Pick<ChatHandlerDeps, 'registry'>, folder: string): string {
  const tracked = deps.registry.resolve(folder)
  if (tracked === null) {
    throw new DomainError(
      'unauthorized',
      `The folder ${folder} is not tracked by Dark Mechanicus. Track the folder again to keep using this chat.`
    )
  }
  return tracked
}

/**
 * A tracked folder's canonical path, as its chats are stored under it; an untracked one is unauthorized, and one
 * replaced by a symlink to another directory is refused (`refuseSwappedFolder`), before any chat is looked up.
 */
export function chatFolder(deps: Pick<ChatHandlerDeps, 'registry'>, folder: string): string {
  const tracked = trackedFolder(deps, folder)
  refuseSwappedFolder(tracked)
  return tracked
}

/** Validates a request naming one chat and resolves its folder; returns the chat ref and the rest. */
function chatRequest<T extends { folder: string; chatId: string }>(deps: ChatHandlerDeps, schema: z.ZodType<T>, input: unknown): { ref: ChatRef; request: T } {
  const request = parseInput(schema, input, 'chat request')
  return { ref: { folder: chatFolder(deps, request.folder), id: request.chatId }, request }
}

/** Validates the request and the folder before anything is queued; see `startOrchestratorRun` for what happens after. */
async function startOrchestrator(deps: ChatHandlerDeps, input: unknown): Promise<StartOrchestratorResult> {
  const request = parseInput(startOrchestratorSchema, input, 'orchestrator request')
  connectedAgent(deps.agents, request.agent)
  const folder = chatFolder(deps, request.folder)
  const { runs, chats, terminals, onUnexpectedError } = deps
  const started = await startOrchestratorRun({ runs, chats, terminals, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder })
  if (started.chat !== null) {
    chatsChanged(deps, { folder: started.chat.folder, id: started.chat.id })
  }
  return started
}

/** Validates the request and the folder before the transfer is read; see `startTransferChat` for what happens after. */
async function startTransfer(deps: ChatHandlerDeps, input: unknown): Promise<StartTransferChatResult> {
  const request = parseInput(startOrchestratorSchema, input, 'transfer chat request')
  connectedAgent(deps.agents, request.agent)
  const folder = chatFolder(deps, request.folder)
  const { transfers, chats, terminals, onUnexpectedError } = deps
  const started = await startTransferChat({ transfers, chats, terminals, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder })
  if (started.chat !== null) {
    chatsChanged(deps, { folder: started.chat.folder, id: started.chat.id })
  }
  return started
}

/** Validates the request, the agent and the folder before the card is played; see `startKanbanCard` for what happens after. */
async function startCard(deps: ChatHandlerDeps, input: unknown): Promise<StartKanbanCardResult> {
  const request = parseInput(startKanbanCardSchema, input, 'Kanban card request')
  connectedAgent(deps.agents, request.agent)
  const folder = chatFolder(deps, request.folder)
  const { kanban, chats, terminals, onUnexpectedError } = deps
  const started = await startKanbanCard({ cards: kanban, chats, terminals, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder })
  if (started.chat !== null) {
    chatsChanged(deps, { folder: started.chat.folder, id: started.chat.id })
  }
  return started
}

/** Validates the request and the folder before the card is kicked back; see `kickBackKanbanCard` for what happens after. */
function kickBackCard(deps: ChatHandlerDeps, input: unknown): Promise<KickBackKanbanCardResult> {
  const request = parseInput(kickBackKanbanCardSchema, input, 'Kanban kick-back request')
  const { kanban, chats, terminals, onUnexpectedError } = deps
  return kickBackKanbanCard({ cards: kanban, chats, terminals, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder: chatFolder(deps, request.folder) })
}

/** A transfer request, validated, with the canonical path of its tracked folder. */
function transferRequest(deps: ChatHandlerDeps, input: unknown): { folder: string; epicId: string } {
  const request = parseInput(transferChatSchema, input, 'transfer request')
  return { folder: chatFolder(deps, request.folder), epicId: request.epicId }
}

/** The attempt or run a request names, and its tracked folder's canonical path. */
function boundRequest(deps: ChatHandlerDeps, input: unknown): { folder: string; target: BoundTarget } {
  const request = parseInput(boundThreadsSchema, input, 'bound threads request')
  const folder = chatFolder(deps, request.folder)
  return { folder, target: 'attemptId' in request ? { attemptId: request.attemptId } : { runId: request.runId } }
}

/** Runs `action` as a `CommandResult`; failures that are not DomainErrors are reported to `onUnexpectedError` too. */
export async function answer<T>(deps: Pick<ChatHandlerDeps, 'onUnexpectedError'>, action: () => T | Promise<T>): Promise<CommandResult<T>> {
  try {
    return { ok: true, data: await action() }
  } catch (error) {
    if (!(error instanceof DomainError)) {
      deps.onUnexpectedError?.(error)
    }
    return { ok: false, error: toErrorShape(error) }
  }
}

/** Tells every window that the chat was created, renamed or deleted in its (canonical) folder. */
function chatsChanged(deps: ChatHandlerDeps, chat: ChatRef): void {
  deps.push?.({ type: 'chats_changed', folder: chat.folder, chatId: chat.id })
}

function createChat(deps: ChatHandlerDeps, input: unknown): ChatRecord {
  const request = parseInput(createSchema, input, 'new chat')
  connectedAgent(deps.agents, request.agent)
  const chat = deps.chats.createChat({ ...request, folder: chatFolder(deps, request.folder) })
  chatsChanged(deps, { folder: chat.folder, id: chat.id })
  return chat
}

function renameChat(deps: ChatHandlerDeps, input: unknown): ChatRecord {
  const { ref, request } = chatRequest(deps, renameSchema, input)
  const chat = deps.chats.renameChat(ref, request.title)
  chatsChanged(deps, ref)
  return chat
}

/** Only this explicit submission supplies a question; PTY bytes and automated pastes never name a chat. */
async function submitPrompt(deps: ChatHandlerDeps, input: unknown): Promise<SubmitPromptResult> {
  const { ref, request } = chatRequest(deps, promptSchema, input)
  deps.chats.readChat(ref)
  const result = await deps.terminals.paste(ref, request.text)
  if (result.state !== 'running') return { problem: result.message }
  // Naming is incidental: a title write failure must not turn an already queued prompt into a failed send.
  try {
    if (deps.chats.nameFromQuestion(ref, request.text) !== null) chatsChanged(deps, ref)
  } catch (error) {
    deps.onUnexpectedError?.(error)
  }
  return { problem: null }
}

async function deleteChat(deps: ChatHandlerDeps, input: unknown): Promise<null> {
  const { ref } = chatRequest(deps, refSchema, input)
  await deps.chats.deleteChat(ref)
  chatsChanged(deps, ref)
  return null
}

export function createChatHandlers(deps: ChatHandlerDeps): ChatHandlers {
  const { chats } = deps
  return {
    list: (folder) => answer(deps, () => chats.listChats(chatFolder(deps, parseInput(folderSchema, folder, 'folder')))),
    create: (input) => answer(deps, () => createChat(deps, input)),
    submitPrompt: (input) => answer(deps, () => submitPrompt(deps, input)),
    startOrchestrator: (input) => answer(deps, () => startOrchestrator(deps, input)),
    startTransferChat: (input) => answer(deps, () => startTransfer(deps, input)),
    startKanbanCard: (input) => answer(deps, () => startCard(deps, input)),
    kickBackKanbanCard: (input) => answer(deps, () => kickBackCard(deps, input)),
    findTransferChat: (input) =>
      answer(deps, () => {
        const { folder, epicId } = transferRequest(deps, input)
        return findTransferChat(chats, folder, epicId)
      }),
    transferPrompt: (input) =>
      answer(deps, () => {
        const { folder, epicId } = transferRequest(deps, input)
        return transferPrompt(deps.transfers, folder, epicId)
      }),
    read: (input) => answer(deps, () => chats.readChat(chatRequest(deps, refSchema, input).ref)),
    // The request and the folder are validated even when the app wired no lookup.
    boundThreads: (input) =>
      answer(deps, () => {
        const { folder, target } = boundRequest(deps, input)
        return deps.boundThreads?.(folder, target) ?? []
      }),
    boundTerminal: (input) =>
      answer(deps, async () => {
        const { folder, target } = boundRequest(deps, input)
        return (await deps.boundTerminal?.(folder, target)) ?? null
      }),
    rename: (input) => answer(deps, () => renameChat(deps, input)),
    delete: (input) => answer(deps, () => deleteChat(deps, input))
  }
}
