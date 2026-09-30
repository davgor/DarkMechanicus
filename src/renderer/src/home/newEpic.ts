import type { CreateEpicInput } from '../../../shared/domain/api'

// Mirrors the command layer's input limits so mistakes are caught before a round trip.
// The core still validates authoritatively.
export const MAX_TITLE = 300
export const MAX_CRITERIA = 100
export const MAX_CRITERION = 2000

interface NewEpicDraft {
  title: string
  intent: string
  /** One success criterion per line. */
  criteria: string
}

type NewEpicResult = { ok: true; input: CreateEpicInput } | { ok: false; message: string }

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/

/** One criterion per non-blank line, with pasted list markers removed. */
export function parseCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line.length > 0)
}

function criteriaProblem(criteria: readonly string[]): string | null {
  if (criteria.length > MAX_CRITERIA) {
    return `Use at most ${MAX_CRITERIA} success criteria.`
  }
  const tooLong = criteria.some((criterion) => criterion.length > MAX_CRITERION)
  return tooLong ? `Each success criterion is limited to ${MAX_CRITERION} characters.` : null
}

/** Validates the New epic form and shapes the `createEpic` input. */
export function buildNewEpic(draft: NewEpicDraft): NewEpicResult {
  const title = draft.title.trim()
  if (title.length === 0) {
    return { ok: false, message: 'Give the epic a title.' }
  }
  if (title.length > MAX_TITLE) {
    return { ok: false, message: `Titles are limited to ${MAX_TITLE} characters.` }
  }
  const criteria = parseCriteria(draft.criteria)
  const problem = criteriaProblem(criteria)
  if (problem !== null) {
    return { ok: false, message: problem }
  }
  const intent = draft.intent.trim()
  const input: CreateEpicInput = { title }
  if (intent.length > 0) {
    input.intent = intent
  }
  if (criteria.length > 0) {
    input.successCriteria = criteria
  }
  return { ok: true, input }
}
