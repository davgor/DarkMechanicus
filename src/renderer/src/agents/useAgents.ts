import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_KINDS, isBuiltInAgentKind } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { useLatest } from '../app/useLatest'
import { describeActivity, IDLE_ACTIVITY } from './agentActivity'
import type { ActivityState, AgentActivity } from './agentActivity'
import { createAgentOperations } from './agentOperations'
import type { AgentOperations } from './agentOperations'

/** Sign-in states by agent id. */
export type AgentStatuses = Readonly<Partial<Record<AgentId, AgentAuthStatus>>>

/** The connected agents with their sign-in states, what is in flight for each, and the actions. */
export interface AgentsModel extends AgentOperations {
  agents: readonly AgentView[]
  /** False until the first list arrives (or fails). */
  loaded: boolean
  /** The state of each connected agent by id; an id is absent while its status is still being asked. */
  statuses: AgentStatuses
  /** Shows a status a sign-in prompt found (a state it asked for itself), so every screen agrees without asking again. */
  recordStatus(id: AgentId, status: AgentAuthStatus): void
  /** What is in flight for an agent id (a built-in kind's id is the kind, which find and download use). */
  activity(id: AgentId): AgentActivity
}

/** Built-in agents show in the order of the add-agent cards, whatever order they were connected in; custom agents follow. */
const cardIndex = (agent: AgentView): number => (isBuiltInAgentKind(agent.kind) ? AGENT_KINDS.indexOf(agent.kind) : AGENT_KINDS.length)
const inCardOrder = (agents: readonly AgentView[]): AgentView[] => [...agents].sort((a, b) => cardIndex(a) - cardIndex(b))

interface ListState {
  agents: AgentView[]
  loaded: boolean
}

interface AgentList extends ListState {
  upsert(agent: AgentView): void
  replace(agents: readonly AgentView[]): void
}

function useAgentList(onError: (error: unknown) => void): AgentList {
  const [state, setState] = useState<ListState>({ agents: [], loaded: false })
  const report = useLatest(onError)
  useEffect(() => {
    let current = true
    window.dm.listAgents().then(
      (agents) => {
        if (current) setState({ agents: inCardOrder(agents), loaded: true })
      },
      (error: unknown) => {
        if (!current) return
        setState((previous) => ({ ...previous, loaded: true }))
        report.current(error)
      }
    )
    return () => {
      current = false
    }
  }, [report])
  const upsert = useCallback(
    (agent: AgentView) =>
      setState((previous) => ({
        ...previous,
        agents: inCardOrder([...previous.agents.filter((other) => other.id !== agent.id), agent])
      })),
    []
  )
  const replace = useCallback(
    (agents: readonly AgentView[]) => setState((previous) => ({ ...previous, agents: inCardOrder(agents) })),
    []
  )
  return { ...state, upsert, replace }
}

/** Whether this is a different executable (or a new probe of it) than the one last checked for the agent. */
const identityOf = (agent: AgentView): string => `${agent.executablePath}|${agent.lastProbed}`

/**
 * Each connected agent's sign-in state, asked of the agent's own CLI. It is asked when an agent is
 * connected or updated, whenever the window regains focus (where a sign-in finished in a terminal
 * window shows up) and whenever a chat reports that its agent's sign-in changed.
 */
function useAgentStatuses(
  agents: readonly AgentView[],
  onError: (error: unknown) => void
): { statuses: AgentStatuses; record(id: AgentId, status: AgentAuthStatus): void } {
  const [statuses, setStatuses] = useState<AgentStatuses>({})
  const report = useLatest(onError)
  const latest = useLatest(agents)
  const checked = useRef(new Map<AgentId, string>())

  const check = useCallback(
    (id: AgentId) => {
      window.dm.agentStatus(id).then(
        (status) => setStatuses((previous) => ({ ...previous, [id]: status })),
        (error: unknown) => report.current(error)
      )
    },
    [report]
  )

  useEffect(() => {
    for (const id of checked.current.keys()) {
      if (!agents.some((agent) => agent.id === id)) checked.current.delete(id)
    }
    for (const agent of agents) {
      if (checked.current.get(agent.id) !== identityOf(agent)) {
        checked.current.set(agent.id, identityOf(agent))
        check(agent.id)
      }
    }
  }, [agents, check])

  useEffect(() => {
    const recheck = (): void => latest.current.forEach((agent) => check(agent.id))
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [latest, check])

  useEffect(
    () =>
      window.dm.chats.onEvent((event) => {
        if (event.type === 'agent_auth' && latest.current.some((agent) => agent.id === event.agent)) check(event.agent)
      }),
    [check, latest]
  )

  const record = useCallback((id: AgentId, status: AgentAuthStatus) => setStatuses((previous) => ({ ...previous, [id]: status })), [])

  // A removed agent's late answer must not linger.
  const connected = useMemo(
    () => Object.fromEntries(Object.entries(statuses).filter(([id]) => agents.some((agent) => agent.id === id))),
    [statuses, agents]
  )
  return { statuses: connected, record }
}

type ActivityMap = Partial<Record<AgentId, ActivityState>>

/** Per-agent activity, plus the download progress the main process pushes for the built-in kind that is downloading. */
function useActivity(): { map: ActivityMap; patch(id: AgentId, change: Partial<ActivityState>): void } {
  const [map, setMap] = useState<ActivityMap>({})
  const patch = useCallback(
    (id: AgentId, change: Partial<ActivityState>) =>
      setMap((previous) => ({ ...previous, [id]: { ...(previous[id] ?? IDLE_ACTIVITY), ...change } })),
    []
  )
  useEffect(
    () =>
      window.dm.onAgentDownloadProgress(({ kind, phase, percent }) =>
        setMap((previous) => {
          const current = previous[kind]
          // Progress that outlives its download (the final events can trail the result) is not shown.
          return current === undefined || current.download === null
            ? previous
            : { ...previous, [kind]: { ...current, download: { phase, percent } } }
        })
      ),
    []
  )
  return { map, patch }
}

export function useAgents(onError: (error: unknown) => void): AgentsModel {
  const list = useAgentList(onError)
  const { statuses, record } = useAgentStatuses(list.agents, onError)
  const { map, patch } = useActivity()
  const report = useLatest(onError)
  const { upsert, replace } = list
  const operations = useMemo(
    () => createAgentOperations({ patch, upsert, replace, onError: (error) => report.current(error) }),
    [patch, upsert, replace, report]
  )
  const activity = useCallback((id: AgentId) => describeActivity(map[id] ?? IDLE_ACTIVITY), [map])
  return { agents: list.agents, loaded: list.loaded, statuses, recordStatus: record, activity, ...operations }
}
