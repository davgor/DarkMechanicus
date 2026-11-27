/**
 * The behavior behind the `chats:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Every argument arrives from the renderer and is untrusted: it is validated
 * here, folders must be tracked and still lead to the folder that was tracked (one replaced by a
 * symlink to another directory is refused before any chat is looked up), and requests are strict
 * objects, so a renderer can name chats, agent ids, models, roles and titles but never an executable
 * or MCP arguments. Agent ids are checked against the agent registry (`not_found` for one that is not
 * connected) before anything runs. Answers are `CommandResult`s, like `dm:command`, so the UI gets the
 * error code and message.
 *
 * A project-less chat (`folder` null) is named by a null folder in the requests about one chat (read, rename,
 * delete) and created by `create` with a null folder and no role or Allow save: it is an orchestrator that may save,
 * as the person decided project-less chats are. Every other request needs a tracked folder.
 */
import { z } from 'zod'
import { boardContextText, type BoardContextBody } from '../../../resources/skitarii/extension/contextDelivery'
import { DomainError, toErrorShape } from '../../core/errors'
import { attachmentRef, commentBody, LIMITS, parseInput, stableId } from '../../core/schemas'
import { CHAT_ROLES, chatIdSchema, thinkingLevelSchema, type ChatRecord } from '../../shared/agents/chat'
import type {
  BoundThread,
  ChatPushEvent,
  ChatReadView,
  ConversationStateResult,
  KickBackKanbanCardResult,
  SendConversationResult,
  StartKanbanCardResult,
  StartOrchestratorResult,
  StartPlannerResult,
  StartTransferChatResult
} from '../../shared/agents/chatApi'
import { agentIdSchema } from '../../shared/desktop/agentKinds'
import type { AgentId, CommandResult } from '../../shared/desktop/api'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import type { KanbanMessageView } from '../../shared/domain/kanban'
import type { CommentView } from '../../shared/domain/views'
import { connectedAgent } from '../desktop/agentHandlers'
import type { AgentRegistry } from '../desktop/agentRegistry'
import type { FolderRegistry } from '../desktop/folderRegistry'
import { kickBackKanbanCard, startKanbanCard, type KanbanCards } from '../kanban/startKanbanCard'
import type { ConversationDeliveries } from './conversationDeliveries'
import type { AgentContextDelivery } from './agentContextDelivery'
import { boardMessage, freshKickoff, type BoardMessageInput, type ConversationHistoryEntry } from './conversationMessage'
import { resolveConversationChat, type ConversationReads, type ResolvedConversationChat } from './conversationTarget'
import type { BoundTarget } from './boundThreads'
import type { ChatRecords } from './chatRecords'
import { byRecency, type ChatRef } from './chatStore'
import { refuseSwappedFolder } from './launchFolder'
import { startOrchestratorRun, type OrchestratorRuns } from './orchestratorStart'
import type { WorkerCatalog } from './workerCatalog'
import { findTransferChat, startTransferChat, transferPrompt, type TransferReads } from './transferStart'
import { startPlannerChat, type PlannerAgents } from './plannerStart'
import { startChatOnSurface } from './chatSurfaceStart'
import type { AgentChatSessions } from '../agentChat/agentChatSessions'
import type { OmpModels } from '../agentChat/ompModels'
import { checkModelChoice } from './modelChoice'
import type { TerminalSessions, TerminalStart } from '../terminals/terminalSessions'

/** Windows long-path maximum; bounds path strings from the renderer. */
const MAX_PATH_LENGTH = 32_767
const MAX_MODEL_LENGTH = 200

/** A folder as the renderer names it; bounded by the Windows long-path maximum. */
export const folderSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const modelSchema = z.string().min(1).max(MAX_MODEL_LENGTH)
/** A Skitarii chat's thinking level, one of OMP's own words; `checkModelChoice` checks it against the model. */
const thinkingSchema = thinkingLevelSchema.nullable().optional()
const refShape = { folder: folderSchema.nullable(), chatId: chatIdSchema }
const firstPromptSchema = z.string().min(1).max(32_000).refine((text) => text.trim().length > 0, 'First prompt must not be blank').optional()

const createSchema = z.strictObject({
  folder: folderSchema,
  agent: agentIdSchema,
  role: z.enum(CHAT_ROLES),
  model: modelSchema.nullable().optional(),
  thinking: thinkingSchema,
  allowSave: z.boolean().optional(),
  title: z.string().max(LIMITS.title).optional(),
  firstPrompt: firstPromptSchema
})
/** A project-less chat: no folder, and no role or Allow save, which main decides. */
const summonSchema = z.strictObject({
  folder: z.null(),
  agent: agentIdSchema,
  model: modelSchema.nullable().optional(),
  title: z.string().max(LIMITS.title).optional(),
  firstPrompt: firstPromptSchema
})
/** Only an epic, an agent and its model, for a transfer chat: the role, Allow save, title, kickoff message and what the chat records are decided in main. */
const startTransferSchema = z.strictObject({
  folder: folderSchema,
  epicId: stableId,
  agent: agentIdSchema,
  model: modelSchema.nullable().optional(),
  thinking: thinkingSchema
})
/** The person's additional instructions from Play or Start run, appended to the kickoff: as long as a first prompt, and not blank. */
const instructionsSchema = z.string().max(32_000).refine((text) => text.trim().length > 0, 'Additional instructions must not be blank').optional()
/** A transfer chat's request and the person's instructions, for an orchestrator. */
const startOrchestratorSchema = startTransferSchema.extend({ instructions: instructionsSchema })
const transferChatSchema = z.strictObject({ folder: folderSchema, epicId: stableId })
const refSchema = z.strictObject(refShape)
/** A whole id of the kind: a claim token (`<attempt id>.<secret>`) or any other text is not one. */
const attemptIdSchema = stableId.regex(/^at_/)
const runIdSchema = stableId.regex(/^rn_/)
const cardIdSchema = stableId.regex(/^kc_/)
/** An attempt or a run, never both and never anything else. */
const boundThreadsSchema = z.union([z.strictObject({ folder: folderSchema, attemptId: attemptIdSchema }), z.strictObject({ folder: folderSchema, runId: runIdSchema })])
/** Only a card, an agent, its model and the person's instructions: the role, Allow save, title, kickoff and what the chat records are decided in main. */
const startKanbanCardSchema = z.strictObject({
  folder: folderSchema,
  cardId: cardIdSchema,
  agent: agentIdSchema,
  model: modelSchema.nullable().optional(),
  thinking: thinkingSchema,
  instructions: instructionsSchema
})
const kickBackKanbanCardSchema = z.strictObject({ folder: folderSchema, cardId: cardIdSchema, comment: commentBody })
const renameSchema = z.strictObject({ ...refShape, title: z.string().trim().min(1).max(LIMITS.title) })
const epicIdSchema = stableId.regex(/^ep_/)
const startPlannerSchema = z.strictObject({ folder: folderSchema, epicId: epicIdSchema, model: modelSchema.nullable().optional(), thinking: thinkingSchema })
const ticketIdSchema = stableId.regex(/^tk_/)
const conversationTargetSchema = z.union([
  z.strictObject({ epicId: epicIdSchema, ticketId: ticketIdSchema.optional() }),
  z.strictObject({ cardId: cardIdSchema })
])
const attachmentsSchema = z.array(attachmentRef.shape.id).max(LIMITS.attachmentsPerRecord).optional()
const sendConversationSchema = z.strictObject({
  folder: folderSchema,
  target: conversationTargetSchema,
  body: commentBody,
  attachments: attachmentsSchema
})
const conversationStateSchema = z.strictObject({
  folder: folderSchema,
  target: conversationTargetSchema,
  messageIds: z.array(stableId).max(LIMITS.listItems)
})

export type ConversationWorkspace = Pick<
  ProjectWorkspace,
  'addComment' | 'listComments' | 'getEpic' | 'getTicket' | 'getKanbanCard' | 'addKanbanMessage' | 'listKanbanMessages'
>

interface ConversationHandlerDeps {
  workspace(folder: string): ConversationWorkspace
  reads: ConversationReads
  deliveries: ConversationDeliveries
  defaultAgent(folder: string): AgentId | null
  contextDelivery?: Pick<AgentContextDelivery, 'queueBoard' | 'hasBoardMessage'>
  resume?: (chat: ChatRecord) => Promise<string | null>
  now?: () => string
}

/** Finds the id of the chat of a (canonical) folder that an attempt or a run is bound to by grant; null when none is. */
export type BoundTerminalLookup = (folder: string, target: BoundTarget) => Promise<string | null>

interface ChatHandlerDeps {
  /** The tracked folders: what requests are checked against, and whose chats `listAll` lists. */
  registry: Pick<FolderRegistry, 'resolve' | 'list'>
  /** The connected agents; a request naming any other agent is refused before anything runs. */
  agents: Pick<AgentRegistry, 'get'>
  /** The chat records; deleting a chat through them also ends its terminal (`endingTerminals`). */
  chats: ChatRecords
  /** The chat terminals: Start run and Play start their chat's terminal before they answer; Kick back pastes into the card's. */
  terminals: Pick<TerminalSessions, 'start' | 'paste'>
  /** The one GUI session manager (`wireAgentChats`): GUI chats start and take board messages here, and live reads ask it. */
  agentChats: Pick<AgentChatSessions, 'start' | 'send' | 'isLive'>
  /** The connected agents with their sign-in state, which Start planner picks its agent from. */
  plannerAgents: PlannerAgents
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
  /** Durable board-message storage, routing reads, delivery ledger and the selected agent for a fresh chat. */
  conversation: ConversationHandlerDeps
  /** Told that a chat was created, renamed or deleted, so every window can list its folder's chats (and every chat) again; without it nothing is pushed. */
  push?: (event: ChatPushEvent) => void
  /** Told about failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
  /** Writes a Skitarii Magos's worker-model catalog for Start run (`workerCatalog.ts`); without it none is written. */
  workerCatalog?: WorkerCatalog
  /** The Skitarii catalogs a new chat's model and thinking level are checked against (`checkModelChoice`); without them a Skitarii chat starts only on its default. */
  models?: Pick<OmpModels, 'catalogModels'>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface ChatHandlers {
  list(folder: unknown): Promise<CommandResult<ChatRecord[]>>
  /** Every chat that is not deleted: each tracked folder's and the project-less ones, most recently updated first. */
  listAll(): Promise<CommandResult<ChatRecord[]>>
  create(request: unknown): Promise<CommandResult<ChatRecord>>
  startOrchestrator(request: unknown): Promise<CommandResult<StartOrchestratorResult>>
  startTransferChat(request: unknown): Promise<CommandResult<StartTransferChatResult>>
  startPlanner(request: unknown): Promise<CommandResult<StartPlannerResult>>
  startKanbanCard(request: unknown): Promise<CommandResult<StartKanbanCardResult>>
  kickBackKanbanCard(request: unknown): Promise<CommandResult<KickBackKanbanCardResult>>
  sendConversationMessage(request: unknown): Promise<CommandResult<SendConversationResult>>
  conversationState(request: unknown): Promise<CommandResult<ConversationStateResult>>
  findTransferChat(request: unknown): Promise<CommandResult<ChatRecord | null>>
  transferPrompt(request: unknown): Promise<CommandResult<string>>
  /** The chat and its stored transcript, read-only: nothing is started or stored. */
  read(request: unknown): Promise<CommandResult<ChatReadView>>
  boundThreads(request: unknown): Promise<CommandResult<BoundThread[]>>
  /** The id of the chat whose terminal the attempt or run is bound to by grant, or null. */
  boundTerminal(request: unknown): Promise<CommandResult<string | null>>
  rename(request: unknown): Promise<CommandResult<ChatRecord>>
  delete(request: unknown): Promise<CommandResult<null>>
}

/** The canonical path of a tracked folder; anything else is unauthorized, with a refusal naming the folder like `launchFolder`'s. */
function trackedFolder(deps: { registry: Pick<FolderRegistry, 'resolve'> }, folder: string): string {
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
export function chatFolder(deps: { registry: Pick<FolderRegistry, 'resolve'> }, folder: string): string {
  const tracked = trackedFolder(deps, folder)
  refuseSwappedFolder(tracked)
  return tracked
}

/** Validates a request naming one chat and resolves its folder (null for a project-less chat); returns the chat ref and the rest. */
function chatRequest<T extends { folder: string | null; chatId: string }>(deps: ChatHandlerDeps, schema: z.ZodType<T>, input: unknown): { ref: ChatRef; request: T } {
  const request = parseInput(schema, input, 'chat request')
  return { ref: { folder: request.folder === null ? null : chatFolder(deps, request.folder), id: request.chatId }, request }
}

/** A folder's chats without its cult members (`cultRunId`), which only the cult views show. */
async function folderChats(deps: Pick<ChatHandlerDeps, 'chats'>, folder: string | null): Promise<ChatRecord[]> {
  return (await deps.chats.listChats(folder)).filter(chat => chat.cultRunId === undefined)
}

/**
 * Every chat that is not deleted and not a cult member: the chats of each tracked folder (a folder swapped for a
 * symlink to another directory is left out, as listing it alone is refused), then the project-less ones, most recently
 * updated first.
 */
async function listAll(deps: ChatHandlerDeps): Promise<ChatRecord[]> {
  const folders = deps.registry.list().flatMap(({ path }) => {
    try {
      return [chatFolder(deps, path)]
    } catch (error) {
      if (error instanceof DomainError) {
        return []
      }
      throw error
    }
  })
  return (await Promise.all([...folders, null].map(folder => folderChats(deps, folder)))).flat().sort(byRecency)
}

/** Validates the request and the folder before anything is queued; see `startOrchestratorRun` for what happens after. */
async function startOrchestrator(deps: ChatHandlerDeps, input: unknown): Promise<StartOrchestratorResult> {
  const request = parseInput(startOrchestratorSchema, input, 'orchestrator request')
  connectedAgent(deps.agents, request.agent)
  const folder = chatFolder(deps, request.folder)
  await checkModelChoice(deps, request.agent, request)
  const { runs, chats, terminals, agentChats, onUnexpectedError, workerCatalog } = deps
  const started = await startOrchestratorRun({
    runs, chats, terminals, agentChats,
    ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }),
    ...(workerCatalog === undefined ? {} : { workerCatalog })
  }, { ...request, folder })
  if (started.chat !== null) {
    chatsChanged(deps, { folder: started.chat.folder, id: started.chat.id })
  }
  return started
}

/** Validates the request and the folder before the transfer is read; see `startTransferChat` for what happens after. */
async function startTransfer(deps: ChatHandlerDeps, input: unknown): Promise<StartTransferChatResult> {
  const request = parseInput(startTransferSchema, input, 'transfer chat request')
  connectedAgent(deps.agents, request.agent)
  const folder = chatFolder(deps, request.folder)
  await checkModelChoice(deps, request.agent, request)
  const { transfers, chats, terminals, agentChats, onUnexpectedError } = deps
  const started = await startTransferChat({ transfers, chats, terminals, agentChats, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder })
  if (started.chat !== null) {
    chatsChanged(deps, { folder: started.chat.folder, id: started.chat.id })
  }
  return started
}

/** Validates the request and the folder before the epic is read; see `startPlannerChat` for what happens after. */
async function startPlanner(deps: ChatHandlerDeps, input: unknown): Promise<StartPlannerResult> {
  const request = parseInput(startPlannerSchema, input, 'planner request')
  const folder = chatFolder(deps, request.folder)
  const { chats, terminals, agentChats, onUnexpectedError } = deps
  const started = await startPlannerChat(
    {
      epics: deps.runs, agents: deps.plannerAgents, chats, terminals, agentChats, checkModel: (agent, choice) => checkModelChoice(deps, agent, choice),
      ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError })
    },
    { ...request, folder }
  )
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
  await checkModelChoice(deps, request.agent, request)
  const { kanban, chats, terminals, agentChats, onUnexpectedError } = deps
  const started = await startKanbanCard({ cards: kanban, chats, terminals, agentChats, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder })
  if (started.chat !== null) {
    chatsChanged(deps, { folder: started.chat.folder, id: started.chat.id })
  }
  return started
}

/** Validates the request and the folder before the card is kicked back; see `kickBackKanbanCard` for what happens after. */
function kickBackCard(deps: ChatHandlerDeps, input: unknown): Promise<KickBackKanbanCardResult> {
  const request = parseInput(kickBackKanbanCardSchema, input, 'Kanban kick-back request')
  const { kanban, chats, terminals, agentChats, onUnexpectedError } = deps
  return kickBackKanbanCard({ cards: kanban, chats, terminals, agentChats, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder: chatFolder(deps, request.folder) })
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

/** Tells every window that the chat was created, renamed or deleted in its (canonical) folder, or among the project-less chats. */
function chatsChanged(deps: ChatHandlerDeps, chat: ChatRef): void {
  deps.push?.({ type: 'chats_changed', folder: chat.folder, chatId: chat.id })
}

/** A chat in a tracked folder, or a project-less one: an orchestrator that may save, reaching every tracked folder. */
async function createChat(deps: ChatHandlerDeps, input: unknown): Promise<ChatRecord> {
  const request = parseInput(z.union([createSchema, summonSchema]), input, 'new chat')
  connectedAgent(deps.agents, request.agent)
  const target = request.folder === null
    ? { ...request, role: 'orchestrator' as const, allowSave: true }
    : { ...request, folder: chatFolder(deps, request.folder) }
  await checkModelChoice(deps, request.agent, request)
  const chat = await deps.chats.createChat(target)
  chatsChanged(deps, chat)
  return chat
}

async function renameChat(deps: ChatHandlerDeps, input: unknown): Promise<ChatRecord> {
  const { ref, request } = chatRequest(deps, renameSchema, input)
  const chat = await deps.chats.renameChat(ref, request.title)
  chatsChanged(deps, ref)
  return chat
}

async function deleteChat(deps: ChatHandlerDeps, input: unknown): Promise<null> {
  const { ref } = chatRequest(deps, refSchema, input)
  await deps.chats.deleteChat(ref)
  chatsChanged(deps, ref)
  return null
}

type SendConversationInput = z.infer<typeof sendConversationSchema>
type ConversationStateInput = z.infer<typeof conversationStateSchema>

interface ConversationDetails extends Omit<BoardMessageInput, 'body' | 'attachmentIds' | 'relay'> {
  title: string
  history: ConversationHistoryEntry[]
  runActive: boolean
}

function isCardTarget(target: SendConversationInput['target']): target is { cardId: string } {
  return 'cardId' in target
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reportUnexpected(deps: ChatHandlerDeps, error: unknown): void {
  if (!(error instanceof DomainError)) deps.onUnexpectedError?.(error)
}

async function storeConversationMessage(
  workspace: ConversationWorkspace,
  request: SendConversationInput
): Promise<string> {
  const fields = {
    body: request.body,
    ...(request.attachments === undefined ? {} : { attachments: request.attachments })
  }
  if (isCardTarget(request.target)) {
    return (await workspace.addKanbanMessage({ cardId: request.target.cardId, ...fields })).id
  }
  return (await workspace.addComment({ ...request.target, ...fields })).id
}

function commentHistory(comments: readonly CommentView[], messageId: string): ConversationHistoryEntry[] {
  return comments
    .filter((comment) => comment.id !== messageId)
    .map((comment) => ({ author: comment.author.label, at: comment.createdAt, body: comment.body }))
}

function cardHistory(messages: readonly KanbanMessageView[], messageId: string): ConversationHistoryEntry[] {
  return messages
    .filter((message) => message.id !== messageId)
    .map((message) => ({ author: message.authorLabel, at: message.createdAt, body: message.body }))
}

async function conversationDetails(
  deps: ChatHandlerDeps,
  folder: string,
  target: SendConversationInput['target'],
  messageId: string
): Promise<ConversationDetails> {
  const workspace = deps.conversation.workspace(folder)
  if (isCardTarget(target)) {
    const [card, messages] = await Promise.all([
      workspace.getKanbanCard({ cardId: target.cardId }),
      workspace.listKanbanMessages({ cardId: target.cardId })
    ])
    return {
      target,
      cardKey: card.key,
      title: `Conversation · ${card.key}`,
      history: cardHistory(messages, messageId),
      runActive: false
    }
  }

  const epic = await workspace.getEpic({ epicId: target.epicId })
  const runActive = (await deps.conversation.reads.activeRunId(folder, target.epicId)) !== null
  if (target.ticketId === undefined) {
    const comments = await workspace.listComments({ epicId: target.epicId })
    return {
      target,
      epicTitle: epic.title,
      title: `Conversation · ${epic.title}`,
      history: commentHistory(comments, messageId),
      runActive
    }
  }
  const [ticket, comments] = await Promise.all([
    workspace.getTicket({ epicId: target.epicId, ticketId: target.ticketId, view: 'saved' }),
    workspace.listComments({ epicId: target.epicId, ticketId: target.ticketId })
  ])
  return {
    target,
    epicTitle: epic.title,
    ticketKey: ticket.ticket.key,
    ticketTitle: ticket.ticket.title,
    title: `Conversation · ${ticket.ticket.key}`,
    history: commentHistory(comments, messageId),
    runActive
  }
}

async function terminalFailure(deps: ChatHandlerDeps, action: () => Promise<TerminalStart>): Promise<string | null> {
  try {
    const result = await action()
    return result.state === 'running' ? null : result.message
  } catch (error) {
    reportUnexpected(deps, error)
    return errorMessage(error)
  }
}

async function listedResolvedChat(deps: ChatHandlerDeps, folder: string, resolved: ResolvedConversationChat): Promise<ChatRecord | null> {
  return (await deps.chats.listChats(folder)).find((chat) => chat.id === resolved.chatId) ?? null
}

type ConversationDelivery = Omit<SendConversationResult, 'messageId'>
type ConversationPrompt = ConversationDetails & Pick<BoardMessageInput, 'body' | 'attachmentIds'> & { messageId: string }

async function scheduleBoardContext(
  deps: ChatHandlerDeps,
  chat: ChatRecord,
  message: BoardContextBody,
  activate: () => Promise<string | null>
): Promise<ConversationDelivery> {
  const delivery = deps.conversation.contextDelivery
  if (delivery === undefined) {
    return { chatId: chat.id, state: 'pending', problem: 'Automatic context delivery is unavailable; the saved person message has not been inserted.' }
  }
  try {
    await delivery.queueBoard(chat, message)
    if (delivery.hasBoardMessage(chat, message.id, message.text)) return { chatId: chat.id, state: 'delivered', problem: null }
    const problem = await activate()
    return delivery.hasBoardMessage(chat, message.id, message.text)
      ? { chatId: chat.id, state: 'delivered', problem: null }
      : { chatId: chat.id, state: 'pending', problem }
  } catch (error) {
    reportUnexpected(deps, error)
    return { chatId: chat.id, state: 'pending', problem: errorMessage(error) }
  }
}

function resumeForBoard(deps: ChatHandlerDeps, chat: ChatRecord): Promise<string | null> {
  return deps.conversation.resume?.(chat) ?? Promise.resolve('Automatic resume is unavailable; the person message remains pending.')
}

/** A board message to a GUI chat is the person's user turn in that chat (starting it if it is stopped), never a paste. */
async function sendGuiTurn(deps: ChatHandlerDeps, chat: ChatRecord, text: string): Promise<ConversationDelivery> {
  try {
    await deps.agentChats.send(chat, { text })
    return { chatId: chat.id, state: 'delivered', problem: null }
  } catch (error) {
    reportUnexpected(deps, error)
    return { chatId: chat.id, state: 'failed', problem: errorMessage(error) }
  }
}

async function pasteConversationMessage(
  deps: ChatHandlerDeps,
  input: {
    folder: string
    target: SendConversationInput['target']
    prompt: ConversationPrompt
    resolved: ResolvedConversationChat
  }
): Promise<ConversationDelivery> {
  const chat = await listedResolvedChat(deps, input.folder, input.resolved)
  if (chat === null) {
    return { chatId: input.resolved.chatId, state: 'failed', problem: 'The selected chat was deleted before the message could be delivered.' }
  }
  const relay =
    !isCardTarget(input.target) &&
    input.target.ticketId !== undefined &&
    (input.resolved.via === 'attempt' || input.resolved.via === 'run')
  const message = { id: input.prompt.messageId, text: boardMessage({ ...input.prompt, relay }) }
  if (chat.surface === 'gui') return sendGuiTurn(deps, chat, message.text)
  return scheduleBoardContext(deps, chat, message, () => deps.agents.get(chat.agent)?.kind === 'omp'
    ? resumeForBoard(deps, chat)
    : terminalFailure(deps, () => deps.terminals.paste(chat, boardContextText(message), message.id)))
}

async function openConversationChat(
  deps: ChatHandlerDeps,
  folder: string,
  request: SendConversationInput,
  prompt: ConversationPrompt
): Promise<ConversationDelivery> {
  const agentId = deps.conversation.defaultAgent(folder)
  if (agentId === null) {
    return {
      chatId: null,
      state: 'failed',
      problem: 'No default agent is selected for this folder. Select one in Agents, then send another message.'
    }
  }
  const agent = connectedAgent(deps.agents, agentId)
  const message = { id: prompt.messageId, text: freshKickoff({ ...prompt, relay: false, history: prompt.history, runActive: prompt.runActive }) }
  let chat: ChatRecord
  try {
    chat = await deps.chats.createChat({
      folder,
      agent: agentId,
      role: 'orchestrator',
      model: null,
      allowSave: true,
      title: prompt.title,
      // An epic conversation is bound to its epic; a card conversation names its card only.
      ...(isCardTarget(request.target)
        ? { conversation: { cardId: request.target.cardId } }
        : { conversation: { epicId: request.target.epicId }, epicId: request.target.epicId })
    })
  } catch (error) {
    reportUnexpected(deps, error)
    return { chatId: null, state: 'failed', problem: `The conversation chat could not be created: ${errorMessage(error)}` }
  }
  if (chat.surface === 'gui') {
    const failure = await startChatOnSurface({ ...deps, ...(deps.onUnexpectedError === undefined ? {} : { onError: deps.onUnexpectedError }) }, chat, message.text)
    return failure === null ? { chatId: chat.id, state: 'delivered', problem: null } : { chatId: chat.id, state: 'failed', problem: failure }
  }
  return scheduleBoardContext(deps, chat, message, () => agent.kind === 'omp'
    ? resumeForBoard(deps, chat)
    : terminalFailure(deps, () => deps.terminals.paste(chat, boardContextText(message), message.id)))
}

async function deliverConversationMessage(
  deps: ChatHandlerDeps,
  folder: string,
  request: SendConversationInput,
  messageId: string
): Promise<ConversationDelivery> {
  const resolved = await resolveConversationChat(
    {
      reads: deps.conversation.reads,
      store: deps.chats,
      boundTerminal: deps.boundTerminal ?? (() => Promise.resolve(null))
    },
    folder,
    request.target
  )
  const details = await conversationDetails(deps, folder, request.target, messageId)
  const prompt = { ...details, body: request.body, attachmentIds: request.attachments ?? [], messageId }
  return resolved === null
    ? openConversationChat(deps, folder, request, prompt)
    : pasteConversationMessage(deps, { folder, target: request.target, prompt, resolved })
}

async function sendConversationMessage(deps: ChatHandlerDeps, input: unknown): Promise<SendConversationResult> {
  const parsed = parseInput(sendConversationSchema, input, 'conversation message')
  const folder = chatFolder(deps, parsed.folder)
  const request: SendConversationInput = { ...parsed, folder }
  const messageId = await storeConversationMessage(deps.conversation.workspace(folder), request)
  let delivery: Omit<SendConversationResult, 'messageId'>
  try {
    delivery = await deliverConversationMessage(deps, folder, request, messageId)
  } catch (error) {
    reportUnexpected(deps, error)
    delivery = { chatId: null, state: 'failed', problem: errorMessage(error) }
  }
  deps.conversation.deliveries.record({
    ...deps.conversation.deliveries.forMessages(folder, [messageId]).get(messageId),
    messageId,
    folder,
    ...delivery,
    source: 'board',
    at: (deps.conversation.now ?? (() => new Date().toISOString()))()
  })
  if (delivery.chatId !== null) chatsChanged(deps, { folder, id: delivery.chatId })
  return { messageId, ...delivery }
}

async function conversationState(deps: ChatHandlerDeps, input: unknown): Promise<ConversationStateResult> {
  const request: ConversationStateInput = parseInput(conversationStateSchema, input, 'conversation state')
  const folder = chatFolder(deps, request.folder)
  const resolved = await resolveConversationChat(
    {
      reads: deps.conversation.reads,
      store: deps.chats,
      boundTerminal: deps.boundTerminal ?? (() => Promise.resolve(null))
    },
    folder,
    request.target
  )
  const chats = await deps.chats.listChats(folder)
  const selected = resolved === null ? null : (chats.find((chat) => chat.id === resolved.chatId) ?? null)
  const deliveries: ConversationStateResult['deliveries'] = {}
  for (const [messageId, delivery] of deps.conversation.deliveries.forMessages(folder, request.messageIds)) {
    deliveries[messageId] = {
      chatId: delivery.chatId,
      state: delivery.state,
      problem: delivery.problem,
      chatExists: delivery.chatId !== null && chats.some((chat) => chat.id === delivery.chatId)
    }
  }
  return {
    chat: selected === null || resolved === null ? null : { id: selected.id, title: selected.title, via: resolved.via },
    deliveries
  }
}

type ChatHandlerOptions = Omit<ChatHandlerDeps, 'conversation'> & { conversation?: ConversationHandlerDeps }

function unavailableConversation(): ConversationHandlerDeps {
  const unavailable = (): never => {
    throw new DomainError('operation_unavailable', 'Board conversations are not configured.')
  }
  return {
    workspace: unavailable,
    reads: { openAttemptId: async () => null, activeRunId: async () => null },
    deliveries: { record: unavailable, forMessages: () => new Map(), pending: () => [], proof: () => undefined },
    defaultAgent: () => null
  }
}

export function createChatHandlers(options: ChatHandlerOptions): ChatHandlers {
  const deps: ChatHandlerDeps = { ...options, conversation: options.conversation ?? unavailableConversation() }
  const { chats } = deps
  return {
    list: (folder) => answer(deps, () => folderChats(deps, chatFolder(deps, parseInput(folderSchema, folder, 'folder')))),
    listAll: () => answer(deps, () => listAll(deps)),
    create: (input) => answer(deps, () => createChat(deps, input)),
    startOrchestrator: (input) => answer(deps, () => startOrchestrator(deps, input)),
    startTransferChat: (input) => answer(deps, () => startTransfer(deps, input)),
    startPlanner: (input) => answer(deps, () => startPlanner(deps, input)),
    startKanbanCard: (input) => answer(deps, () => startCard(deps, input)),
    kickBackKanbanCard: (input) => answer(deps, () => kickBackCard(deps, input)),
    sendConversationMessage: (input) => answer(deps, () => sendConversationMessage(deps, input)),
    conversationState: (input) => answer(deps, () => conversationState(deps, input)),
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
    read: (input) =>
      answer(deps, () => {
        const { ref } = chatRequest(deps, refSchema, input)
        // A live GUI process still owns its pending requests and running calls: the read must not settle them.
        return chats.readChat(ref, { live: deps.agentChats.isLive(ref) })
      }),
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
