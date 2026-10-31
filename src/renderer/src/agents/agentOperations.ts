import { AGENT_DEFINITIONS } from '../../../shared/desktop/agentKinds'
import type { AgentFindResult, AgentId, AgentView, BuiltInAgentKind, CustomAgentRequest, CustomAgentUpdate } from '../../../shared/desktop/api'
import { IDLE_ACTIVITY } from './agentActivity'
import type { ActivityState } from './agentActivity'
import { downloadOutcome, findOutcome } from './agentOutcomes'

/** What the operations change and report to; the hook supplies it. Activity is keyed by agent id (a built-in's id is its kind). */
interface OperationDeps {
  patch(id: AgentId, change: Partial<ActivityState>): void
  upsert(agent: AgentView): void
  replace(agents: readonly AgentView[]): void
  onError(error: unknown): void
}

export interface AgentOperations {
  find(kind: BuiltInAgentKind): Promise<void>
  download(kind: BuiltInAgentKind): Promise<void>
  remove(id: AgentId): Promise<void>
  /** Adds a custom CLI; main's answer, or null when another add is in flight or the call failed (reported). */
  addCustom(request: CustomAgentRequest): Promise<AgentFindResult | null>
  /** Edits a custom CLI; main's answer, or null when another action on it is in flight or the call failed (reported). */
  updateCustom(update: CustomAgentUpdate): Promise<AgentFindResult | null>
}

/** Runs `work` unless `running` already holds the id, so a second press cannot start a second dialog. */
function exclusive(running: Set<AgentId>): (id: AgentId, work: () => Promise<void>) => Promise<void> {
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
  (deps: OperationDeps, slot: Slot) =>
  (kind: BuiltInAgentKind): Promise<void> =>
    slot(kind, async () => {
      deps.patch(kind, { finding: true, outcome: null })
      try {
        const result = await window.dm.findAgent(kind)
        if (result.outcome === 'connected') {
          deps.upsert(result.agent)
        }
        deps.patch(kind, { finding: false, outcome: findOutcome(AGENT_DEFINITIONS[kind].displayName, result) })
      } catch (error) {
        deps.patch(kind, { finding: false })
        deps.onError(error)
      }
    })

const download =
  (deps: OperationDeps, slot: Slot) =>
  (kind: BuiltInAgentKind): Promise<void> =>
    slot(kind, async () => {
      // The main process asks for the person's confirmation before it reports anything else.
      deps.patch(kind, { download: { phase: 'confirming', percent: null }, outcome: null })
      try {
        const result = await window.dm.downloadAgent(kind)
        if (result.outcome === 'installed') {
          deps.upsert(result.agent)
        }
        deps.patch(kind, { download: null, outcome: downloadOutcome(AGENT_DEFINITIONS[kind].displayName, result) })
      } catch (error) {
        deps.patch(kind, { download: null })
        deps.onError(error)
      }
    })

const remove =
  (deps: OperationDeps, slot: Slot) =>
  (id: AgentId): Promise<void> =>
    slot(id, async () => {
      try {
        deps.replace(await window.dm.removeAgent(id))
        deps.patch(id, IDLE_ACTIVITY)
      } catch (error) {
        deps.onError(error)
      }
    })

/** The slot of adding a custom CLI, which has no id until main stores it; not a valid agent id, so it never meets one. */
const NEW_CUSTOM_SLOT = 'custom:new'

/** Runs a custom CLI call in `id`'s slot and lists the agent main connected; the form that started it shows the answer. */
async function customCall(deps: OperationDeps, slot: Slot, id: AgentId, call: () => Promise<AgentFindResult>): Promise<AgentFindResult | null> {
  const answer: { result: AgentFindResult | null } = { result: null }
  await slot(id, async () => {
    try {
      const result = await call()
      if (result.outcome === 'connected') {
        deps.upsert(result.agent)
      }
      answer.result = result
    } catch (error) {
      deps.onError(error)
    }
  })
  return answer.result
}

/**
 * The agent actions, each naming only a built-in kind (find, download) or an agent id (remove): the file
 * dialog, the installer's confirmation and the sign-in terminal all belong to the main process, so nothing
 * the renderer says picks a file or a command. A custom CLI sends only its name, protocol and arguments (or, on
 * an edit, its id, name, arguments and whether to pick the program again). Find, Download, Remove and Edit share
 * one in-flight slot per id.
 * Signing in belongs to the sign-in prompt: it starts the CLI's login and watches the status until it says signed in.
 */
export function createAgentOperations(deps: OperationDeps): AgentOperations {
  const working = exclusive(new Set())
  return {
    find: find(deps, working),
    download: download(deps, working),
    remove: remove(deps, working),
    addCustom: (request) => customCall(deps, working, NEW_CUSTOM_SLOT, () => window.dm.addCustomAgent(request)),
    updateCustom: (update) => customCall(deps, working, update.id, () => window.dm.updateCustomAgent(update))
  }
}
