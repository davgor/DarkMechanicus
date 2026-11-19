import { describe, expect, it } from 'vitest'
import type { TicketReference } from '../../shared/domain/bundle'
import type { CorrectionPlanView } from '../../shared/domain/corrections'
import { completed, draftOf, outcome, sourceRecords, unfinished, SPECIFIC_WORK, type CorrectionWorld, type Unfinished } from '../../test/correctionWorld'
import { flush } from '../../test/repoEnv'
import { withRole } from '../../test/testContext'
import { adoptRevision } from './adoption'
import { advanceSprint, approveCheckpoint, getCheckpoint } from './checkpoints'
import { createCorrections, previewCorrections } from './corrections'
import { discardPlanDraft, openDraft, updatePlanDraft } from './drafts'
import { createEpic } from './epics'
import { getExperiment } from './experiments'
import { requestSave, validatePlanView } from './plans'
import { getRun, startRun } from './runs'

function count(w: CorrectionWorld, sql: string, ...params: string[]): number {
  return w.ctx.db.get<{ n: number }>(sql, ...params)?.n ?? -1
}

const epicCount = (w: CorrectionWorld): number => count(w, 'SELECT COUNT(*) AS n FROM epics')
const eventCount = (w: CorrectionWorld): number => count(w, 'SELECT COUNT(*) AS n FROM events')

/** What a creation must never touch: the run's controls, grants, retries, approvals, attempts and experiment events. */
function controls(w: CorrectionWorld): string {
  const db = w.ctx.db
  return JSON.stringify({
    run: db.get('SELECT state, revision_id, active_sprint_id, auto_continue FROM runs WHERE id = ?', w.runId),
    grants: db.get('SELECT COUNT(*) AS n FROM grants'),
    retryGrants: db.get('SELECT COUNT(*) AS n FROM retry_grants'),
    approvals: db.get("SELECT COUNT(*) AS n FROM events WHERE kind LIKE 'checkpoint.approv%'"),
    attempts: db.get('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?', w.runId),
    experimentEvents: db.get('SELECT COUNT(*) AS n FROM experiment_events')
  })
}

/** Makes the next `draft.corrected` event fail inside SQLite (after the draft, and any follow-up epic, were written). */
function failNextCorrection(w: CorrectionWorld): () => void {
  w.ctx.db.exec("CREATE TEMP TRIGGER outage BEFORE INSERT ON events WHEN NEW.kind = 'draft.corrected' BEGIN SELECT RAISE(ABORT, 'simulated outage'); END")
  return () => w.ctx.db.exec('DROP TRIGGER outage')
}

function refsOf(w: CorrectionWorld, epicId: string, key: string): string[] {
  return (draftOf(w.ctx.db, epicId)?.bundle.tickets.find((ticket) => ticket.key === key)?.references ?? []).map((reference) => reference.location)
}

/** The "Experiment <id>" heads of an epic draft's success criteria. */
function criteriaHeads(w: CorrectionWorld, epicId: string): string[] {
  return (draftOf(w.ctx.db, epicId)?.bundle.epic.successCriteria ?? []).map((criterion) => criterion.text.split(':')[0] ?? '')
}

function epicRow(w: CorrectionWorld, epicId: string): { status: string; current_revision_id: string | null; provenance: unknown } {
  const row = w.ctx.db.get<{ status: string; current_revision_id: string | null; provenance_json: string | null }>('SELECT status, current_revision_id, provenance_json FROM epics WHERE id = ?', epicId)
  return { status: row?.status ?? 'missing', current_revision_id: row?.current_revision_id ?? null, provenance: JSON.parse(row?.provenance_json ?? 'null') }
}

function forged(location: string): TicketReference {
  return { kind: 'doc', label: 'forged', location, hash: `sha256:${'0'.repeat(64)}`, remoteOnly: false }
}

function previewThree(w: Unfinished): CorrectionPlanView {
  const { ready, vague, dm } = w.xp
  return previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [ready.id, vague.id, dm.id] })
}

describe('DM-186 c1: the preview lists the work before anything is materialized', () => {
  it('names the target sprint, each experiment\'s state and key, and why the blocked ones are blocked', () => {
    const w = unfinished()
    const { ready, vague, dm } = w.xp
    const view = previewThree(w)
    expect(view.target).toEqual({ kind: 'new_sprint', epicId: w.epicId, epicTitle: 'Test epic', sprintId: null, sprintOrdinal: 2, afterOrdinal: 1, sprintGoal: `Corrective work from the Sprint 1 retro (report revision 1): experiments ${ready.id}.` })
    expect(view.experiments.map((item) => [item.experimentId, item.state, item.key])).toEqual([
      [ready.id, 'ready', `${w.report.id}/${ready.id}/epic:${w.epicId}`],
      [vague.id, 'blocked', `${w.report.id}/${vague.id}/epic:${w.epicId}`],
      [dm.id, 'blocked', `${w.report.id}/${dm.id}/epic:${w.epicId}`]
    ])
    expect(view.experiments[1]?.problems).toContain('proposedWork[0] "Fix the budgets" has no size')
    expect(view.experiments[2]?.problems[0]).toMatch(/^its destination is the Dark Mechanicus source, another repository/)
  })

  it('lists the sized work tickets with criteria, the Fireguard ticket requiring them and one acceptance node covering each', () => {
    const w = unfinished()
    const { ready } = w.xp
    const view = previewThree(w)
    const work = view.tickets.filter((ticket) => ticket.role === 'work')
    expect(view.tickets.map((ticket) => [ticket.role, ticket.ref, ticket.key, ticket.ticketId])).toEqual([
      ['work', `${ready.id}#0`, 'DM-6', null],
      ['work', `${ready.id}#1`, 'DM-7', null],
      ['fireguard', 'fireguard', 'DM-8', null],
      ['acceptance', 'acceptance', 'DM-5', null]
    ])
    expect(work.map((ticket) => [ticket.title, ticket.size, ticket.acceptanceCriteria[0]?.text])).toEqual([
      [SPECIFIC_WORK[0].title, 'small', `${SPECIFIC_WORK[0].title}: the change the body describes is in place. ${SPECIFIC_WORK[0].body}`],
      [SPECIFIC_WORK[1].title, 'small', `${SPECIFIC_WORK[1].title}: the change the body describes is in place. ${SPECIFIC_WORK[1].body}`]
    ])
    expect(work[0]?.body).toContain(`- Hypothesis (not a proven cause): ${ready.hypothesis}`)
    const [fireguard, node] = view.tickets.slice(2)
    expect([fireguard?.size, fireguard?.tags, fireguard?.dependsOn]).toEqual(['small', ['fireguard', 'corrective'], [`${ready.id}#0`, `${ready.id}#1`]])
    expect(node?.acceptanceCriteria.map((criterion) => criterion.covers)).toEqual([`${ready.id}#0`, `${ready.id}#1`, 'fireguard'])
    expect(view.dependencies).toEqual([
      { from: `${ready.id}#0`, to: 'fireguard' },
      { from: `${ready.id}#1`, to: 'fireguard' }
    ])
    expect([view.validation.valid, view.validation.errors, view.draftRevision]).toEqual([true, [], null])
  })

  it('writes nothing: no draft, no event, no record of the epic changes', () => {
    const w = unfinished()
    const before = { records: sourceRecords(w), events: eventCount(w) }
    previewThree(w)
    expect(draftOf(w.ctx.db, w.epicId)).toBeNull()
    expect({ records: sourceRecords(w), events: eventCount(w) }).toEqual(before)
  })
})

describe('DM-186 c1: the preview of a completed epic\'s work', () => {
  it('a completed epic previews a follow-up epic still to be created, holding the same work, and creates none', () => {
    const c = completed()
    const epics = epicCount(c)
    const view = previewCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    expect(view.target).toMatchObject({ kind: 'follow_up_epic', epicId: null, epicTitle: 'Follow-up: Test epic', sprintId: null, sprintOrdinal: 1, afterOrdinal: null })
    expect(view.tickets.map((ticket) => [ticket.role, ticket.ticketId])).toEqual([
      ['work', null],
      ['work', null],
      ['fireguard', null],
      ['acceptance', null]
    ])
    expect(view.tickets.at(-1)?.acceptanceCriteria.map((criterion) => criterion.covers)).toEqual([`${c.x1}#0`, `${c.x1}#1`, 'fireguard'])
    expect(epicCount(c)).toBe(epics)
  })
})

describe('DM-186 c2: the target follows the source epic', () => {
  it('an unfinished epic gets a sprint appended to its draft; its saved sprint 1, run, report and scorecard stay as they were', () => {
    const w = unfinished()
    const before = sourceRecords(w)
    const saved = JSON.parse(w.ctx.db.get<{ bundle_json: string }>('SELECT p.bundle_json FROM plan_revisions p JOIN epics e ON e.current_revision_id = p.id WHERE e.id = ?', w.epicId)?.bundle_json ?? '{}') as { sprints: unknown[] }
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    const draft = draftOf(w.ctx.db, w.epicId)?.bundle
    expect([made.changed, made.target.kind, made.target.epicId, made.target.sprintOrdinal]).toEqual([true, 'new_sprint', w.epicId, 2])
    expect(draft?.sprints.map((sprint) => [sprint.ordinal, sprint.ticketIds.length, sprint.checkpoint.mode])).toEqual([
      [1, 4, 'human'],
      [2, 4, 'human']
    ])
    expect(draft?.sprints[0]).toEqual(saved.sprints[0])
    expect(sourceRecords(w)).toBe(before)
  })

  it('a later experiment can name that future sprint; the existing acceptance node keeps its criteria and gains covers', () => {
    const w = unfinished()
    const first = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    const sprintId = first.target.sprintId ?? ''
    const second = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.later.id], target: { kind: 'sprint', sprintId } })
    expect([second.target.kind, second.target.sprintId, second.target.sprintOrdinal]).toEqual(['sprint', sprintId, 2])
    const node = second.tickets.find((ticket) => ticket.role === 'acceptance')
    expect([node?.existing, node?.key, node?.acceptanceCriteria.map((criterion) => criterion.id)]).toEqual([true, 'DM-5', ['c1', 'c2', 'c3', 'c4', 'c5']])
    expect(node?.acceptanceCriteria.slice(0, 3).map((criterion) => criterion.covers)).toEqual(['DM-6', 'DM-7', 'DM-8'])
  })
})

describe('DM-186 c2: a completed epic gets a follow-up epic', () => {
  it('a completed epic gets a distinct backlog follow-up epic linked by provenance; the completed epic keeps its content and status', () => {
    const c = completed()
    const before = sourceRecords(c)
    const made = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    const followId = made.target.epicId ?? ''
    expect(followId).not.toBe(c.epicId)
    expect(epicRow(c, followId)).toEqual({
      status: 'backlog',
      current_revision_id: null,
      provenance: { sourceEpicId: c.epicId, note: `Corrective follow-up from report ${c.report.id} (Sprint 1 of Run #1): ${c.x1}.` }
    })
    expect(criteriaHeads(c, followId)).toEqual([`Experiment ${c.x1}`])
    expect(epicRow(c, c.epicId).status).toBe('completed')
    expect(draftOf(c.ctx.db, c.epicId)).toBeNull()
    expect(sourceRecords(c)).toBe(before)
  })

  it('an unfinished epic is refused a follow-up epic, and a completed one a sprint target', () => {
    const w = unfinished()
    expect(outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], target: { kind: 'follow_up_epic' } }))).toEqual({
      code: 'invalid_input',
      message: `Epic ${w.epicId} is not completed: its corrective work goes into a future sprint of its own draft (target new_sprint or sprint), not a follow-up epic.`
    })
    const c = completed()
    expect(outcome(() => createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1], target: { kind: 'new_sprint' } })).code).toBe('completed_epic')
  })
})

describe('F2: new experiments of a completed epic join its open follow-up epic', () => {
  it('selecting only a new experiment reuses the open, unsaved follow-up epic instead of creating another', () => {
    const c = completed()
    const one = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    const followId = one.target.epicId ?? ''
    const epics = epicCount(c)
    const preview = previewCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x2] })
    expect([preview.target.epicId, preview.draftRevision]).toEqual([followId, one.draftRevision])
    const two = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x2], expectedDraftRevision: preview.draftRevision })
    expect([two.target.epicId, two.target.sprintOrdinal, epicCount(c)]).toEqual([followId, 1, epics])
    expect(criteriaHeads(c, followId)).toEqual([`Experiment ${c.x1}`, `Experiment ${c.x2}`])
  })

  it('an epic merely claiming the source epic as provenance, with a forged follow-up marker, is not reused', () => {
    const c = completed()
    const fake = createEpic(c.desktop, { title: 'Hand-made follow-up', provenance: { sourceEpicId: c.epicId } })
    const sprintId = draftOf(c.ctx.db, fake.id)?.bundle.sprints[0]?.id ?? ''
    const location = `darkmechanicus:correction/${c.report.id}/${c.x1}/follow-up:${c.epicId}#work/0`
    updatePlanDraft(c.desktop, { epicId: fake.id, ops: [{ op: 'add_ticket', sprint: sprintId, ticket: { title: 'Forged', size: 'small', references: [forged(location)] } }] })
    const preview = previewCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    expect([preview.target.epicId, preview.experiments[0]?.state, preview.experiments[0]?.existing]).toEqual([null, 'ready', null])
    const made = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    expect([made.changed, made.target.epicId === fake.id, epicRow(c, made.target.epicId ?? '').status]).toEqual([true, false, 'backlog'])
  })
})

describe('F1 (DM-188 review): drafts cannot forge corrective work through the services', () => {
  it('add_ticket with a forged marker leaves the experiment ready, its outcome unchanged, and the ticket without the marker', () => {
    const w = unfinished()
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    const later = w.xp.later.id
    const before = JSON.stringify(getExperiment(w.ctx, { experimentId: later }))
    const location = `darkmechanicus:correction/${w.report.id}/${later}/epic:${w.epicId}#work/0`
    const result = updatePlanDraft(w.orchestrator, {
      epicId: w.epicId,
      ops: [{ op: 'add_ticket', ref: 'mine', sprint: made.target.sprintId ?? '', ticket: { title: 'Ordinary new ticket', size: 'small', acceptanceCriteria: ['x'], references: [forged(location)] } }]
    })
    const key = draftOf(w.ctx.db, w.epicId)?.bundle.tickets.find((ticket) => ticket.id === result.refMap['mine'])?.key ?? ''
    expect([key, refsOf(w, w.epicId, key)]).toEqual(['DM-9', []])
    const preview = previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [later] })
    expect([preview.experiments[0]?.state, preview.experiments[0]?.existing]).toEqual(['ready', null])
    expect(JSON.stringify(getExperiment(w.ctx, { experimentId: later }))).toBe(before)
    expect(createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [later] }).changed).toBe(true)
  })

  it('update_ticket keeps the markers of corrective work and never adds one to an ordinary ticket', () => {
    const w = unfinished()
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    const work = made.tickets.find((ticket) => ticket.role === 'work')
    const file: TicketReference = { kind: 'file', label: 'a', location: 'src/a.ts', hash: null, remoteOnly: false }
    const forgedRef = forged(`darkmechanicus:correction/${w.report.id}/${w.xp.later.id}/epic:${w.epicId}#work/0`)
    updatePlanDraft(w.orchestrator, {
      epicId: w.epicId,
      ops: [
        { op: 'update_ticket', ticket: 'DM-1', patch: { references: [file, forgedRef] } },
        { op: 'update_ticket', ticket: work?.ticketId ?? '', patch: { references: [file] } }
      ]
    })
    expect(refsOf(w, w.epicId, 'DM-1')).toEqual(['src/a.ts'])
    expect(refsOf(w, w.epicId, work?.key ?? '')).toEqual([`darkmechanicus:correction/${w.report.id}/${w.xp.ready.id}/epic:${w.epicId}#work/0`, 'src/a.ts'])
    expect(previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.later.id] }).experiments[0]?.state).toBe('ready')
  })
})

describe('F4: a sprint target that cannot take the work is refused with a target message', () => {
  it('a sprint id the draft does not have is not_found', () => {
    const w = unfinished()
    const missing = 'sp_zzzzzzzzzzzzzzzzzzzzzzzzzz'
    expect(outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], target: { kind: 'sprint', sprintId: missing } }))).toEqual({
      code: 'not_found',
      message: `Not created: Sprint ${missing} is not in the draft of epic ${w.epicId}: pick a sprint of that draft after Sprint 1 or append a new one. Nothing was written.`
    })
    expect(draftOf(w.ctx.db, w.epicId)).toBeNull()
  })

  it('a sprint of another epic is not_found too', () => {
    const w = unfinished()
    const other = createEpic(w.desktop, { title: 'Another epic' })
    const foreign = draftOf(w.ctx.db, other.id)?.bundle.sprints[0]?.id ?? ''
    const refused = outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], target: { kind: 'sprint', sprintId: foreign } }))
    expect(refused.code).toBe('not_found')
    expect(refused.message).toContain(`Sprint ${foreign} is not in the draft of epic ${w.epicId}`)
  })

  it('the passed or in-progress sprint is a conflict that says where corrections go, not to restate the experiment', () => {
    const w = unfinished()
    const before = sourceRecords(w)
    expect(outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], target: { kind: 'sprint', sprintId: w.sprintId } }))).toEqual({
      code: 'conflict',
      message: 'Not created: Sprint 1 is passed or in progress (corrections go after Sprint 1): pick a later sprint or append a new one. Nothing was written.'
    })
    expect([draftOf(w.ctx.db, w.epicId), sourceRecords(w)]).toEqual([null, before])
  })

  it('an experiment blocked on its own still gets the restatement advice', () => {
    const w = unfinished()
    const refused = outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.vague.id] }))
    expect(refused.code).toBe('conflict')
    expect(refused.message).toContain('Deselect it, or restate it in a new report revision')
  })
})

describe('DM-186 c3: stable idempotency keys in the unfinished epic', () => {
  it('a repeat adds nothing and names the same tickets, also after the tickets and sprint are renamed', () => {
    const w = unfinished()
    const request = { reportId: w.report.id, experimentIds: [w.xp.ready.id] }
    const made = createCorrections(w.orchestrator, request)
    expect(made.experiments[0]?.key).toBe(`${w.report.id}/${w.xp.ready.id}/epic:${w.epicId}`)
    const repeat = createCorrections(w.orchestrator, request)
    expect([repeat.changed, repeat.draftRevision, repeat.experiments[0]?.state, repeat.experiments[0]?.existing?.keys]).toEqual([false, made.draftRevision, 'created', ['DM-6', 'DM-7', 'DM-8']])
    const work = made.tickets.filter((ticket) => ticket.role !== 'acceptance')
    const renamed = updatePlanDraft(w.orchestrator, {
      epicId: w.epicId,
      ops: [...work.map((ticket) => ({ op: 'update_ticket' as const, ticket: ticket.ticketId ?? '', patch: { title: `Renamed ${ticket.key}` } })), { op: 'update_sprint', sprint: made.target.sprintId ?? '', patch: { goal: 'Renamed goal' } }]
    })
    const tickets = draftOf(w.ctx.db, w.epicId)?.bundle.tickets.length
    const again = createCorrections(w.orchestrator, request)
    expect([again.changed, again.draftRevision, draftOf(w.ctx.db, w.epicId)?.bundle.tickets.length]).toEqual([false, renamed.draftRevision, tickets])
  })

  it('the same experiment with another payload or another target is refused (idempotency_mismatch) and writes nothing', () => {
    const w = unfinished()
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    const edited = outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], edits: [{ experimentId: w.xp.ready.id, index: 0, title: 'Another title' }] }))
    expect(edited.code).toBe('idempotency_mismatch')
    expect(edited.message).toContain(`already created as DM-6, DM-7, DM-8 in epic ${w.epicId} (its draft) under key ${w.report.id}/${w.xp.ready.id}/epic:${w.epicId} with another payload`)
    const retargeted = outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], target: { kind: 'sprint', sprintId: made.target.sprintId ?? '' } }))
    expect(retargeted.code).toBe('idempotency_mismatch')
    expect(draftOf(w.ctx.db, w.epicId)?.revision).toBe(made.draftRevision)
  })
})

describe('DM-186 c3: stable idempotency keys across Save and follow-up renames', () => {
  it('work found only in the saved revision (draft saved, then discarded) is still created: nothing added, no draft opened', () => {
    const w = unfinished()
    const request = { reportId: w.report.id, experimentIds: [w.xp.ready.id] }
    const made = createCorrections(w.orchestrator, request)
    requestSave(w.desktop, { epicId: w.epicId, expectedDraftRevision: made.draftRevision ?? 0 })
    flush(w.env)
    openDraft(w.desktop, { epicId: w.epicId })
    discardPlanDraft(w.desktop, { epicId: w.epicId })
    const repeat = createCorrections(w.orchestrator, request)
    expect([repeat.changed, repeat.experiments[0]?.state, repeat.experiments[0]?.existing?.holder, repeat.experiments[0]?.existing?.revisionNumber]).toEqual([false, 'created', 'revision', 2])
    expect(draftOf(w.ctx.db, w.epicId)).toBeNull()
  })

  it('a follow-up epic keeps its key through a rename; a different follow-up title is a conflicting payload', () => {
    const c = completed()
    const request = { reportId: c.report.id, experimentIds: [c.x1] }
    const made = createCorrections(c.orchestrator, request)
    const followId = made.target.epicId ?? ''
    updatePlanDraft(c.desktop, { epicId: followId, ops: [{ op: 'set_epic', title: 'Renamed follow-up' }] })
    const repeat = createCorrections(c.orchestrator, request)
    expect([repeat.changed, repeat.target.epicId]).toEqual([false, followId])
    expect(outcome(() => createCorrections(c.orchestrator, { ...request, target: { kind: 'follow_up_epic', title: 'Another title' } })).code).toBe('idempotency_mismatch')
    expect(count(c, 'SELECT COUNT(*) AS n FROM epics WHERE provenance_json IS NOT NULL')).toBe(1)
  })
})

describe('DM-270 c4: a creation that fails part way leaves one target and the source history byte-identical on retry', () => {
  it('in the unfinished epic: the failed creation rolls back its draft, and the retry adds exactly one corrective sprint', () => {
    const w = unfinished()
    const before = sourceRecords(w)
    const request = { reportId: w.report.id, experimentIds: [w.xp.ready.id] }
    const restore = failNextCorrection(w)
    expect(() => createCorrections(w.orchestrator, request)).toThrow('simulated outage')
    restore()
    expect(draftOf(w.ctx.db, w.epicId)).toBeNull()
    const made = createCorrections(w.orchestrator, request)
    const repeat = createCorrections(w.orchestrator, request)
    const draft = draftOf(w.ctx.db, w.epicId)?.bundle
    expect([made.changed, repeat.changed, draft?.sprints.length, draft?.tickets.filter((ticket) => ticket.tags.includes('corrective')).length]).toEqual([true, false, 2, 3])
    expect(count(w, "SELECT COUNT(*) AS n FROM events WHERE kind = 'draft.corrected'")).toBe(1)
    expect(sourceRecords(w)).toBe(before)
  })

  it('for a completed epic: the follow-up epic made before the failure is rolled back, and the retry makes exactly one', () => {
    const c = completed()
    const before = sourceRecords(c)
    const epics = epicCount(c)
    const request = { reportId: c.report.id, experimentIds: [c.x1] }
    const restore = failNextCorrection(c)
    expect(() => createCorrections(c.orchestrator, request)).toThrow('simulated outage')
    restore()
    expect(epicCount(c)).toBe(epics)
    const made = createCorrections(c.orchestrator, request)
    const repeat = createCorrections(c.orchestrator, request)
    expect([made.changed, repeat.changed, repeat.target.epicId === made.target.epicId, epicCount(c)]).toEqual([true, false, true, epics + 1])
    expect(sourceRecords(c)).toBe(before)
  })
})

const stale = (message: string): { code: string; message: string } => ({ code: 'conflict', message })

function opened(): Unfinished {
  const w = unfinished()
  openDraft(w.desktop, { epicId: w.epicId })
  return w
}

describe('DM-187 expectedDraftRevision matrix: same epic, no draft (the preview read null)', () => {
  it.each([
    ['undefined', undefined],
    ['null', null]
  ] as const)('%s creates the work in a draft opened for it', (_name, expected) => {
    const w = unfinished()
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], expectedDraftRevision: expected })
    expect([made.changed, made.draftRevision, draftOf(w.ctx.db, w.epicId)?.revision]).toEqual([true, 2, 2])
  })

  it('a number (a draft the preview read is gone) is refused and opens no draft', () => {
    const w = unfinished()
    expect(outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], expectedDraftRevision: 1 }))).toEqual(
      stale('The draft is gone (your preview read revision 1; there is no open draft now). Reload and reapply your edit.')
    )
    expect(draftOf(w.ctx.db, w.epicId)).toBeNull()
  })
})

describe('DM-187 expectedDraftRevision matrix: same epic, an open draft at revision 1', () => {
  it.each([
    ['undefined', undefined],
    ['its revision', 1]
  ] as const)('%s creates the work in it', (_name, expected) => {
    const w = opened()
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], expectedDraftRevision: expected })
    expect([made.changed, made.draftRevision]).toEqual([true, 2])
  })

  it('null refuses: an open draft now exists', () => {
    const w = opened()
    expect(outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], expectedDraftRevision: null }))).toEqual(stale('An open draft now exists (revision 1). Reload and reapply your edit.'))
    expect(draftOf(w.ctx.db, w.epicId)?.revision).toBe(1)
  })

  it('another revision refuses: the draft changed', () => {
    const w = opened()
    expect(outcome(() => createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], expectedDraftRevision: 2 }))).toEqual(stale('The draft changed (now revision 1). Reload and reapply your edit.'))
    expect(draftOf(w.ctx.db, w.epicId)?.revision).toBe(1)
  })
})

describe('DM-187 expectedDraftRevision matrix: work already created (an identical repeat)', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['its revision', 2],
    ['a stale revision', 1]
  ] as const)('%s adds nothing and is not refused', (_name, expected) => {
    const w = unfinished()
    const request = { reportId: w.report.id, experimentIds: [w.xp.ready.id] }
    createCorrections(w.orchestrator, request)
    const events = eventCount(w)
    const repeat = createCorrections(w.orchestrator, { ...request, expectedDraftRevision: expected })
    expect([repeat.changed, repeat.draftRevision, eventCount(w), draftOf(w.ctx.db, w.epicId)?.revision]).toEqual([false, 2, events, 2])
  })
})

describe('DM-187 expectedDraftRevision matrix: a completed epic', () => {
  it.each([
    ['undefined', undefined],
    ['null', null]
  ] as const)('with no follow-up yet, %s creates one follow-up epic', (_name, expected) => {
    const c = completed()
    const epics = epicCount(c)
    const made = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1], expectedDraftRevision: expected })
    expect([made.changed, made.draftRevision, epicCount(c)]).toEqual([true, 2, epics + 1])
  })

  it('with no follow-up yet, a number is refused and creates no epic', () => {
    const c = completed()
    const epics = epicCount(c)
    expect(outcome(() => createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1], expectedDraftRevision: 2 }))).toEqual(
      stale('The draft is gone (your preview read revision 2; there is no open draft now). Reload and reapply your edit.')
    )
    expect(epicCount(c)).toBe(epics)
  })

  it('with an open follow-up: null refuses (its draft exists), a stale number refuses, its revision adds the new experiment', () => {
    const c = completed()
    const one = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    const request = { reportId: c.report.id, experimentIds: [c.x2] }
    expect(outcome(() => createCorrections(c.orchestrator, { ...request, expectedDraftRevision: null }))).toEqual(stale('An open draft now exists (revision 2). Reload and reapply your edit.'))
    expect(outcome(() => createCorrections(c.orchestrator, { ...request, expectedDraftRevision: 1 }))).toEqual(stale('The draft changed (now revision 2). Reload and reapply your edit.'))
    const two = createCorrections(c.orchestrator, { ...request, expectedDraftRevision: one.draftRevision })
    expect([two.changed, two.target.epicId, two.draftRevision]).toEqual([true, one.target.epicId, 3])
  })
})

describe('DM-186 c4: created work follows the normal rules; no grade grants anything', () => {
  it('only a session that may edit drafts creates it', () => {
    const w = unfinished()
    const request = { reportId: w.report.id, experimentIds: [w.xp.ready.id] }
    for (const role of ['worker', 'reviewer', 'reader'] as const) {
      expect(outcome(() => createCorrections(withRole(w.ctx, role), request))).toEqual({ code: 'unauthorized', message: `This ${role} session is not permitted to perform "draft.edit".` })
    }
    expect(draftOf(w.ctx.db, w.epicId)).toBeNull()
  })

  it('creating it validates and saves, adopts, approves, grants, retries and continues nothing; the checkpoint stays blocked', () => {
    const w = unfinished()
    const before = controls(w)
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    expect([made.validation.valid, validatePlanView(w.ctx, { epicId: w.epicId, view: 'draft' }).errors]).toEqual([true, []])
    expect(controls(w)).toBe(before)
    expect(getExperiment(w.ctx, { experimentId: w.xp.ready.id }).status).toBe('proposed')
    expect(getCheckpoint(w.ctx, { runId: w.runId }).conditions.find((item) => item.id === 'plan_current')?.met).toBe(false)
    expect(outcome(() => advanceSprint(w.orchestrator, { runId: w.runId })).code).toBe('gate_blocked')
    expect(outcome(() => requestSave(withRole(w.ctx, 'orchestrator', { allowSave: false }), { epicId: w.epicId, expectedDraftRevision: made.draftRevision ?? 0 })).code).toBe('unauthorized')
  })

  it('the person saves and adopts it normally; the run stays in sprint 1 and the corrective tickets are not claimable', () => {
    const w = unfinished()
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    const save = requestSave(w.desktop, { epicId: w.epicId, expectedDraftRevision: made.draftRevision ?? 0 })
    flush(w.env)
    adoptRevision(w.desktop, { runId: w.runId, revisionId: save.revisionId })
    const run = w.ctx.db.get<{ revision_id: string; active_sprint_id: string; state: string }>('SELECT revision_id, active_sprint_id, state FROM runs WHERE id = ?', w.runId)
    expect(run).toEqual({ revision_id: save.revisionId, active_sprint_id: w.sprintId, state: 'awaiting_checkpoint' })
    const corrective = made.tickets.filter((ticket) => ticket.role !== 'acceptance').map((ticket) => ticket.ticketId)
    expect(getRun(w.ctx, { runId: w.runId })?.tickets.filter((ticket) => corrective.includes(ticket.ticketId)).map((ticket) => ticket.state)).toEqual(['later_sprint', 'later_sprint', 'later_sprint'])
    expect(outcome(() => approveCheckpoint(w.desktop, { runId: w.runId, reportId: w.report.id })).code).toBe('gate_blocked')
  })

  it('a follow-up epic is backlog and never saved; a run starts only after the person saves it and starts one', () => {
    const c = completed()
    const made = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    const followId = made.target.epicId ?? ''
    const runs = (): number => count(c, 'SELECT COUNT(*) AS n FROM runs WHERE epic_id = ?', followId)
    expect(outcome(() => startRun(c.orchestrator, { epicId: followId }))).toEqual({ code: 'invalid_plan', message: 'Save the plan before starting a run.' })
    requestSave(c.desktop, { epicId: followId, expectedDraftRevision: made.draftRevision ?? 0 })
    flush(c.env)
    expect(runs()).toBe(0)
    startRun(c.orchestrator, { epicId: followId })
    expect(runs()).toBe(1)
  })
})
