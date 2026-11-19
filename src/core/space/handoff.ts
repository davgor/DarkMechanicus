/**
 * Handoff checks: whether a submission carried what the next reader needs, decided only from the submission and the
 * ticket it answers, so anyone holding the same records reaches the same result. They measure the handoff, not the
 * outcome: a criterion honestly reported unmet, with a note saying why or asking a question, has its evidence, so a
 * purposeful clarification never fails a check. Missing evidence or a broken output contract does.
 */
import type { TicketContent } from '../../shared/domain/bundle'
import type { HandoffCheckName } from '../../shared/domain/spaceSignals'
import type { AttemptEvidence, AttemptOutputs } from '../../shared/domain/views'
import { checkNameKey } from '../definitionOfDone'

export interface HandoffCheckResult {
  check: HandoffCheckName
  passed: boolean
  /** What the submission lacked: criterion ids, required check names or output fields. Empty when it passed. */
  missing: string[]
}

function result(check: HandoffCheckName, missing: string[]): HandoffCheckResult {
  return { check, passed: missing.length === 0, missing }
}

/** Every acceptance criterion has an evidence entry with a note, met or not. */
function criteriaEvidence(ticket: Pick<TicketContent, 'acceptanceCriteria'>, evidence: AttemptEvidence): HandoffCheckResult {
  const noted = new Set(evidence.criteria.filter((item) => item.note.trim() !== '').map((item) => item.criterionId))
  return result(
    'criteria_evidence',
    ticket.acceptanceCriteria.filter((criterion) => !noted.has(criterion.id)).map((criterion) => criterion.id)
  )
}

/**
 * At least one check was reported, and every check the packet required by name (a Definition of Done) is among them,
 * matched the way the `definition_of_done` gate matches them (`checkNameKey`: trimmed, ignoring case).
 */
function verificationChecks(evidence: AttemptEvidence, requiredChecks: readonly string[]): HandoffCheckResult {
  const reported = new Set(evidence.checks.map((item) => checkNameKey(item.name)))
  const missing = requiredChecks.filter((name) => !reported.has(checkNameKey(name)))
  return result('verification_checks', evidence.checks.length === 0 && missing.length === 0 ? ['any check'] : missing)
}

/**
 * The output contract a successor builds on: a summary; something delivered (artifacts, commits or changed files);
 * the branch that holds any commits; and artifacts when the ticket expects some.
 */
function outputsContract(ticket: Pick<TicketContent, 'expectedArtifacts'>, outputs: AttemptOutputs): HandoffCheckResult {
  const missing: string[] = []
  if (outputs.summary.trim() === '') {
    missing.push('summary')
  }
  if (outputs.artifacts.length === 0 && outputs.commits.length === 0 && outputs.changedFiles.length === 0) {
    missing.push('deliverables')
  }
  if (outputs.commits.length > 0 && (outputs.branch ?? '').trim() === '') {
    missing.push('branch')
  }
  if (ticket.expectedArtifacts.length > 0 && outputs.artifacts.length === 0) {
    missing.push('artifacts')
  }
  return result('outputs_contract', missing)
}

/**
 * The checks of one submission, in `HANDOFF_CHECKS` order. `requiredChecks` are the check names its packet required
 * (a single repository's acceptance node lists the project's Definition of Done); empty for other tickets.
 */
export function deriveHandoffChecks(
  ticket: Pick<TicketContent, 'acceptanceCriteria' | 'expectedArtifacts'>,
  submission: { outputs: AttemptOutputs; evidence: AttemptEvidence },
  requiredChecks: readonly string[]
): HandoffCheckResult[] {
  return [
    criteriaEvidence(ticket, submission.evidence),
    verificationChecks(submission.evidence, requiredChecks),
    outputsContract(ticket, submission.outputs)
  ]
}
