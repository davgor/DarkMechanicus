import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'
import { callTool, withServer } from '../../test/mcpHarness'
import { createMcpServer } from '../../mcp/server'

let harness: Harness
let desktop: Workspace
beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Save permission fixture' })
})
afterEach(() => harness.cleanup())

async function agent(allowSave: boolean, role: 'orchestrator' | 'planner' | 'worker' = 'orchestrator') {
  const issued = await desktop.issueGrant({ role, label: 'Permission fixture', allowSave })
  return { ...issued, api: harness.open('reader', { transport: 'cli', grantToken: issued.token }) }
}

describe('Allow save defaults and human approval', () => {
  it('defaults new orchestrator grants to saving without elevating other roles', async () => {
    for (const role of ['orchestrator', 'planner', 'worker', 'reader', 'reviewer'] as const) {
      const issued = await desktop.issueGrant({ role, label: role })
      const api = harness.open('reader', { transport: 'cli', grantToken: issued.token })
      expect((await api.getCapabilities()).capabilities.includes('plan.save')).toBe(role === 'orchestrator')
    }
  })

  it('keeps a request pending until human approval, then updates existing and new CLI sessions only on its grant', async () => {
    const target = await agent(false)
    const other = await agent(false)
    const epic = await target.api.createEpic({ title: 'A plan requiring general save authority' })
    const draft = await target.api.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Reviewed work' } }] })
    const save = { epicId: epic.id, expectedDraftRevision: draft.draftRevision }
    await expect(target.api.savePlan(save)).rejects.toMatchObject({ code: 'unauthorized' })
    const request = await target.api.requestSavePermission({ reason: 'Save the reviewed plan' })
    expect(request).toMatchObject({ status: 'pending', grantId: target.grant.id })
    expect((await target.api.getCapabilities()).capabilities).not.toContain('plan.save')
    expect(await target.api.listSavePermissionRequests()).toEqual([request])
    await desktop.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Reviewed scope' })
    expect((await target.api.listSavePermissionRequests())[0]).toMatchObject({ status: 'approved', decisionReason: 'Reviewed scope' })
    expect((await target.api.getCapabilities()).capabilities).toContain('plan.save')
    expect((await harness.open('reader', { transport: 'cli', grantToken: target.token }).getCapabilities()).capabilities).toContain('plan.save')
    expect((await other.api.getCapabilities()).capabilities).not.toContain('plan.save')
    await expect(target.api.savePlan(save)).resolves.toMatchObject({ status: 'saved' })
    const events = (await desktop.listEvents({})).events
    expect(events.find((event) => event.kind === 'save_permission.decided')?.payload).toMatchObject({ requestId: request.id, decision: 'approved' })
    const caps = (await target.api.getCapabilities()).capabilities
    for (const forbidden of ['grant.issue', 'checkpoint.approve', 'ticket.retry_grant', 'kanban.review']) expect(caps).not.toContain(forbidden)
  })

})

describe('Allow save decision authority and session scope', () => {
  it('allows an explicitly saving other orchestrator, never self approval or transitive delegation', async () => {
    const target = await agent(false)
    const approver = await agent(true)
    const third = await agent(false)
    const request = await target.api.requestSavePermission({ reason: 'Need save' })
    await expect(target.api.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Myself' })).rejects.toMatchObject({ code: 'unauthorized' })
    const sameGrant = harness.open('reader', { transport: 'cli', grantToken: target.token })
    await expect(sameGrant.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Same grant' })).rejects.toMatchObject({ code: 'unauthorized' })
    await approver.api.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Authorized other orchestrator' })
    const next = await third.api.requestSavePermission({ reason: 'Need save too' })
    await expect(target.api.decideSavePermission({ requestId: next.id, decision: 'approved', reason: 'Cannot delegate acquired permission' })).rejects.toMatchObject({ code: 'unauthorized' })
    for (const role of ['planner', 'worker'] as const) {
      const unauthorized = await agent(true, role)
      await expect(unauthorized.api.decideSavePermission({ requestId: next.id, decision: 'approved', reason: 'Wrong role' })).rejects.toMatchObject({ code: 'unauthorized' })
    }
  })

  it('records denial without changing permission and refuses changing a decided request', async () => {
    const target = await agent(false)
    const request = await target.api.requestSavePermission({ reason: 'Need save' })
    await desktop.decideSavePermission({ requestId: request.id, decision: 'denied', reason: 'Not approved' })
    expect((await target.api.listSavePermissionRequests())[0]).toMatchObject({ status: 'denied', decisionReason: 'Not approved' })
    expect((await target.api.getCapabilities()).capabilities).not.toContain('plan.save')
    await expect(desktop.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Changed mind' })).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('supports existing non-grant MCP sessions without granting a replacement session permission', async () => {
    const target = harness.open('orchestrator', { transport: 'stdio', allowSave: false })
    const request = await target.requestSavePermission({ reason: 'Existing MCP session' })
    await desktop.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Session only' })
    expect((await target.getCapabilities()).capabilities).toContain('plan.save')
    expect((await harness.open('orchestrator', { transport: 'stdio', allowSave: false }).getCapabilities()).capabilities).not.toContain('plan.save')
  })

})

describe('Allow save refusal and pending-request audit', () => {
  it('refuses revoked targets and approvers and prevents requests from non-orchestrators', async () => {
    const target = await agent(false)
    const request = await target.api.requestSavePermission({ reason: 'Need save' })
    await desktop.revokeGrant({ grantId: target.grant.id })
    await expect(desktop.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Too late' })).rejects.toMatchObject({ code: 'unauthorized' })
    const other = await agent(false)
    const next = await other.api.requestSavePermission({ reason: 'Need save' })
    const approver = await agent(true)
    await desktop.revokeGrant({ grantId: approver.grant.id })
    await expect(approver.api.decideSavePermission({ requestId: next.id, decision: 'approved', reason: 'Revoked' })).rejects.toMatchObject({ code: 'unauthorized' })
    const planner = await agent(false, 'planner')
    await expect(planner.api.requestSavePermission({ reason: 'Wrong role' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('returns the same pending request without granting authority or duplicating its audit', async () => {
    const target = await agent(false)
    const request = await target.api.requestSavePermission({ reason: 'Need save' })
    expect(await target.api.requestSavePermission({ reason: 'Still waiting' })).toEqual(request)
    expect((await desktop.listEvents({})).events.filter((event) => event.kind === 'save_permission.requested')).toHaveLength(1)
    await desktop.decideSavePermission({ requestId: request.id, decision: 'denied', reason: 'Denied first request' })
    const next = await target.api.requestSavePermission({ reason: 'New reviewed request' })
    expect(next.id).not.toBe(request.id)
    expect(next.status).toBe('pending')
  })

})

describe('Allow save grant and target liveness fences', () => {
  it('fences approval and its effects by expiry, revocation, machine and folder', async () => {
    const target = await agent(false)
    const request = await target.api.requestSavePermission({ reason: 'Need save' })
    const clone = harness.cloneTracked()
    const elsewhere = harness.open('desktop', { root: clone })
    await expect(elsewhere.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Wrong folder' })).rejects.toMatchObject({ code: 'not_found' })
    await desktop.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Correct folder' })
    expect((await target.api.getCapabilities()).capabilities).toContain('plan.save')
    expect((await target.api.getCapabilities()).capabilities).not.toContain('plan.decide_save')
    await desktop.revokeGrant({ grantId: target.grant.id })
    await expect(target.api.getCapabilities()).rejects.toMatchObject({ code: 'unauthorized' })
    const expiring = await desktop.issueGrant({ role: 'orchestrator', label: 'Expires soon', allowSave: false, minutes: 5 })
    const session = harness.open('reader', { transport: 'cli', grantToken: expiring.token })
    const pending = await session.requestSavePermission({ reason: 'Before expiry' })
    harness.clock.advanceSeconds(301)
    await expect(desktop.decideSavePermission({ requestId: pending.id, decision: 'approved', reason: 'Expired target' })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(session.getCapabilities()).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('supports authorized MCP agent denial and refuses closed or stale session targets', async () => {
    const approver = harness.open('orchestrator', { transport: 'stdio', allowSave: true })
    const target = harness.open('orchestrator', { transport: 'stdio', allowSave: false })
    const pending = await target.requestSavePermission({ reason: 'MCP request' })
    await approver.decideSavePermission({ requestId: pending.id, decision: 'denied', reason: 'Not this plan' })
    expect((await target.listSavePermissionRequests()).find((request) => request.id === pending.id)?.status).toBe('denied')
    const closed = await target.requestSavePermission({ reason: 'Closed session request' })
    target.close()
    await expect(desktop.decideSavePermission({ requestId: closed.id, decision: 'approved', reason: 'Closed' })).rejects.toMatchObject({ code: 'unauthorized' })
    const stale = harness.open('orchestrator', { transport: 'stdio', allowSave: false })
    const staleRequest = await stale.requestSavePermission({ reason: 'Stale session' })
    harness.clock.advanceSeconds(61)
    await expect(desktop.decideSavePermission({ requestId: staleRequest.id, decision: 'approved', reason: 'Stale' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

})

describe('Allow save MCP transport', () => {
  it('lists and executes MCP permission tools and saves immediately after approval without reconnecting', async () => {
    const target = harness.open('orchestrator', { transport: 'stdio', allowSave: false })
    const epic = await target.createEpic({ title: 'MCP save proof' })
    const draft = await target.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Reviewed work' } }] })
    const server = createMcpServer(target, { name: 'permission-proof', version: '1' }, { role: 'orchestrator', allowSave: false })
    await withServer(server, async (rig) => {
      const tools = (await rig.client.listTools()).tools.map((tool) => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['request_save_permission', 'list_save_permission_requests', 'decide_save_permission', 'save_plan']))
      const result = await callTool(rig, 'request_save_permission', { reason: 'MCP explicit request' })
      expect(result.isError).toBe(false)
      const request = (await desktop.listSavePermissionRequests())[0]
      expect(request?.status).toBe('pending')
      await desktop.decideSavePermission({ requestId: request?.id ?? '', decision: 'approved', reason: 'Human reviewed' })
      const saved = await callTool(rig, 'save_plan', { epicId: epic.id, expectedDraftRevision: draft.draftRevision })
      expect(saved.isError).toBe(false)
      expect((await target.getPlan({ epicId: epic.id, view: 'saved' })).revisionNumber).toBe(1)
      expect((await target.getCapabilities()).capabilities).not.toContain('plan.decide_save')
    })
  })

})

describe('Allow save approved-session lifetime', () => {
  it('expires approved MCP-session saving when its live-session fence lapses, without reviving it on a command', async () => {
    const target = harness.open('orchestrator', { transport: 'stdio', allowSave: false })
    const epic = await target.createEpic({ title: 'Unrelated epic without an active run' })
    const draft = await target.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Reviewed work' } }] })
    const request = await target.requestSavePermission({ reason: 'Live MCP-session scope' })
    await desktop.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Only while live' })
    expect((await target.getCapabilities()).capabilities).toContain('plan.save')
    harness.clock.advanceSeconds(61)
    expect((await target.getCapabilities()).capabilities).not.toContain('plan.save')
    await expect(target.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await target.getCapabilities()).capabilities).not.toContain('plan.save')
  })

  it('does not restore an ended approved MCP session when its workspace reconnects', async () => {
    const target = harness.open('orchestrator', { transport: 'stdio', allowSave: false })
    const request = await target.requestSavePermission({ reason: 'This session only' })
    await desktop.decideSavePermission({ requestId: request.id, decision: 'approved', reason: 'Until it ends' })
    const before = await target.getCapabilities()
    expect(before.capabilities).toContain('plan.save')
    target.close()
    const after = await target.getCapabilities()
    expect(after.sessionId).not.toBe(before.sessionId)
    expect(after.capabilities).not.toContain('plan.save')
  })
})
