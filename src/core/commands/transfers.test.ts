import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { LinearReadback, LinearTransferPacket } from '../../shared/domain/transfer'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import { idOf, insertRun } from '../../test/repoFixtures'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { openDatabase } from '../db/database'
import { DomainError } from '../errors'
import type { Workspace } from '../workspace'

/** Sprint 1: First. Sprint 2: Second, which requires First. */
const TWO_SPRINTS: DraftOp[] = [
  { op: 'add_ticket', ref: 'first', sprint: '1', ticket: { title: 'First', acceptanceCriteria: ['First works'] } },
  { op: 'add_sprint', ref: 's2', sprint: { goal: 'Finish' } },
  { op: 'add_ticket', ref: 'second', sprint: 's2', ticket: { title: 'Second', acceptanceCriteria: ['Second works'] } },
  { op: 'add_dependency', from: 'first', to: 'second' }
]

const PROJECT_URL = 'https://linear.app/acme/project/handoff-0a1b2c3d'

/** The Linear id the fixture agent records for a packet ref. */
function lin(ref: string): string {
  return `lin-${ref}`
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

async function failureOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error: unknown) {
    return error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'thrown', message: String(error) }
  }
  return { code: 'ok', message: '' }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  return (await failureOf(promise)).code
}

interface Queued {
  desktop: Workspace
  agent: Workspace
  epicId: string
}

/** A saved two-sprint epic whose transfer the person queued in the desktop app. */
async function queuedEpic(): Promise<Queued> {
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'transfer-repo' })
  const epic = await desktop.createEpic({ title: 'Handoff' })
  await dropAcceptanceNodes(desktop, epic.id)
  await desktop.updatePlanDraft({ epicId: epic.id, ops: TWO_SPRINTS })
  const revision = await dropAcceptanceNodes(desktop, epic.id)
  await desktop.savePlan({ epicId: epic.id, expectedDraftRevision: revision })
  await desktop.queueTransfer({ epicId: epic.id })
  return { desktop, agent: harness.open('orchestrator'), epicId: epic.id }
}

interface Recorded extends Queued {
  packet: LinearTransferPacket
}

/** A started transfer with every packet ref recorded, as an agent that created each item in Linear would. */
async function recordedTransfer(): Promise<Recorded> {
  const queued = await queuedEpic()
  const { agent, epicId } = queued
  const { packet, next } = await agent.startTransfer({ epicId })
  const positions = new Map(packet.issues.map((issue) => [issue.ref, issue.position]))
  for (const ref of next) {
    const position = positions.get(ref)
    const issue = position === undefined ? {} : { identifier: `ENG-${position}`, url: `https://linear.app/acme/issue/ENG-${position}` }
    await agent.recordTransferItem({ epicId, ref, linearId: lin(ref), ...issue, ...(ref === 'project' ? { url: PROJECT_URL } : {}) })
  }
  return { ...queued, packet }
}

/** What Linear holds after a faithful transfer of `packet`. */
function readbackOf(packet: LinearTransferPacket): Required<LinearReadback> {
  const { project } = packet
  return {
    project: { linearId: lin('project'), url: PROJECT_URL, name: project.name, summary: project.summary, content: project.content },
    milestones: packet.milestones.map((item) => ({ linearId: lin(item.ref), name: item.name, description: item.description })),
    issues: packet.issues.map((item) => ({
      linearId: lin(item.ref),
      identifier: `ENG-${item.position}`,
      milestoneId: lin(item.milestoneRef),
      title: item.title,
      description: item.description,
      priority: item.priority,
      labels: [...item.labels],
      stateType: item.state === 'completed' ? 'completed' : 'unstarted',
      sortOrder: item.position * 100
    })),
    relations: packet.relations.map((item) =>
      item.kind === 'blocks'
        ? { kind: 'blocks', fromId: lin(item.blockerRef), toId: lin(item.blockedRef) }
        : { kind: 'related', fromId: lin(item.fromRef), toId: lin(item.toRef) }
    )
  }
}

/** The stored, not yet compared read-back parts of the epic's transfer. */
function storedReadback(epicId: string): string | null {
  const db = openDatabase(join(harness.root, '.darkmechanicus', 'local', 'state.sqlite'))
  try {
    return db.get<{ readback_json: string | null }>('SELECT readback_json FROM transfers WHERE epic_id = ?', epicId)?.readback_json ?? null
  } finally {
    db.close()
  }
}

describe('transfer commands', () => {
  it('carry a queued transfer through start, record and read-back to a completed epic', async () => {
    const { desktop, agent, epicId, packet } = await recordedTransfer()
    expect(await agent.getTransfer({ epicId })).toMatchObject({ status: 'in_progress', next: [] })
    const { project, milestones, issues, relations } = readbackOf(packet)

    const partial = await agent.submitTransferReadback({ epicId, readback: { project, milestones }, final: false })
    expect(partial).toMatchObject({ status: 'partial', received: { project: true, milestones: milestones.length } })
    const verified = await agent.submitTransferReadback({ epicId, readback: { issues, relations }, final: true })

    expect(verified).toMatchObject({ status: 'verified', mismatches: [] })
    expect(await desktop.getTransfer({ epicId })).toMatchObject({ status: 'verified' })
    expect(await desktop.getEpic({ epicId })).toMatchObject({ status: 'completed', outcome: { transfer: { projectUrl: PROJECT_URL } } })
  })

  it('let the desktop cancel a queued transfer, and refuse queueing and canceling to every agent role', async () => {
    const { desktop, epicId } = await queuedEpic()
    for (const role of ['planner', 'orchestrator', 'worker', 'reviewer'] as const) {
      const session = harness.open(role)
      expect(await codeOf(session.queueTransfer({ epicId }))).toBe('unauthorized')
      expect(await codeOf(session.cancelTransfer({ epicId }))).toBe('unauthorized')
    }
    expect(await desktop.cancelTransfer({ epicId })).toMatchObject({ status: 'canceled', recorded: [] })
    expect(await desktop.queueTransfer({ epicId })).toMatchObject({ status: 'queued' })
  })

  it('refuse start, record and read-back to a worker and a reviewer, which may still read the transfer', async () => {
    const { epicId } = await queuedEpic()
    for (const role of ['worker', 'reviewer'] as const) {
      const session = harness.open(role)
      expect(await session.getTransfer({ epicId })).toMatchObject({ status: 'queued' })
      expect(await codeOf(session.startTransfer({ epicId }))).toBe('unauthorized')
      expect(await codeOf(session.recordTransferItem({ epicId, ref: 'project', linearId: 'lin-project' }))).toBe('unauthorized')
      expect(await codeOf(session.submitTransferReadback({ epicId, readback: {}, final: false }))).toBe('unauthorized')
    }
  })
})

describe('transfer command idempotency', () => {
  it('replays queue, start and record with the same idempotency key instead of acting twice', async () => {
    const desktop = harness.open('desktop')
    await desktop.initializeRepository({ name: 'transfer-repo' })
    const epic = await desktop.createEpic({ title: 'Handoff' })
    await dropAcceptanceNodes(desktop, epic.id)
    await desktop.updatePlanDraft({ epicId: epic.id, ops: TWO_SPRINTS })
    await desktop.savePlan({ epicId: epic.id, expectedDraftRevision: await dropAcceptanceNodes(desktop, epic.id) })
    const epicId = epic.id

    const queued = await desktop.queueTransfer({ epicId, idempotencyKey: 'queue-1' })
    // Without the key a second queue is a conflict: the transfer is already open.
    expect(await desktop.queueTransfer({ epicId, idempotencyKey: 'queue-1' })).toEqual(queued)
    expect(await codeOf(desktop.queueTransfer({ epicId }))).toBe('conflict')

    const agent = harness.open('orchestrator')
    const started = await agent.startTransfer({ epicId, idempotencyKey: 'start-1' })
    const item = { epicId, ref: 'project', linearId: 'lin-project', url: PROJECT_URL, idempotencyKey: 'record-1' }
    const first = await agent.recordTransferItem(item)
    harness.clock.advanceSeconds(5)
    expect(await agent.recordTransferItem(item)).toEqual(first)
    expect(await agent.startTransfer({ epicId, idempotencyKey: 'start-1' })).toEqual(started)
    expect(await codeOf(agent.recordTransferItem({ ...item, linearId: 'lin-other' }))).toBe('idempotency_mismatch')
  })
})

describe('submitTransferReadback after a final part whose completion fails', () => {
  it('leaves no stored parts behind, so a later read-back cannot borrow the consumed ones', async () => {
    const { desktop, agent, epicId, packet } = await recordedTransfer()
    const { project, milestones, issues, relations } = readbackOf(packet)
    await agent.submitTransferReadback({ epicId, readback: { project, milestones, issues }, final: false })
    expect(storedReadback(epicId)).not.toBeNull()

    // A run that became active behind the transfer's back refuses the completion of a matching read-back.
    const revisionId = (await desktop.getEpic({ epicId })).currentRevisionId ?? ''
    const db = openDatabase(join(harness.root, '.darkmechanicus', 'local', 'state.sqlite'))
    try {
      insertRun(db, { id: idOf('run', 1), epicId, revisionId })
    } finally {
      db.close()
    }
    expect(await codeOf(agent.submitTransferReadback({ epicId, readback: { relations }, final: true }))).toBe('active_run_exists')

    expect(storedReadback(epicId)).toBeNull()
    expect(await desktop.getEpic({ epicId })).toMatchObject({ status: 'backlog', outcome: null })
    const reopened = openDatabase(join(harness.root, '.darkmechanicus', 'local', 'state.sqlite'))
    try {
      reopened.run("UPDATE runs SET state = 'canceled'")
    } finally {
      reopened.close()
    }
    // A fresh read-back that leaves the last issue out is rejected, not completed from the consumed parts.
    const missing = issues[issues.length - 1]
    const result = await agent.submitTransferReadback({
      epicId,
      readback: { project, milestones, issues: issues.slice(0, -1), relations },
      final: true
    })
    expect(result.status).toBe('rejected')
    expect(result.mismatches).toContainEqual(expect.objectContaining({ field: 'present', expected: missing?.linearId }))
  })
})

describe('transfer command input', () => {
  it('rejects a read-back issue without its stateType before anything is stored', async () => {
    const { agent, epicId, packet } = await recordedTransfer()
    const { issues } = readbackOf(packet)
    const { stateType: _dropped, ...withoutState } = issues[0] ?? { stateType: '' }
    const raw = agent.submitTransferReadback as (input: unknown) => Promise<unknown>
    expect(await failureOf(raw({ epicId, readback: { issues: [withoutState] }, final: false }))).toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('Invalid submitTransferReadback input at readback.issues.0.stateType')
    })
    expect(storedReadback(epicId)).toBeNull()
  })

  it.each([
    ['more issues than a plan holds', (issue: object) => ({ issues: Array.from({ length: 1_001 }, () => issue) }), 'readback.issues'],
    ['more milestones than a plan holds', () => ({ milestones: Array.from({ length: 101 }, () => ({ linearId: 'm', name: '', description: '' })) }), 'readback.milestones'],
    ['more labels than a ticket holds', (issue: object) => ({ issues: [{ ...issue, labels: Array.from({ length: 51 }, (_, at) => `l${at}`) }] }), 'readback.issues.0.labels'],
    ['an over-long project URL', () => ({ project: { linearId: 'p', url: 'x'.repeat(2_001), name: '', summary: '', content: '' } }), 'readback.project.url'],
    ['an empty Linear id', (issue: object) => ({ issues: [{ ...issue, linearId: '' }] }), 'readback.issues.0.linearId'],
    ['an unknown field', (issue: object) => ({ issues: [{ ...issue, team: 'ENG' }] }), 'readback.issues.0'],
    ['a missing milestoneId', (issue: object) => ({ issues: [{ ...issue, milestoneId: undefined }] }), 'readback.issues.0.milestoneId']
  ])('rejects %s', async (_label, build, path) => {
    const { agent, epicId, packet } = await recordedTransfer()
    const issue = readbackOf(packet).issues[0] ?? {}
    const raw = agent.submitTransferReadback as (input: unknown) => Promise<unknown>
    expect(await failureOf(raw({ epicId, readback: build(issue), final: false }))).toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining(`at ${path}`)
    })
    expect(storedReadback(epicId)).toBeNull()
  })

  it('takes no idempotency key on a read-back part, and needs final', async () => {
    const { agent, epicId } = await recordedTransfer()
    const raw = agent.submitTransferReadback as (input: unknown) => Promise<unknown>
    expect(await codeOf(raw({ epicId, readback: {}, final: false, idempotencyKey: 'part-1' }))).toBe('invalid_input')
    expect(await codeOf(raw({ epicId, readback: {} }))).toBe('invalid_input')
  })

  it('rejects a malformed ref, an empty Linear id and an over-long URL when recording', async () => {
    const { agent, epicId } = await queuedEpic()
    await agent.startTransfer({ epicId })
    const bad = [
      agent.recordTransferItem({ epicId, ref: 'not a ref', linearId: 'lin-x' }),
      agent.recordTransferItem({ epicId, ref: 'project', linearId: '' }),
      agent.recordTransferItem({ epicId, ref: 'project', linearId: 'lin-x', url: 'x'.repeat(2_001) }),
      agent.recordTransferItem({ epicId, ref: 'x'.repeat(201), linearId: 'lin-x' })
    ]
    expect(await Promise.all(bad.map(codeOf))).toEqual(bad.map(() => 'invalid_input'))
    expect((await agent.getTransfer({ epicId })).recorded).toEqual([])
  })
})
