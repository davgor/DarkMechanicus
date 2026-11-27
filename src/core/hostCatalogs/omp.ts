/**
 * The `register_host` payload a Skitarii (OMP) Magos registers, mapped from OMP's own model catalog
 * (`chatModelOptions`) so the Magos never types it by hand. Pure: main lists the catalog and writes the payload to the
 * chat's private folder (`workerCatalog.ts`); the Magos still calls `register_host` itself.
 *
 * Only the latest model of each line (`featuredModels`) is listed, plus the model the Magos itself runs on when that
 * is another one, so `match_capabilities` recommends current models only. Each model maps as follows:
 * - `id` is OMP's `provider/id` (what OMP's task tool takes as a subagent's `model`), `label` its name;
 * - `efforts` are the model's thinking levels that DM also names (`low`, `medium`, `high`), in DM's order; a model
 *   with no thinking levels declares none, so any effort is accepted (OMP ignores the level for it);
 * - `modalities` are `text`, plus `images` when the model reads images; `contextWindowTokens` its context window;
 * - `costTier` comes from the input price per million tokens: under 1.5 USD `low`, up to 5 USD `normal`, otherwise
 *   `high`; null when the catalog does not price the model;
 * - `reasoningLevels`: a reasoning model costed `normal` or `high` (or unpriced) takes all three; a `low`-cost
 *   reasoning model `routine` and `multi_step`; a model that does not reason `routine` only;
 * - `skills` is empty: the catalog says nothing about them.
 */
import { featuredModels, type ChatModelOption } from '../../shared/agents/models'
import { REASONING_EFFORTS, type ReasoningEffort, type ReasoningLevel } from '../../shared/domain/bundle'
import type { HostCatalog, HostModel } from '../../shared/domain/views'

type CostTier = NonNullable<HostModel['costTier']>

/** The host DM registers OMP as; one Magos host per app, whichever providers it is signed into. */
const OMP_HOST_ID = 'omp'
/**
 * What an OMP session can do on its own: read and edit files, run commands (tests included), browse and fetch.
 * The Magos removes any its configuration turned off before registering.
 */
const OMP_TOOLS: HostCatalog['tools'] = ['repo_read', 'repo_write', 'shell', 'browser', 'test_execution', 'network']
const LOW_COST_BELOW = 1.5
const NORMAL_COST_UP_TO = 5

function costTier(inputCost: number | null): CostTier | null {
  if (inputCost === null) return null
  return inputCost < LOW_COST_BELOW ? 'low' : inputCost <= NORMAL_COST_UP_TO ? 'normal' : 'high'
}

function reasoningLevels(option: ChatModelOption, tier: CostTier | null): ReasoningLevel[] {
  if (!option.reasoning) return ['routine']
  return tier === 'low' ? ['routine', 'multi_step'] : ['routine', 'multi_step', 'deep']
}

function hostModel(option: ChatModelOption): HostModel {
  const tier = costTier(option.inputCost)
  const efforts = REASONING_EFFORTS.filter((effort): effort is ReasoningEffort => option.efforts.includes(effort))
  return {
    id: `${option.provider}/${option.id}`,
    label: option.name,
    reasoningLevels: reasoningLevels(option, tier),
    ...(option.efforts.length === 0 ? {} : { efforts }),
    modalities: option.images ? ['text', 'images'] : ['text'],
    contextWindowTokens: option.contextWindow,
    skills: [],
    costTier: tier,
    latencyTier: null
  }
}

/** FNV-1a over the text, as 8 hex digits: the same models always give the same catalog revision. */
function digest(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The models to register: the featured ones, then `current` (the Magos's own model, as `provider/id` or OMP's bare
 * id) when the catalog has it and it is not featured already.
 */
function ompHostModels(options: readonly ChatModelOption[], current: string | null): HostModel[] {
  const chosen = featuredModels(options).featured
  const running = current === null ? undefined : options.find((option) => `${option.provider}/${option.id}` === current || option.id === current)
  if (running !== undefined && !chosen.includes(running)) chosen.push(running)
  return chosen.map(hostModel)
}

/** The whole `register_host` input; its `catalogRevision` changes exactly when the listed models do. */
export function ompHostCatalog(options: readonly ChatModelOption[], current: string | null = null): HostCatalog {
  const models = ompHostModels(options, current)
  return {
    hostId: OMP_HOST_ID,
    hostType: 'omp',
    catalogRevision: `omp-${digest(JSON.stringify(models))}`,
    tools: [...OMP_TOOLS],
    canSelectWorkerModel: true,
    models
  }
}
