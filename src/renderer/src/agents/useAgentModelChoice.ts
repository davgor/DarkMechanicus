import { useState } from 'react'
import type { AgentKind, AgentView } from '../../../shared/desktop/api'
import { chattableAgents } from './NewChatFields'
import type { AgentStatuses } from './useAgents'
import { useAgentModels } from './useAgentModels'
import type { ModelsState } from './useAgentModels'

/** The agent and model a person is picking: only connected, signed-in agents, then that agent's models. */
export interface AgentModelChoice {
  /** The agent chosen; the first one that can chat stands in until one is picked, and again if the picked one stops being able to. Null when none can. */
  agent: AgentKind | null
  /** The model chosen if the agent still offers it, otherwise its first; null when it lists none (the agent's default is used). */
  model: string | null
  models: ModelsState
  /** An agent is chosen and its model list is known: a list, or a failure that falls back to the agent's default model. */
  settled: boolean
  chooseAgent(kind: AgentKind): void
  chooseModel(model: string): void
}

interface Picked {
  agent: AgentKind | null
  model: string | null
}

function modelFor(picked: Picked, state: ModelsState): string | null {
  if (state.status !== 'ready') {
    return null
  }
  const chosen = state.models.find((model) => model.id === picked.model)
  return chosen?.id ?? state.models[0]?.id ?? null
}

const modelsSettled = (state: ModelsState): boolean => state.status === 'ready' || state.status === 'failed'

/** Agent, then model, as the new-chat and Start run dialogs both ask for them. */
export function useAgentModelChoice(agents: readonly AgentView[], statuses: AgentStatuses): AgentModelChoice {
  const [picked, setPicked] = useState<Picked>({ agent: null, model: null })
  const ready = chattableAgents(agents, statuses)
  const agent = ready.find((candidate) => candidate.kind === picked.agent)?.kind ?? ready[0]?.kind ?? null
  const models = useAgentModels(agent)
  return {
    agent,
    model: modelFor(picked, models),
    models,
    settled: agent !== null && modelsSettled(models),
    chooseAgent: (kind) => setPicked({ agent: kind, model: null }),
    chooseModel: (model) => setPicked((previous) => ({ ...previous, model }))
  }
}
