import type { AgentAuthStatus, AgentKind, AgentView } from '../../../shared/desktop/api'
import { agentName, signInLabel } from '../agents/agentText'
import { SignInOffer } from '../agents/SignInPrompt'
import type { AgentStatuses } from '../agents/useAgents'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'

interface AgentsSectionProps {
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** The agent whose page is open in the main area. */
  selected: AgentKind | null
  onAdd(): void
  onSelect(kind: AgentKind): void
  /** A sign-in prompt asked an agent's state itself: the shell shows what it found. */
  onStatus(kind: AgentKind, status: AgentAuthStatus): void
}

interface AgentRowProps {
  agent: AgentView
  statuses: AgentStatuses
  selected: boolean
  onSelect(kind: AgentKind): void
  onStatus(kind: AgentKind, status: AgentAuthStatus): void
}

/** An agent that needs attention says so right on its row: Sign in when it is signed out, its reason and Check again when its state is unknown. */
function AgentRow({ agent, statuses, selected, onSelect, onStatus }: AgentRowProps): JSX.Element {
  const state = signInLabel(statuses[agent.kind])
  return (
    <li>
      <button
        type="button"
        className={classNames('agent-row', selected && 'is-selected')}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(agent.kind)}
      >
        <Icon name="plug" />
        <span className="agent-text">
          <span className="agent-name">{agentName(agent.kind)}</span>
          <span className="agent-meta">
            <span className="mono">{agent.version === null ? 'Version unknown' : `v${agent.version}`}</span>
            <span className={`agent-state tone-${state.tone}`}>
              <span className="agent-state-dot" aria-hidden="true" />
              {state.text}
            </span>
          </span>
        </span>
      </button>
      <div className="agent-row-offer">
        <SignInOffer kind={agent.kind} status={statuses[agent.kind]} onStatus={(status) => onStatus(agent.kind, status)} />
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
              key={agent.kind}
              agent={agent}
              statuses={statuses}
              selected={selected === agent.kind}
              onSelect={onSelect}
              onStatus={onStatus}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
