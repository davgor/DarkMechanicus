import { afterEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { bindToolingGrant, holdToolingWorkflow, releaseToolingWorkflow, retireToolingWorkflow } from './toolingHold'
import { claim, startedRun } from '../../test/execution'
import { withRole } from '../../test/testContext'
import { heartbeatAttempt } from './attempts'
import { expireLeases, listAttempts } from './execution'
import { cancelRun, getRun, pauseRun, resumeRun, takeoverRun } from './runs'
import { makeBundle } from '../../test/bundles'

const harnesses: Harness[] = []
afterEach(() => { for (const harness of harnesses.splice(0)) harness.cleanup() })
  it('blocks unrelated planner mutations while leaving reads, heartbeat and repair communication available across a new grant', async () => {
    const h = createHarness(); harnesses.push(h)
    const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'fixture', keyPrefix: 'FIX' })
    const grant = await desktop.issueGrant({ role: 'planner', label: 'unfinished fixture' })
    bindToolingGrant(desktop.ctx(), grant.grant.id, 'chat_fixture')
    holdToolingWorkflow(desktop.ctx(), { id: 'chat_fixture', incidentId: 'incident_fixture' })
    const planner = h.open('planner', { grantToken: grant.token, transport: 'cli' })
    await expect(planner.createKanbanCard({ title: 'Unrelated progress' })).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await planner.getProject()).name).toBe('fixture')
    await expect(planner.recoverTooling({ action: 'status', incidentId: 'incident_fixture' })).rejects.toMatchObject({ code: 'desktop_unavailable' })
    const next = await desktop.issueGrant({ role: 'planner', label: 'restarted fixture' })
    bindToolingGrant(desktop.ctx(), next.grant.id, 'chat_fixture')
    const restarted = h.open('planner', { grantToken: next.token, transport: 'cli' })
    await expect(restarted.createKanbanCard({ title: 'Still blocked' })).rejects.toMatchObject({ code: 'invalid_state' })
    releaseToolingWorkflow(desktop.ctx(), { id: 'chat_fixture', incidentId: 'wrong' })
    await expect(restarted.createKanbanCard({ title: 'Wrong incident' })).rejects.toMatchObject({ code: 'invalid_state' })
    releaseToolingWorkflow(desktop.ctx(), { id: 'chat_fixture', incidentId: 'incident_fixture' })
    expect((await restarted.createKanbanCard({ title: 'Resumed original task' })).title).toBe('Resumed original task')
  })
  it('holds only captured run claims, keeps heartbeats live, releases once without inflating lease lengths, and preserves revoke/cancel controls', async () => {
    const h = createHarness(); harnesses.push(h)
    const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'lease fixture' })
    const ctx = { ...desktop.ctx(), clock: h.clock }
    const agent = withRole(ctx, 'orchestrator')
    const owned = startedRun(ctx); const unrelated = startedRun(ctx, { bundle: makeBundle([[3]]) })
    const held = claim(agent, owned.runId, 1, { leaseSeconds: 30 })
    const other = claim(agent, unrelated.runId, 3, { leaseSeconds: 30 })
    const grant = await desktop.issueGrant({ role: 'orchestrator', label: 'live caller' })
    bindToolingGrant(ctx, grant.grant.id, 'chat_lease')
    holdToolingWorkflow(ctx, { id: 'chat_lease', incidentId: 'lease_incident', runId: owned.runId })
    h.clock.advanceSeconds(60)
    expect(expireLeases(ctx)).toEqual([other.attempt.id])
    expect(getRun(ctx, { runId: owned.runId })?.state).toBe('paused')
    const heartbeat = { attemptId: held.attempt.id, claimToken: held.packet.claimToken }
    heartbeatAttempt(agent, heartbeat)
    h.clock.advanceSeconds(60)
    releaseToolingWorkflow(ctx, { id: 'chat_lease', incidentId: 'lease_incident' })
    expect(getRun(ctx, { runId: owned.runId })?.state).toBe('running')
    const renewed = heartbeatAttempt(agent, heartbeat)
    expect(Date.parse(renewed.leaseExpiresAt!) - h.clock.nowMs()).toBe(30_000)
    holdToolingWorkflow(ctx, { id: 'chat_lease', incidentId: 'revoke_incident', runId: owned.runId })
    await desktop.revokeGrant({ grantId: grant.grant.id })
    h.clock.advanceSeconds(60)
    expect(expireLeases(ctx)).toContain(held.attempt.id)
    expect(cancelRun(ctx, { runId: owned.runId }).state).toBe('canceled')
  })

  it('never resumes or extends a run after takeover and refuses stale takeover-scoped holds', async () => {
    const h = createHarness(); harnesses.push(h)
    const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'takeover fixture' })
    const ctx = { ...desktop.ctx(), clock: h.clock }
    const run = startedRun(ctx)
    holdToolingWorkflow(ctx, { id: 'chat_takeover', incidentId: 'takeover_incident', runId: run.runId })
    ctx.db.run("UPDATE runs SET owner_machine_id = 'mc_other' WHERE id = ?", run.runId)
    takeoverRun(ctx, { runId: run.runId })
    expect(() => releaseToolingWorkflow(ctx, { id: 'chat_takeover', incidentId: 'takeover_incident' })).toThrow('taken over')
    expect(() => holdToolingWorkflow(ctx, { id: 'chat_stale', incidentId: 'stale_incident', runId: run.runId })).toThrow('taken-over')
  })

  it('preserves exact Kanban claims through interruption and renewal without enlarging future heartbeats', async () => {
    const h = createHarness(); harnesses.push(h)
    const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'card fixture' })
    const grant = await desktop.issueGrant({ role: 'orchestrator', label: 'card caller' })
    const agent = h.open('orchestrator', { grantToken: grant.token, transport: 'cli' })
    const card = await desktop.createKanbanCard({ title: 'Original unfinished card' })
    await desktop.playKanbanCard({ cardId: card.id })
    const packet = await agent.claimKanbanCard({ cardId: card.id })
    if (packet.claimToken === null) throw new Error('First claim unexpectedly replayed')
    bindToolingGrant(desktop.ctx(), grant.grant.id, 'chat_card')
    holdToolingWorkflow(desktop.ctx(), { id: 'chat_card', incidentId: 'card_incident', cardId: card.id })
    const leaseMs = Date.parse(packet.leaseExpiresAt) - h.clock.nowMs()
    h.clock.advanceSeconds(leaseMs / 1000 + 60)
    const input = { attemptId: packet.attemptId, claimToken: packet.claimToken }
    await agent.heartbeatKanbanCard(input)
    h.clock.advanceSeconds(60)
    releaseToolingWorkflow(desktop.ctx(), { id: 'chat_card', incidentId: 'card_incident' })
    const heartbeat = await agent.heartbeatKanbanCard(input)
    expect(Date.parse(heartbeat.leaseExpiresAt!) - h.clock.nowMs()).toBe(leaseMs)
    expect((await desktop.getKanbanCard({ cardId: card.id })).lane).toBe('in_progress')
  })
  it('retires a deleted-origin hold without completing work or requiring the deceased identity for human recovery', async () => {
    const h = createHarness(); harnesses.push(h)
    const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'deleted origin fixture' })
    const ctx = { ...desktop.ctx(), clock: h.clock }
    const run = startedRun(ctx)
    holdToolingWorkflow(ctx, { id: 'chat_deleted', incidentId: 'deleted_incident', runId: run.runId })
    retireToolingWorkflow(ctx, 'chat_deleted')
    expect(getRun(ctx, { runId: run.runId })?.state).toBe('paused')
    expect(resumeRun(ctx, { runId: run.runId }).state).toBe('running')
  })

it.each([false, true])('returns only hold time since the last lease renewal (heartbeat during hold=%s)', async renewDuringHold => {
  const h = createHarness(); harnesses.push(h)
  const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'hold arithmetic' })
  const ctx = { ...desktop.ctx(), clock: h.clock }; const agent = withRole(ctx, 'orchestrator')
  const run = startedRun(ctx); const held = claim(agent, run.runId, 1, { leaseSeconds: 30 })
  const grant = await desktop.issueGrant({ role: 'orchestrator', label: 'arithmetic owner' })
  bindToolingGrant(ctx, grant.grant.id, 'chat_arithmetic')
  h.clock.advanceSeconds(10)
  const input = { attemptId: held.attempt.id, claimToken: held.packet.claimToken }
  heartbeatAttempt(agent, input)
  h.clock.advanceSeconds(10)
  const target = { id: 'chat_arithmetic', incidentId: 'arithmetic', runId: run.runId }
  holdToolingWorkflow(ctx, target)
  h.clock.advanceSeconds(30)
  holdToolingWorkflow(ctx, target)
  expect(() => holdToolingWorkflow(ctx, { ...target, incidentId: 'different' })).toThrow('unresolved tooling hold')
  h.clock.advanceSeconds(10)
  if (renewDuringHold) heartbeatAttempt(agent, input)
  h.clock.advanceSeconds(40)
  releaseToolingWorkflow(ctx, target)
  const released = listAttempts(ctx, { runId: run.runId })[0]!
  expect(Date.parse(released.leaseExpiresAt!) - h.clock.nowMs()).toBe(renewDuringHold ? 30_000 : 20_000)
  expect(getRun(ctx, { runId: run.runId })?.state).toBe('running')
  releaseToolingWorkflow(ctx, target)
  expect(listAttempts(ctx, { runId: run.runId })).toEqual([released])
  expect(Date.parse(heartbeatAttempt(agent, input).leaseExpiresAt!) - h.clock.nowMs()).toBe(30_000)
})

it('extends only captured run claims on replay and keeps human resume blocked until verified release', async () => {
  const h = createHarness(); harnesses.push(h)
  const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'captured claims' })
  const ctx = { ...desktop.ctx(), clock: h.clock }; const agent = withRole(ctx, 'orchestrator')
  const run = startedRun(ctx)
  const first = claim(agent, run.runId, 1, { leaseSeconds: 30 })
  const grant = await desktop.issueGrant({ role: 'orchestrator', label: 'capture owner' })
  bindToolingGrant(ctx, grant.grant.id, 'chat_capture')
  const target = { id: 'chat_capture', incidentId: 'captured', runId: run.runId }
  holdToolingWorkflow(ctx, target)
  h.clock.advanceSeconds(10)
  expect(() => resumeRun(ctx, { runId: run.runId })).toThrow('only verified incident recovery')
  const unrelated = startedRun(ctx, { bundle: makeBundle([[3]]) })
  const later = claim(agent, unrelated.runId, 3, { leaseSeconds: 30 })
  holdToolingWorkflow(ctx, target)
  h.clock.advanceSeconds(5)
  releaseToolingWorkflow(ctx, target)
  const attempts = listAttempts(ctx, { runId: run.runId })
  expect(attempts.find(attempt => attempt.id === first.attempt.id)?.leaseExpiresAt).toBe(new Date(Date.parse(first.attempt.leaseExpiresAt!) + 15_000).toISOString())
  expect(listAttempts(ctx, { runId: unrelated.runId })[0]?.leaseExpiresAt).toBe(later.attempt.leaseExpiresAt)
})

it('leaves a canceled held run canceled and refuses to revive canceled attempts', async () => {
  const h = createHarness(); harnesses.push(h)
  const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'cancel held run' })
  const ctx = { ...desktop.ctx(), clock: h.clock }; const agent = withRole(ctx, 'orchestrator')
  const run = startedRun(ctx); const held = claim(agent, run.runId, 1, { leaseSeconds: 30 })
  const target = { id: 'chat_cancel', incidentId: 'cancel', runId: run.runId }
  holdToolingWorkflow(ctx, target)
  cancelRun(ctx, { runId: run.runId })
  const canceled = listAttempts(ctx, { runId: run.runId })
  h.clock.advanceSeconds(60)
  releaseToolingWorkflow(ctx, target)
  expect(getRun(ctx, { runId: run.runId })?.state).toBe('canceled')
  expect(listAttempts(ctx, { runId: run.runId })).toEqual(canceled)
  expect(() => heartbeatAttempt(agent, { attemptId: held.attempt.id, claimToken: held.packet.claimToken })).toThrow()
})

it('preserves a pre-existing human pause instead of treating repair release as permission to resume', async () => {
  const h = createHarness(); harnesses.push(h)
  const desktop = h.open('desktop'); await desktop.initializeRepository({ name: 'human paused run' })
  const ctx = { ...desktop.ctx(), clock: h.clock }
  const run = startedRun(ctx)
  pauseRun(ctx, { runId: run.runId, reason: 'human inspection' })
  const target = { id: 'chat_pause', incidentId: 'pause', runId: run.runId }
  holdToolingWorkflow(ctx, target)
  releaseToolingWorkflow(ctx, target)
  expect(getRun(ctx, { runId: run.runId })).toMatchObject({ state: 'paused', pauseReason: 'human inspection' })
  expect(resumeRun(ctx, { runId: run.runId }).state).toBe('running')
})
