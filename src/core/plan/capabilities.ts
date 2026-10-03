/**
 * Capability matching: hard constraints of a ticket's provider-neutral profile filter the host's
 * models; preferences only rank the survivors. Ranking favours the model that fits the ticket
 * rather than the most capable one: reasoning depth beyond the ticket's need costs points, and
 * skill tags, quality and cost tiers cannot buy it back. Requirements the catalog cannot vouch for
 * are reported as unknown so the orchestrator escalates instead of silently passing them. Pure.
 */
import type { CapabilityProfile, TicketSize } from '../../shared/domain/bundle'
import type { CapabilityMatchView, HostCatalog, HostModel } from '../../shared/domain/views'
import { costRankOf, costTierOf, highestLevel, rankOf } from './modelTiers'
import { type PriorAttempt, recommend } from './recommendation'

type ProfileMatch = Omit<CapabilityMatchView, 'ticketId' | 'catalogId'>

/** What the profile alone cannot say: the ticket's size and the earlier attempts on it in this run. */
interface MatchContext {
  size?: TicketSize | undefined
  /** Oldest first. */
  attempts?: PriorAttempt[]
}

const BASE_SCORE = 50
/** Per reasoning rank by which a model's highest level exceeds the ticket's need. Larger than every other term. */
const FIT_PENALTY_POINTS = 20
const SKILL_POINTS = 5
/** Below one fit rank, so skill tags nudge but never outweigh fit. */
const SKILL_CAP_POINTS = 10
/** Per cost rank on micro and small tickets; two ranks stay below one fit rank. */
const SMALL_TICKET_COST_POINTS = 8

interface ScoreTerm {
  points: number
  reason: string
}

interface Scoring {
  profile: CapabilityProfile
  model: HostModel
  size: TicketSize | undefined
}

interface PreferenceBonus {
  applies(profile: CapabilityProfile, model: HostModel): boolean
  points: number
  reason: string
}

const PREFERENCE_BONUSES: PreferenceBonus[] = [
  {
    applies: (profile, model) => profile.preferences.cost === 'low' && model.costTier === 'low',
    points: 10,
    reason: 'Low cost tier fits a low-cost preference (+10).'
  },
  {
    applies: (profile, model) => profile.preferences.cost === 'low' && model.costTier === 'high',
    points: -10,
    reason: 'High cost tier works against a low-cost preference (-10).'
  },
  {
    applies: (profile, model) => profile.preferences.latency === 'low' && model.latencyTier === 'low',
    points: 10,
    reason: 'Low latency tier fits a low-latency preference (+10).'
  }
]

function reasoningFailure(profile: CapabilityProfile, model: HostModel): string[] {
  const needed = profile.reasoning.level
  const best = highestLevel(model)
  if (rankOf(needed) <= rankOf(best)) {
    return []
  }
  return [
    best === null
      ? `Needs "${needed}" reasoning; the model lists no reasoning levels.`
      : `Needs "${needed}" reasoning; the model's highest level is "${best}".`
  ]
}

function contextFailure(profile: CapabilityProfile, model: HostModel): string[] {
  const estimate = profile.context.estimatedInputTokens
  const window = model.contextWindowTokens
  if (estimate !== null && window !== null && estimate > window) {
    return [`Estimated input of ${estimate} tokens exceeds the ${window}-token context window.`]
  }
  return []
}

function overrideFailure(profile: CapabilityProfile, model: HostModel): string[] {
  const override = profile.preferences.modelOverride
  return override !== null && override !== model.id ? [`The ticket requires model "${override}".`] : []
}

function modelFailures(profile: CapabilityProfile, model: HostModel): string[] {
  return [
    ...profile.modalities.filter((modality) => !model.modalities.includes(modality)).map((modality) => `Missing modality "${modality}".`),
    ...reasoningFailure(profile, model),
    ...contextFailure(profile, model),
    ...overrideFailure(profile, model)
  ]
}

function unknownRequirements(profile: CapabilityProfile, catalog: HostCatalog): string[] {
  const unknown = profile.constraints.environments.map(
    (environment) =>
      `Environment requirement "${environment}" cannot be verified: the host catalog declares no environments.`
  )
  const override = profile.preferences.modelOverride
  if (override !== null && !catalog.models.some((model) => model.id === override)) {
    unknown.push(`Model override "${override}" is not in the host catalog.`)
  }
  return unknown
}

function fitTerm({ profile, model }: Scoring): ScoreTerm[] {
  const needed = profile.reasoning.level
  const best = highestLevel(model)
  const excess = rankOf(best) - rankOf(needed)
  if (excess <= 0) {
    return [{ points: 0, reason: `Fits the ticket's "${needed}" reasoning need exactly (+0).` }]
  }
  const points = -excess * FIT_PENALTY_POINTS
  const ranks = `${excess} rank${excess === 1 ? '' : 's'}`
  return [{ points, reason: `Highest reasoning level "${best}" is ${ranks} above the ticket's "${needed}" need (${points}).` }]
}

function skillTerm({ profile, model }: Scoring): ScoreTerm[] {
  const listed = new Set(model.skills.map((skill) => skill.toLowerCase()))
  const matched = profile.skills.filter((skill) => listed.has(skill.toLowerCase()))
  if (matched.length === 0) {
    return []
  }
  const points = Math.min(matched.length * SKILL_POINTS, SKILL_CAP_POINTS)
  const capped = matched.length * SKILL_POINTS > SKILL_CAP_POINTS ? `, capped at ${SKILL_CAP_POINTS}` : ''
  const names = matched.map((skill) => `"${skill}"`).join(', ')
  return [{ points, reason: `Lists ${matched.length === 1 ? 'skill' : 'skills'} ${names} (+${points}${capped}).` }]
}

/** Costs no points: a cheaper tier only wins when the scores are otherwise equal. */
function costTierTerm({ model }: Scoring): ScoreTerm[] {
  const reason =
    model.costTier === null
      ? 'No cost tier declared; ranked as "normal" on equal scores.'
      : `Cost tier "${model.costTier}": cheaper tiers sort first on equal scores.`
  return [{ points: 0, reason }]
}

function sizeTerm({ model, size }: Scoring): ScoreTerm[] {
  const points = -costRankOf(model) * SMALL_TICKET_COST_POINTS
  if ((size !== 'micro' && size !== 'small') || points === 0) {
    return []
  }
  const label = size.charAt(0).toUpperCase() + size.slice(1)
  return [{ points, reason: `${label} ticket favours the cheapest fitting model: "${costTierOf(model)}" cost tier (${points}).` }]
}

/** Earns nothing: quality may not put a deeper model ahead of one that fits, so it only explains itself. */
function qualityTerm({ profile }: Scoring): ScoreTerm[] {
  return profile.preferences.quality === 'high'
    ? [{ points: 0, reason: "High-quality preference earns no credit for depth beyond the ticket's need (+0)." }]
    : []
}

function preferenceTerms({ profile, model }: Scoring): ScoreTerm[] {
  return PREFERENCE_BONUSES.filter((bonus) => bonus.applies(profile, model)).map(({ points, reason }) => ({ points, reason }))
}

const SCORE_TERMS: ((scoring: Scoring) => ScoreTerm[])[] = [
  fitTerm,
  skillTerm,
  costTierTerm,
  sizeTerm,
  qualityTerm,
  preferenceTerms
]

function scoreModel(scoring: Scoring): { score: number; reasons: string[] } {
  const terms = SCORE_TERMS.flatMap((term) => term(scoring))
  return {
    score: BASE_SCORE + terms.reduce((sum, term) => sum + term.points, 0),
    reasons: terms.map((term) => term.reason)
  }
}

interface Scored {
  model: HostModel
  item: ProfileMatch['eligible'][number]
}

/** Best score first; equal scores go to the cheaper cost tier, then to the lower model id. */
function ranked(scored: Scored[]): ProfileMatch['eligible'] {
  return scored
    .sort(
      (a, b) =>
        b.item.score - a.item.score ||
        costRankOf(a.model) - costRankOf(b.model) ||
        a.item.modelId.localeCompare(b.item.modelId)
    )
    .map(({ item }) => item)
}

/** Filters and ranks the catalog's models for one capability profile, and recommends a model and effort. */
export function matchProfile(profile: CapabilityProfile, catalog: HostCatalog, context: MatchContext = {}): ProfileMatch {
  const hostFailures = profile.tools
    .filter((tool) => !catalog.tools.includes(tool))
    .map((tool) => `Host lacks required tool "${tool}".`)
  const scored: Scored[] = []
  const rejected: ProfileMatch['rejected'] = []
  for (const model of catalog.models) {
    const failures = [...modelFailures(profile, model), ...hostFailures]
    if (failures.length > 0) {
      rejected.push({ modelId: model.id, failures })
    } else {
      scored.push({ model, item: { modelId: model.id, ...scoreModel({ profile, model, size: context.size }) } })
    }
  }
  const eligible = ranked(scored)
  const { size, attempts = [] } = context
  return {
    eligible,
    rejected,
    hostFailures,
    unknownRequirements: unknownRequirements(profile, catalog),
    recommended: recommend({ profile, catalog, eligible, size, attempts })
  }
}
