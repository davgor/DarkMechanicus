/**
 * Capability matching: hard constraints of a ticket's provider-neutral profile filter the host's
 * models; preferences only rank the survivors. Requirements the catalog cannot vouch for are
 * reported as unknown so the orchestrator escalates instead of silently passing them. Pure.
 */
import type { CapabilityProfile } from '../../shared/domain/bundle'
import type { CapabilityMatchView, HostCatalog, HostModel } from '../../shared/domain/views'

type ProfileMatch = Omit<CapabilityMatchView, 'ticketId' | 'catalogId'>

const BASE_SCORE = 50
const SKILL_POINTS = 10

const REASONING_RANK: Record<string, number> = { routine: 0, multi_step: 1, deep: 2 }

interface PreferenceBonus {
  applies(profile: CapabilityProfile, model: HostModel): boolean
  points: number
  reason: string
}

const PREFERENCE_BONUSES: PreferenceBonus[] = [
  {
    applies: (profile, model) => profile.preferences.quality === 'high' && model.reasoningLevels.includes('deep'),
    points: 15,
    reason: 'Supports deep reasoning for a high-quality preference (+15).'
  },
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

function rankOf(level: string | null): number {
  return level === null ? -1 : (REASONING_RANK[level] ?? -1)
}

function highestLevel(model: HostModel): string | null {
  let best: string | null = null
  for (const level of model.reasoningLevels) {
    if (rankOf(level) > rankOf(best)) {
      best = level
    }
  }
  return best
}

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

function scoreModel(profile: CapabilityProfile, model: HostModel): { score: number; reasons: string[] } {
  const listed = new Set(model.skills.map((skill) => skill.toLowerCase()))
  const skills = profile.skills.filter((skill) => listed.has(skill.toLowerCase()))
  const bonuses = PREFERENCE_BONUSES.filter((bonus) => bonus.applies(profile, model))
  const points = bonuses.reduce((sum, bonus) => sum + bonus.points, 0)
  return {
    score: BASE_SCORE + skills.length * SKILL_POINTS + points,
    reasons: [...skills.map((skill) => `Lists skill "${skill}" (+${SKILL_POINTS}).`), ...bonuses.map((bonus) => bonus.reason)]
  }
}

/** Filters and ranks the catalog's models for one capability profile. */
export function matchProfile(profile: CapabilityProfile, catalog: HostCatalog): ProfileMatch {
  const hostFailures = profile.tools
    .filter((tool) => !catalog.tools.includes(tool))
    .map((tool) => `Host lacks required tool "${tool}".`)
  const eligible: ProfileMatch['eligible'] = []
  const rejected: ProfileMatch['rejected'] = []
  for (const model of catalog.models) {
    const failures = [...modelFailures(profile, model), ...hostFailures]
    if (failures.length > 0) {
      rejected.push({ modelId: model.id, failures })
    } else {
      eligible.push({ modelId: model.id, ...scoreModel(profile, model) })
    }
  }
  eligible.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId))
  return { eligible, rejected, hostFailures, unknownRequirements: unknownRequirements(profile, catalog) }
}
