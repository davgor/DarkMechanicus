import { matchesGlob } from 'node:path'
import type { KnowledgeFact } from './fact'
import { LAYER_RANK } from './merge'
import { compareCodeUnits } from './order'

export const DEFAULT_CONTEXT_BUDGET = 1500

interface SelectQuery {
  role: string
  event?: string
  topics?: string[]
  paths?: string[]
  budgetTokens: number
}

interface OmittedFact {
  id: string
  title: string
  tokens: number
}

interface SelectResult {
  facts: KnowledgeFact[]
  omitted: OmittedFact[]
  usedTokens: number
}

interface Candidate {
  fact: KnowledgeFact
  eventMatch: boolean
  pathBoost: boolean
}

/** Picks role- and event/topic-scoped facts, ranks them deterministically and fills greedily within the budget. */
export function selectFacts(facts: KnowledgeFact[], query: SelectQuery): SelectResult {
  const topics = query.topics ?? []
  const paths = query.paths ?? []
  const candidates: Candidate[] = []
  for (const fact of facts) {
    if (!fact.scope.roles.includes(query.role)) continue
    const eventMatch = query.event !== undefined && fact.scope.events.includes(query.event)
    const topicMatch = topics.some((topic) => fact.scope.topics.includes(topic))
    if (!eventMatch && !topicMatch) continue
    const pathBoost = fact.scope.paths.some((glob) => paths.some((path) => matchesGlob(path, glob)))
    candidates.push({ fact, eventMatch, pathBoost })
  }

  candidates.sort(
    (a, b) =>
      Number(b.eventMatch) - Number(a.eventMatch) ||
      Number(b.pathBoost) - Number(a.pathBoost) ||
      b.fact.priority - a.fact.priority ||
      LAYER_RANK[b.fact.layer] - LAYER_RANK[a.fact.layer] ||
      compareCodeUnits(a.fact.id, b.fact.id)
  )

  const selected: KnowledgeFact[] = []
  const omitted: OmittedFact[] = []
  let usedTokens = 0
  for (const { fact } of candidates) {
    if (usedTokens + fact.tokens <= query.budgetTokens) {
      selected.push(fact)
      usedTokens += fact.tokens
    } else {
      omitted.push({ id: fact.id, title: fact.title, tokens: fact.tokens })
    }
  }
  return { facts: selected, omitted, usedTokens }
}
