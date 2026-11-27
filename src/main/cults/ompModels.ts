/**
 * The models a cult may run on: what OMP lists (`omp models --json`) for the providers OMP is signed in for
 * (`omp usage --json`, classified by `agentAuth.ts`), cheapest tier first (docs/design/cults.md, section 4).
 *
 * - Both commands run shell-free through `planCliLaunch`, with a constant argument list and a timeout, the way the
 *   sign-in status check runs OMP. The usage output (which names accounts) is read for provider names only.
 * - The tier comes only from what a model declares: `cost.output` (USD per million output tokens) when
 *   `pricingStatus` is `fixed`. Never from a vendor or model name. Anything else is `unpriced`: listed last and never
 *   picked as the cheapest.
 * - An option's `id` is OMP's `selector` (`provider/id`), passed as `--model`, so only ids that pass `isSafeModelId`
 *   are listed.
 * - Without OMP, or signed out, the list is empty with a reason. There is never a fallback model.
 */
import { z } from 'zod'
import { isSafeModelId } from '../../shared/agents/models'
import type { AgentAuthState } from '../../shared/desktop/api'
import { getOmpSignIn } from '../desktop/agentAuth'
import { planCliLaunch, type AgentProbeDeps, type ProcessOutcome } from '../desktop/agentProbe'

/** At or below this output price (USD per 1M tokens) a model is `low`. */
const LOW_TIER_MAX_OUTPUT_COST = 5
/** At or above this output price (USD per 1M tokens) a model is `high`; between the two it is `normal`. */
const HIGH_TIER_MIN_OUTPUT_COST = 25

type CultModelTier = 'low' | 'normal' | 'high' | 'unpriced'

export interface CultModelOption {
  /** OMP's `provider/id` selector, the value of `--model`. */
  id: string
  provider: string
  label: string
  tier: CultModelTier
}

/** The models offered, cheapest first, or none with the reason why. */
interface CultModelList {
  options: readonly CultModelOption[]
  reason: string | null
}

/** Cheapest first: a model above the cheapest offered tier needs a reason (`cult_summon_acolyte`'s `tierReason`). */
export const TIER_RANK: Readonly<Record<CultModelTier, number>> = { low: 0, normal: 1, high: 2, unpriced: 3 }

/** `omp models --json` printed 7.8 kB in 0.61 s (docs/design/cults.md, section 4); the margin matches `omp usage`. */
const MODELS_TIMEOUT_MS = 10_000
const MODELS_ARGS: readonly string[] = ['models', '--json']
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

const ompModelSchema = z.object({
  provider: z.string(),
  kind: z.string(),
  selector: z.string(),
  name: z.string(),
  cost: z.object({ output: z.number() }),
  pricingStatus: z.string()
})
const ompModelsSchema = z.object({ models: z.array(z.unknown()) })

type OmpModel = z.infer<typeof ompModelSchema>

export function tierOf(model: Pick<OmpModel, 'cost' | 'pricingStatus'>): CultModelTier {
  if (model.pricingStatus !== 'fixed') {
    return 'unpriced'
  }
  const output = model.cost.output
  if (output <= LOW_TIER_MAX_OUTPUT_COST) {
    return 'low'
  }
  return output >= HIGH_TIER_MIN_OUTPUT_COST ? 'high' : 'normal'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(ANSI_ESCAPE, '')) as unknown
  } catch {
    return null
  }
}

/**
 * The chat models of `signedIn` providers in an `omp models --json` document, cheapest first, or null when the
 * document is not that shape. An entry that does not parse, or whose selector is unsafe, is left out.
 */
export function parseOmpModels(text: string, signedIn: readonly string[]): CultModelOption[] | null {
  const document = ompModelsSchema.safeParse(parseJson(text))
  if (!document.success) {
    return null
  }
  const providers = new Set(signedIn)
  return document.data.models
    .flatMap((entry) => {
      const model = ompModelSchema.safeParse(entry)
      return model.success ? [model.data] : []
    })
    .filter((model) => model.kind === 'chat' && providers.has(model.provider) && isSafeModelId(model.selector))
    .map((model) => ({ id: model.selector, provider: model.provider, label: model.name, tier: tierOf(model) }))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

/** The default pick: the first option, unless it has no declared price. */
export function cheapest(options: readonly CultModelOption[]): CultModelOption | null {
  const first = options[0]
  return first === undefined || first.tier === 'unpriced' ? null : first
}

function none(reason: string): CultModelList {
  return { options: [], reason }
}

function interpretModels(outcome: ProcessOutcome, providers: readonly string[]): CultModelList {
  if (outcome.kind === 'timed_out') {
    return none('OMP did not list its models in time.')
  }
  if (outcome.kind === 'spawn_failed') {
    return none(outcome.code === null ? 'OMP did not start.' : `OMP did not start (${outcome.code}).`)
  }
  if (outcome.exitCode !== 0) {
    return none(`OMP could not list its models (exit code ${outcome.exitCode}).`)
  }
  const options = parseOmpModels(outcome.output, providers)
  if (options === null) {
    return none('OMP listed its models in a way this app does not recognise.')
  }
  return options.length > 0 ? { options, reason: null } : none('OMP lists no usable model for the providers it is signed in for.')
}

/** What a listing found, with the sign-in state it was made under. */
interface Listing {
  list: CultModelList
  signIn: AgentAuthState
}

/** Asks OMP (no cache) for the models it is signed in for, cheapest first, and the sign-in state it found. */
async function listOmpModels(executablePath: string, deps: AgentProbeDeps): Promise<Listing> {
  const signIn = await getOmpSignIn(executablePath, deps)
  if (signIn.status.state !== 'signed_in') {
    return { list: none(signIn.status.reason), signIn: signIn.status.state }
  }
  const plan = planCliLaunch(executablePath, MODELS_ARGS, deps)
  if ('ok' in plan) {
    return { list: none(plan.reason), signIn: 'signed_in' }
  }
  const outcome = await deps.run(plan.launch, deps.timeoutMs ?? MODELS_TIMEOUT_MS)
  return { list: interpretModels(outcome, signIn.providers), signIn: 'signed_in' }
}

interface OmpModelCatalogOptions {
  /** The connected OMP executable, or null when OMP is not connected. */
  ompPath: () => string | null
  deps: AgentProbeDeps
}

/** A cached model list: asked once, again on `refresh`, and again after OMP's sign-in status changes. */
interface OmpModelCatalog {
  list(): Promise<CultModelList>
  refresh(): Promise<CultModelList>
  /** Tells the catalog OMP's current sign-in state; a state other than the cached list's drops the cache. */
  signInChanged(state: AgentAuthState): void
}

const OMP_NOT_CONNECTED = 'OMP is not connected, so no model can be offered.'

export function createOmpModelCatalog(options: OmpModelCatalogOptions): OmpModelCatalog {
  let cached: Promise<Listing> | null = null
  let cachedState: AgentAuthState | null = null
  const load = (): Promise<Listing> => {
    const path = options.ompPath()
    const pending = path === null ? Promise.resolve({ list: none(OMP_NOT_CONNECTED), signIn: 'unchecked' as const })
      : listOmpModels(path, options.deps)
    const settled = pending.then((listing) => {
      if (cached === settled) cachedState = listing.signIn
      return listing
    })
    cached = settled
    cachedState = null
    return settled
  }
  return {
    list: async () => (await (cached ?? load())).list,
    refresh: async () => (await load()).list,
    signInChanged: (state) => {
      if (cachedState !== null && state !== cachedState) {
        cached = null
        cachedState = null
      }
    }
  }
}
