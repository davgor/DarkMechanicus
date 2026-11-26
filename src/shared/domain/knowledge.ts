/** Scoped knowledge an agent asks for at a workflow event (`getContext`). */
import type { LearningContextView } from './learnings'

/** The layer a fact came from; a higher layer overrides a lower one with the same id. */
type ContextLayer = 'builtin' | 'overall' | 'repo'

export interface GetContextInput {
  /** A workflow event id such as `ticket.claimed`; give this or `topics`. */
  event?: string
  topics?: string[]
  /** Repository paths that boost facts scoped to matching globs. */
  paths?: string[]
  /** A ticket whose `file` references join `paths`. */
  ticketId?: string
  budgetTokens?: number
}

interface ContextFactView {
  id: string
  type: string
  title: string
  layer: ContextLayer
  body: string
}

/** The knowledge an orchestrator's state-changing command pushes with its result: `ContextView` without `layers`. */
interface KnowledgeContextView {
  facts: ContextFactView[]
  /** Matching facts left out because the budget ran out. */
  omitted: { id: string; title: string; tokens: number }[]
  usedTokens: number
  budgetTokens: number
  /** Fact files that could not be read, with the reason. */
  diagnostics: { layer: ContextLayer; path: string; message: string }[]
  /**
   * DM-936: the active published learnings matching the session's role, the event and the paths, within their own
   * budget beside the facts'; present only when at least one learning matched. Guidance only: never a grant.
   */
  learnings?: LearningContextView
}

/** A state-changing command's result, with the pushed knowledge for an orchestrator session. */
export interface PushedContext {
  context?: KnowledgeContextView
}

export interface ContextView extends KnowledgeContextView {
  layers: {
    builtin: { count: number }
    overall: { configured: boolean; path: string | null; count: number }
    repo: { path: string; count: number }
  }
}
