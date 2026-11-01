import { useId } from 'react'
import { CHAT_ROLES, canSavePlans } from '../../../shared/agents/chat'
import type { ChatRole } from '../../../shared/agents/chat'
import { AGENT_DEFINITIONS, AGENT_KINDS } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { agentName, agentVersionLabel, signInLabel } from './agentText'
import { ROLE_LABELS } from './chatList'
import { SignInOffer } from './SignInPrompt'
import type { ModelsState } from './useAgentModels'

const ROLE_HINTS: Readonly<Record<ChatRole, string>> = {
  planner: 'Drafts epics, plans and tickets.',
  orchestrator: 'Runs an epic: claims tickets, starts workers and reviews what they hand back.',
  worker: 'Does one ticket and reports back.',
  reviewer: 'Checks finished work against its criteria.'
}

type Statuses = Readonly<Partial<Record<AgentId, AgentAuthStatus>>>

/** An agent a chat can run on: connected, and its own CLI says it is signed in, or its sign-in cannot be checked. */
export function chattableAgents(agents: readonly AgentView[], statuses: Statuses): AgentView[] {
  return agents.filter((agent) => {
    const state = statuses[agent.id]?.state
    return state === 'signed_in' || state === 'unchecked'
  })
}

interface AgentChoiceProps {
  agents: readonly AgentView[]
  statuses: Statuses
  value: AgentId | null
  onChange(id: AgentId): void
  onAddAgent(): void
  /** A sign-in prompt in the list asked an agent's state itself (the agent may now be signed in). */
  onAgentStatus(id: AgentId, status: AgentAuthStatus): void
  /** What to say while no agent is ready; the new-chat wording unless a caller (Start run) has its own. */
  emptyText?: string
}

const NO_AGENT_READY = 'No agent is ready to chat yet. Connect one and sign in to start a chat.'

/** A row of the not-available list: a connected agent that cannot chat yet, or a built-in kind that is not connected. */
type UnavailableRow = { key: AgentId; name: string; agent: AgentView | null }

function unavailableRows(props: AgentChoiceProps): UnavailableRow[] {
  const usable = new Set(chattableAgents(props.agents, props.statuses).map((agent) => agent.id))
  const builtIns = AGENT_KINDS.map((kind) => {
    const agent = props.agents.find((candidate) => candidate.id === kind) ?? null
    return { key: kind, name: agent?.displayName ?? AGENT_DEFINITIONS[kind].displayName, agent }
  })
  const custom = props.agents.filter((agent) => agent.kind === 'custom').map((agent) => ({ key: agent.id, name: agent.displayName, agent }))
  return [...builtIns, ...custom].filter((row) => !usable.has(row.key))
}

function Unavailable({ props }: { props: AgentChoiceProps }): JSX.Element | null {
  const labelId = useId()
  const rows = unavailableRows(props)
  if (rows.length === 0) {
    return null
  }
  return (
    <div className="chat-unavailable">
      <p id={labelId} className="field-hint">
        Not available
      </p>
      <ul aria-labelledby={labelId} className="chat-unavailable-list">
        {rows.map(({ key, name, agent }) => {
          const status = props.statuses[key]
          return (
            <li key={key}>
              <span className="chat-unavailable-name">{name}</span>
              <span className="field-hint">{agent === null ? 'Not connected' : signInLabel(status).text}</span>
              {agent === null ? (
                <Button size="sm" onClick={props.onAddAgent}>
                  {`Add ${name}`}
                </Button>
              ) : (
                <SignInOffer agent={agent.id} name={name} status={status} onStatus={(fresh) => props.onAgentStatus(agent.id, fresh)} />
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
          <label key={agent.id} className="chat-choice">
            <input
              type="radio"
              name="new-chat-agent"
              checked={props.value === agent.id}
              onChange={() => props.onChange(agent.id)}
            />
            <span>{agent.displayName}</span>
            <span className="field-hint mono">{agentVersionLabel(agent)}</span>
          </label>
        ))
      )}
      <Unavailable props={props} />
    </fieldset>
  )
}

function ModelNote({ state, agent }: { state: ModelsState; agent: AgentId }): JSX.Element | null {
  switch (state.status) {
    case 'loading':
      return <p className="note">Loading models…</p>
    case 'unsupported':
      return <p className="note">{`Chats with ${agentName(agent)} are not available in this version yet.`}</p>
    case 'failed':
      return <p className="note">{`Could not list this agent’s models: ${state.message} The chat will use its default model.`}</p>
    case 'ready':
    case 'idle':
      return null
  }
}

interface ModelChoiceProps {
  agent: AgentId
  state: ModelsState
  value: string | null
  onChange(model: string): void
}

/** The one choice of an agent that lists no models (a custom ACP CLI): the chat is created with `model: null`, so the CLI picks. */
function CliDefault({ id }: { id: string }): JSX.Element {
  return (
    <>
      <select id={id} className="connect-select">
        <option value="">CLI default</option>
      </select>
      <span className="field-hint">The CLI picks its own model.</span>
    </>
  )
}

/** Step two: the models the chosen agent offers; one that lists none offers CLI default, and a list that could not be read says why. */
export function ModelChoice({ agent, state, value, onChange }: ModelChoiceProps): JSX.Element {
  const id = useId()
  const models = state.status === 'ready' ? state.models : []
  if (state.status === 'ready' && models.length === 0) {
    return (
      <div className="chat-field">
        <label className="field-label" htmlFor={id}>
          Model
        </label>
        <CliDefault id={id} />
      </div>
    )
  }
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
