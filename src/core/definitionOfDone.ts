/**
 * Matching evidence to a project's Definition of Done. Dark Mechanicus never runs a check: a worker runs the
 * commands and reports each one in its evidence by name, and this is how a reported name finds its check.
 */
import type { CheckResult, DefinitionOfDoneCheck } from '../shared/domain/views'

/**
 * What names are compared by: trimmed and lower-cased, so `Lint` and ` lint ` report the same check. Inner
 * spacing and punctuation stay significant (`unit tests` is not `unit  tests`), and nothing is matched by
 * containing a name, because a loose match could let a different check stand in for one that never ran.
 */
export function checkNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** A check the evidence does not show as passed, and why. */
interface UnmetCheck {
  name: string
  reason: 'not reported' | 'failed' | 'skipped'
}

function reasonFor(entries: readonly CheckResult[]): UnmetCheck['reason'] | null {
  if (entries.length === 0) {
    return 'not reported'
  }
  if (entries.some((entry) => entry.status === 'failed')) {
    return 'failed'
  }
  return entries.some((entry) => entry.status === 'skipped') ? 'skipped' : null
}

/**
 * The checks of `definition`, in its order, that `evidence` does not show as passed. A check passes when
 * the evidence reports it at least once and every entry under its name passed (the rule a row check
 * follows: a failed or skipped entry means the check did not pass). Evidence naming no check of the
 * definition is ignored.
 */
export function unmetChecks(definition: readonly DefinitionOfDoneCheck[], evidence: readonly CheckResult[]): UnmetCheck[] {
  return definition.flatMap((check) => {
    const key = checkNameKey(check.name)
    const reason = reasonFor(evidence.filter((entry) => checkNameKey(entry.name) === key))
    return reason === null ? [] : [{ name: check.name, reason }]
  })
}
