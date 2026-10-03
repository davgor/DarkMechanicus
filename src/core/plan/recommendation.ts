/**
 * Which model and effort to dispatch a ticket's worker at. The top-ranked eligible model leads;
 * after a rejected or failed attempt the recommendation steps up one tier (cost tier, then reasoning
 * depth, both from the catalog), or raises the effort when no tier is left above. Pure.
 */
import { REASONING_EFFORTS, type CapabilityProfile, type ReasoningEffort, type TicketSize } from '../../shared/domain/bundle'
import type { AttemptState } from '../../shared/domain/status'
import type { CapabilityMatchView, CapabilityRecommendation, HostCatalog, HostModel } from '../../shared/domain/views'
import { compareTier } from './modelTiers'

/** What an earlier attempt on the same ticket says about the model that ran it. */
export interface PriorAttempt {
  state: AttemptState
  modelId: string | null
  effort: ReasoningEffort | null
}

type Eligible = CapabilityMatchView['eligible'][number]
type Verdict = PriorAttempt & { state: 'rejected' | 'failed' }

interface RecommendInput {
  profile: CapabilityProfile
  catalog: HostCatalog
  /** Best fit first. */
  eligible: Eligible[]
  size: TicketSize | undefined
  /** Oldest first. */
  attempts: PriorAttempt[]
}

interface Effort {
  effort: ReasoningEffort
  reasons: string[]
}

const SIZE_EFFORT: Record<TicketSize, ReasoningEffort> = { micro: 'low', small: 'low', medium: 'medium', large: 'high' }
const DEFAULT_EFFORT: ReasoningEffort = 'medium'
const VERDICT_WORDS = { rejected: 'was rejected', failed: 'failed' } as const

function effortRank(effort: ReasoningEffort): number {
  return REASONING_EFFORTS.indexOf(effort)
}

function allows(model: HostModel | undefined, effort: ReasoningEffort): boolean {
  const declared = model?.efforts ?? []
  return declared.length === 0 || declared.includes(effort)
}

/** The ticket's own effort, else the size's default, else a medium default; each says which. */
function baseEffort(profile: CapabilityProfile, size: TicketSize | undefined): Effort {
  const own = profile.reasoning.effort
  if (own !== undefined) {
    return { effort: own, reasons: [`Uses the ticket's "${own}" effort.`] }
  }
  if (size !== undefined) {
    const effort = SIZE_EFFORT[size]
    return { effort, reasons: [`No effort set; a ${size} ticket defaults to "${effort}" effort.`] }
  }
  return {
    effort: DEFAULT_EFFORT,
    reasons: [`The ticket sets no size or effort; defaulting to "${DEFAULT_EFFORT}" effort.`]
  }
}

/** Moves an effort onto one the model declares (the next one up, else the highest below): a claim at any other is refused. */
function fitEffort(model: HostModel | undefined, wanted: Effort): Effort {
  if (allows(model, wanted.effort)) {
    return wanted
  }
  const above = REASONING_EFFORTS.find((effort) => effortRank(effort) > effortRank(wanted.effort) && allows(model, effort))
  const below = [...REASONING_EFFORTS].reverse().find((effort) => allows(model, effort))
  const effort = above ?? below ?? wanted.effort
  return { effort, reasons: [...wanted.reasons, `"${wanted.effort}" effort is not one the model declares; using "${effort}" instead.`] }
}

function higherEffort(model: HostModel | undefined, current: ReasoningEffort): ReasoningEffort | null {
  return REASONING_EFFORTS.find((effort) => effortRank(effort) > effortRank(current) && allows(model, effort)) ?? null
}

function modelOf(catalog: HostCatalog, modelId: string): HostModel | undefined {
  return catalog.models.find((model) => model.id === modelId)
}

function recommendation(item: Eligible, lead: string[], effort: Effort): CapabilityRecommendation {
  return { modelId: item.modelId, effort: effort.effort, reasons: [...lead, ...item.reasons, ...effort.reasons] }
}

/** The best-ranked eligible model at the ticket's normal effort. */
function topFit(input: RecommendInput, note?: string): CapabilityRecommendation | null {
  const top = input.eligible[0]
  if (top === undefined) {
    return null
  }
  const count = input.eligible.length
  const lead = [`Top-ranked of ${count} eligible model${count === 1 ? '' : 's'}.`]
  const effort = fitEffort(modelOf(input.catalog, top.modelId), baseEffort(input.profile, input.size))
  return recommendation(top, note === undefined ? lead : [note, ...lead], effort)
}

function lastVerdict(attempts: PriorAttempt[]): Verdict | undefined {
  const isVerdict = (attempt: PriorAttempt): attempt is Verdict => attempt.state === 'rejected' || attempt.state === 'failed'
  return attempts.filter(isVerdict).at(-1)
}

/** The lowest tier strictly above `last` among the eligible models; ranking decides inside a tier. */
function cheapestAbove(input: RecommendInput, last: HostModel): Eligible | undefined {
  let best: { item: Eligible; model: HostModel } | undefined
  for (const item of input.eligible) {
    const model = modelOf(input.catalog, item.modelId)
    const above = model !== undefined && compareTier(model, last) > 0
    if (above && (best === undefined || compareTier(model, best.model) < 0)) {
      best = { item, model }
    }
  }
  return best?.item
}

/** Same model, one effort higher than its last run; unchanged (and said so) when none is higher. */
function sameModelHarder(input: RecommendInput, last: Verdict, same: Eligible): CapabilityRecommendation {
  const model = modelOf(input.catalog, same.modelId)
  const normal = baseEffort(input.profile, input.size).effort
  const current = last.effort ?? normal
  const subject = `Last attempt on "${same.modelId}" ${VERDICT_WORDS[last.state]}`
  const next = higherEffort(model, current)
  if (next === null) {
    const note = `${subject}; nothing eligible sits above it and "${current}" is already its highest effort, so the same model is repeated.`
    return recommendation(same, [note], { effort: current, reasons: [] })
  }
  const raised = `Effort raised from "${current}" to "${next}".`
  return recommendation(same, [`${subject}; nothing eligible sits above it, so the same model runs at higher effort.`], {
    effort: next,
    reasons: [raised]
  })
}

function escalate(input: RecommendInput, last: Verdict): CapabilityRecommendation | null {
  const word = VERDICT_WORDS[last.state]
  if (last.modelId === null) {
    return topFit(input, `Last attempt ${word} but recorded no model; using the normal recommendation.`)
  }
  const subject = `Last attempt on "${last.modelId}" ${word}`
  const model = modelOf(input.catalog, last.modelId)
  if (model === undefined) {
    return topFit(input, `${subject}, but that model is not in the host catalog; using the normal recommendation.`)
  }
  const above = cheapestAbove(input, model)
  if (above !== undefined) {
    const lead = [`${subject}; escalating to the cheapest eligible model one tier above it.`]
    return recommendation(above, lead, fitEffort(modelOf(input.catalog, above.modelId), baseEffort(input.profile, input.size)))
  }
  const same = input.eligible.find((item) => item.modelId === last.modelId)
  if (same === undefined) {
    return topFit(input, `${subject}, but that model is no longer eligible and nothing eligible sits above it; using the normal recommendation.`)
  }
  return sameModelHarder(input, last, same)
}

/** The model and effort to run the ticket at, or null when no model is eligible. */
export function recommend(input: RecommendInput): CapabilityRecommendation | null {
  const verdict = lastVerdict(input.attempts)
  return verdict === undefined ? topFit(input) : escalate(input, verdict)
}
