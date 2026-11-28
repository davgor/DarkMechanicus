/**
 * DM-999: stalled-worker detection from the worktree diff counts a claim's heartbeats report. A worker sends the size of
 * its worktree's diff against the commit its claim started from (counts only, never paths or contents); the run view
 * flags a live claim that still reports an empty diff once the plan's no-diff alert minutes have passed since the claim,
 * so the orchestrator's supervision can hand over an edit plan or reassign. Detection only: nothing here fails,
 * expires or re-claims an attempt.
 */
import type { WorktreeDiffReport } from '../../shared/domain/api'
import { isLeasedAttemptState } from '../../shared/domain/status'
import type { WorktreeActivity } from '../../shared/domain/views'
import { parseJson, toJson } from '../db/database'
import type { AttemptRow } from './execution'

/** What `attempts.worktree_json` holds. */
interface StoredWorktreeDiff extends WorktreeDiffReport {
  reportedAt: string
  changedAt: string | null
}

const MINUTE_MS = 60_000
const EMPTY_DIFF: WorktreeDiffReport = { changedFiles: 0, changedLines: 0 }

function sameDiff(a: WorktreeDiffReport, b: WorktreeDiffReport): boolean {
  return a.changedFiles === b.changedFiles && a.changedLines === b.changedLines
}

/**
 * The `worktree_json` to store for a heartbeat's report: the counts and when they were reported, and `changedAt` moved
 * to now when they differ from the last report (no report before counts as an empty diff).
 */
export function nextWorktreeJson(storedJson: string | null, report: WorktreeDiffReport, now: string): string {
  const stored = parseJson<StoredWorktreeDiff | null>(storedJson, null)
  const changed = !sameDiff(report, stored ?? EMPTY_DIFF)
  const next: StoredWorktreeDiff = {
    changedFiles: report.changedFiles,
    changedLines: report.changedLines,
    reportedAt: now,
    changedAt: changed ? now : (stored?.changedAt ?? null)
  }
  return toJson(next)
}

/** The attempt's worktree activity at `now`, flagged stalled at `alertMinutes` without a diff since the claim. */
export function worktreeActivity(row: Pick<AttemptRow, 'state' | 'created_at' | 'worktree_json'>, now: string, alertMinutes: number): WorktreeActivity {
  const stored = parseJson<StoredWorktreeDiff | null>(row.worktree_json, null)
  if (stored === null) {
    return { state: 'unknown', stalled: false, alertMinutes, changedFiles: null, changedLines: null, reportedAt: null, changedAt: null }
  }
  const state = sameDiff(stored, EMPTY_DIFF) ? 'no_diff' : 'changed'
  const claimedForMs = Date.parse(now) - Date.parse(row.created_at)
  return {
    state,
    stalled: state === 'no_diff' && isLeasedAttemptState(row.state) && claimedForMs >= alertMinutes * MINUTE_MS,
    alertMinutes,
    changedFiles: stored.changedFiles,
    changedLines: stored.changedLines,
    reportedAt: stored.reportedAt,
    changedAt: stored.changedAt
  }
}
