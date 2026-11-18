import { describe, expect, it } from 'vitest'
import { bundle, runView } from '../epic/__mocks__/fixtures'
import {
  experiment,
  experimentRead,
  finding,
  findings,
  improvementReport,
  outcome,
  planView,
  REPORT_ID,
  resultOf,
  workTicket
} from '../__mocks__/improvementFixtures'
import { retroLookup } from './gateView'
import {
  assessmentView,
  createBlock,
  drawnFrom,
  EMPTY_PLANNER,
  editDefaults,
  editStanding,
  experimentStatus,
  findingsView,
  fittingTarget,
  holdingEpics,
  type KeptEdit,
  OPEN_SCOPE,
  plannerFailure,
  plannerRequest,
  type PlannerState,
  previewStanding,
  previewView,
  requestKey,
  resultStands,
  resultView,
  selectability,
  shownNotice
} from './improvementView'

const LOOKUP = retroLookup({ run: runView(), bundle: bundle() })
const XP_A = experiment('xp_a')
const XP_B = experiment('xp_b')
const BOTH = [XP_A, XP_B]

function planner(patch: Partial<PlannerState> = {}): PlannerState {
  return { ...EMPTY_PLANNER, ...patch }
}

function kept(patch: Partial<KeptEdit> = {}): KeptEdit {
  return { against: { reportId: REPORT_ID, title: 'xp_a work one', body: 'List the importer record files in the claim packet.' }, ...patch }
}

/** A state whose last preview was read for exactly what it asks now. */
function previewed(state: PlannerState, view = planView(state.selected)): PlannerState {
  const input = plannerRequest(REPORT_ID, state, BOTH).input
  return { ...state, preview: { key: requestKey(input), reportId: REPORT_ID, view } }
}

describe('DM-187 c1: the measured result heads the chain', () => {
  it('shows the sprint grade frozen with the revision and what it was read under', () => {
    const view = assessmentView(improvementReport([XP_A], { id: 'sr_0123456789abcdefghijklmnop' }))
    expect(view.headline).toEqual({ letter: 'C', score: 'Score 71', status: 'final', coverage: 'Coverage 75.0%' })
    expect(view.facts).toEqual([
      { label: 'Frozen with', value: 'Report revision 1 (sr_0123456789abcdefghijklmnop)' },
      { label: 'Records up to', value: '2026-09-30T11:00:00.000Z' },
      { label: 'Policy', value: 'space-default v3 · 001122334455' },
      { label: 'Snapshot', value: 'ss_9 · abcdef012345' },
      { label: 'Graded', value: '4 tickets, rolled up into the ticket, sprint and run grades' }
    ])
    expect(view.note).toContain('A low grade starts no work by itself')
  })

  it('says a report from before scorecards was never measured instead of showing a grade', () => {
    const view = assessmentView(improvementReport([XP_A], { scorecard: undefined }))
    expect(view.headline).toBeNull()
    expect(view.facts).toEqual([])
    expect(view.note).toMatch(/^This report was submitted before scorecards/)
  })

  it('says the scorecard holds no sprint grade rather than inventing one', () => {
    const report = improvementReport([XP_A], { sprintId: 'sp_9' })
    const view = assessmentView(report)
    expect(view.headline).toBeNull()
    expect(view.note).toBe('The frozen scorecard holds no grade for this sprint.')
  })
})

describe('DM-187 c1: findings link to the experiments drawn from them', () => {
  it('names the ticket by key, keeps the numbers and links each experiment drawn from the finding', () => {
    const view = findingsView(findings([finding('f1')]), [XP_A, experiment('xp_k', { baseline: { measure: 'K.actual_tokens', unit: 'tokens', value: 1, state: 'observed' } })], LOOKUP)
    const [row] = view.rows
    expect(row?.heading).toBe('#1 · Budget overrun')
    expect(row?.statement).toBe('DM-202 used 90 minutes of active time against a 30 minute budget.')
    expect(row?.subject).toBe('Ticket grade · DM-202 Transactional bundle import')
    expect(row?.coverage).toBe('Grade coverage 85.7% · 2 of 3 items measured')
    expect(row?.withheld).toBe('No proposal: too little was measured to size a change.')
    expect(row?.evidence).toEqual([{ kind: 'attempt', id: 'at_202_1', detail: null }])
    expect(row?.experiments).toEqual([{ experimentId: 'xp_a', label: 'xp_a · xp_a: DM-202 ran 90 minutes against a 30 minute budget' }])
  })

  it('matches by measure first, then by component, and never across grades', () => {
    const time = finding('f_time')
    const timeOther = finding('f_time2', { magnitude: { ...finding('x').magnitude, measure: 'E.corrective_ms' } })
    const otherGrade = finding('f_other', { assessmentId: 'as_other' })
    expect(drawnFrom(XP_A, [time, timeOther, otherGrade]).map((item) => item.id)).toEqual(['f_time'])
    const tokens = experiment('xp_t', { baseline: { measure: 'K.actual_tokens', unit: 'tokens', value: 1, state: 'observed' } })
    const kFinding = finding('f_k', { component: 'K', magnitude: { ...finding('x').magnitude, measure: null } })
    expect(drawnFrom(tokens, [time, kFinding]).map((item) => item.id)).toEqual(['f_k'])
    const whole = experiment('xp_g', { baseline: { measure: 'grade.score', unit: 'points', value: 52, state: 'observed' } })
    expect(drawnFrom(whole, [time, kFinding, otherGrade]).map((item) => item.id)).toEqual(['f_time', 'f_k'])
  })

  it('states when the scorecard shows nothing to correct', () => {
    expect(findingsView(findings([], { status: 'no_meaningful_issue' }), [], LOOKUP).status).toBe(
      'The scorecard shows no gap past the thresholds: nothing to correct, and nothing is proposed.'
    )
    expect(findingsView(findings([finding('f1')]), [], LOOKUP).status).toBeNull()
  })

  it('lists the follow-up epics holding an experiment’s work, once each, never the home epic or another project', () => {
    const tickets = [
      { epicId: 'ep_1', epicTitle: 'Home', ticketId: 't1', key: 'DM-1', title: 'a', role: 'work' as const, workIndex: 0, revisionNumber: 1, accepted: null },
      { epicId: 'ep_f', epicTitle: 'Follow-up', ticketId: 't2', key: 'FU-1', title: 'b', role: 'work' as const, workIndex: 0, revisionNumber: 1, accepted: null },
      { epicId: 'ep_f', epicTitle: 'Follow-up', ticketId: 't3', key: 'FU-2', title: 'c', role: 'work' as const, workIndex: 1, revisionNumber: 1, accepted: null },
      { epicId: 'ep_x', epicTitle: 'Elsewhere', projectId: 'pj', ticketId: 't4', key: 'X-1', title: 'd', role: 'work' as const, workIndex: 0, revisionNumber: 1, accepted: null }
    ]
    const read = experimentRead(XP_A, { outcome: outcome('xp_a', { corrections: { tickets, runIds: [] } }) })
    expect(holdingEpics(read, 'ep_1')).toEqual([{ epicId: 'ep_f', title: 'Follow-up' }])
    expect(holdingEpics(null, 'ep_1')).toEqual([])
  })
})

describe('DM-187 c3: which experiments can be selected', () => {
  it('refuses Dark Mechanicus, withdrawn and finished experiments, each with why', () => {
    expect(selectability(experiment('xp_d', { destination: { kind: 'darkmechanicus_source' } }), null).selectable).toBe(false)
    expect(selectability(XP_A, experimentRead(XP_A, { withdrawn: true }))).toEqual({ selectable: false, note: 'A later revision of the report left it out (withdrawn): it takes no new work.' })
    expect(selectability(XP_A, experimentRead(XP_A, { status: 'completed' }))).toEqual({ selectable: false, note: 'It is completed: it takes no new work.' })
    expect(selectability(XP_A, experimentRead(XP_A, { status: 'abandoned' })).selectable).toBe(false)
  })

  it('lets unsized or vague work be selected and says the preview shows how to restate it', () => {
    expect(selectability(XP_A, experimentRead(XP_A, { executionProblems: ['work 1 is unsized'] }))).toEqual({
      selectable: true,
      note: 'Not creatable as written: work 1 is unsized. The preview shows how to restate it.'
    })
    expect(selectability(XP_A, experimentRead(XP_A, { status: 'scheduled' }))).toEqual({ selectable: true, note: null })
    expect(selectability(XP_A, null)).toEqual({ selectable: true, note: null })
  })

  it('reads a withdrawn experiment’s status with the withdrawal, and nothing before it is read', () => {
    expect(experimentStatus(experimentRead(XP_A, { status: 'in_progress', withdrawn: true }))).toBe('In progress · withdrawn')
    expect(experimentStatus(null)).toBeNull()
  })
})

describe('DM-187 c2: plannerRequest asks for exactly the person’s selection and edits', () => {
  it('sends selected experiments in retro order, the edits of selected work only, the target and Fireguard choice', () => {
    const state = planner({
      selected: ['xp_b', 'xp_a'],
      target: { kind: 'sprint', sprintId: 'sp_3' },
      fireguard: false,
      edits: {
        'xp_a#0': kept({ title: 'Renamed', body: 'Now says what changes.', criteria: ' First \n\n Second ', requiresTickets: 'DM-12, DM-13' }),
        'xp_c#0': kept({ title: 'Of an unselected experiment' })
      }
    })
    const request = plannerRequest(REPORT_ID, state, BOTH, { ...OPEN_SCOPE, laterSprints: ['sp_3'] })
    expect(request.input).toEqual({
      reportId: REPORT_ID,
      experimentIds: ['xp_a', 'xp_b'],
      target: { kind: 'sprint', sprintId: 'sp_3' },
      edits: [
        {
          experimentId: 'xp_a',
          index: 0,
          title: 'Renamed',
          body: 'Now says what changes.',
          acceptanceCriteria: ['First', 'Second'],
          dependsOn: [{ ticket: 'DM-12' }, { ticket: 'DM-13' }]
        }
      ],
      fireguard: false
    })
    expect(request.leftOut).toEqual([])
    expect(request.held).toEqual([])
  })

  it('sends a follow-up title trimmed, and no title when blank', () => {
    const scope = { ...OPEN_SCOPE, epicCompleted: true }
    expect(plannerRequest(REPORT_ID, planner({ selected: ['xp_a'], target: { kind: 'follow_up_epic', title: '  Fix it  ' } }), BOTH, scope).input.target).toEqual({
      kind: 'follow_up_epic',
      title: 'Fix it'
    })
    expect(plannerRequest(REPORT_ID, planner({ selected: ['xp_a'], target: { kind: 'follow_up_epic', title: '  ' } }), BOTH, scope).input.target).toEqual({ kind: 'follow_up_epic' })
  })
})

describe('DM-187 c3: plannerRequest leaves out what no longer fits, saying why', () => {
  it('leaves out experiments no longer in the retro or not selectable now, saying why', () => {
    const scope = { ...OPEN_SCOPE, unselectable: new Map([['xp_b', 'It is completed: it takes no new work.']]) }
    const request = plannerRequest(REPORT_ID, planner({ selected: ['xp_gone', 'xp_b', 'xp_a'] }), BOTH, scope)
    expect(request.input.experimentIds).toEqual(['xp_a'])
    expect(request.leftOut).toEqual([
      { experimentId: 'xp_gone', why: "It is no longer in this revision's retro." },
      { experimentId: 'xp_b', why: 'It is completed: it takes no new work.' }
    ])
  })

  it('holds edits written against restated or missing work and never sends them', () => {
    const state = planner({
      selected: ['xp_a'],
      edits: {
        'xp_a#0': kept({ title: 'Mine', against: { reportId: 'sr_0', title: 'Older title', body: 'Older body' } }),
        'xp_a#5': kept({ title: 'Of a dropped item' })
      }
    })
    const request = plannerRequest(REPORT_ID, state, BOTH)
    expect(request.input.edits).toBeUndefined()
    expect(request.held).toEqual([
      { ref: 'xp_a#0', experimentId: 'xp_a', index: 0, standing: 'restated' },
      { ref: 'xp_a#5', experimentId: 'xp_a', index: 5, standing: 'gone' }
    ])
  })
})

describe('DM-187 review fix 1: a prerequisite on a deselected experiment’s work', () => {
  it('is left out of the request and reported, while the rest of the edit is still sent', () => {
    const state = planner({ selected: ['xp_a'], edits: { 'xp_a#0': kept({ requires: ['xp_b#1', 'xp_a#1'], requiresTickets: 'DM-12' }) } })
    const request = plannerRequest(REPORT_ID, state, BOTH)
    expect(request.input.edits).toEqual([{ experimentId: 'xp_a', index: 0, dependsOn: [{ work: { experimentId: 'xp_a', index: 1 } }, { ticket: 'DM-12' }] }])
    expect(request.prerequisitesDropped).toEqual([{ ref: 'xp_a#0', requires: 'xp_b#1' }])
  })

  it('is sent again once its experiment is selected again', () => {
    const state = planner({ selected: ['xp_a', 'xp_b'], edits: { 'xp_a#0': kept({ requires: ['xp_b#1'] }) } })
    const request = plannerRequest(REPORT_ID, state, BOTH)
    expect(request.input.edits).toEqual([{ experimentId: 'xp_a', index: 0, dependsOn: [{ work: { experimentId: 'xp_b', index: 1 } }] }])
    expect(request.prerequisitesDropped).toEqual([])
  })
})

describe('DM-187 review fix 2: cleared criteria', () => {
  it('omit acceptanceCriteria (the generated ones are kept) instead of sending an empty list', () => {
    const blank = plannerRequest(REPORT_ID, planner({ selected: ['xp_a'], edits: { 'xp_a#0': kept({ criteria: ' \n  \n' }) } }), BOTH)
    expect(blank.input.edits).toBeUndefined()
    const titled = plannerRequest(REPORT_ID, planner({ selected: ['xp_a'], edits: { 'xp_a#0': kept({ title: 'T', criteria: '' }) } }), BOTH)
    expect(titled.input.edits).toEqual([{ experimentId: 'xp_a', index: 0, title: 'T' }])
  })
})

describe('DM-187 c3: fittingTarget keeps a target only while it still fits', () => {
  it('keeps the default and any target that fits', () => {
    expect(fittingTarget(null, OPEN_SCOPE)).toEqual({ target: null, dropped: null })
    expect(fittingTarget({ kind: 'sprint', sprintId: 'sp_3' }, { ...OPEN_SCOPE, laterSprints: ['sp_3'] })).toEqual({ target: { kind: 'sprint', sprintId: 'sp_3' }, dropped: null })
    expect(fittingTarget({ kind: 'new_sprint' }, OPEN_SCOPE)).toEqual({ target: { kind: 'new_sprint' }, dropped: null })
    expect(fittingTarget({ kind: 'follow_up_epic', title: 'x' }, { ...OPEN_SCOPE, epicCompleted: true }).dropped).toBeNull()
  })

  it('drops a sprint target once the epic is completed, a follow-up target while it is not, and a sprint no longer later', () => {
    expect(fittingTarget({ kind: 'sprint', sprintId: 'sp_3' }, { ...OPEN_SCOPE, epicCompleted: true, laterSprints: ['sp_3'] })).toEqual({
      target: null,
      dropped: 'The epic is completed: the sprint chosen earlier no longer applies, so the work goes into a follow-up epic.'
    })
    expect(fittingTarget({ kind: 'follow_up_epic', title: 'x' }, OPEN_SCOPE)).toEqual({ target: null, dropped: 'The epic is not completed: the work goes into its draft, not a follow-up epic.' })
    expect(fittingTarget({ kind: 'sprint', sprintId: 'sp_2' }, { ...OPEN_SCOPE, laterSprints: ['sp_3'] })).toEqual({
      target: null,
      dropped: 'The sprint chosen earlier is no longer a later sprint of the draft: a new sprint is appended instead.'
    })
  })
})

describe('DM-187 c3: editStanding of a kept edit on a newer revision', () => {
  it('is current where it was written, or where the item reads the same; restated or gone otherwise', () => {
    const older = kept({ against: { reportId: 'sr_0', title: 'xp_a work one', body: 'List the importer record files in the claim packet.' } })
    expect(editStanding(kept(), XP_A, 0, REPORT_ID)).toBe('current')
    expect(editStanding(older, XP_A, 0, REPORT_ID)).toBe('current')
    expect(editStanding({ ...older, against: { ...older.against, title: 'Old title' } }, XP_A, 0, REPORT_ID)).toBe('restated')
    expect(editStanding({ ...older, against: { ...older.against, body: 'Old body' } }, XP_A, 0, REPORT_ID)).toBe('restated')
    expect(editStanding(kept({ against: { reportId: REPORT_ID, title: 'other', body: 'other' } }), XP_A, 0, REPORT_ID)).toBe('current')
    expect(editStanding(kept(), XP_A, 2, REPORT_ID)).toBe('gone')
  })
})

describe('DM-187 c3: createBlock (no creation before a current, clean preview)', () => {
  const selected = planner({ selected: ['xp_a'] })
  const block = (state: PlannerState, busy = false): string | null => createBlock(state, plannerRequest(REPORT_ID, state, BOTH), busy)

  it('blocks while a request is in flight, so a repeated click starts nothing', () => {
    expect(block({ ...previewed(selected), pending: 'create' })).toBe('Creating the draft work…')
    expect(block({ ...previewed(selected), pending: 'preview' })).toBe('Reading the preview…')
  })

  it('asks for a selection, then a preview, then a new preview once choices or the report changed', () => {
    expect(block(planner())).toBe('Select at least one experiment.')
    expect(block(selected)).toBe('Preview the corrective work first: nothing is created before you have seen it.')
    expect(block({ ...previewed(selected), fireguard: false })).toBe('Your choices changed since the preview: preview again to see what would be created.')
    const old = previewed(selected)
    expect(block({ ...old, preview: old.preview && { ...old.preview, reportId: 'sr_0' } })).toBe('The report was revised since the preview: preview again against the latest revision.')
  })

  it('names restated edits to keep or discard first', () => {
    const state = previewed(planner({ selected: ['xp_a'], edits: { 'xp_a#1': kept({ title: 'x', against: { reportId: 'sr_0', title: 'old', body: 'old' } }) } }))
    expect(block(state)).toBe('A newer report revision restated the work you edited (xp_a#1): keep or discard those edits under Selected work first.')
  })

  it('reads conflicts, blocked work (yours or as stated) and already-created work from the preview', () => {
    const states = (state: 'conflict' | 'blocked' | 'created'): PlannerState => {
      const plan = planView(['xp_a'])
      return previewed(selected, { ...plan, experiments: plan.experiments.map((item) => ({ ...item, state })) })
    }
    expect(block(states('conflict'))).toBe('xp_a already has corrective work from a different request: deselect it, or open the draft holding it.')
    expect(block(states('blocked'))).toBe('xp_a cannot be created as the experiment states it: deselect it, or ask the orchestrator to restate it with sized, specific work.')
    expect(block(states('created'))).toBe('Already created: nothing to add. Open the draft holding it.')
    const edited = planner({ selected: ['xp_a'], edits: { 'xp_a#0': kept({ title: '' }) } })
    const plan = planView(['xp_a'])
    expect(block(previewed(edited, { ...plan, experiments: plan.experiments.map((item) => ({ ...item, state: 'blocked' as const })) }))).toMatch(/^xp_a cannot be created with your edits/)
  })

  it('offers creation on a current, ready preview unless the workspace is busy', () => {
    expect(block(previewed(selected))).toBeNull()
    expect(block(previewed(selected), true)).toBe('The workspace is busy.')
  })

  it('reads the preview standing', () => {
    const input = plannerRequest(REPORT_ID, selected, BOTH).input
    expect(previewStanding(selected, REPORT_ID, input)).toBe('none')
    expect(previewStanding(previewed(selected), REPORT_ID, input)).toBe('current')
    expect(previewStanding(previewed(selected), 'sr_2', input)).toBe('report_revised')
  })
})

describe('DM-187 c2: the preview shows criteria, dependencies and destination', () => {
  it('names the target sprint, the destination repository and each ticket with its own body, criteria and prerequisites', () => {
    const plan = planView(['xp_a'], {
      tickets: [workTicket('xp_a', 0), workTicket('xp_a', 1, { key: 'DM-311', dependsOn: ['xp_a#0', 'DM-12'], acceptanceCriteria: [{ id: 'a', text: 'Covers it', covers: 'xp_a#0' }] })]
    })
    const view = previewView(plan)
    expect(view.target).toBe('The draft of "Checkout revamp": a new Sprint 4, appended (after Sprint 3, which stays as it is) · goal: Corrective work')
    expect(view.destination).toBe("This project's repository")
    expect(view.tickets[0]).toMatchObject({ role: 'Corrective work', key: 'DM-310', size: 'Small', body: 'List the importer record files in the claim packet.', tags: 'correction', work: { experimentId: 'xp_a', index: 0 } })
    expect(view.tickets[1]?.requires).toEqual(['DM-310', 'DM-12'])
    expect(view.tickets[1]?.criteria).toEqual([{ text: 'Covers it', covers: 'DM-310' }])
    expect(view.dependencies).toEqual(['DM-311 requires DM-310'])
    expect(view.experiments[0]).toMatchObject({ label: 'Ready to create', tone: 'accepted', existing: null })
  })

  it('names an existing sprint, a follow-up epic and another repository', () => {
    const plan = planView(['xp_a'])
    expect(previewView({ ...plan, target: { ...plan.target, sprintId: 'sp_3', sprintOrdinal: 3, afterOrdinal: null, sprintGoal: ' ' } }).target).toBe('The draft of "Checkout revamp": Sprint 3')
    expect(previewView({ ...plan, target: { ...plan.target, kind: 'follow_up_epic', epicId: null, epicTitle: 'Follow-up', sprintOrdinal: 1 } }).target).toBe(
      'A new follow-up epic "Follow-up" · Sprint 1 · goal: Corrective work'
    )
    expect(previewView({ ...plan, tickets: [workTicket('xp_a', 0, { repo: 'api' })] }).destination).toBe('Repository api')
  })

  it('says where already-created work is and offers the restatement of blocked work', () => {
    const plan = planView(['xp_a'])
    const existing = { key: 'k', payloadHash: 'p', epicId: 'ep_9', holder: 'revision' as const, revisionNumber: 4, ticketIds: [], keys: ['DM-50', 'DM-51'] }
    const [row] = previewView({ ...plan, experiments: [{ ...plan.experiments[0]!, state: 'created', existing }] }).experiments
    expect(row).toMatchObject({ label: 'Already created', existing: 'DM-50, DM-51 in the saved revision 4 of epic ep_9', existingEpicId: 'ep_9' })
  })

  it('starts an edit from the experiment’s work and the previewed criteria and prerequisites', () => {
    const ticket = workTicket('xp_a', 1, { dependsOn: ['xp_a#0', 'DM-12', 'fireguard'], acceptanceCriteria: [{ id: 'a', text: 'One', covers: null }, { id: 'b', text: 'Two', covers: null }] })
    expect(editDefaults(XP_A, 1, ticket)).toEqual({ title: 'xp_a work two', body: 'Add the schema modules to the context section.', criteria: 'One\nTwo', requires: ['xp_a#0'], requiresTickets: 'DM-12' })
    expect(editDefaults(XP_A, 0, undefined).criteria).toBe('')
  })
})

describe('DM-187 c3: results and notices stay with the context they describe', () => {
  const created = resultOf(planView(['xp_a']))

  it('resultStands only for this revision and, in this epic, the draft revision it wrote', () => {
    const result = { reportId: REPORT_ID, view: created }
    expect(resultStands(result, REPORT_ID, 8)).toBe(true)
    expect(resultStands(result, REPORT_ID, 9)).toBe(false)
    expect(resultStands(result, REPORT_ID, null)).toBe(false)
    expect(resultStands(result, 'sr_2', 8)).toBe(false)
    expect(resultStands(null, REPORT_ID, 8)).toBe(false)
    const followUp = { reportId: REPORT_ID, view: { ...created, target: { ...created.target, epicId: 'ep_f' } } }
    expect(resultStands(followUp, REPORT_ID, null)).toBe(true)
  })

  it('reads a creation as draft work only, and a repeat as nothing added', () => {
    expect(resultView(created)).toMatchObject({
      heading: 'Created as draft work in "Checkout revamp" (draft revision 8). Nothing was saved, adopted, started or approved.',
      tone: 'accepted',
      tickets: ['DM-310 xp_a work one', 'DM-311 xp_a work two'],
      sameEpic: true
    })
    expect(resultView({ ...created, changed: false }).heading).toBe('Already created by the same request: nothing was added.')
  })

  it('shownNotice turns a reload notice of an earlier revision into a new-preview notice', () => {
    const report = { id: 'sr_2', reportRevision: 2 }
    const reload = { tone: 'error' as const, text: 'Reload.', action: 'reload' as const, reportId: REPORT_ID }
    expect(shownNotice(reload, report)).toEqual({
      tone: 'info',
      text: 'The report was read again: its revision 2 is shown now. Nothing was created; your selection and edits are kept. Preview again to see the work against this revision.',
      action: 'preview'
    })
    expect(shownNotice({ ...reload, reportId: 'sr_2' }, report)).toEqual({ ...reload, reportId: 'sr_2' })
    const preview = { ...reload, action: 'preview' as const }
    expect(shownNotice(preview, report)).toBe(preview)
    expect(shownNotice(null, report)).toBeNull()
  })
})

describe('DM-187 c3: refusals in words, with what recovers and nothing lost', () => {
  it('explains a stale draft, a replaced report, a different request and a completed epic', () => {
    expect(plannerFailure({ code: 'conflict', message: 'x', details: { currentDraftRevision: 9 } }, 'create')).toEqual({
      tone: 'error',
      text: 'The draft changed since your preview (it is now revision 9). Nothing was created; your selection and edits are kept. Preview again to see it as it is now.',
      action: 'preview'
    })
    expect(plannerFailure({ code: 'conflict', message: 'x', details: { latestReportId: 'sr_2' } }, 'preview').action).toBe('reload')
    expect(plannerFailure({ code: 'idempotency_mismatch', message: 'x' }, 'create').text).toMatch(/^Corrective work for a selected experiment was already created by a different request/)
    expect(plannerFailure({ code: 'completed_epic', message: 'x' }, 'create').action).toBe('reload')
  })

  it('keeps the core’s message for invalid edits, missing records and blocked work', () => {
    expect(plannerFailure({ code: 'invalid_graph', message: 'DM-311 requires itself.' }, 'preview').text).toBe(
      'DM-311 requires itself. Nothing was created; your selection and edits are kept. Fix the edits (a prerequisite must be work of this request or a work ticket of the draft) and preview again.'
    )
    expect(plannerFailure({ code: 'not_found', message: 'No report sr_9.' }, 'preview')).toEqual({
      tone: 'error',
      text: 'No report sr_9. Nothing was created; your selection and edits are kept. Reload to read the report as it is now.',
      action: 'reload'
    })
    expect(plannerFailure({ code: 'conflict', message: 'xp_a is blocked.' }, 'create')).toEqual({ tone: 'error', text: 'xp_a is blocked. Nothing was created; your selection and edits are kept.', action: 'preview' })
  })

  it('names the phase of an unknown failure', () => {
    expect(plannerFailure({ code: null, message: 'Disk full.' }, 'preview')).toEqual({
      tone: 'error',
      text: 'The preview could not be read: Disk full. Nothing was created; your selection and edits are kept.',
      action: 'preview'
    })
    expect(plannerFailure({ code: null, message: 'Disk full.' }, 'create')).toEqual({
      tone: 'error',
      text: 'The draft work was not created: Disk full. Nothing was created; your selection and edits are kept.',
      action: null
    })
  })
})
