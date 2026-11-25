import type { SprintReportInput } from '../../shared/domain/api'
import type { EpicBranch } from '../../shared/domain/bundle'
import type { AttemptDecision, AttemptEvidence, AttemptOutputs, CheckResult } from '../../shared/domain/views'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import type { GitAdapter } from '../repo/types'
import { loadAttempt, loadBundle, requireRun, ticketOf } from './execution'
import type { AppliedStandard } from './workStandards'
import { itemWorkflow } from './workflowPolicy'

type ReportEvidence = Pick<SprintReportInput, 'checks' | 'changes' | 'deployment' | 'standardsVerification' | 'epicVerification' | 'summary'>

const CHECKS_REQUIRED = 'Record passing results for the required tests. Diagnose and fix failed or timed-out checks before delivery.'

function allChecksPassed(checks: CheckResult[]): boolean {
  return checks.length > 0 && checks.every(check => check.status === 'passed')
}

function requirePassedChecks(checks: CheckResult[]): void {
  if (!allChecksPassed(checks)) fail('invalid_input', CHECKS_REQUIRED)
}

/** Keep the policy revision with the evidence, even after further project edits. */
export function checkTicketDecision(rule: AppliedStandard | undefined, decision: AttemptDecision, checks: CheckResult[], integrated: boolean): void {
  if (!rule?.workflow) return
  decision.standardsRevision = rule.revision
  if (rule.workflow === 'custom') {
    if (!decision.notes.trim()) fail('invalid_input', 'Record how the reviewer verified the custom Ticket standards in notes.')
    return
  }
  requirePassedChecks(checks)
  if (!integrated || !decision.integration) fail('invalid_input', 'Verify the submitted commits on the epic integration branch before accepting this ticket.')
}

/**
 * `learningManifestsVerified` (DM-938) is true only for a sprint learning card whose branch manifests were already
 * verified read-only against Git: that proof replaces the merge to main, and every other requirement still applies.
 */
export function checkKanbanSubmission(rule: AppliedStandard | undefined, evidence: AttemptEvidence, mergedToMain: boolean, learningManifestsVerified = false): void {
  if (!rule?.workflow) return
  evidence.standardsRevision = rule.revision
  if (rule.workflow === 'custom') {
    if (!evidence.notes.trim()) fail('invalid_input', 'Record how the custom Ticket standards were verified in evidence.notes.')
    return
  }
  requirePassedChecks(evidence.checks)
  if (learningManifestsVerified) return
  if (!mergedToMain || evidence.merge?.branch !== 'main') {
    fail('invalid_input', 'Verify the PR merge on origin/main and provide its green CI evidence before submitting for review.')
  }
}

type Integration = NonNullable<AttemptDecision['integration']>

async function landed(git: GitAdapter, target: Integration, commits: string[]): Promise<boolean> {
  if (!commits.length || await git.isAncestor(target.commit, 'refs/heads/' + target.branch) !== true) return false
  for (const commit of commits) {
    if (!/^[a-f\d]{7,64}$/i.test(commit) || await git.isAncestor(commit, target.commit) !== true) return false
  }
  return true
}

function boundBranch(ctx: Ctx, epicId: string): string | undefined {
  const epic = ctx.db.get<{ branch_json: string | null }>('SELECT branch_json FROM epics WHERE id = ?', epicId)
  return parseJson<EpicBranch | null>(epic?.branch_json ?? null, null)?.name
}

interface TicketIntegrationProof {
  passed: boolean
  assertCurrent?(): void
}

/** Verify the submitted revisions against the run's bound epic branch before the acceptance transaction. */
export async function verifyTicketIntegration(ctx: Ctx, id: string, integration: AttemptDecision['integration']): Promise<TicketIntegrationProof> {
  if (!integration) return { passed: false }
  const row = loadAttempt(ctx, id)
  if (row.state !== 'submitted') return { passed: false }
  const run = requireRun(ctx, row.run_id)
  if (boundBranch(ctx, run.epic_id) !== integration.branch) return { passed: false }
  const ticket = ticketOf(loadBundle(ctx, row.revision_id), row.ticket_id)
  const commits = parseJson<AttemptOutputs | null>(row.outputs_json, null)?.commits ?? []
  const git = ctx.gitFor(ticket.repo ?? null)
  if (!await landed(git, integration, commits)) return { passed: false }
  return {
    passed: true,
    assertCurrent: () => {
      git.assertCurrent?.()
      if (loadAttempt(ctx, id).outputs_json !== row.outputs_json || boundBranch(ctx, run.epic_id) !== integration.branch) {
        fail('conflict', 'The submitted commits or epic branch changed during verification. Verify the current delivery again.')
      }
    }
  }
}

function deploymentGap(report: ReportEvidence): string | null {
  if (!allChecksPassed(report.checks ?? [])) return CHECKS_REQUIRED
  if (report.deployment && report.changes?.commits.includes(report.deployment.commit)) return null
  return 'Record the deployed revision in changes.commits, its rollout verification, version and human verification instructions before requesting a checkpoint.'
}

function customSprintGap(workflow: AppliedStandard['workflow'], report: ReportEvidence): string | null {
  return workflow === 'custom' && !report.standardsVerification?.trim()
    ? 'Record how the orchestrator verified the custom Sprint standards in standardsVerification.' : null
}

function epicCloseoutGap(ctx: Ctx, epicId: string, report: ReportEvidence): string | null {
  return itemWorkflow(ctx, epicId, 'epic', epicId)?.workflow && !report.epicVerification?.trim()
    ? 'Review the project Epic standards against the delivered sprints and record the evidence in epicVerification.' : null
}

export function deliveryReportGap(ctx: Ctx, scope: { epicId: string; sprintId: string; final: boolean }, report: ReportEvidence): string | null {
  const sprintRule = itemWorkflow(ctx, scope.epicId, 'sprint', scope.sprintId)?.workflow
  const gap = sprintRule === 'default' ? deploymentGap(report) : customSprintGap(sprintRule, report)
  if (gap) return gap
  return scope.final ? epicCloseoutGap(ctx, scope.epicId, report) : null
}
