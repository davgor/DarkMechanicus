import { useState } from 'react'
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
  /** What the model choice shows: the listed model picked (else the first), or the text typed. */
  value: string
  /** The model the agent starts on: null for the CLI's own default (`default`, an empty text, or an agent that takes none). */
  model: string | null
  /** A typed model holds only characters that may go on a command line (`isSafeModelId`); always true otherwise. */
  valid: boolean
  chooseAgent(id: AgentId): void
  chooseModel(model: string): void
}

interface Picked {
  agent: AgentId | null
  model: string | null
}

interface Model {
  value: string
  model: string | null
  valid: boolean
}

function listed(picked: string | null, models: readonly ModelOption[]): Model {
  const value = models.find((model) => model.id === picked)?.id ?? models[0]?.id ?? 'default'
  return { value, model: value === 'default' ? null : value, valid: true }
}

function typed(picked: string | null): Model {
  const value = picked ?? ''
  const id = value.trim()
  return { value, model: id === '' ? null : id, valid: id === '' || isSafeModelId(id) }
}

function modelFor(picked: string | null, models: AgentModels): Model {
  switch (models.kind) {
    case 'list':
      return listed(picked, models.models)
    case 'free':
      return typed(picked)
    case 'cli':
      return { value: '', model: null, valid: true }
  }
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
  const [picked, setPicked] = useState<Picked>({ agent: null, model: null })
  const ready = chattableAgents(agents, statuses)
  const usable = (id: AgentId | null): AgentView | undefined => ready.find((candidate) => candidate.id === id)
  const agent = usable(picked.agent) ?? usable(preferredAgentId) ?? ready[0] ?? null
  const models: AgentModels = agent === null ? { kind: 'cli' } : agentModels(agent.kind)
  const model = modelFor(agent !== null && agent.id === picked.agent ? picked.model : null, models)
  return {
    agent: agent?.id ?? null,
    models,
    ...model,
    chooseAgent: (id) => setPicked({ agent: id, model: null }),
    chooseModel: (value) => setPicked({ agent: agent?.id ?? null, model: value })
  }
}
