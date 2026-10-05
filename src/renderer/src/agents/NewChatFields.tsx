import { useId } from 'react'
import { CHAT_ROLES, canSavePlans } from '../../../shared/agents/chat'
import type { ChatRole } from '../../../shared/agents/chat'
import { AGENT_KINDS } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentKind, AgentView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { agentName, signInLabel } from './agentText'
import { ROLE_LABELS } from './chatList'
import { SignInOffer } from './SignInPrompt'
import type { ModelsState } from './useAgentModels'

const ROLE_HINTS: Readonly<Record<ChatRole, string>> = {
  planner: 'Drafts epics, plans and tickets.',
  orchestrator: 'Runs an epic: claims tickets, starts workers and reviews what they hand back.',
  worker: 'Does one ticket and reports back.',
  reviewer: 'Checks finished work against its criteria.'
}

type Statuses = Readonly<Partial<Record<AgentKind, AgentAuthStatus>>>

/** An agent a chat can run on: connected, and its own CLI says it is signed in. */
export function chattableAgents(agents: readonly AgentView[], statuses: Statuses): AgentView[] {
  return agents.filter((agent) => statuses[agent.kind]?.state === 'signed_in')
}

interface AgentChoiceProps {
  agents: readonly AgentView[]
  statuses: Statuses
  value: AgentKind | null
  onChange(kind: AgentKind): void
  onAddAgent(): void
  /** A sign-in prompt in the list asked an agent's state itself (the agent may now be signed in). */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  /** What to say while no agent is ready; the new-chat wording unless a caller (Start run) has its own. */
  emptyText?: string
}

const NO_AGENT_READY = 'No agent is ready to chat yet. Connect one and sign in to start a chat.'

function Unavailable({ props }: { props: AgentChoiceProps }): JSX.Element | null {
  const labelId = useId()
  const usable = new Set(chattableAgents(props.agents, props.statuses).map((agent) => agent.kind))
  const kinds = AGENT_KINDS.filter((kind) => !usable.has(kind))
  if (kinds.length === 0) {
    return null
  }
  return (
    <div className="chat-unavailable">
      <p id={labelId} className="field-hint">
        Not available
      </p>
      <ul aria-labelledby={labelId} className="chat-unavailable-list">
        {kinds.map((kind) => {
          const connected = props.agents.some((agent) => agent.kind === kind)
          const status = props.statuses[kind]
          const name = agentName(kind)
          return (
            <li key={kind}>
              <span className="chat-unavailable-name">{name}</span>
              <span className="field-hint">{connected ? signInLabel(status).text : 'Not connected'}</span>
              {connected ? (
                <SignInOffer kind={kind} status={status} onStatus={(fresh) => props.onAgentStatus(kind, fresh)} />
              ) : (
                <Button size="sm" onClick={props.onAddAgent}>
                  {`Add ${name}`}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Step one: only connected, signed-in agents can be chosen; a signed-out one has Sign in right there, and the others say why not and where to fix it. */
export function AgentChoice(props: AgentChoiceProps): JSX.Element {
  const ready = chattableAgents(props.agents, props.statuses)
  return (
    <fieldset className="chat-field">
      <legend className="field-label">Agent</legend>
      {ready.length === 0 ? (
        <p className="note">{props.emptyText ?? NO_AGENT_READY}</p>
      ) : (
        ready.map((agent) => (
          <label key={agent.kind} className="chat-choice">
            <input
              type="radio"
              name="new-chat-agent"
              checked={props.value === agent.kind}
              onChange={() => props.onChange(agent.kind)}
            />
            <span>{agentName(agent.kind)}</span>
            {agent.version === null ? null : <span className="field-hint mono">{`v${agent.version}`}</span>}
          </label>
        ))
      )}
      <Unavailable props={props} />
    </fieldset>
  )
}

function ModelNote({ state, agent }: { state: ModelsState; agent: AgentKind }): JSX.Element | null {
  switch (state.status) {
    case 'loading':
      return <p className="note">Loading models…</p>
    case 'unsupported':
      return <p className="note">{`Chats with ${agentName(agent)} are not available in this version yet.`}</p>
    case 'failed':
      return <p className="note">{`Could not list this agent’s models: ${state.message} The chat will use its default model.`}</p>
    case 'ready':
      return state.models.length === 0 ? (
        <p className="note">No models available for this agent yet. The chat will use its default model.</p>
      ) : null
    case 'idle':
      return null
  }
}

interface ModelChoiceProps {
  agent: AgentKind
  state: ModelsState
  value: string | null
  onChange(model: string): void
}

/** Step two: the models the chosen agent offers; without any, a note says what the chat will use instead. */
export function ModelChoice({ agent, state, value, onChange }: ModelChoiceProps): JSX.Element {
  const id = useId()
  const models = state.status === 'ready' ? state.models : []
  return (
    <div className="chat-field">
      <label className="field-label" htmlFor={id}>
        Model
      </label>
      {models.length === 0 ? (
        <ModelNote state={state} agent={agent} />
      ) : (
        <select id={id} className="connect-select" value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

interface RoleChoiceProps {
  role: ChatRole
  allowSave: boolean
  onRole(role: ChatRole): void
  onAllowSave(allow: boolean): void
}

/** Step three: the Dark Mechanicus role; Allow save only exists for the roles that save plans, and starts on. */
export function RoleChoice({ role, allowSave, onRole, onAllowSave }: RoleChoiceProps): JSX.Element {
  const id = useId()
  return (
    <div className="chat-field">
      <label className="field-label" htmlFor={id}>
        Role
      </label>
      <select id={id} className="connect-select" value={role} onChange={(event) => onRole(event.target.value as ChatRole)}>
        {CHAT_ROLES.map((option) => (
          <option key={option} value={option}>
            {ROLE_LABELS[option]}
          </option>
        ))}
      </select>
      <span className="field-hint">{ROLE_HINTS[role]}</span>
      {canSavePlans(role) ? (
        <label className="connect-check">
          <input type="checkbox" checked={allowSave} onChange={(event) => onAllowSave(event.target.checked)} />
          <span>Allow save</span>
          <span className="field-hint">
            Lets it save plans (<code>--allow-save</code>)
          </span>
        </label>
      ) : null}
    </div>
  )
}
