import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type {
  LinearReadback,
  LinearReadbackIssue,
  LinearReadbackMilestone,
  LinearTransferPacket,
  TransferMismatch,
  TransferReadbackResult
} from '../../shared/domain/transfer'
import { makeBundle, sid, tid } from '../../test/bundles'
import { domainError, eventKinds, lastEventPayload, pendingOutbox, seedEpic, seedRevision, startedRun } from '../../test/execution'
import { idOf, insertRevision, insertRun } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { fail } from '../errors'
import { buildEpicStateRecord } from '../repo/portable'
import { READBACK_LIMITS } from '../schemas'
import { listComments } from './comments'
import { openDraft, updatePlanDraft } from './drafts'
import { getEpic } from './epics'
import { startRun } from './runs'
import { TRANSFER_HOLD_PREFIX } from './transferGuard'
import {
  cancelTransfer,
  getTransfer,
  queueTransfer,
  recordTransferItem,
  startTransfer,
  submitTransferReadback
} from './transfers'

function desktopCtx(): TestCtx {
  return createTestCtx({ role: 'desktop' })
}

function transferRowCount(ctx: TestCtx): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transfers')?.n ?? 0
}

/** A saved two-sprint epic with a blocking edge, so the packet has a project, milestones, issues and a relation. */
function savedEpic(ctx: TestCtx): string {
  return seedEpic(ctx, { bundle: makeBundle([[1, 2], [3]], [[1, 3]]) }).epicId
}

describe('queueTransfer refusals', () => {
  it('refuses a completed epic with completed_epic', () => {
    const ctx = desktopCtx()
    const { epicId } = seedEpic(ctx, { status: 'completed' })
    expect(domainError(() => queueTransfer(ctx, { epicId })).code).toBe('completed_epic')
    expect(transferRowCount(ctx)).toBe(0)
  })

  it('refuses an epic with an active run with active_run_exists', () => {
    const ctx = desktopCtx()
    const { epicId } = startedRun(ctx)
    expect(domainError(() => queueTransfer(ctx, { epicId })).code).toBe('active_run_exists')
    expect(transferRowCount(ctx)).toBe(0)
  })

  it('refuses an epic with no saved revision with invalid_plan', () => {
    const ctx = desktopCtx()
    const { epicId } = seedEpic(ctx, { saved: false })
    expect(domainError(() => queueTransfer(ctx, { epicId })).code).toBe('invalid_plan')
    expect(transferRowCount(ctx)).toBe(0)
  })

  it('refuses an unsaved draft change with conflict', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    openDraft(ctx, { epicId })
    updatePlanDraft(ctx, { epicId, ops: [{ op: 'update_ticket', ticket: tid(1), patch: { title: 'Changed in the draft' } }] })
    const error = domainError(() => queueTransfer(ctx, { epicId }))
    expect(error.code).toBe('conflict')
    expect(error.details).toMatchObject({ epicId })
    expect(transferRowCount(ctx)).toBe(0)
  })

  it('accepts a draft opened without changes', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    openDraft(ctx, { epicId })
    expect(queueTransfer(ctx, { epicId }).status).toBe('queued')
  })

  it('refuses a second transfer while one is open with conflict', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    queueTransfer(ctx, { epicId })
    expect(domainError(() => queueTransfer(ctx, { epicId })).code).toBe('conflict')
    startTransfer(withRole(ctx, 'orchestrator'), { epicId })
    expect(domainError(() => queueTransfer(ctx, { epicId })).code).toBe('conflict')
    expect(eventKinds(ctx, 'transfer.')).toEqual(['transfer.queued', 'transfer.started'])
  })
})

describe('queueTransfer', () => {
  it('is refused to the orchestrator, which lacks transfer.queue', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const error = domainError(() => queueTransfer(withRole(ctx, 'orchestrator'), { epicId }))
    expect(error.code).toBe('unauthorized')
    expect(transferRowCount(ctx)).toBe(0)
  })

  it('stores the packet of the current saved revision with its hash and logs transfer.queued', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const view = queueTransfer(ctx, { epicId })
    expect(view.status).toBe('queued')
    expect(view.packet?.issues.map((issue) => issue.ref)).toEqual([tid(1), tid(2), tid(3)])
    const row = ctx.db.get<{ packet_hash: string; target: string }>('SELECT packet_hash, target FROM transfers WHERE epic_id = ?', epicId)
    expect(row).toEqual({ packet_hash: view.packet?.packetHash, target: 'linear' })
    expect(eventKinds(ctx, 'transfer.')).toEqual(['transfer.queued'])
  })
})

describe('startTransfer', () => {
  it('fails when the person has not queued a transfer, and changes nothing', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const error = domainError(() => startTransfer(withRole(ctx, 'orchestrator'), { epicId }))
    expect(error.message).toBe('The person has not authorized a transfer of this epic.')
    expect(transferRowCount(ctx)).toBe(0)
    expect(eventKinds(ctx, 'transfer.')).toEqual([])
  })

  it('fails after the person canceled the transfer', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    queueTransfer(ctx, { epicId })
    cancelTransfer(ctx, { epicId })
    const error = domainError(() => startTransfer(withRole(ctx, 'orchestrator'), { epicId }))
    expect(error.message).toBe('The person has not authorized a transfer of this epic.')
  })
})

describe('startTransfer resume', () => {
  it('resumes with the stored packet, and next skips what was recorded, in packet order', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const queued = queueTransfer(ctx, { epicId })
    const agent = withRole(ctx, 'orchestrator')
    const first = startTransfer(agent, { epicId })
    const relationRef = `rel:${tid(1)}:${tid(3)}`
    expect(first.packet).toEqual(queued.packet)
    expect(first.next).toEqual(['project', sid(1), sid(2), tid(1), tid(2), tid(3), relationRef])
    expect(ctx.db.get('SELECT status FROM transfers WHERE epic_id = ?', epicId)).toEqual({ status: 'in_progress' })

    recordTransferItem(agent, { epicId, ref: 'project', linearId: 'lin-project', url: 'https://linear.app/p' })
    recordTransferItem(agent, { epicId, ref: sid(1), linearId: 'lin-m1' })
    recordTransferItem(agent, { epicId, ref: tid(2), linearId: 'lin-2', identifier: 'ENG-2' })

    const resumed = startTransfer(agent, { epicId })
    expect(resumed.packet).toEqual(queued.packet)
    expect(resumed.recorded.map((item) => [item.ref, item.kind, item.linearId])).toEqual([
      ['project', 'project', 'lin-project'],
      [sid(1), 'milestone', 'lin-m1'],
      [tid(2), 'issue', 'lin-2']
    ])
    expect(resumed.next).toEqual([sid(2), tid(1), tid(3), relationRef])
    expect(getTransfer(ctx, { epicId }).next).toEqual(resumed.next)
    expect(ctx.db.get('SELECT project_id, project_url FROM transfers WHERE epic_id = ?', epicId)).toEqual({
      project_id: 'lin-project',
      project_url: 'https://linear.app/p'
    })
    expect(eventKinds(ctx, 'transfer.')).toEqual([
      'transfer.queued',
      'transfer.started',
      'transfer.item_recorded',
      'transfer.item_recorded',
      'transfer.item_recorded',
      'transfer.started'
    ])
  })

  it('is refused to a worker, which lacks epic.transfer', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    queueTransfer(ctx, { epicId })
    expect(domainError(() => startTransfer(withRole(ctx, 'worker'), { epicId })).code).toBe('unauthorized')
  })
})

describe('recordTransferItem', () => {
  function inProgress(): { ctx: TestCtx; agent: TestCtx; epicId: string } {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    queueTransfer(ctx, { epicId })
    const agent = withRole(ctx, 'orchestrator')
    startTransfer(agent, { epicId })
    return { ctx, agent, epicId }
  }

  it('works only while the transfer is in progress', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const agent = withRole(ctx, 'orchestrator')
    expect(domainError(() => recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'x' })).message).toBe(
      'The person has not authorized a transfer of this epic.'
    )
    queueTransfer(ctx, { epicId })
    expect(domainError(() => recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'x' })).code).toBe('conflict')
    expect(ctx.db.all('SELECT * FROM transfer_items')).toEqual([])
  })

  it('refuses a ref that is not in the packet', () => {
    const { agent, epicId } = inProgress()
    expect(domainError(() => recordTransferItem(agent, { epicId, ref: 'tk_unknown', linearId: 'x' })).code).toBe('invalid_input')
  })

  it('treats re-recording the same values as a no-op', () => {
    const { ctx, agent, epicId } = inProgress()
    const first = recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'lin-1', identifier: 'ENG-1' })
    ctx.clock.advanceSeconds(1)
    expect(recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'lin-1', identifier: 'ENG-1' })).toEqual(first)
    expect(eventKinds(ctx, 'transfer.item_recorded')).toHaveLength(1)
  })

  it('refuses a changed linearId with conflict, and accepts it with replace', () => {
    const { ctx, agent, epicId } = inProgress()
    recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'lin-1' })
    const error = domainError(() => recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'lin-other' }))
    expect(error.code).toBe('conflict')
    expect(error.details).toMatchObject({ ref: tid(1), recordedLinearId: 'lin-1' })
    expect(ctx.db.get('SELECT linear_id FROM transfer_items WHERE ref = ?', tid(1))).toEqual({ linear_id: 'lin-1' })

    const replaced = recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'lin-other', replace: true })
    expect(replaced.linearId).toBe('lin-other')
    expect(ctx.db.get('SELECT linear_id FROM transfer_items WHERE ref = ?', tid(1))).toEqual({ linear_id: 'lin-other' })
  })
})

describe('cancelTransfer', () => {
  it('marks the transfer canceled and clears its items', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    queueTransfer(ctx, { epicId })
    const agent = withRole(ctx, 'orchestrator')
    startTransfer(agent, { epicId })
    recordTransferItem(agent, { epicId, ref: 'project', linearId: 'lin-project' })
    recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'lin-1' })

    const view = cancelTransfer(ctx, { epicId })
    expect(view.status).toBe('canceled')
    expect(view.recorded).toEqual([])
    expect(ctx.db.all('SELECT * FROM transfer_items')).toEqual([])
    expect(eventKinds(ctx, 'transfer.canceled')).toEqual(['transfer.canceled'])

    expect(queueTransfer(ctx, { epicId }).status).toBe('queued')
  })

  it('is refused to the orchestrator and when no transfer is open', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    expect(domainError(() => cancelTransfer(ctx, { epicId })).code).toBe('conflict')
    queueTransfer(ctx, { epicId })
    expect(domainError(() => cancelTransfer(withRole(ctx, 'orchestrator'), { epicId })).code).toBe('unauthorized')
  })
})

describe('getTransfer', () => {
  it('reports not_started with the packet of the current saved revision, and writes nothing', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const view = getTransfer(withRole(ctx, 'reader'), { epicId })
    expect(view).toMatchObject({ epicId, status: 'not_started', recorded: [], lastMismatches: [] })
    expect(view.next[0]).toBe('project')
    expect(view.packet?.epicId).toBe(epicId)
    expect(transferRowCount(ctx)).toBe(0)
    expect(eventKinds(ctx, 'transfer.')).toEqual([])
  })

  it('reports a null packet for an epic that was never saved', () => {
    const ctx = desktopCtx()
    const { epicId } = seedEpic(ctx, { saved: false })
    expect(getTransfer(ctx, { epicId })).toMatchObject({ status: 'not_started', packet: null, next: [] })
  })

  it('keeps the stored packet fixed when a ticket status changes after queuing', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const queued = queueTransfer(ctx, { epicId })
    expect(queued.packet?.issues[0]?.state).toBe('default')
    ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))

    expect(getTransfer(ctx, { epicId }).packet).toEqual(queued.packet)
    expect(startTransfer(withRole(ctx, 'orchestrator'), { epicId }).packet).toEqual(queued.packet)
    // A fresh queue builds from the new status, so the stored packet really was the earlier one.
    cancelTransfer(ctx, { epicId })
    expect(queueTransfer(ctx, { epicId }).packet?.issues[0]?.state).toBe('completed')
  })
})

const PROJECT_URL = 'https://linear.app/acme/project/test-epic-0a1b2c3d'

/** The Linear id the fixture agent records for a packet ref. */
function lin(ref: string): string {
  return `lin-${ref}`
}

function patchTicket(bundle: PlanBundle, n: number, patch: Partial<TicketContent>): void {
  bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(n) ? { ...ticket, ...patch } : ticket))
}

/** Sprint 1 {1, 2} and sprint 2 {3}: 1 blocks 3 and 2 is related to 3; ticket 1 has labels and high priority. */
function readbackBundle(): PlanBundle {
  const bundle = makeBundle([[1, 2], [3]], [[1, 3]])
  patchTicket(bundle, 1, { tags: ['backend', 'UI'], priority: 'high' })
  bundle.relations = [{ kind: 'related_to', from: tid(2), to: tid(3) }]
  return bundle
}

interface RecordedTransfer {
  ctx: TestCtx
  agent: TestCtx
  epicId: string
  revisionId: string
  packet: LinearTransferPacket
}

/**
 * A saved epic whose ticket 2 is completed, with a started transfer and every packet ref but `skip` recorded,
 * as an agent that created each item in Linear would record it: issues get `ENG-<position>`.
 */
function recordedTransfer(bundle: PlanBundle = readbackBundle(), skip: string[] = []): RecordedTransfer {
  const ctx = desktopCtx()
  const { epicId, revisionId } = seedEpic(ctx, { bundle })
  ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(2))
  queueTransfer(ctx, { epicId })
  const agent = withRole(ctx, 'orchestrator')
  const { packet, next } = startTransfer(agent, { epicId })
  const positions = new Map(packet.issues.map((issue) => [issue.ref, issue.position]))
  for (const ref of next.filter((candidate) => !skip.includes(candidate))) {
    const position = positions.get(ref)
    const issue = position === undefined ? {} : { identifier: `ENG-${position}`, url: `https://linear.app/acme/issue/ENG-${position}` }
    recordTransferItem(agent, { epicId, ref, linearId: lin(ref), ...issue, ...(ref === 'project' ? { url: PROJECT_URL } : {}) })
  }
  ctx.clock.advanceSeconds(60)
  return { ctx, agent, epicId, revisionId: revisionId ?? '', packet }
}

/** What Linear holds after a faithful transfer of `packet`, read back in one piece. */
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

function issueOf(readback: Required<LinearReadback>, n: number): LinearReadbackIssue {
  const found = readback.issues.find((item) => item.linearId === lin(tid(n)))
  if (found === undefined) {
    throw new Error(`issue ${n} missing from the read-back`)
  }
  return found
}

function milestoneOf(readback: Required<LinearReadback>, n: number): LinearReadbackMilestone {
  const found = readback.milestones.find((item) => item.linearId === lin(sid(n)))
  if (found === undefined) {
    throw new Error(`milestone ${n} missing from the read-back`)
  }
  return found
}

function submit(fixture: RecordedTransfer, readback: LinearReadback, final = true): TransferReadbackResult {
  return submitTransferReadback(fixture.agent, { epicId: fixture.epicId, readback, final })
}

/** The epic is not completed and nothing the completion writes exists; the transfer holds `mismatches`. */
function expectStillOpen(fixture: RecordedTransfer, mismatches: TransferMismatch[]): void {
  const { ctx, epicId } = fixture
  expect(getEpic(ctx, { epicId })).toMatchObject({ status: 'backlog', completedAt: null, outcome: null })
  expect(getTransfer(ctx, { epicId })).toMatchObject({ status: 'in_progress', lastMismatches: mismatches })
  expect(listComments(ctx, { epicId })).toEqual([])
  expect(eventKinds(ctx, 'epic.')).toEqual([])
  expect(pendingOutbox(ctx)).toEqual([])
}

type Mutation = (readback: Required<LinearReadback>) => void

const MISMATCH_CASES: [string, Mutation, (epicId: string) => TransferMismatch[]][] = [
  [
    'a recorded issue missing from the read-back (present)',
    (readback) => {
      readback.issues = readback.issues.filter((item) => item.linearId !== lin(tid(2)))
    },
    () => [{ ref: tid(2), key: 'DM-2', field: 'present', expected: lin(tid(2)), actual: null }]
  ],
  [
    'another project than the recorded one (present)',
    (readback) => {
      readback.project.linearId = 'lin-other'
    },
    () => [{ ref: 'project', field: 'present', expected: lin('project'), actual: 'lin-other' }]
  ],
  [
    'the project name',
    (readback) => {
      readback.project.name = 'Renamed in Linear'
    },
    () => [{ ref: 'project', field: 'name', expected: 'Test epic', actual: 'Renamed in Linear' }]
  ],
  [
    'a project summary without its marker',
    (readback) => {
      readback.project.summary = 'From Dark Mechanicus'
    },
    (epicId) => [{ ref: 'project', field: 'summary', expected: `dm:${epicId}/project`, actual: 'From Dark Mechanicus' }]
  ],
  [
    'a milestone name',
    (readback) => {
      milestoneOf(readback, 2).name = 'Sprint 2'
    },
    () => [{ ref: sid(2), field: 'name', expected: 'Sprint 2: Sprint 2 goal', actual: 'Sprint 2' }]
  ],
  [
    'the milestone order',
    (readback) => {
      readback.milestones.reverse()
    },
    () => [
      { ref: sid(1), field: 'position', expected: 1, actual: 2 },
      { ref: sid(2), field: 'position', expected: 2, actual: 1 }
    ]
  ],
  [
    'an issue in another milestone',
    (readback) => {
      issueOf(readback, 1).milestoneId = lin(sid(2))
    },
    () => [{ ref: tid(1), key: 'DM-1', field: 'milestone', expected: lin(sid(1)), actual: lin(sid(2)) }]
  ],
  [
    'an issue title',
    (readback) => {
      issueOf(readback, 3).title = 'Ticket three'
    },
    () => [{ ref: tid(3), key: 'DM-3', field: 'title', expected: 'Ticket 3', actual: 'Ticket three' }]
  ],
  [
    'an issue priority',
    (readback) => {
      issueOf(readback, 1).priority = 3
    },
    () => [{ ref: tid(1), key: 'DM-1', field: 'priority', expected: 2, actual: 3 }]
  ],
  [
    'a missing label',
    (readback) => {
      issueOf(readback, 1).labels = ['Backend']
    },
    () => [{ ref: tid(1), key: 'DM-1', field: 'labels', expected: ['backend', 'UI'], actual: ['Backend'] }]
  ],
  [
    'a description without its checklist item, back-link and marker',
    (readback) => {
      issueOf(readback, 3).description = 'Rewritten in Linear'
    },
    (epicId) => [
      {
        ref: tid(3),
        key: 'DM-3',
        field: 'description',
        expected: ['- [ ] c1 Ticket 3 works', `DM key DM-3 · epic ${epicId} · revision 1`, `dm:${epicId}/${tid(3)}`],
        actual: null
      }
    ]
  ],
  [
    'the state of a completed ticket and of a canceled issue',
    (readback) => {
      issueOf(readback, 2).stateType = 'started'
      issueOf(readback, 3).stateType = 'canceled'
    },
    () => [
      { ref: tid(2), key: 'DM-2', field: 'state', expected: 'completed', actual: 'started' },
      { ref: tid(3), key: 'DM-3', field: 'state', expected: 'triage, backlog, unstarted or started', actual: 'canceled' }
    ]
  ],
  [
    'a missing blocks relation',
    (readback) => {
      readback.relations = readback.relations.filter((item) => item.kind !== 'blocks')
    },
    () => [{ ref: `rel:${tid(1)}:${tid(3)}`, field: 'relation', expected: 'DM-1 blocks DM-3', actual: null }]
  ],
  [
    'a relation the packet does not have',
    (readback) => {
      readback.relations.push({ kind: 'blocks', fromId: lin(tid(2)), toId: lin(tid(3)) })
    },
    () => [{ ref: `rel:${tid(2)}:${tid(3)}`, field: 'relation', expected: null, actual: 'DM-2 blocks DM-3' }]
  ],
  [
    'an issue and a milestone that were never recorded (unexpected)',
    (readback) => {
      readback.milestones.push({ linearId: 'lin-extra-milestone', name: 'Backlog', description: 'Made by hand' })
      readback.issues.push({ ...issueOf(readback, 3), linearId: 'lin-extra', identifier: 'ENG-9', description: 'Made by hand' })
    },
    () => [
      { ref: 'lin-extra-milestone', field: 'unexpected', expected: null, actual: 'lin-extra-milestone' },
      { ref: 'lin-extra', field: 'unexpected', expected: null, actual: 'ENG-9' }
    ]
  ],
  [
    'a second issue carrying the marker of an issue (duplicate)',
    (readback) => {
      readback.issues.push({ ...issueOf(readback, 1), linearId: 'lin-copy', identifier: 'ENG-4' })
    },
    () => [
      { ref: tid(1), key: 'DM-1', field: 'unexpected', expected: null, actual: 'ENG-4' },
      { ref: tid(1), key: 'DM-1', field: 'duplicate', expected: lin(tid(1)), actual: [lin(tid(1)), 'lin-copy'] }
    ]
  ],
  [
    'an issue in another team',
    (readback) => {
      issueOf(readback, 3).identifier = 'OPS-3'
    },
    () => [{ ref: tid(3), key: 'DM-3', field: 'team', expected: 'ENG', actual: 'OPS' }]
  ]
]

describe('submitTransferReadback mismatches', () => {
  it.each(MISMATCH_CASES)('reports %s with its ref, key and field, and leaves the epic open', (_label, mutate, expected) => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    mutate(readback)
    const mismatches = expected(fixture.epicId)
    const result = submit(fixture, readback)
    expect(result).toEqual({ status: 'rejected', received: expect.any(Object), mismatches, warnings: [] })
    expectStillOpen(fixture, mismatches)
    expect(eventKinds(fixture.ctx, 'transfer.readback')).toEqual(['transfer.readback_rejected'])
    expect(lastEventPayload(fixture.ctx, 'transfer.readback_rejected')).toMatchObject({ mismatches: mismatches.length })
  })

  it('reports a packet issue and relation that were never recorded (recorded)', () => {
    const relation = `rel:${tid(1)}:${tid(3)}`
    const fixture = recordedTransfer(readbackBundle(), [tid(3), relation])
    const readback = readbackOf(fixture.packet)
    readback.issues = readback.issues.filter((item) => item.linearId !== lin(tid(3)))
    const mismatches: TransferMismatch[] = [
      { ref: tid(3), key: 'DM-3', field: 'recorded', expected: true, actual: false },
      { ref: relation, field: 'recorded', expected: true, actual: false }
    ]
    expect(submit(fixture, readback).mismatches).toEqual(mismatches)
    expectStillOpen(fixture, mismatches)
  })

  it('compares labels as a set without case, ignores ticked items and Markdown escapes, and reads a related link either way', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    issueOf(readback, 1).labels = ['ui', 'BACKEND', 'Backend']
    issueOf(readback, 2).description = issueOf(readback, 2).description.replaceAll('_', '\\_')
    issueOf(readback, 3).description = issueOf(readback, 3).description.replace('- [ ] c1', '* [x] c1')
    issueOf(readback, 3).title = 'Ticket 3 '
    readback.relations = [
      ...readback.relations.map((item) => (item.kind === 'related' ? { ...item, fromId: item.toId, toId: item.fromId } : item)),
      { kind: 'duplicate', fromId: lin(tid(1)), toId: lin(tid(2)) },
      { kind: 'blocks', fromId: lin(tid(1)), toId: 'lin-issue-outside-the-transfer' }
    ]
    expect(submit(fixture, readback)).toMatchObject({ status: 'verified', mismatches: [] })
  })
})

describe('submitTransferReadback one Linear item for two refs', () => {
  it('reports one Linear issue recorded for two look-alike tickets (duplicate), though every field matches', () => {
    const bundle = makeBundle([[1, 3]])
    patchTicket(bundle, 3, { title: 'Ticket 1' })
    const fixture = recordedTransfer(bundle)
    recordTransferItem(fixture.agent, { epicId: fixture.epicId, ref: tid(3), linearId: lin(tid(1)), identifier: 'ENG-1', replace: true })
    const readback = readbackOf(fixture.packet)
    const both = fixture.packet.issues.map((issue) => issue.description).join('\n\n')
    readback.issues = [{ ...issueOf(readback, 1), description: both }]
    const mismatches: TransferMismatch[] = [
      { ref: tid(1), key: 'DM-1', field: 'duplicate', expected: lin(tid(1)), actual: [tid(1), tid(3)] },
      { ref: tid(3), key: 'DM-3', field: 'duplicate', expected: lin(tid(1)), actual: [tid(1), tid(3)] }
    ]
    expect(submit(fixture, readback).mismatches).toEqual(mismatches)
    expectStillOpen(fixture, mismatches)
  })
})

describe('submitTransferReadback warnings', () => {
  it('reports identifier order and an unreported sort order as warnings that do not block completion', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    issueOf(readback, 1).identifier = 'ENG-7'
    for (const issue of readback.issues) {
      delete issue.sortOrder
    }
    const result = submit(fixture, readback)
    expect(result).toMatchObject({ status: 'verified', mismatches: [] })
    expect(result.warnings).toEqual([
      { code: 'identifier_order', ref: tid(2), key: 'DM-2', detail: 'ENG-2 (position 2) does not come after ENG-7.' },
      {
        code: 'sort_order_unreported',
        detail: '3 of 3 issues have no sortOrder in the read-back, so their order in Linear was not checked.'
      }
    ])
    expect(getEpic(fixture.ctx, { epicId: fixture.epicId }).status).toBe('completed')
    const [comment] = listComments(fixture.ctx, { epicId: fixture.epicId })
    expect(comment?.body).toContain('Warnings, which do not block: identifier_order (1), sort_order_unreported (1).')
  })

  it('reports a sort order that does not rise as a warning that does not block completion', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    issueOf(readback, 2).sortOrder = 50
    const result = submit(fixture, readback)
    expect(result).toMatchObject({ status: 'verified', mismatches: [] })
    expect(result.warnings).toEqual([
      { code: 'sort_order', ref: tid(2), key: 'DM-2', detail: 'sortOrder 50 at position 2 does not rise above 100.' }
    ])
    expect(getEpic(fixture.ctx, { epicId: fixture.epicId }).status).toBe('completed')
  })
})

describe('submitTransferReadback parts', () => {
  it('accumulates parts until the final one, and a part sent again replaces its earlier copy', () => {
    const fixture = recordedTransfer()
    const { project, milestones, issues, relations } = readbackOf(fixture.packet)
    expect(submit(fixture, { project, milestones }, false)).toEqual({
      status: 'partial',
      received: { project: true, milestones: 2, issues: 0, relations: 0 },
      mismatches: [],
      warnings: []
    })
    expect(submit(fixture, { issues: issues.slice(0, 2) }, false).received).toEqual({ project: true, milestones: 2, issues: 2, relations: 0 })
    expect(submit(fixture, { issues: issues.slice(0, 2) }, false).received).toEqual({ project: true, milestones: 2, issues: 2, relations: 0 })
    expect(getEpic(fixture.ctx, { epicId: fixture.epicId }).status).toBe('backlog')

    const result = submit(fixture, { issues: issues.slice(2), relations })
    expect(result).toEqual({ status: 'verified', received: { project: true, milestones: 2, issues: 3, relations: 2 }, mismatches: [], warnings: [] })
    expect(eventKinds(fixture.ctx, 'transfer.readback')).toEqual([
      'transfer.readback_received',
      'transfer.readback_received',
      'transfer.readback_received'
    ])
    expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual({ readback_json: null })
  })

  it('starts afresh after a rejected read-back, so an item moved out of the project is gone from the next one', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    const extra = { ...issueOf(readback, 3), linearId: 'lin-extra', identifier: 'ENG-4', description: 'Made by hand' }
    submit(fixture, { ...readback, issues: [...readback.issues, extra] }, false)
    const mismatches = [{ ref: 'lin-extra', field: 'unexpected', expected: null, actual: 'ENG-4' }]
    expect(submit(fixture, {}).mismatches).toEqual(mismatches)
    expect(getTransfer(fixture.ctx, { epicId: fixture.epicId }).lastMismatches).toEqual(mismatches)

    expect(submit(fixture, readback).status).toBe('verified')
    expect(getTransfer(fixture.ctx, { epicId: fixture.epicId })).toMatchObject({ status: 'verified', lastMismatches: [] })
  })

  it('discards an unfinished read-back when the transfer is resumed or canceled', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    submit(fixture, { project: readback.project, milestones: readback.milestones }, false)
    startTransfer(fixture.agent, { epicId: fixture.epicId })
    const result = submit(fixture, { issues: readback.issues, relations: readback.relations })
    expect(result.mismatches.map((item) => [item.ref, item.field])).toEqual([
      ['project', 'present'],
      [sid(1), 'present'],
      [sid(2), 'present']
    ])
    submit(fixture, { project: readback.project }, false)
    cancelTransfer(fixture.ctx, { epicId: fixture.epicId })
    expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual({ readback_json: null })
  })
})

type ReadbackList = 'milestones' | 'issues' | 'relations'

/** `count` items of `list`, each its own Linear item, so none replaces another (or one of `tag`'s siblings) when merged. */
function distinctItems(readback: Required<LinearReadback>, list: ReadbackList, count: number, tag: string): LinearReadback {
  const ids = Array.from({ length: count }, (_, at) => `lin-${tag}-${at}`)
  switch (list) {
    case 'milestones':
      return { milestones: ids.map((linearId) => ({ ...milestoneOf(readback, 1), linearId })) }
    case 'issues':
      return { issues: ids.map((linearId) => ({ ...issueOf(readback, 3), linearId })) }
    case 'relations':
      return { relations: ids.map((fromId) => ({ kind: 'blocks', fromId, toId: lin(tid(3)) })) }
  }
}

describe('submitTransferReadback merged limits', () => {
  it('pins the read-back limits: the packet limit of each list plus 100 unexpected items, 8,000,000 characters a part and 100,000,000 merged', () => {
    expect(READBACK_LIMITS).toEqual({ partChars: 8_000_000, totalChars: 100_000_000, milestones: 200, issues: 1_100, relations: 15_100 })
  })

  it.each(['milestones', 'issues', 'relations'] as const)(
    'refuses a part that takes the merged %s past the limit, naming it, and keeps the parts sent before',
    (list) => {
      const fixture = recordedTransfer()
      const readback = readbackOf(fixture.packet)
      const max = READBACK_LIMITS[list]
      submit(fixture, { project: readback.project }, false)
      expect(submit(fixture, distinctItems(readback, list, max - 1, 'a'), false).received[list]).toBe(max - 1)
      fixture.ctx.clock.advanceSeconds(60)
      const stored = fixture.ctx.db.get('SELECT readback_json, updated_at FROM transfers')
      const events = eventKinds(fixture.ctx, 'transfer.')

      const error = domainError(() => submit(fixture, distinctItems(readback, list, 2, 'b'), false))
      expect(error.code).toBe('invalid_input')
      expect(error.message).toContain(`at most ${max} ${list}`)
      expect(error.details).toEqual({ limit: list, max, count: max + 1 })
      expect(fixture.ctx.db.get('SELECT readback_json, updated_at FROM transfers')).toEqual(stored)
      expect(eventKinds(fixture.ctx, 'transfer.')).toEqual(events)

      // Exactly at the limit is accepted, and items sent again replace their copies instead of counting twice.
      expect(submit(fixture, distinctItems(readback, list, 1, 'b'), false).received[list]).toBe(max)
      expect(submit(fixture, distinctItems(readback, list, max - 1, 'a'), false).received[list]).toBe(max)
    }
  )

  it('refuses non-final issue parts past the limit and keeps the earlier parts', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    submit(fixture, { project: readback.project, milestones: readback.milestones }, false)
    submit(fixture, distinctItems(readback, 'issues', 1_000, 'a'), false)
    const stored = fixture.ctx.db.get('SELECT readback_json FROM transfers')
    expect(domainError(() => submit(fixture, distinctItems(readback, 'issues', 101, 'b'), false)).code).toBe('invalid_input')
    expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual(stored)
    expect(submit(fixture, { issues: readback.issues }, false).received).toEqual({ project: true, milestones: 2, issues: 1_003, relations: 0 })
  })

  it('refuses a final part past a limit with invalid_input, and still ends the read-back', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    submit(fixture, { ...readback, issues: [] }, false)
    submit(fixture, distinctItems(readback, 'issues', READBACK_LIMITS.issues, 'a'), false)
    const error = domainError(() => submit(fixture, { issues: readback.issues }))
    expect(error).toMatchObject({ code: 'invalid_input', details: { limit: 'issues', max: READBACK_LIMITS.issues } })
    expect(error.message).toContain('read the project back again from the start')
    expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual({ readback_json: null })
    expect(getTransfer(fixture.ctx, { epicId: fixture.epicId })).toMatchObject({ status: 'in_progress', lastMismatches: [] })
    expect(getEpic(fixture.ctx, { epicId: fixture.epicId }).status).toBe('backlog')
    expect(submit(fixture, readback).status).toBe('verified')
  })
})

describe('submitTransferReadback merged size', () => {
  it('refuses a part that takes the merged JSON past totalChars, naming the limit, and keeps the parts sent before', () => {
    const fixture = recordedTransfer()
    const { totalChars } = READBACK_LIMITS
    const padded = fillToTotalChars(fixture)
    expect(submit(fixture, padded(0), false).received.issues).toBeLessThan(READBACK_LIMITS.issues)
    expect(storedReadback(fixture).chars).toBe(totalChars)
    fixture.ctx.clock.advanceSeconds(60)
    const stored = storedReadback(fixture)
    const events = eventKinds(fixture.ctx, 'transfer.')

    const error = domainError(() => submit(fixture, padded(1), false))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain(`A transfer read-back is at most ${totalChars} characters of JSON`)
    expect(error.message).toContain('the parts sent before are kept')
    expect(error.details).toEqual({ limit: 'totalChars', max: totalChars })
    expect(storedReadback(fixture)).toEqual(stored)
    expect(eventKinds(fixture.ctx, 'transfer.')).toEqual(events)
  })

  it('compares a final part that brings the merged JSON to exactly totalChars, and refuses one past it after ending the read-back', () => {
    const atLimit = recordedTransfer()
    const result = submit(atLimit, fillToTotalChars(atLimit)(0))
    expect(result.status).toBe('rejected')
    expect(getTransfer(atLimit.ctx, { epicId: atLimit.epicId }).lastMismatches).not.toEqual([])

    const fixture = recordedTransfer()
    const padded = fillToTotalChars(fixture)
    const error = domainError(() => submit(fixture, padded(1)))
    expect(error).toMatchObject({ code: 'invalid_input', details: { limit: 'totalChars', max: READBACK_LIMITS.totalChars } })
    expect(error.message).toContain('This final part still ended the read-back')
    expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual({ readback_json: null })
    expect(getTransfer(fixture.ctx, { epicId: fixture.epicId })).toMatchObject({ status: 'in_progress', lastMismatches: [] })
    expect(getEpic(fixture.ctx, { epicId: fixture.epicId }).status).toBe('backlog')
    expect(submit(fixture, readbackOf(fixture.packet)).status).toBe('verified')
  })
})

/** The stored read-back's length in characters, a digest of it and when it was written, cheap to compare when it is large. */
function storedReadback(fixture: RecordedTransfer): { chars: number; sha256: string; updatedAt: string } {
  const row = fixture.ctx.db.get<{ readback_json: string | null; updated_at: string }>('SELECT readback_json, updated_at FROM transfers')
  const json = row?.readback_json ?? ''
  return { chars: json.length, sha256: createHash('sha256').update(json).digest('hex'), updatedAt: row?.updated_at ?? '' }
}

/**
 * Stores a read-back of exactly `READBACK_LIMITS.totalChars` characters of JSON, short of the last padding issue's
 * description, and returns the part that sends that issue `extra` characters past the limit. About 250 issues of
 * 400,000 characters fill it, far below the issue limit. The service sits behind the part-size check, so one part
 * carries them all here: the merged size is what is under test.
 */
function fillToTotalChars(fixture: RecordedTransfer): (extra: number) => LinearReadback {
  const readback = readbackOf(fixture.packet)
  const issue = (linearId: string, description: string): LinearReadbackIssue => ({ ...issueOf(readback, 3), linearId, description })
  const pad = (length: number): LinearReadback => ({ issues: [issue('lin-pad', 'x'.repeat(length))] })
  submit(fixture, { project: readback.project, milestones: readback.milestones, ...pad(0) }, false)
  const description = 'x'.repeat(400_000)
  // Ids of one width, so every issue adds the same characters, its comma included.
  const each = JSON.stringify(issue('lin-big-000', description)).length + 1
  const count = Math.floor((READBACK_LIMITS.totalChars - storedReadback(fixture).chars) / each)
  submit(fixture, { issues: Array.from({ length: count }, (_, at) => issue(`lin-big-${String(at).padStart(3, '0')}`, description)) }, false)
  const room = READBACK_LIMITS.totalChars - storedReadback(fixture).chars
  return (extra) => pad(room + extra)
}

describe('submitTransferReadback full match', () => {
  it('completes the epic with the transfer outcome, a summary comment, the event and a verified transfer', () => {
    const fixture = recordedTransfer()
    const { ctx, epicId, packet, revisionId } = fixture
    const before = getEpic(ctx, { epicId }).revision
    const result = submit(fixture, readbackOf(packet))
    expect(result).toEqual({ status: 'verified', received: { project: true, milestones: 2, issues: 3, relations: 2 }, mismatches: [], warnings: [] })
    const now = ctx.clock.nowIso()
    const epic = getEpic(ctx, { epicId })
    expect(epic).toMatchObject({ status: 'completed', completedAt: now, revision: before + 1 })
    const transfer = {
      target: 'linear',
      projectUrl: PROJECT_URL,
      revisionId,
      packetHash: packet.packetHash,
      items: [1, 2, 3].map((n) => ({ key: `DM-${n}`, identifier: `ENG-${n}`, url: `https://linear.app/acme/issue/ENG-${n}` }))
    }
    expect(epic.outcome).toEqual({ summary: `Transferred to Linear: ${PROJECT_URL}`, successCriteria: [], recordedAt: now, runId: null, transfer })
    expect(listComments(ctx, { epicId }).map((comment) => [comment.body, comment.author.role])).toEqual([
      [
        `Transferred to Linear: ${PROJECT_URL}\n\nThe project, its 2 milestones, 3 issues and 2 relations match revision 1 of the saved plan, as read back from Linear.`,
        'orchestrator'
      ]
    ])
    expect(eventKinds(ctx).slice(-2)).toEqual(['comment.added', 'epic.transferred'])
    expect(lastEventPayload(ctx, 'epic.transferred')).toEqual({ from: 'backlog', ...transfer, items: 3, commentId: expect.stringMatching(/^cm_/) })
    expect(getTransfer(ctx, { epicId })).toMatchObject({ status: 'verified', lastMismatches: [] })
    expect(pendingOutbox(ctx)).toEqual([`comment:${epicId}:`, `epic_state:${epicId}:`])
    expect(buildEpicStateRecord(ctx.db, epicId, { generation: 1, updatedAt: now }).outcome).toEqual(epic.outcome)
  })

  it('leaves the epic open when a write inside the transaction fails', () => {
    const fixture = recordedTransfer()
    const { ctx } = fixture
    ctx.db.exec("CREATE TRIGGER refuse BEFORE UPDATE ON transfers WHEN NEW.status = 'verified' BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    expect(() => submit(fixture, readbackOf(fixture.packet))).toThrow(/disk full/)
    expectStillOpen(fixture, [])
    expect(eventKinds(ctx, 'comment.')).toEqual([])

    ctx.db.exec('DROP TRIGGER refuse')
    expect(submit(fixture, readbackOf(fixture.packet)).status).toBe('verified')
  })
})

type Arrange = (fixture: RecordedTransfer) => void

const RECHECK_CASES: [string, string, Arrange][] = [
  [
    'an unsaved draft change',
    'conflict',
    ({ ctx, epicId }) => {
      openDraft(ctx, { epicId })
      updatePlanDraft(ctx, { epicId, ops: [{ op: 'update_ticket', ticket: tid(1), patch: { title: 'Changed in the draft' } }] })
    }
  ],
  ['an active run', 'active_run_exists', ({ ctx, epicId, revisionId }) => insertRun(ctx.db, { id: idOf('run', 1), epicId, revisionId })],
  ['a newer saved revision', 'conflict', ({ ctx, epicId }) => void seedRevision(ctx, epicId, makeBundle([[1]]))],
  [
    'a save still pending',
    'save_pending',
    ({ ctx, epicId }) => insertRevision(ctx.db, { id: idOf('revision', 900), epicId, number: 2, bundle: readbackBundle(), state: 'pending' })
  ],
  [
    'records another machine wrote held back by a reconcile',
    'conflict',
    ({ ctx, epicId }) =>
      ctx.db.run(
        "INSERT INTO sync_state (kind, entity_id, generation, conflict, updated_at) VALUES ('epic', ?, 0, ?, ?)",
        epicId,
        `${TRANSFER_HOLD_PREFIX}${epicId}: tracked records bring a saved revision`,
        ctx.clock.nowIso()
      )
  ]
]

describe('submitTransferReadback rechecks before completing', () => {
  it.each(RECHECK_CASES)('refuses a matching read-back with %s (%s) and leaves the epic open', (_label, code, arrange) => {
    const fixture = recordedTransfer()
    arrange(fixture)
    expect(domainError(() => submit(fixture, readbackOf(fixture.packet))).code).toBe(code)
    expect(getEpic(fixture.ctx, { epicId: fixture.epicId })).toMatchObject({ status: 'backlog', outcome: null })
    expect(getTransfer(fixture.ctx, { epicId: fixture.epicId }).status).toBe('in_progress')
    expect(listComments(fixture.ctx, { epicId: fixture.epicId })).toEqual([])
    expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual({ readback_json: null })
  })

  it('is refused to a worker, before the transfer starts, and without an authorized transfer', () => {
    const ctx = desktopCtx()
    const epicId = savedEpic(ctx)
    const agent = withRole(ctx, 'orchestrator')
    const part = { epicId, readback: {}, final: false }
    expect(domainError(() => submitTransferReadback(agent, part)).code).toBe('approval_required')
    queueTransfer(ctx, { epicId })
    expect(domainError(() => submitTransferReadback(agent, part)).code).toBe('conflict')
    startTransfer(agent, { epicId })
    expect(domainError(() => submitTransferReadback(withRole(ctx, 'worker'), part)).code).toBe('unauthorized')
    expect(submitTransferReadback(agent, part).status).toBe('partial')
  })
})

/** After a final part that failed, a fresh read-back that leaves issue 3 out must not borrow it from earlier parts. */
function expectFreshReadbackRejected(fixture: RecordedTransfer): void {
  const { project, milestones, issues, relations } = readbackOf(fixture.packet)
  expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual({ readback_json: null })
  submit(fixture, { project, milestones }, false)
  submit(fixture, { issues: issues.slice(0, 2) }, false)
  const mismatches: TransferMismatch[] = [{ ref: tid(3), key: 'DM-3', field: 'present', expected: lin(tid(3)), actual: null }]
  expect(submit(fixture, { relations })).toMatchObject({ status: 'rejected', mismatches })
  expectStillOpen(fixture, mismatches)
}

describe('submitTransferReadback after a final part that failed', () => {
  it('ends the accumulation when an active run refuses the completion', () => {
    const fixture = recordedTransfer()
    const { ctx, epicId, revisionId } = fixture
    const { project, milestones, issues, relations } = readbackOf(fixture.packet)
    submit(fixture, { project, milestones }, false)
    submit(fixture, { issues }, false)
    insertRun(ctx.db, { id: idOf('run', 1), epicId, revisionId })
    expect(domainError(() => submit(fixture, { relations })).code).toBe('active_run_exists')
    ctx.db.run("UPDATE runs SET state = 'canceled'")
    expectFreshReadbackRejected(fixture)
  })

  it('ends the accumulation when adding the summary comment fails', () => {
    const fixture = recordedTransfer()
    const { project, milestones, issues, relations } = readbackOf(fixture.packet)
    submit(fixture, { project, milestones, issues }, false)
    const moved = { ...fixture.agent, assertBranch: () => fail('branch_changed', 'The checkout moved to another branch.') }
    expect(domainError(() => submitTransferReadback(moved, { epicId: fixture.epicId, readback: { relations }, final: true })).code).toBe(
      'branch_changed'
    )
    expectFreshReadbackRejected(fixture)
  })

  it('refuses to run inside a transaction, where a failed completion would roll the clear back too', () => {
    const fixture = recordedTransfer()
    const { project, milestones, issues } = readbackOf(fixture.packet)
    submit(fixture, { project, milestones, issues }, false)
    const stored = fixture.ctx.db.get('SELECT readback_json FROM transfers')
    expect(domainError(() => fixture.ctx.db.tx(() => submit(fixture, {}))).code).toBe('internal')
    expect(fixture.ctx.db.get('SELECT readback_json FROM transfers')).toEqual(stored)
  })
})

describe('submitTransferReadback state types', () => {
  it.each([['Canceled'], ['cancelled'], ['Done'], ['']])('reports state type %j of an open ticket as a mismatch', (stateType) => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    issueOf(readback, 3).stateType = stateType
    const mismatches: TransferMismatch[] = [
      { ref: tid(3), key: 'DM-3', field: 'state', expected: 'triage, backlog, unstarted or started', actual: stateType }
    ]
    expect(submit(fixture, readback).mismatches).toEqual(mismatches)
    expectStillOpen(fixture, mismatches)
  })

  it.each([['Done'], ['canceled'], ['complete']])('reports state type %j of a completed ticket as a mismatch', (stateType) => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    issueOf(readback, 2).stateType = stateType
    expect(submit(fixture, readback).mismatches).toEqual([{ ref: tid(2), key: 'DM-2', field: 'state', expected: 'completed', actual: stateType }])
  })

  it('compares state types without case', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    issueOf(readback, 1).stateType = 'Started'
    issueOf(readback, 2).stateType = 'Completed'
    issueOf(readback, 3).stateType = 'BACKLOG'
    expect(submit(fixture, readback)).toMatchObject({ status: 'verified', mismatches: [] })
  })
})

describe('submitTransferReadback project URL', () => {
  it('reports a read-back project URL other than the recorded one, and stores no link', () => {
    const fixture = recordedTransfer()
    const readback = readbackOf(fixture.packet)
    readback.project.url = 'https://linear.app/acme/project/another-project-9z8y'
    const mismatches: TransferMismatch[] = [{ ref: 'project', field: 'url', expected: PROJECT_URL, actual: readback.project.url }]
    expect(submit(fixture, readback).mismatches).toEqual(mismatches)
    expectStillOpen(fixture, mismatches)
  })

  it('fails closed for a project recorded without a URL, and completes with the recorded URL once it is recorded', () => {
    const fixture = recordedTransfer(readbackBundle(), ['project'])
    const { agent, ctx, epicId } = fixture
    recordTransferItem(agent, { epicId, ref: 'project', linearId: lin('project') })
    const readback = readbackOf(fixture.packet)
    const mismatches: TransferMismatch[] = [{ ref: 'project', field: 'url', expected: null, actual: PROJECT_URL }]
    expect(submit(fixture, readback).mismatches).toEqual(mismatches)
    expectStillOpen(fixture, mismatches)

    recordTransferItem(agent, { epicId, ref: 'project', linearId: lin('project'), url: PROJECT_URL })
    readback.project.url = ` ${PROJECT_URL} `
    expect(submit(fixture, readback).status).toBe('verified')
    const outcome = getEpic(ctx, { epicId }).outcome
    expect([outcome?.summary, outcome?.transfer?.projectUrl]).toEqual([`Transferred to Linear: ${PROJECT_URL}`, PROJECT_URL])
    expect(listComments(ctx, { epicId })[0]?.body.startsWith(`Transferred to Linear: ${PROJECT_URL}\n`)).toBe(true)
  })
})

describe('a transferred epic', () => {
  it('refuses start_run, plan edits, a new transfer and another read-back', () => {
    const fixture = recordedTransfer()
    const { ctx, agent, epicId } = fixture
    expect(submit(fixture, readbackOf(fixture.packet)).status).toBe('verified')
    expect(domainError(() => startRun(agent, { epicId })).code).toBe('completed_epic')
    const ops = [{ op: 'update_ticket' as const, ticket: tid(1), patch: { title: 'Changed later' } }]
    expect(domainError(() => updatePlanDraft(ctx, { epicId, ops })).code).toBe('completed_epic')
    expect(domainError(() => openDraft(ctx, { epicId })).code).toBe('completed_epic')
    expect(domainError(() => queueTransfer(ctx, { epicId })).code).toBe('completed_epic')
    expect(domainError(() => submit(fixture, readbackOf(fixture.packet))).code).toBe('completed_epic')
    expect(domainError(() => recordTransferItem(agent, { epicId, ref: tid(1), linearId: 'lin-again' })).code).toBe('approval_required')
    expect(getEpic(ctx, { epicId }).status).toBe('completed')
  })
})

describe('a 1,000-ticket transfer', () => {
  it('verifies a read-back sent in pages and completes the epic with every issue in its outcome', () => {
    const sprints = Array.from({ length: 10 }, (_, sprint) => Array.from({ length: 100 }, (_, at) => sprint * 100 + at + 1))
    const edges = Array.from({ length: 9 }, (_, at): [number, number] => [at * 100 + 1, at * 100 + 101])
    const fixture = recordedTransfer(makeBundle(sprints, edges))
    const { project, milestones, issues, relations } = readbackOf(fixture.packet)
    expect(issues).toHaveLength(1000)
    submit(fixture, { project, milestones }, false)
    for (let page = 0; page < issues.length; page += 250) {
      submit(fixture, { issues: issues.slice(page, page + 250) }, false)
    }
    const result = submit(fixture, { relations })
    expect(result).toMatchObject({ status: 'verified', received: { project: true, milestones: 10, issues: 1000, relations: 9 }, mismatches: [] })
    const outcome = getEpic(fixture.ctx, { epicId: fixture.epicId }).outcome
    expect(outcome?.transfer?.items).toHaveLength(1000)
    expect(outcome?.transfer?.items.at(-1)).toEqual({ key: 'DM-1000', identifier: 'ENG-1000', url: 'https://linear.app/acme/issue/ENG-1000' })
    const record = buildEpicStateRecord(fixture.ctx.db, fixture.epicId, { generation: 1, updatedAt: fixture.ctx.clock.nowIso() })
    expect(record.outcome).toEqual(outcome)
  })
})
