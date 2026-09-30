/** Pure view model for the Draft view's validation, changes and Save panel. */
import { isActiveRunState } from '../../../shared/domain/status'
import type { ChangeKind, PlanChange, PlanView, RunView, SaveResultView, ValidationReport } from '../../../shared/domain/views'
import { runLabel } from './runBarView'

export const STALE_DRAFT_NOTE =
  'The saved plan changed since this draft was opened. Saving will be rejected: discard this draft and edit again from the current revision.'

export interface ValidationItem {
  tone: 'ok' | 'error' | 'warning'
  text: string
}

export interface ChangeRow {
  symbol: '+' | '~' | '−'
  tone: ChangeKind
  /** Bold lead (empty when the text already names the item). */
  label: string
  text: string
}

interface SaveOutcome {
  kind: SaveResultView['status']
  message: string
}

const SYMBOLS: Record<ChangeKind, ChangeRow['symbol']> = { added: '+', edited: '~', removed: '−' }

function count(value: number, word: string): string {
  return `${value} ${word}${value === 1 ? '' : 'S'}`
}

export function validationSummary(report: ValidationReport | null): { heading: string; items: ValidationItem[] } {
  if (report === null) {
    return { heading: 'VALIDATION · NOT CHECKED YET', items: [] }
  }
  const errors = report.errors.map((issue): ValidationItem => ({ tone: 'error', text: issue.message }))
  const warnings = report.warnings.map((issue): ValidationItem => ({ tone: 'warning', text: issue.message }))
  const clean: ValidationItem[] = errors.length === 0 ? [{ tone: 'ok', text: 'Graph is acyclic; every reference resolves' }] : []
  return {
    heading: `VALIDATION · ${count(report.errors.length, 'ERROR')} · ${count(report.warnings.length, 'WARNING')}`,
    items: [...clean, ...errors, ...warnings]
  }
}

export function saveBlocked(report: ValidationReport | null): string | null {
  const errors = report?.errors.length ?? 0
  if (errors === 0) {
    return null
  }
  return `Fix ${errors} ${errors === 1 ? 'error' : 'errors'} before saving.`
}

export function changeRows(changes: PlanChange[]): ChangeRow[] {
  return changes.map((change) => {
    const named = change.detail.startsWith(change.label)
    return {
      symbol: SYMBOLS[change.kind],
      tone: change.kind,
      label: named ? '' : change.label,
      text: change.detail
    }
  })
}

export function changesHeading(plan: PlanView): string {
  return plan.baseRevisionNumber === null ? 'CHANGES · FIRST REVISION' : `CHANGES SINCE REV ${plan.baseRevisionNumber}`
}

export function saveNote(run: RunView | null, nextNumber: number): string {
  if (run === null || !isActiveRunState(run.state)) {
    return `Saving makes rev ${nextNumber} the plan the next run executes.`
  }
  const name = `run #${run.number}`
  const where = run.activeSprintOrdinal === null ? 'its next checkpoint' : `the Sprint ${run.activeSprintOrdinal} checkpoint`
  return `Saving doesn't change ${name}. Adopt rev ${nextNumber} at ${where}.`
}

export function saveOutcome(result: SaveResultView): SaveOutcome {
  switch (result.status) {
    case 'saved':
      return { kind: 'saved', message: `Saved rev ${result.revisionNumber}.` }
    case 'unchanged':
      return { kind: 'unchanged', message: `Nothing to save — the draft matches rev ${result.revisionNumber}.` }
    default: {
      const reason = result.error === null ? '' : ` (${result.error})`
      return {
        kind: 'pending',
        message: `Save pending — the snapshot hasn't been written yet; your draft is kept.${reason}`
      }
    }
  }
}

/** "Changes stay in draft rev 5 until you save. Run #2 keeps executing rev 4 unchanged." */
export function draftBarNote(run: RunView | null, nextNumber: number): string {
  const lead = `Changes stay in draft rev ${nextNumber} until you save.`
  if (run === null || !isActiveRunState(run.state)) {
    return lead
  }
  return `${lead} ${runLabel(run)} keeps executing rev ${run.revisionNumber} unchanged.`
}
