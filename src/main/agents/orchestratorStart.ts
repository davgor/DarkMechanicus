import { forgeKickoff } from '../desktop/forgeManifest'
/**
 * Starts an agent as the orchestrator of a run (`docs/design/chat-shells.md`, "The orchestrator chat Start run
 * opens"): queue the run, create an orchestrator chat for it, and start its terminal with the kickoff before
 * answering, so the app can show the terminal. It lives in main, in one place, so a failure part way leaves a
 * state the person can read instead of one the renderer has to piece together:
 *
 *   - The epic cannot be read, or the run cannot be queued: nothing was created, and the error
 *     is the answer (an epic with an active run, an unsaved plan, ...).
 *   - The run is queued but the chat cannot be created: no chat exists. The run waits for an
 *     orchestrator, like one left pending, and the answer says so.
 *   - The chat exists but its terminal does not start (a folder refused, the agent not connected or signed out,
 *     a spawn that fails): the chat is removed again, so none is left claiming to orchestrate a run nobody is
 *     running, and the answer says why. If the chat cannot be removed it is kept and returned, with the reason.
 *     A CLI that starts and then exits leaves its chat, which the person can read and start again.
 *
 * A chat is never created before its run exists, and it records that run's id. The orchestrator and worker
 * guidance goes in the chat's instructions (`terminalFiles.ts`, for a chat with a `runId`); the kickoff is only
 * the run lines, and goes with the chat's first start (`terminalSessions.ts`). A Skitarii (OMP) Magos's first start
 * also gets one line naming the worker-model catalog main wrote for it (`workerCatalog.ts`); a catalog OMP cannot
 * list leaves the line out and the start goes on.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { StartOrchestratorRequest, StartOrchestratorResult } from '../../shared/agents/chatApi'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import type { AgentChatSessions } from '../agentChat/agentChatSessions'
import type { TerminalSessions } from '../terminals/terminalSessions'
import { startChatOnSurface } from './chatSurfaceStart'
import type { ChatRecords } from './chatRecords'
import { orchestratorKickoff, orchestratorTitle } from './orchestratorKickoff'
import { workerCatalogLine, type WorkerCatalog } from './workerCatalog'

/** The run side of the desktop for one tracked folder: the same commands the Start run button uses. */
export interface OrchestratorRuns {
  getEpic(folder: string, epicId: string): Promise<EpicDetailView>
  /** Queues a run pinned to the epic's current saved revision, for an orchestrator to pick up. */
  queueRun(folder: string, epicId: string): Promise<RunView>
}

interface OrchestratorStartDeps {
  runs: OrchestratorRuns
  chats: Pick<ChatRecords, 'createChat' | 'deleteChat' | 'agentName'>
  terminals: Pick<TerminalSessions, 'start'>
  /** The one GUI session manager: a chat on the `gui` surface starts there, with the kickoff as its first turn. */
  agentChats: Pick<AgentChatSessions, 'start'>
  /** Told about failures that are not DomainErrors and about a chat that could not be removed, so main can log them. */
  onError?: (error: unknown) => void
  /** Writes a Skitarii Magos's worker-model catalog and answers its path (null for another agent); without it none is written. */
  workerCatalog?: WorkerCatalog
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[.s]+$/, '')
}

function logUnexpected(deps: OrchestratorStartDeps, error: unknown): void {
  if (!(error instanceof DomainError)) {
    deps.onError?.(error)
  }
}

/** The catalog line for the chat's kickoff, or nothing when the agent is not OMP or its catalog could not be written. */
async function catalogLine(deps: OrchestratorStartDeps, chat: ChatRecord): Promise<string> {
  try {
    const path = await deps.workerCatalog?.(chat)
    return path ? `\n\n${workerCatalogLine(path)}` : ''
  } catch (error) {
    logUnexpected(deps, error)
    return ''
  }
}

function queuedButNoChat(run: RunView, what: string, error: unknown): string {
  return `Run #${run.number} is queued, but ${what}: ${reasonOf(error)}. It is waiting for an orchestrator.`
}

/** Removes the chat of an agent that could not start; false (after reporting) when it could not be removed. */
async function removeChat(deps: OrchestratorStartDeps, chat: ChatRecord): Promise<boolean> {
  try {
    await deps.chats.deleteChat(chat)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/** `request.folder` is the canonical path of a tracked folder. */
export async function startOrchestratorRun(deps: OrchestratorStartDeps, request: StartOrchestratorRequest): Promise<StartOrchestratorResult> {
  const { folder, epicId, agent } = request
  const epic = await deps.runs.getEpic(folder, epicId)
  const run = await deps.runs.queueRun(folder, epicId)
  const agentName = deps.chats.agentName(agent)
  const kickoff = orchestratorKickoff({
    epicId: epic.id,
    epicTitle: epic.title,
    branch: epic.branch?.name ?? null,
    repositoryBranches: epic.repositoryBranches,
    runId: run.id,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions })
  }) + forgeKickoff(folder)

  let chat: ChatRecord
  try {
    chat = await deps.chats.createChat({
      folder,
      agent,
      role: 'orchestrator',
      model: request.model ?? null,
      ...(request.thinking == null ? {} : { thinking: request.thinking }),
      allowSave: true,
      title: orchestratorTitle(epic.title),
      runId: run.id,
      epicId: epic.id,
      // Recorded as the chat's first input, so a start that ends before they went delivers them once, later.
      ...(request.instructions === undefined ? {} : { firstPrompt: kickoff })
    })
  } catch (error) {
    logUnexpected(deps, error)
    return { run, chat: null, problem: queuedButNoChat(run, 'the orchestrator chat could not be created', error) }
  }

  const failure = await startChatOnSurface(deps, chat, kickoff + (await catalogLine(deps, chat)))
  if (failure !== null) {
    const removed = await removeChat(deps, chat)
    const problem = queuedButNoChat(run, `${agentName} could not be started`, failure)
    return { run, chat: removed ? null : chat, problem }
  }
  return { run, chat, problem: null }
}
