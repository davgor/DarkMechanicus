import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { agentVersionLabel, signInLabel } from '../agents/agentText'
import { SignInOffer } from '../agents/SignInPrompt'
import type { AgentStatuses } from '../agents/useAgents'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'

interface AgentsSectionProps {
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** The id of the agent whose page is open in the main area. */
  selected: AgentId | null
  onAdd(): void
  onSelect(id: AgentId): void
  /** A sign-in prompt asked an agent's state itself: the shell shows what it found. */
  onStatus(id: AgentId, status: AgentAuthStatus): void
}

interface AgentRowProps {
  agent: AgentView
  statuses: AgentStatuses
  selected: boolean
  onSelect(id: AgentId): void
  onStatus(id: AgentId, status: AgentAuthStatus): void
}

/** An agent that needs attention says so right on its row: Sign in when it is signed out, its reason and Check again when its state is unknown. */
function AgentRow({ agent, statuses, selected, onSelect, onStatus }: AgentRowProps): JSX.Element {
  const state = signInLabel(statuses[agent.id])
  return (
    <li>
      <button
        type="button"
        className={classNames('agent-row', selected && 'is-selected')}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(agent.id)}
      >
        <Icon name="plug" />
        <span className="agent-text">
          <span className="agent-name">{agent.displayName}</span>
          <span className="agent-meta">
            <span className="mono">{agentVersionLabel(agent)}</span>
            <span className={`agent-state tone-${state.tone}`}>
              <span className="agent-state-dot" aria-hidden="true" />
              {state.text}
            </span>
          </span>
        </span>
      </button>
      <div className="agent-row-offer">
        <SignInOffer agent={agent.id} name={agent.displayName} status={statuses[agent.id]} onStatus={(status) => onStatus(agent.id, status)} />
      </div>
    </li>
  )
}

/** The connected agents above the folders, with the + that opens the add-agent pane. */
export function AgentsSection({ agents, statuses, selected, onAdd, onSelect, onStatus }: AgentsSectionProps): JSX.Element {
  return (
    <section className="sidebar-agents" aria-label="Agents">
      <div className="sidebar-head">
        <span className="eyebrow">AGENTS</span>
        <Button variant="ghost" icon="plus" aria-label="Add an agent" onClick={onAdd} />
      </div>
      {agents.length === 0 ? (
        <p className="sidebar-note">No agents yet. Use + to add one.</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              statuses={statuses}
              selected={selected === agent.id}
              onSelect={onSelect}
              onStatus={onStatus}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
