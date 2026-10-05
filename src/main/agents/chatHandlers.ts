/**
 * The behavior behind the `chats:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Every argument arrives from the renderer and is untrusted: it is validated
 * here, folders must be tracked, and requests are strict objects, so a renderer can name chats,
 * kinds, models, roles, text and decisions but never an executable or MCP arguments. Answers are
 * `CommandResult`s, like `dm:command`, so the UI gets the error code and message.
 */
import { z } from 'zod'
import { DomainError, toErrorShape } from '../../core/errors'
import { LIMITS, parseInput, stableId } from '../../core/schemas'
import { APPROVAL_DECISIONS, CHAT_ROLES, chatIdSchema, type ChatItem, type ChatRecord, type ModelOption } from '../../shared/agents/chat'
import type { BoundThread, ChatOpenView, ChatPushEvent, ChatSummary, StartOrchestratorResult, ThreadBinding } from '../../shared/agents/chatApi'
import { AGENT_KINDS } from '../../shared/desktop/agentKinds'
import type { CommandResult } from '../../shared/desktop/api'
import { agentKindSchema } from '../desktop/agentHandlers'
import type { FolderRegistry } from '../desktop/folderRegistry'
import type { BoundTarget } from './boundThreads'
import type { ChatRef } from './chatStore'
import { startOrchestratorRun, type OrchestratorRuns } from './orchestratorStart'
import type { SessionManager } from './sessionManager'

/** Windows long-path maximum; bounds path strings from the renderer. */
const MAX_PATH_LENGTH = 32_767
const MAX_MODEL_LENGTH = 200
const MAX_REQUEST_ID_LENGTH = 200

const folderSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const modelSchema = z.string().min(1).max(MAX_MODEL_LENGTH)
const refShape = { folder: folderSchema, chatId: chatIdSchema }

const createSchema = z.strictObject({
  folder: folderSchema,
  agent: z.enum(AGENT_KINDS),
  role: z.enum(CHAT_ROLES),
  model: modelSchema.nullable().optional(),
  allowSave: z.boolean().optional(),
  title: z.string().max(LIMITS.title).optional()
})
/** Only an epic, an agent and its model: the role, Allow save, title and kickoff message are decided in main. */
const startOrchestratorSchema = z.strictObject({
  folder: folderSchema,
  epicId: stableId,
  agent: z.enum(AGENT_KINDS),
  model: modelSchema.nullable().optional()
})
const refSchema = z.strictObject(refShape)
/** A whole id of the kind: a claim token (`<attempt id>.<secret>`) or any other text is not one. */
const attemptIdSchema = stableId.regex(/^at_/)
const runIdSchema = stableId.regex(/^rn_/)
/** An attempt or a run, never both and never anything else. */
const boundThreadsSchema = z.union([z.strictObject({ folder: folderSchema, attemptId: attemptIdSchema }), z.strictObject({ folder: folderSchema, runId: runIdSchema })])
const sendSchema = z.strictObject({ ...refShape, text: z.string().min(1).max(LIMITS.markdown) })
const setModelSchema = z.strictObject({ ...refShape, model: modelSchema })
const renameSchema = z.strictObject({ ...refShape, title: z.string().trim().min(1).max(LIMITS.title) })
const answerSchema = z.strictObject({
  ...refShape,
  requestId: z.string().min(1).max(MAX_REQUEST_ID_LENGTH),
  decision: z.enum(APPROVAL_DECISIONS)
})

interface ChatHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  sessions: SessionManager
  /** The desktop's run commands, for starting an orchestrator. */
  runs: OrchestratorRuns
  /** The bindings of a chat's threads to runs and attempts, resolved as far as the folder's store allows; without it a chat has none. */
  threadBindings?: (chat: ChatRef) => Promise<ThreadBinding[]>
  /** The threads bound to an attempt or a run among the chats of a (canonical) folder; without it nothing is bound. */
  boundThreads?: (folder: string, target: BoundTarget) => BoundThread[]
  /** Told that a chat was created, renamed or deleted, so every window can list the folder's chats again; without it nothing is pushed. */
  push?: (event: ChatPushEvent) => void
  /** Told about failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface ChatHandlers {
  list(folder: unknown): Promise<CommandResult<ChatSummary[]>>
  create(request: unknown): Promise<CommandResult<ChatRecord>>
  startOrchestrator(request: unknown): Promise<CommandResult<StartOrchestratorResult>>
  open(request: unknown): Promise<CommandResult<ChatOpenView>>
  /** The same view as `open`, read-only: no agent is started and nothing is stored, for panels that follow a chat. */
  read(request: unknown): Promise<CommandResult<ChatOpenView>>
  send(request: unknown): Promise<CommandResult<ChatItem>>
  stop(request: unknown): Promise<CommandResult<null>>
  threadBindings(request: unknown): Promise<CommandResult<ThreadBinding[]>>
  boundThreads(request: unknown): Promise<CommandResult<BoundThread[]>>
  retryTurn(request: unknown): Promise<CommandResult<ChatItem>>
  setModel(request: unknown): Promise<CommandResult<ChatRecord>>
  rename(request: unknown): Promise<CommandResult<ChatRecord>>
  delete(request: unknown): Promise<CommandResult<null>>
  answerApproval(request: unknown): Promise<CommandResult<null>>
  models(kind: unknown): Promise<CommandResult<ModelOption[]>>
}

/** The canonical path of a tracked folder; anything else is unauthorized. */
function trackedFolder(deps: ChatHandlerDeps, folder: string): string {
  const tracked = deps.registry.resolve(folder)
  if (tracked === null) {
    throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
  }
  return tracked
}

/** Validates a request naming one chat and resolves its folder; returns the chat ref and the rest. */
function chatRequest<T extends { folder: string; chatId: string }>(deps: ChatHandlerDeps, schema: z.ZodType<T>, input: unknown): { ref: ChatRef; request: T } {
  const request = parseInput(schema, input, 'chat request')
  return { ref: { folder: trackedFolder(deps, request.folder), id: request.chatId }, request }
}

/** Validates the request and the folder before anything is queued; see `startOrchestratorRun` for what happens after. */
async function startOrchestrator(deps: ChatHandlerDeps, input: unknown): Promise<StartOrchestratorResult> {
  const request = parseInput(startOrchestratorSchema, input, 'orchestrator request')
  const folder = trackedFolder(deps, request.folder)
  const { runs, sessions, onUnexpectedError } = deps
  const started = await startOrchestratorRun({ runs, sessions, ...(onUnexpectedError === undefined ? {} : { onError: onUnexpectedError }) }, { ...request, folder })
  if (started.chat !== null) {
    chatsChanged(deps, { folder: started.chat.folder, id: started.chat.id })
  }
  return started
}

/** The chat's thread bindings; the request is validated even when the app wired none. */
async function threadBindings(deps: ChatHandlerDeps, input: unknown): Promise<ThreadBinding[]> {
  const { ref } = chatRequest(deps, refSchema, input)
  return (await deps.threadBindings?.(ref)) ?? []
}

/** The threads bound to the attempt or run the request names; the request and the folder are validated even when the app wired no lookup. */
function boundThreads(deps: ChatHandlerDeps, input: unknown): BoundThread[] {
  const request = parseInput(boundThreadsSchema, input, 'bound threads request')
  const folder = trackedFolder(deps, request.folder)
  const target: BoundTarget = 'attemptId' in request ? { attemptId: request.attemptId } : { runId: request.runId }
  return deps.boundThreads?.(folder, target) ?? []
}

async function answer<T>(deps: ChatHandlerDeps, action: () => T | Promise<T>): Promise<CommandResult<T>> {
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
  const chat = deps.sessions.createChat({ ...request, folder: trackedFolder(deps, request.folder) })
  chatsChanged(deps, { folder: chat.folder, id: chat.id })
  return chat
}

function renameChat(deps: ChatHandlerDeps, input: unknown): ChatRecord {
  const { ref, request } = chatRequest(deps, renameSchema, input)
  const chat = deps.sessions.renameChat(ref, request.title)
  chatsChanged(deps, ref)
  return chat
}

async function deleteChat(deps: ChatHandlerDeps, input: unknown): Promise<null> {
  const { ref } = chatRequest(deps, refSchema, input)
  await deps.sessions.deleteChat(ref)
  chatsChanged(deps, ref)
  return null
}

export function createChatHandlers(deps: ChatHandlerDeps): ChatHandlers {
  const { sessions } = deps
  return {
    list: (folder) => answer(deps, () => sessions.listChats(trackedFolder(deps, parseInput(folderSchema, folder, 'folder')))),
    create: (input) => answer(deps, () => createChat(deps, input)),
    startOrchestrator: (input) => answer(deps, () => startOrchestrator(deps, input)),
    open: (input) => answer(deps, () => sessions.openChat(chatRequest(deps, refSchema, input).ref)),
    read: (input) => answer(deps, () => sessions.readChat(chatRequest(deps, refSchema, input).ref)),
    send: (input) =>
      answer(deps, () => {
        const { ref, request } = chatRequest(deps, sendSchema, input)
        return sessions.send(ref, request.text)
      }),
    stop: (input) =>
      answer(deps, async () => {
        await sessions.stop(chatRequest(deps, refSchema, input).ref)
        return null
      }),
    threadBindings: (input) => answer(deps, () => threadBindings(deps, input)),
    boundThreads: (input) => answer(deps, () => boundThreads(deps, input)),
    retryTurn: (input) => answer(deps, () => sessions.retryTurn(chatRequest(deps, refSchema, input).ref)),
    setModel: (input) =>
      answer(deps, () => {
        const { ref, request } = chatRequest(deps, setModelSchema, input)
        return sessions.setModel(ref, request.model)
      }),
    rename: (input) => answer(deps, () => renameChat(deps, input)),
    delete: (input) => answer(deps, () => deleteChat(deps, input)),
    answerApproval: (input) =>
      answer(deps, () => {
        const { ref, request } = chatRequest(deps, answerSchema, input)
        sessions.answerApproval(ref, { requestId: request.requestId, decision: request.decision })
        return null
      }),
    models: (kind) => answer(deps, () => sessions.listModels(parseInput(agentKindSchema, kind, 'agent kind')))
  }
}
