import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createTestCtx, withRole } from '../../test/testContext'
import { issueGrant, renewGrant, revokeGrant } from './grants'
import { approveYolo, isYoloEligible, bindYoloChat, endYoloChat, listYoloAudit, revokeYolo } from './yolo'
import { seedRun } from '../../test/checkpointSeed'
import { submitSprintReport } from './reports'
import { createYoloDesktopRuntime } from './yoloFence'

const directories: string[] = []
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const ctx = createTestCtx({ role: 'desktop' })
  const { grant } = issueGrant(ctx, { role: 'orchestrator', label: 'Named chat', minutes: 60 })
  const directory = mkdtempSync(join(tmpdir(), 'dm-yolo-fence-'))
  directories.push(directory)
  const runtime = createYoloDesktopRuntime(join(directory, 'desktop.json'))
  disposers.push(runtime.dispose)
  const fence = runtime.fence
  const binding = { grantId: grant.id, chatId: 'chat-one', generation: 'start-one', desktopId: fence.instance, desktopPid: fence.pid, fencePath: fence.path, proofEndpoint: fence.proofEndpoint, proofPublicKey: fence.proofPublicKey, runId: null }
  bindYoloChat(ctx, binding)
  return { ctx, grant, binding }
}

  it('is off by default, preserves roles and admits only its explicit powers after approval', () => {
    const { ctx, grant, binding } = fixture()
    expect(isYoloEligible(ctx, grant.id, 'plan.save', null)).toBe(false)
    const approved = approveYolo(ctx, binding)
    expect(approved.expiresAt).toBe(grant.expiresAt)
    expect(isYoloEligible(ctx, grant.id, 'plan.save', null)).toBe(true)
    expect(isYoloEligible(ctx, grant.id, 'ticket.retry_grant', null)).toBe(true)
    expect(isYoloEligible(ctx, grant.id, 'checkpoint.approve', null)).toBe(true)
    for (const capability of ['grant.issue', 'grant.revoke', 'mail.manage', 'feedback.record', 'repo.backup'] as const) {
      expect(isYoloEligible(ctx, grant.id, capability, null)).toBe(false)
    }
    expect(ctx.db.get<{ role: string }>('SELECT role FROM grants WHERE id = ?', grant.id)?.role).toBe('orchestrator')
  })

  it('refuses and durably audits agent self-elevation without retaining request secrets', () => {
    const { ctx, binding } = fixture()
    expect(() => approveYolo(withRole(ctx, 'orchestrator'), binding)).toThrow()
    const audit = listYoloAudit(ctx)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ command: 'yolo.enable', result: 'refused', grantId: binding.grantId })
    expect(JSON.stringify(audit)).not.toContain('token')
  })

  it('ends immediately on revoke, generation replacement, desktop restart and parent revocation', () => {
    for (const end of ['revoke', 'generation', 'restart', 'parent', 'exit'] as const) {
      const { ctx, grant, binding } = fixture()
      approveYolo(ctx, binding)
      if (end === 'revoke') revokeYolo(ctx, grant.id)
      if (end === 'generation') bindYoloChat(ctx, { ...binding, generation: 'start-two' })
      if (end === 'restart') bindYoloChat(ctx, { ...binding, desktopId: 'desktop-two' })
      if (end === 'parent') revokeGrant(ctx, grant.id)
      if (end === 'exit') endYoloChat(ctx, grant.id)
      expect(isYoloEligible(ctx, grant.id, 'plan.save', null), end).toBe(false)
      ctx.db.close()
    }
  })

  it('binds folder, run and grant and never extends when its parent is renewed', () => {
    const { ctx, grant, binding } = fixture()
    approveYolo(ctx, { ...binding, runId: 'run-one' })
    expect(isYoloEligible(ctx, grant.id, 'plan.save', 'run-two')).toBe(false)
    expect(isYoloEligible({ ...ctx, projectRoot: '/other' }, grant.id, 'plan.save', 'run-one')).toBe(false)
    expect(isYoloEligible(ctx, 'another-grant', 'plan.save', 'run-one')).toBe(false)
    ctx.clock.advanceSeconds(59 * 60)
    renewGrant(ctx, { grantId: grant.id, minutes: 60 })
    expect(isYoloEligible(ctx, grant.id, 'plan.save', 'run-one')).toBe(true)
    ctx.clock.advanceSeconds(60)
    expect(isYoloEligible(ctx, grant.id, 'plan.save', 'run-one')).toBe(false)
  })
  it('inserts the server-derived bounded log in a retro and requires per-capability role suggestions', () => {
    const { ctx, grant } = fixture()
    const run = seedRun(ctx)
    ctx.db.run(`INSERT INTO yolo_audit (time, grant_id, session_id, folder, run_id, capability, command, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.clock.nowIso(), grant.id, ctx.session.id, ctx.projectRoot, run.runId, 'plan.save', 'savePlan', 'admitted')
    const reporter = withRole(ctx, 'orchestrator')
    expect(() => submitSprintReport(reporter, { runId: run.runId, sprintId: run.bundle.sprints[0]?.id ?? '', report: { summary: 'No suggestions' } })).toThrow(/suggestion/i)
    const view = submitSprintReport(reporter, { runId: run.runId, sprintId: run.bundle.sprints[0]?.id ?? '', report: {
      summary: 'Auditable report',
      retro: { actions: ['[YOLO plan.save] planner: Permit Save only for a reviewed draft in the bound epic; keep checkpoint approval human-only.'] }
    } })
    expect(view.report.retro).toMatchObject({ yoloUsage: [expect.stringContaining('savePlan')] })
  })
