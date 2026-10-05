import type { AgentKind, AgentView } from '../../../shared/desktop/api'
import { IDLE_ACTIVITY } from './agentActivity'
import type { ActivityState } from './agentActivity'
import { downloadOutcome, findOutcome } from './agentOutcomes'
import { agentName } from './agentText'

/** What the operations change and report to; the hook supplies it. */
interface OperationDeps {
  patch(kind: AgentKind, change: Partial<ActivityState>): void
  upsert(agent: AgentView): void
  replace(agents: readonly AgentView[]): void
  onError(error: unknown): void
}

export interface AgentOperations {
  find(kind: AgentKind): Promise<void>
  download(kind: AgentKind): Promise<void>
  remove(kind: AgentKind): Promise<void>
}

type Operation = (kind: AgentKind) => Promise<void>

/** Runs `work` unless `running` already holds the kind, so a second press cannot start a second dialog. */
function exclusive(running: Set<AgentKind>): (kind: AgentKind, work: () => Promise<void>) => Promise<void> {
  return async (kind, work) => {
    if (running.has(kind)) {
      return
    }
    running.add(kind)
    try {
      await work()
    } finally {
      running.delete(kind)
    }
  }
}

type Slot = ReturnType<typeof exclusive>

const find =
  (deps: OperationDeps, slot: Slot): Operation =>
  (kind) =>
    slot(kind, async () => {
      deps.patch(kind, { finding: true, outcome: null })
      try {
        const result = await window.dm.findAgent(kind)
        if (result.outcome === 'connected') {
          deps.upsert(result.agent)
        }
        deps.patch(kind, { finding: false, outcome: findOutcome(agentName(kind), result) })
      } catch (error) {
        deps.patch(kind, { finding: false })
        deps.onError(error)
      }
    })

const download =
  (deps: OperationDeps, slot: Slot): Operation =>
  (kind) =>
    slot(kind, async () => {
      // The main process asks for the person's confirmation before it reports anything else.
      deps.patch(kind, { download: { phase: 'confirming', percent: null }, outcome: null })
      try {
        const result = await window.dm.downloadAgent(kind)
        if (result.outcome === 'installed') {
          deps.upsert(result.agent)
        }
        deps.patch(kind, { download: null, outcome: downloadOutcome(agentName(kind), result) })
      } catch (error) {
        deps.patch(kind, { download: null })
        deps.onError(error)
      }
    })

const remove =
  (deps: OperationDeps, slot: Slot): Operation =>
  (kind) =>
    slot(kind, async () => {
      try {
        deps.replace(await window.dm.removeAgent(kind))
        deps.patch(kind, IDLE_ACTIVITY)
      } catch (error) {
        deps.onError(error)
      }
    })

/**
 * The agent actions, each naming only the kind: the file dialog, the installer's confirmation and the
 * sign-in terminal all belong to the main process, so nothing the renderer says picks a file or a
 * command. Find, Download and Remove share one in-flight slot per kind. Signing in belongs to the
 * sign-in prompt: it starts the CLI's login and watches the status until it says signed in.
 */
export function createAgentOperations(deps: OperationDeps): AgentOperations {
  const working = exclusive(new Set())
  return {
    find: find(deps, working),
    download: download(deps, working),
    remove: remove(deps, working)
  }
}
