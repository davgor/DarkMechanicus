import { isKnowledgeEvent } from './events'
import type { KnowledgeDiagnostic, KnowledgeFact, KnowledgeLayer } from './fact'
import { compareCodeUnits } from './order'

/** Higher rank wins: repo > overall > builtin. */
export const LAYER_RANK: Record<KnowledgeLayer, number> = { builtin: 0, overall: 1, repo: 2 }

interface MergeResult {
  facts: KnowledgeFact[]
  diagnostics: KnowledgeDiagnostic[]
}

/** Keeps one fact per id: the highest layer wins; within a layer the first by path order wins and the rest are reported. */
function resolveIds(facts: KnowledgeFact[], diagnostics: KnowledgeDiagnostic[]): Map<string, KnowledgeFact> {
  const ordered = [...facts].sort((a, b) => LAYER_RANK[b.layer] - LAYER_RANK[a.layer] || compareCodeUnits(a.path, b.path))
  const byId = new Map<string, KnowledgeFact>()
  for (const fact of ordered) {
    const kept = byId.get(fact.id)
    if (kept === undefined) byId.set(fact.id, fact)
    else if (kept.layer === fact.layer) {
      diagnostics.push({
        layer: fact.layer,
        path: fact.path,
        message: `duplicate id "${fact.id}" in ${fact.layer} layer; keeping ${kept.path}`
      })
    }
  }
  return byId
}

/** Ids removed by a `supersedes` entry of a fact in the same or a higher layer. */
function supersededIds(byId: Map<string, KnowledgeFact>): Set<string> {
  const removed = new Set<string>()
  for (const fact of byId.values()) {
    for (const target of fact.supersedes) {
      const victim = byId.get(target)
      if (victim && victim !== fact && LAYER_RANK[victim.layer] <= LAYER_RANK[fact.layer]) removed.add(target)
    }
  }
  return removed
}

/**
 * Merges facts from all layers. Within a layer a duplicate id keeps the first by path order;
 * across layers the higher layer replaces the same id; `supersedes` removes ids from lower or equal layers.
 * Unknown `scope.events` are reported but the fact still loads.
 */
export function mergeLayers(facts: KnowledgeFact[]): MergeResult {
  const diagnostics: KnowledgeDiagnostic[] = []
  const byId = resolveIds(facts, diagnostics)
  const removed = supersededIds(byId)
  const merged = [...byId.values()].filter((fact) => !removed.has(fact.id))
  for (const fact of merged) {
    for (const event of fact.scope.events.filter((name) => !isKnowledgeEvent(name))) {
      diagnostics.push({ layer: fact.layer, path: fact.path, message: `unknown event "${event}" in scope.events` })
    }
  }
  return { facts: merged, diagnostics }
}
