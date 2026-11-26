import { matchesGlob } from 'node:path'
import type { LearningContextView, LearningView } from '../../shared/domain/learnings'
import type { KnowledgeFact } from './fact'
import { LAYER_RANK } from './merge'
import { compareCodeUnits } from './order'

export const DEFAULT_CONTEXT_BUDGET = 1800

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

// DM-936: bounded selection of published learnings, beside (never inside) the knowledge facts.

/** Tokens set aside for learnings, separate from the facts' budget so learnings never displace a fact. */
export const DEFAULT_LEARNING_BUDGET = 600

interface LearningQuery {
  role: string
  event?: string
  paths?: string[]
  budgetTokens: number
}

interface LearningSelection {
  learnings: LearningContextView['learnings']
  omitted: OmittedFact[]
  usedTokens: number
}

interface LearningCandidate {
  learning: LearningView
  pathMatch: boolean
  eventMatch: boolean
  /** Rough token estimate, like a fact's: ceil((title + rule + check) / 4). */
  tokens: number
}

/**
 * `learning` as a candidate when it is active, addressed to the query's role, scoped to its event or to none, and
 * scoped to a path glob one of the query's paths matches or to none; null otherwise. Retired and replaced never match.
 */
function learningCandidate(learning: LearningView, query: LearningQuery, paths: readonly string[]): LearningCandidate | null {
  const { roles, events, paths: globs } = learning.applicability
  const live = learning.state === 'active' && learning.replacedBy === null
  const eventApplies = events.length === 0 || (query.event !== undefined && (events as readonly string[]).includes(query.event))
  const pathMatch = globs.some((glob) => paths.some((path) => matchesGlob(path, glob)))
  if (!live || !(roles as readonly string[]).includes(query.role) || !eventApplies || (globs.length > 0 && !pathMatch)) return null
  const tokens = Math.ceil((learning.title.length + learning.rule.length + learning.check.length) / 4)
  return { learning, pathMatch, eventMatch: events.length > 0, tokens }
}

/**
 * Picks the active learnings addressed to `role` whose events include `event` (or name none) and whose path globs
 * match one of `paths` (or name none), ranks them deterministically (path-scoped, then event-scoped, then newest,
 * then id) and fills greedily within the learnings' own budget. Retired and replaced learnings never match.
 *
 * A selected learning carries its text and provenance only: its applicability, lifecycle and any other field stay
 * behind, so nothing in a learning reads as a grant, a priority or a rule about who may do what.
 */
export function selectLearnings(learnings: readonly LearningView[], query: LearningQuery): LearningSelection {
  const paths = query.paths ?? []
  const candidates = learnings
    .map((learning) => learningCandidate(learning, query, paths))
    .filter((candidate): candidate is LearningCandidate => candidate !== null)

  candidates.sort(
    (a, b) =>
      Number(b.pathMatch) - Number(a.pathMatch) ||
      Number(b.eventMatch) - Number(a.eventMatch) ||
      compareCodeUnits(b.learning.createdAt, a.learning.createdAt) ||
      compareCodeUnits(a.learning.id, b.learning.id)
  )

  const selected: LearningContextView['learnings'] = []
  const omitted: OmittedFact[] = []
  let usedTokens = 0
  for (const { learning, tokens } of candidates) {
    const { id, title, rule, check, source } = learning
    if (usedTokens + tokens <= query.budgetTokens) {
      selected.push({ id, title, rule, check, source: { ...source } })
      usedTokens += tokens
    } else {
      omitted.push({ id, title, tokens })
    }
  }
  return { learnings: selected, omitted, usedTokens }
}
