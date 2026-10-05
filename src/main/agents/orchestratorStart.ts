/**
 * Starts an agent as the orchestrator of a run: queue the run, create an orchestrator chat for it,
 * send the kickoff message. It lives in main, in one place, so a failure part way leaves a state
 * the person can read instead of one the renderer has to piece together:
 *
 *   - The epic cannot be read, or the run cannot be queued: nothing was created, and the error
 *     is the answer (an epic with an active run, an unsaved plan, ...).
 *   - The run is queued but the chat cannot be created: no chat exists. The run waits for an
 *     orchestrator, like one left pending, and the answer says so.
 *   - The chat exists but its agent cannot start (not connected, signed out, crashed): the chat is
 *     removed again, so none is left claiming to orchestrate a run nobody is running, and the answer
 *     says why. If the chat cannot be removed it is kept and returned, with the reason.
 *
 * A chat is never created before its run exists, and it records that run's id.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { StartOrchestratorRequest, StartOrchestratorResult } from '../../shared/agents/chatApi'
import { AGENT_DEFINITIONS } from '../../shared/desktop/agentKinds'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import { orchestratorKickoff, orchestratorTitle } from './orchestratorKickoff'
import type { SessionManager } from './sessionManager'

/** The run side of the desktop for one tracked folder: the same commands the Start run button uses. */
export interface OrchestratorRuns {
  getEpic(folder: string, epicId: string): Promise<EpicDetailView>
  /** Queues a run pinned to the epic's current saved revision, for an orchestrator to pick up. */
  queueRun(folder: string, epicId: string): Promise<RunView>
}

interface OrchestratorStartDeps {
  runs: OrchestratorRuns
  sessions: Pick<SessionManager, 'createChat' | 'send' | 'deleteChat'>
  /** Told about failures that are not DomainErrors and about a chat that could not be removed, so main can log them. */
  onError?: (error: unknown) => void
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[.s]+$/, '')
}

function logUnexpected(deps: OrchestratorStartDeps, error: unknown): void {
  if (!(error instanceof DomainError)) {
    deps.onError?.(error)
  }
}

function queuedButNoChat(run: RunView, what: string, error: unknown): string {
  return `Run #${run.number} is queued, but ${what}: ${reasonOf(error)}. It is waiting for an orchestrator.`
}

/** Removes the chat of an agent that could not start; false (after reporting) when it could not be removed. */
async function removeChat(deps: OrchestratorStartDeps, chat: { folder: string; id: string }): Promise<boolean> {
  try {
    await deps.sessions.deleteChat(chat)
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
  const agentName = AGENT_DEFINITIONS[agent].displayName

  let chat: ChatRecord
  try {
    chat = deps.sessions.createChat({
      folder,
      agent,
      role: 'orchestrator',
      model: request.model ?? null,
      allowSave: false,
      title: orchestratorTitle(epic.title),
      runId: run.id
    })
  } catch (error) {
    logUnexpected(deps, error)
    return { run, chat: null, problem: queuedButNoChat(run, 'the orchestrator chat could not be created', error) }
  }

  try {
    await deps.sessions.send(chat, orchestratorKickoff({ epicId: epic.id, epicTitle: epic.title, branch: epic.branch?.name ?? null, runId: run.id }))
  } catch (error) {
    logUnexpected(deps, error)
    const removed = await removeChat(deps, chat)
    const problem = queuedButNoChat(run, `${agentName} could not be started`, error)
    return { run, chat: removed ? null : chat, problem }
  }
  return { run, chat, problem: null }
}
