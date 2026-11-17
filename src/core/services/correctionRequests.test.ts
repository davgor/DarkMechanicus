import { describe, expect, it } from 'vitest'
import type { CorrectionWorkEdit } from '../../shared/domain/corrections'
import type { RetroExperiment } from '../../shared/domain/experiments'
import type { SprintReportInput } from '../../shared/domain/api'
import { tid } from '../../test/bundles'
import { completed, draftOf, outcome, SPECIFIC_WORK, unfinished, type Unfinished } from '../../test/correctionWorld'
import { flush } from '../../test/repoEnv'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { restatementOf } from '../plan/experiments'
import { parseInput, sprintReportInput } from '../schemas'
import { createCorrections, previewCorrections } from './corrections'
import { discardPlanDraft, updatePlanDraft } from './drafts'
import { recordExperimentEvent } from './experiments'
import { requestSave } from './plans'
import { submitSprintReport } from './reports'

/** Submits another revision of the unfinished epic's Sprint 1 report, as the command layer does. */
function resubmit(w: Unfinished, report: unknown): string {
  const parsed = parseInput(sprintReportInput, report, 'report') as SprintReportInput
  const view = submitSprintReport(w.orchestrator, { runId: w.runId, sprintId: w.sprintId, report: parsed })
  w.ctx.clock.advanceSeconds(60)
  return view.id
}

const LONG_SENTENCE = `Rewrite the importer context note in skills/planner.md ${'so that it names every record file and schema module '.repeat(8)}today.`

describe('DM-273: the person edits the generated tickets before they are created', () => {
  it('applies the edits of two work items of one experiment, and cuts a long first sentence in the default criterion', () => {
    const w = unfinished()
    const id = w.xp.ready.id
    const edits: CorrectionWorkEdit[] = [
      { experimentId: id, index: 1, title: 'Re-budget importer tickets from the measured median' },
      { experimentId: id, index: 0, body: LONG_SENTENCE }
    ]
    const view = previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [id], edits })
    const work = view.tickets.filter((ticket) => ticket.role === 'work')
    expect(view.experiments[0]?.state).toBe('ready')
    expect(work.map((ticket) => ticket.title)).toEqual([SPECIFIC_WORK[0].title, 'Re-budget importer tickets from the measured median'])
    const criterion = work[0]?.acceptanceCriteria[0]?.text ?? ''
    expect(criterion.endsWith('…')).toBe(true)
    expect(criterion.length).toBe(`${SPECIFIC_WORK[0].title}: the change the body describes is in place. `.length + 400)
  })

  it('blocks an experiment whose edits leave a blank title, a vague body, blank criteria or name missing work', () => {
    const w = unfinished()
    const id = w.xp.ready.id
    const edits: CorrectionWorkEdit[] = [
      { experimentId: id, index: 0, title: ' ' },
      { experimentId: id, index: 1, body: 'TBD after review.', acceptanceCriteria: [' '] },
      { experimentId: id, index: 5, title: 'Work that is not proposed' }
    ]
    const view = previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [id], edits })
    expect(view.experiments[0]?.state).toBe('blocked')
    expect(view.experiments[0]?.problems).toEqual([
      `an edit names proposedWork[5], which experiment ${id} does not have`,
      'the edited title of proposedWork[0] is blank',
      `the edited body of proposedWork[1] "${SPECIFIC_WORK[1].title}" does not say what changes (its body is under 40 characters)`,
      `proposedWork[1] "${SPECIFIC_WORK[1].title}" needs non-blank acceptance criteria`
    ])
    expect(view.tickets).toEqual([])
  })

  it('refuses an edit of an experiment that is not selected, and a work item edited twice', () => {
    const w = unfinished()
    const { ready, later } = w.xp
    const ask = (edits: CorrectionWorkEdit[]) => outcome(() => previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [ready.id], edits }))
    expect(ask([{ experimentId: later.id, index: 0, title: 'Elsewhere' }])).toEqual({ code: 'invalid_input', message: `The edit of ${later.id}#0 names an experiment that is not selected.` })
    expect(ask([{ experimentId: ready.id, index: 0, title: 'One' }, { experimentId: ready.id, index: 0, title: 'Two' }])).toEqual({
      code: 'invalid_input',
      message: `${ready.id}#0 is edited twice: give one edit per work item.`
    })
    expect(outcome(() => previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [ready.id, ready.id] }))).toEqual({
      code: 'invalid_input',
      message: `Experiment ${ready.id} is selected twice: select each once.`
    })
  })
})

describe('DM-273: prerequisites the person names for a corrective ticket', () => {
  it('makes a work ticket wait on an existing ticket by key and on another item of the request', () => {
    const w = unfinished()
    const id = w.xp.ready.id
    const edits: CorrectionWorkEdit[] = [{ experimentId: id, index: 1, dependsOn: [{ ticket: 'DM-2' }, { work: { experimentId: id, index: 0 } }] }]
    const made = createCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [id], edits })
    expect(made.tickets.find((ticket) => ticket.ref === `${id}#1`)?.dependsOn).toEqual(['DM-2', `${id}#0`])
    expect(made.dependencies).toContainEqual({ from: 'DM-2', to: `${id}#1` })
  })

  it('refuses an unknown ticket, an acceptance node and work this request does not create', () => {
    const w = unfinished()
    const { ready, later } = w.xp
    const ask = (dependsOn: NonNullable<CorrectionWorkEdit['dependsOn']>) =>
      outcome(() => previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [ready.id], edits: [{ experimentId: ready.id, index: 0, dependsOn }] }))
    expect(ask([{ ticket: 'DM-99' }])).toEqual({ code: 'invalid_input', message: 'Invalid prerequisite "DM-99": name a work ticket of the target draft by id or key.' })
    expect(ask([{ ticket: tid(4) }]).message).toBe(`Invalid prerequisite "${tid(4)}": name a work ticket of the target draft by id or key.`)
    expect(ask([{ work: { experimentId: later.id, index: 0 } }])).toEqual({ code: 'invalid_input', message: `Invalid prerequisite of ${ready.id}#0: ${later.id}#0 is not work this request creates.` })
  })
})

describe('DM-273: the report revision and experiments a request reads', () => {
  it('refuses a report revision a later one replaced, and an experiment the latest revision does not hold', () => {
    const w = unfinished()
    const latest = resubmit(w, { summary: 'Sprint 1, written again without experiments.' })
    expect(outcome(() => previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] }))).toEqual({
      code: 'conflict',
      message: `Report ${w.report.id} is revision 1 of its sprint's report; revision 2 (${latest}) replaced it. Read the corrections of the latest revision.`
    })
    expect(outcome(() => previewCorrections(w.orchestrator, { reportId: latest, experimentIds: [w.xp.ready.id] }))).toEqual({
      code: 'not_found',
      message: `Experiment ${w.xp.ready.id} is not in the retro of report ${latest}.`
    })
  })

  it('notes the retro leftovers still in the reported sprint', () => {
    const w = unfinished()
    const restated = (experiment: RetroExperiment) => restatementOf(experiment)
    const latest = resubmit(w, {
      summary: 'Sprint 1 with a leftover.',
      retro: { experiments: Object.values(w.xp).map(restated), leftovers: [{ ticket: tid(3), reason: 'Its docs are still to come.' }] }
    })
    const view = previewCorrections(w.orchestrator, { reportId: latest, experimentIds: [w.xp.ready.id] })
    expect(view.notes).toContain('The Sprint 1 retro lists 1 leftover(s) still in that sprint: redrafting moves them to the sprint right after it, ahead of its acceptance node, as before.')
  })

  it('blocks an experiment already abandoned', () => {
    const w = unfinished()
    recordExperimentEvent(w.orchestrator, { experimentId: w.xp.ready.id, event: { kind: 'status', status: 'abandoned', note: 'Not worth it' } })
    const view = previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    expect([view.experiments[0]?.state, view.experiments[0]?.problems]).toEqual(['blocked', ['it is abandoned']])
  })
})

describe('DM-273: previews that place nothing', () => {
  it('previews a missing sprint target as planned sprint 1 with no id, no goal and no tickets', () => {
    const w = unfinished()
    const view = previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id], target: { kind: 'sprint', sprintId: 'sp_zzzzzzzzzzzzzzzzzzzzzzzzzz' } })
    expect(view.target).toMatchObject({ kind: 'sprint', sprintId: null, sprintOrdinal: 1, sprintGoal: '' })
    expect([view.tickets, view.validation.valid]).toEqual([[], true])
  })
})

describe('DM-273: the follow-up epic of a completed epic', () => {
  it('takes the title the request gives, and the default title for a blank one', () => {
    const c = completed()
    const titled = previewCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1], target: { kind: 'follow_up_epic', title: 'Importer corrections' } })
    const blank = previewCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1], target: { kind: 'follow_up_epic', title: ' ' } })
    const untitled = previewCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1], target: { kind: 'follow_up_epic' } })
    expect([titled.target.epicTitle, blank.target.epicTitle, untitled.target.epicTitle]).toEqual(['Importer corrections', 'Follow-up: Test epic', 'Follow-up: Test epic'])
  })

  it('appends the work of a new experiment after the sprints of a saved follow-up epic', () => {
    const c = completed()
    const one = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x1] })
    const followId = one.target.epicId ?? ''
    requestSave(c.desktop, { epicId: followId, expectedDraftRevision: one.draftRevision ?? 0 })
    flush(c.env)
    const two = createCorrections(c.orchestrator, { reportId: c.report.id, experimentIds: [c.x2] })
    expect([two.target.epicId, two.target.sprintOrdinal, two.target.sprintGoal]).toEqual([followId, 2, `Corrective work from the Sprint 1 retro (report revision 1): experiments ${c.x2}.`])
    expect(draftOf(c.ctx.db, followId)?.bundle.sprints.length).toBe(2)
  })

  it('names the saved revision holding work created with another payload', () => {
    const c = completed()
    const request = { reportId: c.report.id, experimentIds: [c.x1] }
    const one = createCorrections(c.orchestrator, request)
    const followId = one.target.epicId ?? ''
    requestSave(c.desktop, { epicId: followId, expectedDraftRevision: one.draftRevision ?? 0 })
    flush(c.env)
    discardPlanDraft(c.desktop, { epicId: followId })
    const refused = outcome(() => createCorrections(c.orchestrator, { ...request, edits: [{ experimentId: c.x1, index: 0, title: 'Another title for the work' }] }))
    expect(refused.code).toBe('idempotency_mismatch')
    expect(refused.message).toContain(`in epic ${followId} (saved revision 1) under key`)
  })
})

/** `on` as a session of a folder holding the repositories `names`. */
function inFolder(on: TestCtx, names: string[]): TestCtx {
  const folder = createTestCtx({ db: on.db, repositories: names })
  return { ...on, repositories: folder.repositories, repositoryEntries: folder.repositoryEntries }
}

describe('DM-273: corrective work in a folder of repositories', () => {
  it('blocks an experiment aimed at a repository once that repository is not one of the project any more', () => {
    const w = unfinished()
    const restated = { ...restatementOf(w.xp.ready), destination: { kind: 'source_repository', repository: 'api' } }
    const parsed = parseInput(sprintReportInput, { summary: 'Sprint 1, aimed at the api repository.', retro: { experiments: [restated] } }, 'report') as SprintReportInput
    const reportId = submitSprintReport(inFolder(w.orchestrator, ['api', 'web']), { runId: w.runId, sprintId: w.sprintId, report: parsed }).id
    const problems = (on: TestCtx) => previewCorrections(on, { reportId, experimentIds: [w.xp.ready.id] }).experiments[0]?.problems
    const gone = 'its repository "api" is not a repository of this folder'
    expect(problems(inFolder(w.orchestrator, ['web']))).toEqual([gone])
    expect(problems(w.orchestrator)).toEqual([gone])
    expect(problems(inFolder(w.orchestrator, ['api', 'web']))).toEqual([])
  })

  it("refuses work the folder's validation would reject, beside the draft's own errors, and writes nothing", () => {
    const w = unfinished()
    const refused = outcome(() => createCorrections(inFolder(w.orchestrator, ['api']), { reportId: w.report.id, experimentIds: [w.xp.ready.id] }))
    expect(refused.code).toBe('invalid_graph')
    expect(refused.message).toBe(
      'The corrective work would make the plan invalid: DM-6 needs a repository; this folder\'s repositories: api. DM-7 needs a repository; this folder\'s repositories: api. DM-8 needs a repository; this folder\'s repositories: api.'
    )
    expect(draftOf(w.ctx.db, w.epicId)).toBeNull()
  })
})

describe('DM-273: a draft that no longer holds the reported sprint', () => {
  it('still places corrective work after the reported sprint, by its ordinal in the run', () => {
    const w = unfinished()
    updatePlanDraft(w.orchestrator, {
      epicId: w.epicId,
      ops: [
        { op: 'add_sprint', ref: 'next', sprint: { goal: 'Next' } },
        ...[1, 2, 3].map((n) => ({ op: 'move_ticket' as const, ticket: tid(n), toSprint: 'next' })),
        { op: 'remove_ticket', ticket: tid(4) },
        { op: 'remove_sprint', sprint: w.sprintId }
      ]
    })
    const view = previewCorrections(w.orchestrator, { reportId: w.report.id, experimentIds: [w.xp.ready.id] })
    expect([view.target.kind, view.target.afterOrdinal, view.target.sprintOrdinal]).toEqual(['new_sprint', 1, 2])
  })
})
