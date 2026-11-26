import type { TicketReference } from '../../shared/domain/bundle'
import type { ContextView, PushedContext } from '../../shared/domain/knowledge'
import type { WorkspaceCore } from '../commands/types'
import { activeLearnings } from '../services/learnings'
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_LEARNING_BUDGET, selectFacts, selectLearnings } from './select'

/** What selecting knowledge needs from the open workspace; `db`, when given, adds the published learnings (DM-936). */
type KnowledgeCore = Pick<WorkspaceCore, 'role' | 'layout' | 'homeDir' | 'fs'> & Partial<Pick<WorkspaceCore, 'db'>>

interface ContextQuery {
  event?: string
  topics?: string[]
  paths?: string[]
  budgetTokens?: number
}

/** Loads every layer and selects the facts for the session's role and `query` (the result of `getContext`). */
export async function knowledgeContext(core: KnowledgeCore, query: ContextQuery): Promise<ContextView> {
  const budgetTokens = query.budgetTokens ?? DEFAULT_CONTEXT_BUDGET
  // Loaded on first use: the built-in layer is bundled with Vite's `import.meta.glob`, which a workspace loaded
  // outside Vite (tsx, as in the agent-mail child-process test) cannot evaluate at import time.
  const { loadKnowledge } = await import('./load')
  const loaded = loadKnowledge({ layout: core.layout, homeDir: core.homeDir, fs: core.fs })
  const selected = selectFacts(loaded.facts, {
    role: core.role,
    event: query.event,
    topics: query.topics,
    paths: query.paths,
    budgetTokens
  })
  // DM-936: active learnings, selected within their own budget after the facts, so they never displace a fact or
  // change its precedence; an item carries text and provenance only.
  const db = core.db?.() ?? null
  const learnings =
    db === null
      ? null
      : selectLearnings(activeLearnings(db), { role: core.role, event: query.event, paths: query.paths, budgetTokens: DEFAULT_LEARNING_BUDGET })
  const matched = learnings !== null && learnings.learnings.length + learnings.omitted.length > 0
  return {
    facts: selected.facts.map(({ id, type, title, layer, body }) => ({ id, type, title, layer, body })),
    omitted: selected.omitted,
    usedTokens: selected.usedTokens,
    budgetTokens,
    diagnostics: loaded.diagnostics,
    ...(matched && { learnings: { ...learnings, budgetTokens: DEFAULT_LEARNING_BUDGET } }),
    layers: loaded.layers
  }
}

/** The locations of the `file` references among `references`. */
export function filePaths(references: TicketReference[]): string[] {
  return references.filter((reference) => reference.kind === 'file').map((reference) => reference.location)
}

/**
 * Adds the knowledge for `event` to a state-changing command's `result`, for an orchestrator session only. The
 * command already happened, so a knowledge load that fails is logged and leaves `result` without `context`.
 */
export async function withKnowledgeContext<T extends object>(
  core: KnowledgeCore,
  result: T,
  event: string,
  paths: string[] = []
): Promise<T & PushedContext> {
  if (core.role !== 'orchestrator') return result
  try {
    const { layers: _layers, ...context } = await knowledgeContext(core, { event, paths })
    return { ...result, context }
  } catch (error) {
    console.warn(`Knowledge context for ${event} was left out: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
}
