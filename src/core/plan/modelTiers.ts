/**
 * Provider-neutral ordering of host models, derived only from what a catalog entry declares (its
 * reasoning levels and cost tier), never from vendor or model names. Pure.
 */
import type { HostModel } from '../../shared/domain/views'

const REASONING_RANK: Record<string, number> = { routine: 0, multi_step: 1, deep: 2 }
const COST_RANK = { low: 0, normal: 1, high: 2 } as const

export function rankOf(level: string | null): number {
  return level === null ? -1 : (REASONING_RANK[level] ?? -1)
}

export function highestLevel(model: HostModel): string | null {
  let best: string | null = null
  for (const level of model.reasoningLevels) {
    if (rankOf(level) > rankOf(best)) {
      best = level
    }
  }
  return best
}

/** The cost tier a model ranks at: an undeclared tier counts as normal. */
export function costTierOf(model: HostModel): 'low' | 'normal' | 'high' {
  return model.costTier ?? 'normal'
}

export function costRankOf(model: HostModel): number {
  return COST_RANK[costTierOf(model)]
}

/** Orders models by tier, lowest first: cost tier, then the highest reasoning level. Equal tiers return 0. */
export function compareTier(a: HostModel, b: HostModel): number {
  return costRankOf(a) - costRankOf(b) || rankOf(highestLevel(a)) - rankOf(highestLevel(b))
}
