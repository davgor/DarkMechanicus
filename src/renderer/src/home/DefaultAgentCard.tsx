import { useEffect, useId, useState } from 'react'
import type { AgentId, AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import { useToasts } from '../app/toasts'

interface DefaultAgentCardProps {
  folder: TrackedFolderView
  /** The connected agents. */
  agents: readonly AgentView[]
}

/** The stored default, null for none; undefined until it is read. */
function useStoredDefault(folderPath: string): [AgentId | null | undefined, (value: AgentId | null) => void] {
  const toasts = useToasts()
  const [stored, setStored] = useState<AgentId | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    window.dm.folderDefaultAgent(folderPath).then(
      (agentId) => {
        if (live) setStored(agentId)
      },
      (error: unknown) => {
        if (!live) return
        setStored(null)
        toasts.reportError(error)
      }
    )
    return () => {
      live = false
    }
  }, [folderPath, toasts])
  const write = (agentId: AgentId | null): void => {
    window.dm.setFolderDefaultAgent({ folder: folderPath, agentId }).then(setStored, (error: unknown) => toasts.reportError(error))
  }
  return [stored, write]
}

/**
 * The folder's default agent: New chat and Start run choose it first while it can chat. None leaves
 * them on the first agent that can. A stored default that is no longer connected stays listed as such.
 */
export function DefaultAgentCard({ folder, agents }: DefaultAgentCardProps): JSX.Element {
  const id = useId()
  const [stored, write] = useStoredDefault(folder.path)
  const missing = stored != null && !agents.some((agent) => agent.id === stored)
  return (
    <section className="card" aria-labelledby={id}>
      <h2 className="card-title" id={id}>
        Default agent
      </h2>
      <select
        aria-labelledby={id}
        className="connect-select"
        value={stored ?? ''}
        disabled={stored === undefined}
        onChange={(event) => write(event.target.value === '' ? null : (event.target.value as AgentId))}
      >
        <option value="">None</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.displayName}
          </option>
        ))}
        {missing ? <option value={stored}>{`${stored} (not connected)`}</option> : null}
      </select>
      <p className="note">New chat and Start run choose this agent first while it is signed in.</p>
    </section>
  )
}
