/**
 * The model and thinking level a new chat starts on (New chat, Start run, Play, a transfer, the Lexmechanic card), as
 * main checks them before the chat is created. A Skitarii (OMP) chat's model must be in its agent's catalog, named
 * `provider/id`, and a thinking level must be one that model takes, as `agentChat:setModel` checks a live switch
 * (`agentChatSessions.ts`); only a Skitarii chat takes a thinking level, and only with a model. Another agent's model
 * is checked where it reaches a command line (`terminalLaunchSpec.ts`), as before.
 */
import { DomainError } from '../../core/errors'
import type { ThinkingLevel } from '../../shared/agents/chat'
import type { AgentId, AgentView } from '../../shared/desktop/api'
import type { OmpModels } from '../agentChat/ompModels'

export interface ModelChoice {
  model?: string | null
  thinking?: ThinkingLevel | null
}

export interface ModelChoiceDeps {
  agents: { get(id: AgentId): AgentView | null }
  /** The Skitarii catalogs (`omp models --json`); without them a Skitarii chat cannot be given a model. */
  models?: Pick<OmpModels, 'catalogModels'>
}

/** A Skitarii model (`provider/id`) must be in the agent's catalog, and a thinking level one the model takes. */
async function checkCatalogModel(deps: ModelChoiceDeps, agentId: AgentId, model: string, thinking: ThinkingLevel | null): Promise<void> {
  if (deps.models === undefined) throw new DomainError('operation_unavailable', 'The Skitarii model catalog is not available.')
  const option = (await deps.models.catalogModels(agentId)).find((candidate) => `${candidate.provider}/${candidate.id}` === model)
  if (option === undefined) throw new DomainError('invalid_input', `${model} is not in this agent's model catalog.`)
  if (thinking !== null && !option.efforts.includes(thinking)) {
    throw new DomainError('invalid_input', `${model} does not take the ${thinking} thinking level.`)
  }
}

/** Throws `invalid_input` (or `unsupported_agent`) when `agentId` cannot start on `choice`; resolves when it can. */
export async function checkModelChoice(deps: ModelChoiceDeps, agentId: AgentId, choice: ModelChoice): Promise<void> {
  const model = choice.model ?? null
  const thinking = choice.thinking ?? null
  if (deps.agents.get(agentId)?.kind !== 'omp') {
    if (thinking !== null) throw new DomainError('unsupported_agent', 'Only a Skitarii chat takes a thinking level.')
    return
  }
  if (model !== null) return checkCatalogModel(deps, agentId, model, thinking)
  if (thinking !== null) throw new DomainError('invalid_input', 'Choose a model for the thinking level.')
}
