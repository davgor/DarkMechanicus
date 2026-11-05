import { useId } from 'react'
import type { AgentModels } from '../../../shared/agents/models'
import { AGENT_DEFINITIONS, AGENT_KINDS } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { agentVersionLabel, signInLabel } from './agentText'
import { SignInOffer } from './SignInPrompt'

type Statuses = Readonly<Partial<Record<AgentId, AgentAuthStatus>>>

/** An agent a chat can run on: connected, and its own CLI says it is signed in, or its sign-in cannot be checked. */
export function chattableAgents(agents: readonly AgentView[], statuses: Statuses): AgentView[] {
  return agents.filter((agent) => {
    const state = statuses[agent.id]?.state
    return state === 'signed_in' || state === 'unchecked'
  })
}

/**
 * The agent New chat opens: the folder's default while it is connected (signed out too: its terminal says
 * so), else OMP when it can chat, else the first agent that can chat, else the first connected one; null when
 * none is connected.
 */
export function newChatAgent(defaultId: AgentId | null, agents: readonly AgentView[], statuses: Statuses): AgentId | null {
  if (defaultId !== null && agents.some((agent) => agent.id === defaultId)) return defaultId
  const chattable = chattableAgents(agents, statuses)
  return (chattable.find((agent) => agent.id === 'omp') ?? chattable[0] ?? agents[0])?.id ?? null
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

interface ModelChoiceProps {
  models: AgentModels
  /** The listed model picked, or the text typed (`useAgentModelChoice`). */
  value: string
  /** The typed model may go on a command line; one that may not says so. */
  valid: boolean
  onChange(model: string): void
}

/**
 * Step two: the chosen agent's model as the app knows it without asking the agent (`agentModels`). Claude Code
 * picks from its curated aliases; Autonomous takes a typed id (empty for its default); the rest start on the
 * model their CLI picks. The CLI's own `/model` changes it once the chat runs.
 */
export function ModelChoice({ models, value, valid, onChange }: ModelChoiceProps): JSX.Element {
  const id = useId()
  return (
    <div className="chat-field">
      <label className="field-label" htmlFor={id}>
        Model
      </label>
      {models.kind === 'list' ? (
        <select id={id} className="connect-select" value={value} onChange={(event) => onChange(event.target.value)}>
          {models.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      ) : null}
      {models.kind === 'free' ? (
        <>
          <input
            id={id}
            className="input mono"
            value={value}
            placeholder="Default"
            spellCheck={false}
            aria-invalid={!valid}
            onChange={(event) => onChange(event.target.value)}
          />
          {valid ? (
            <span className="field-hint">Leave it empty for the agent’s default model, or type an id such as provider/model.</span>
          ) : (
            <p role="alert" className="form-error">
              A model id holds only letters, digits and . _ / + -, and cannot start with one of the symbols.
            </p>
          )}
        </>
      ) : null}
      {models.kind === 'cli' ? (
        <>
          <select id={id} className="connect-select">
            <option value="">CLI default</option>
          </select>
          <span className="field-hint">The CLI picks its own model.</span>
        </>
      ) : null}
    </div>
  )
}
