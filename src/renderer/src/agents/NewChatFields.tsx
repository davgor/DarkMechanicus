import { useCallback, useId } from 'react'
import type { AgentChatModelChoice } from '../../../shared/agents/agentChat'
import type { ThinkingLevel } from '../../../shared/agents/chat'
import { pickChatAgent } from '../../../shared/agents/pickChatAgent'
import { AGENT_DEFINITIONS, AGENT_KINDS } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { ModelPicker } from '../agentChat/ModelPicker'
import { Button } from '../components/Button'
import { agentVersionLabel, signInLabel } from './agentText'
import { SignInOffer } from './SignInPrompt'
import type { AgentModelChoice } from './useAgentModelChoice'

type Statuses = Readonly<Partial<Record<AgentId, AgentAuthStatus>>>

/** An agent a chat can run on: connected, and its own CLI says it is signed in, or its sign-in cannot be checked. */
export function chattableAgents(agents: readonly AgentView[], statuses: Statuses): AgentView[] {
  return agents.filter((agent) => {
    const state = statuses[agent.id]?.state
    return state === 'signed_in' || state === 'unchecked'
  })
}

/**
 * Keep an explicit connected folder default. Otherwise prefer the signed-in GUI agent,
 * retaining the existing sign-in path when no agent is ready.
 */
export function newChatAgent(defaultId: AgentId | null, agents: readonly AgentView[], statuses: Statuses): AgentId | null {
  if (defaultId !== null && agents.some((agent) => agent.id === defaultId)) return defaultId
  const chattable = chattableAgents(agents, statuses)
  return pickChatAgent(agents, statuses)?.agentId ?? chattable[0]?.id ?? agents[0]?.id ?? null
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

interface CatalogModelChoiceProps {
  /** The tracked folder the chat starts in (null when none is known yet); main checks it with the catalog request. */
  folder: string | null
  /** A Skitarii (OMP) agent, whose catalog is listed (`agentChat:models`). */
  agent: AgentId
  /** The model chosen (`provider/id`), or null for Default. */
  model: string | null
  thinking: ThinkingLevel | null
  /** A model and its effort; null and null for Default. */
  onChange(model: string | null, thinking: ThinkingLevel | null): void
  label?: string
}

/**
 * A Skitarii chat's model and effort before the chat exists, chosen from the agent's OMP catalog with the composer's
 * picker (`ModelPicker`: the latest model of each line, More models and Effort), plus Default, which leaves both to
 * the person's OMP configuration.
 */
export function CatalogModelChoice({ folder, agent, model, thinking, onChange, label = 'Model' }: CatalogModelChoiceProps): JSX.Element {
  const labelId = useId()
  const load = useCallback(() => window.dm.agentChat.models({ folder, agentId: agent }), [folder, agent])
  const choose = (choice: AgentChatModelChoice): Promise<{ ok: true; data: null }> => {
    onChange(`${choice.provider}/${choice.modelId}`, choice.effort ?? null)
    return Promise.resolve({ ok: true, data: null })
  }
  return (
    <div className="chat-field model-choice" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="field-label">{label}</span>
      <ModelPicker key={agent} state={{ model, thinking, status: 'idle' }} load={load} choose={choose} onDefault={() => onChange(null, null)} />
      <span className="field-hint">Default starts on the model and effort set in OMP.</span>
    </div>
  )
}

interface ModelChoiceProps {
  /** The agent and model being picked (`useAgentModelChoice`). */
  choice: AgentModelChoice
  /** The tracked folder the chat starts in; null when the dialog does not know it. */
  folder: string | null
}

/**
 * Step two: the chosen agent's model as the app knows it (`agentModels`). Claude Code picks from its curated aliases;
 * Autonomous takes a typed id (empty for its default); OMP picks from its own catalog (`CatalogModelChoice`), with an
 * effort; the rest start on the model their CLI picks. The CLI's own `/model` changes it once the chat runs.
 */
export function ModelChoice({ choice, folder }: ModelChoiceProps): JSX.Element {
  const { models, value, valid } = choice
  const id = useId()
  if (models.kind === 'catalog' && choice.agent !== null) {
    return <CatalogModelChoice folder={folder} agent={choice.agent} model={choice.model} thinking={choice.thinking}
      onChange={(model, thinking) => choice.chooseModel(model ?? '', thinking)} />
  }
  return (
    <div className="chat-field">
      <label className="field-label" htmlFor={id}>
        Model
      </label>
      {models.kind === 'list' ? (
        <select id={id} className="connect-select" value={value} onChange={(event) => choice.chooseModel(event.target.value)}>
          {models.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      ) : null}
      {models.kind === 'free' ? <TypedModel id={id} value={value} valid={valid} onChange={(model) => choice.chooseModel(model)} /> : null}
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

/** An agent without a model list (Autonomous): a typed id, empty for its default, refused when it may not go on a command line. */
function TypedModel({ id, value, valid, onChange }: { id: string; value: string; valid: boolean; onChange(model: string): void }): JSX.Element {
  return (
    <>
      <input id={id} className="input mono" value={value} placeholder="Default" spellCheck={false} aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)} />
      {valid ? (
        <span className="field-hint">Leave it empty for the agent’s default model, or type an id such as provider/model.</span>
      ) : (
        <p role="alert" className="form-error">
          A model id holds only letters, digits and . _ / + -, and cannot start with one of the symbols.
        </p>
      )}
    </>
  )
}
