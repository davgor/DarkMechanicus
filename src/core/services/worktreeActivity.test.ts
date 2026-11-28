import { describe, expect, it } from 'vitest'
import type { WorktreeDiffReport } from '../../shared/domain/api'
import { makeBundle } from '../../test/bundles'
import { attemptRow, bundleWith, claim, eventKinds, type IssuedClaim, startedRun, submitClaim } from '../../test/execution'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { heartbeatAttempt } from './attempts'
import { getRun } from './runs'
import { nextWorktreeJson, worktreeActivity } from './worktreeActivity'

const NO_DIFF: WorktreeDiffReport = { changedFiles: 0, changedLines: 0 }
const EDIT: WorktreeDiffReport = { changedFiles: 2, changedLines: 31 }

function beat(ctx: TestCtx, claimed: IssuedClaim, worktree?: WorktreeDiffReport) {
  return heartbeatAttempt(withRole(ctx, 'worker'), {
    attemptId: claimed.attempt.id,
    claimToken: claimed.packet.claimToken,
    ...(worktree === undefined ? {} : { worktree })
  })
}

function runWorktree(ctx: TestCtx, runId: string, attemptId: string) {
  return getRun(ctx, { runId })?.attempts.find((attempt) => attempt.id === attemptId)?.worktree
}

/** Heartbeats every five minutes for `minutes`, each reporting `worktree`. */
function beatFor(ctx: TestCtx, claimed: IssuedClaim, minutes: number, worktree?: WorktreeDiffReport): void {
  for (let elapsed = 0; elapsed < minutes; elapsed += 5) {
    ctx.clock.advanceSeconds(300)
    beat(ctx, claimed, worktree)
  }
}

describe('no-diff detection with a controlled clock', () => {
  it('flags a live claim that reports no diff once 15 minutes have passed since the claim, in the run view and the heartbeat answer', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1)
    beatFor(ctx, claimed, 10, NO_DIFF)
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toMatchObject({ state: 'no_diff', stalled: false, alertMinutes: 15 })
    ctx.clock.advanceSeconds(299)
    expect(beat(ctx, claimed, NO_DIFF).worktree?.stalled).toBe(false)
    ctx.clock.advanceSeconds(1)
    expect(beat(ctx, claimed, NO_DIFF).worktree).toEqual({
      state: 'no_diff',
      stalled: true,
      alertMinutes: 15,
      changedFiles: 0,
      changedLines: 0,
      reportedAt: ctx.clock.nowIso(),
      changedAt: null
    })
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toMatchObject({ state: 'no_diff', stalled: true })
  })

  it('clears the flag when a heartbeat reports a diff, and records when it changed', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1)
    beatFor(ctx, claimed, 20, NO_DIFF)
    expect(runWorktree(ctx, runId, claimed.attempt.id)?.stalled).toBe(true)
    ctx.clock.advanceSeconds(60)
    const editedAt = ctx.clock.nowIso()
    expect(beat(ctx, claimed, EDIT).worktree).toMatchObject({ state: 'changed', stalled: false, changedAt: editedAt })
    ctx.clock.advanceSeconds(300)
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toMatchObject({
      state: 'changed',
      stalled: false,
      changedFiles: 2,
      changedLines: 31,
      changedAt: editedAt
    })
  })
})

describe('no-diff detection between reports', () => {
  it('keeps the last report when a heartbeat sends none, and moves changedAt only when the counts change', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1)
    ctx.clock.advanceSeconds(60)
    const editedAt = ctx.clock.nowIso()
    beat(ctx, claimed, EDIT)
    ctx.clock.advanceSeconds(60)
    const reportedAt = ctx.clock.nowIso()
    beat(ctx, claimed, EDIT)
    ctx.clock.advanceSeconds(60)
    beat(ctx, claimed)
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toMatchObject({ state: 'changed', reportedAt, changedAt: editedAt })
  })
})

describe('no-diff detection: unknown worktrees, the plan threshold and finished claims', () => {
  it('reports unknown, never stalled, for a claim whose heartbeats name no worktree', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1)
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toMatchObject({ state: 'unknown', stalled: false })
    beatFor(ctx, claimed, 60)
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toEqual({
      state: 'unknown',
      stalled: false,
      alertMinutes: 15,
      changedFiles: null,
      changedLines: null,
      reportedAt: null,
      changedAt: null
    })
  })

  it("uses the plan's noDiffAlertMinutes", () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1]], [], { noDiffAlertMinutes: 5 }) })
    const claimed = claim(ctx, runId, 1)
    ctx.clock.advanceSeconds(299)
    expect(beat(ctx, claimed, NO_DIFF).worktree).toMatchObject({ stalled: false, alertMinutes: 5 })
    ctx.clock.advanceSeconds(1)
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toMatchObject({ stalled: true, alertMinutes: 5 })
  })

  it('never flags a claim that is no longer live', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1)
    beatFor(ctx, claimed, 20, NO_DIFF)
    submitClaim(ctx, claimed)
    expect(runWorktree(ctx, runId, claimed.attempt.id)).toMatchObject({ state: 'no_diff', stalled: false })
  })
})

describe('no-diff detection only detects, and records counts only', () => {
  it('only detects: the stalled claim keeps running with its lease, and nothing fails, expires or re-claims it', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1)
    beatFor(ctx, claimed, 30, NO_DIFF)
    const run = getRun(ctx, { runId })
    expect(run?.attempts.find((attempt) => attempt.id === claimed.attempt.id)).toMatchObject({
      state: 'running',
      worktree: { stalled: true }
    })
    expect(run?.attempts).toHaveLength(1)
    expect(attemptRow(ctx, claimed.attempt.id)).toMatchObject({ state: 'running', failure_json: null })
    expect([...eventKinds(ctx, 'attempt.failed'), ...eventKinds(ctx, 'attempt.lease_expired')]).toEqual([])
  })

  it('stores counts and times only, never paths, contents or the claim token', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1)
    beat(ctx, claimed, EDIT)
    const stored = attemptRow(ctx, claimed.attempt.id).worktree_json
    expect(Object.keys(JSON.parse(stored ?? '{}')).sort()).toEqual(['changedAt', 'changedFiles', 'changedLines', 'reportedAt'])
    expect(stored).not.toContain(claimed.packet.claimToken.split('.')[1])
  })

  it('refuses a report that carries anything but the two counts', () => {
    const ctx = createTestCtx()
    const claimed = claim(ctx, startedRun(ctx, { bundle: makeBundle([[1]]) }).runId, 1)
    const base = { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken }
    expect(COMMAND_SCHEMAS.heartbeatAttempt.safeParse({ ...base, worktree: EDIT }).success).toBe(true)
    expect(COMMAND_SCHEMAS.heartbeatAttempt.safeParse({ ...base, worktree: { ...EDIT, paths: ['src/a.ts'] } }).success).toBe(false)
    expect(COMMAND_SCHEMAS.heartbeatAttempt.safeParse({ ...base, worktree: { changedFiles: -1, changedLines: 0 } }).success).toBe(false)
    expect(COMMAND_SCHEMAS.heartbeatAttempt.safeParse({ ...base, worktree: { changedFiles: 1.5, changedLines: 0 } }).success).toBe(false)
  })
})

describe('worktreeActivity', () => {
  const T0 = '2026-01-01T00:00:00.000Z'
  const T15 = '2026-01-01T00:15:00.000Z'

  it('flags a claimed attempt as well as a running one, and goes back to no_diff when the diff is reverted', () => {
    const empty = nextWorktreeJson(null, NO_DIFF, T0)
    expect(worktreeActivity({ state: 'claimed', created_at: T0, worktree_json: empty }, T15, 15).stalled).toBe(true)
    const edited = nextWorktreeJson(empty, EDIT, T0)
    const reverted = nextWorktreeJson(edited, NO_DIFF, T15)
    expect(worktreeActivity({ state: 'running', created_at: T0, worktree_json: reverted }, T15, 15)).toMatchObject({
      state: 'no_diff',
      stalled: true,
      changedAt: T15
    })
  })

  it.each(['submitted', 'accepted', 'failed', 'lease_expired'] as const)('never flags a %s attempt', (state) => {
    const empty = nextWorktreeJson(null, NO_DIFF, T0)
    expect(worktreeActivity({ state, created_at: T0, worktree_json: empty }, T15, 15).stalled).toBe(false)
  })
})
