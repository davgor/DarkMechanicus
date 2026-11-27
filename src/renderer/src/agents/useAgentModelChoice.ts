import { useState } from 'react'
import type { ThinkingLevel } from '../../../shared/agents/chat'
import { agentModels, isSafeModelId } from '../../../shared/agents/models'
import type { AgentModels, ModelOption } from '../../../shared/agents/models'
import type { AgentId, AgentView } from '../../../shared/desktop/api'
import { chattableAgents } from './NewChatFields'
import type { AgentStatuses } from './useAgents'

/** The agent and model a person is picking: only connected, signed-in agents, then that agent's model. */
export interface AgentModelChoice {
  /** The agent chosen; the first one that can chat stands in until one is picked, and again if the picked one stops being able to. Null when none can. */
  agent: AgentId | null
  /** How the chosen agent's model is chosen (`agentModels`); `cli` while no agent is chosen. */
  models: AgentModels
  /** What the model choice shows: the listed model picked (else the first), the text typed, or the catalog model (`provider/id`). */
  value: string
  /** The model the agent starts on: null for the CLI's own default (`default`, an empty text, Default, or an agent that takes none). */
  model: string | null
  /** A Skitarii model's effort (`--thinking`), chosen with it from the catalog; null otherwise. */
  thinking: ThinkingLevel | null
  /** A typed model holds only characters that may go on a command line (`isSafeModelId`); always true otherwise. */
  valid: boolean
  chooseAgent(id: AgentId): void
  /** A model, and for a catalog model its effort; an empty model is the default. */
  chooseModel(model: string, thinking?: ThinkingLevel | null): void
}

interface Picked {
  agent: AgentId | null
  model: string | null
  thinking: ThinkingLevel | null
}

interface Model {
  value: string
  model: string | null
  thinking: ThinkingLevel | null
  valid: boolean
}

function listed(picked: string | null, models: readonly ModelOption[]): Model {
  const value = models.find((model) => model.id === picked)?.id ?? models[0]?.id ?? 'default'
  return { value, model: value === 'default' ? null : value, thinking: null, valid: true }
}

function typed(picked: string | null): Model {
  const value = picked ?? ''
  const id = value.trim()
  return { value, model: id === '' ? null : id, thinking: null, valid: id === '' || isSafeModelId(id) }
}

/** A catalog model as the picker chose it (main checks it against the catalog), or Default: no model and no effort. */
function cataloged(picked: string | null, thinking: ThinkingLevel | null): Model {
  return picked === null || picked === ''
    ? { value: '', model: null, thinking: null, valid: true }
    : { value: picked, model: picked, thinking, valid: true }
}

/** Nothing picked yet (or picked for another agent): each kind's first or default model. */
const UNPICKED: Picked = { agent: null, model: null, thinking: null }

function modelFor(picked: Picked, models: AgentModels): Model {
  switch (models.kind) {
    case 'list':
      return listed(picked.model, models.models)
    case 'free':
      return typed(picked.model)
    case 'catalog':
      return cataloged(picked.model, picked.thinking)
    case 'cli':
      return { value: '', model: null, thinking: null, valid: true }
  }
}

/** What a start request carries of the choice: its model, and a Skitarii model's effort only when one was chosen. */
export function startModel(choice: Pick<AgentModelChoice, 'model' | 'thinking'>): { model: string | null; thinking?: ThinkingLevel } {
  return choice.thinking === null ? { model: choice.model } : { model: choice.model, thinking: choice.thinking }
}

/**
 * Agent, then model, as Start run asks for them. Until one is picked, the preferred agent (a folder's
 * default) stands in when it can chat, and otherwise the first that can.
 */
export function useAgentModelChoice(
  agents: readonly AgentView[],
  statuses: AgentStatuses,
  preferredAgentId: AgentId | null = null
): AgentModelChoice {
  const [picked, setPicked] = useState<Picked>(UNPICKED)
  const ready = chattableAgents(agents, statuses)
  const usable = (id: AgentId | null): AgentView | undefined => ready.find((candidate) => candidate.id === id)
  const agent = usable(picked.agent) ?? usable(preferredAgentId) ?? ready[0] ?? null
  const models: AgentModels = agent === null ? { kind: 'cli' } : agentModels(agent.kind)
  const model = modelFor(agent !== null && agent.id === picked.agent ? picked : UNPICKED, models)
  return {
    agent: agent?.id ?? null,
    models,
    ...model,
    chooseAgent: (id) => setPicked({ agent: id, model: null, thinking: null }),
    chooseModel: (value, thinking = null) => setPicked({ agent: agent?.id ?? null, model: value, thinking })
  }
}
