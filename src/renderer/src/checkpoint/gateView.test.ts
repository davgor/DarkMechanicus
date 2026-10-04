import { describe, expect, it } from 'vitest'
import {
  MINUTE,
  NOW,
  attempt,
  bundle,
  checkpointView,
  condition,
  draftPlan,
  execution,
  incrementView,
  reportView as reportFixture,
  runView,
  sprint
} from '../epic/__mocks__/fixtures'
import { followUpOp, gateView, reportView } from './gateView'

const FAILED_RUN = runView({
  state: 'awaiting_checkpoint',
  tickets: runView().tickets.map((item) =>
    item.ticketId === 'tk_202'
      ? execution('DM-202', 'sp_2', 'failed', { attemptCount: 2, blockers: [{ kind: 'retry_limit', attempts: 2, limit: 2 }] })
      : item
  ),
  attempts: [
    ...runView().attempts.filter((item) => item.ticketId !== 'tk_202'),
    attempt('DM-202', 1, 'failed', { failure: { reason: 'flaky', details: '', retryable: true }, updatedAt: '2026-09-30T11:00:00.000Z' }),
    attempt('DM-202', 2, 'failed', {
      failure: { reason: 'codesign: no identity found', details: '', retryable: false },
      updatedAt: '2026-09-30T11:30:00.000Z'
    }),
    attempt('DM-203', 1, 'accepted', {
      outputs: { summary: '', artifacts: [], commits: ['b27e4c9f00'], changedFiles: [], branch: null }
    })
  ]
})

describe('checkpoint gate (1)', () => {
  it('blocks advancing while gate conditions are unmet and offers retries for failed required tickets', () => {
    expect(gateView({ checkpoint: checkpointView(), run: FAILED_RUN, bundle: bundle() })).toEqual({
      title: "Sprint 3 can't start yet",
      conditions: checkpointView().conditions.filter((item) => item.id !== 'approval'),
      approveLabel: 'Approve & advance to Sprint 3',
      approveEnabled: false,
      blockedNote: "Blocked by 2 gate conditions. Retry DM-202 or edit the plan so it's no longer required.",
      retries: [{ ticketId: 'tk_202', label: 'Retry DM-202' }],
      autoContinue: {
        checked: false,
        available: true,
        note:
          'Sprints whose checkpoint policy is "auto" advance on their own once every gate is met. Human-gated sprints still wait for you. Applies to this run only; imported runs never carry it.'
      }
    })
  })

  it('is ready to advance when every gate is met', () => {
    const met = checkpointView({ gatesMet: true, conditions: [condition('report_submitted', true), condition('approval', false)] })
    const view = gateView({ checkpoint: met, run: runView({ state: 'awaiting_checkpoint', autoContinue: true }), bundle: bundle() })
    expect(view).toMatchObject({
      title: 'Ready to advance to Sprint 3',
      approveEnabled: true,
      blockedNote: null,
      retries: [],
      autoContinue: { checked: true, available: true }
    })
  })

  it('needs a report before approving and names the final sprint differently', () => {
    const noReport = checkpointView({ gatesMet: true, report: null })
    expect(gateView({ checkpoint: noReport, run: FAILED_RUN, bundle: null }).approveEnabled).toBe(false)
    const final = checkpointView({ isFinalSprint: true, sprintOrdinal: 3, gatesMet: true })
    expect(gateView({ checkpoint: final, run: FAILED_RUN, bundle: null })).toMatchObject({
      title: 'Ready to complete the epic',
      approveLabel: 'Approve & complete epic'
    })
    const blocked = checkpointView({ isFinalSprint: true, sprintOrdinal: 3 })
    expect(gateView({ checkpoint: blocked, run: runView(), bundle: null }).title).toBe("The epic can't complete yet")
  })
})

describe('checkpoint gate (2)', () => {
  it('skips optional tickets, words several retries and hides auto-continue for imported runs', () => {
    const tickets = [
      execution('DM-202', 'sp_2', 'failed'),
      execution('DM-201', 'sp_2', 'failed'),
      execution('DM-203', 'sp_2', 'failed'),
      execution('DM-301', 'sp_3', 'failed')
    ]
    const withOptional = bundle({
      tickets: bundle().tickets.map((item) => (item.id === 'tk_203' ? { ...item, optional: true } : item))
    })
    const run = runView({ tickets, ownedByThisMachine: false })
    const one = checkpointView({ conditions: [condition('required_accepted', false)] })
    const view = gateView({ checkpoint: one, run, bundle: withOptional })
    expect(view.retries.map((item) => item.label)).toEqual(['Retry DM-202', 'Retry DM-201'])
    expect(view.blockedNote).toBe(
      "Blocked by 1 gate condition. Retry DM-202 or DM-201 or edit the plan so they're no longer required."
    )
    expect(view.autoContinue.available).toBe(false)
    const quiet = gateView({ checkpoint: one, run: runView({ tickets: [] }), bundle: null })
    expect(quiet.blockedNote).toBe('Blocked by 1 gate condition.')
    expect(gateView({ checkpoint: one, run: runView({ state: 'completed' }), bundle: null }).autoContinue.available).toBe(false)
  })
})

describe('sprint report (1)', () => {
  it('builds the header, accepted and failed rows, checks and follow-ups', () => {
    const view = reportView(reportFixture(), { run: FAILED_RUN, bundle: bundle(), now: NOW })
    expect(view.header).toBe('SPRINT 2 REPORT · AUTHORING THROUGH MCP · WRITTEN BY SPRINT REPORTER 12M AGO')
    expect(view.summary).toBe('Authoring works end to end. **Import** is still flaky.')
    expect(view.accepted).toEqual([
      { ticketId: 'tk_203', key: 'DM-203', title: 'Folder registry & picker', detail: 'b27e4c9' },
      { ticketId: 'tk_201', key: 'DM-201', title: 'MCP authoring tools', detail: '' }
    ])
    expect(view.failed).toEqual([
      {
        ticketId: 'tk_202',
        key: 'DM-202',
        title: 'Transactional bundle import',
        detail: 'attempt 2 of 2 · codesign: no identity found · retry limit reached'
      }
    ])
    expect(view.checks).toEqual([
      { name: 'Typecheck', status: 'passed', detail: '0 errors', icon: '✓' },
      { name: 'Package · macos-latest', status: 'failed', detail: 'exit 1', icon: '✗' },
      { name: 'Docs', status: 'skipped', detail: 'n/a', icon: '–' }
    ])
    expect(view.risks).toEqual(['macOS signing is unverified'])
    expect(view.followUps.map((item) => item.title)).toEqual(['Provide a signing identity', 'Re-run driver load test'])
    expect(view.outcome).toBe(null)
  })
})

describe('sprint report (2)', () => {
  it('maps exit criteria and the epic outcome to their text', () => {
    const plan = bundle({
      sprints: [sprint(1, 'One', []), sprint(2, '', ['tk_202'], { exitCriteria: [{ id: 'x1', text: 'Driver loads everywhere' }] })]
    })
    const report = reportFixture({
      submittedBy: null,
      report: {
        ...reportFixture().report,
        accepted: ['DM-999'],
        failed: [],
        epicOutcome: { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: 'ok' }, { criterionId: 'zz', met: false, note: '' }] }
      }
    })
    const view = reportView(report, { run: runView({ tickets: [], attempts: [] }), bundle: plan, now: NOW + 60 * MINUTE })
    expect(view.header).toBe('SPRINT 2 REPORT · WRITTEN BY AN AGENT 1H 12M AGO')
    expect(view.accepted).toEqual([{ ticketId: null, key: 'DM-999', title: '', detail: '' }])
    expect(view.exitCriteria).toEqual([{ text: 'Driver loads everywhere', met: false, note: 'macOS unverified' }])
    expect(view.outcome).toEqual({
      summary: 'Done',
      criteria: [
        { text: 'An agent saves a plan through MCP', met: true, note: 'ok' },
        { text: 'zz', met: false, note: '' }
      ]
    })
  })

  it('explains a failure by the latest failed or rejected attempt', () => {
    const run = runView({
      tickets: [execution('DM-201', 'sp_2', 'failed', { attemptCount: 2 })],
      attempts: [
        attempt('DM-201', 1, 'failed', { failure: { reason: 'flaky', details: '', retryable: true } }),
        attempt('DM-201', 2, 'rejected', {
          decision: { outcome: 'rejected', notes: '', reasons: ['Rollback is untested'], decidedBy: 'you' }
        })
      ]
    })
    const report = reportFixture({ report: { ...reportFixture().report, failed: ['DM-201'] } })
    expect(reportView(report, { run, bundle: bundle(), now: NOW }).failed).toEqual([
      { ticketId: 'tk_201', key: 'DM-201', title: 'MCP authoring tools', detail: 'attempt 2 of 2 · Rollback is untested' }
    ])
  })

  it('describes failures without run details and without a bundle', () => {
    const view = reportView(reportFixture(), { run: runView({ tickets: [], attempts: [] }), bundle: null, now: NOW })
    expect(view.header).toBe('SPRINT ? REPORT · WRITTEN BY SPRINT REPORTER 12M AGO')
    expect(view.failed).toEqual([{ ticketId: null, key: 'tk_202', title: '', detail: '' }])
    expect(view.exitCriteria).toEqual([{ text: 'x1', met: false, note: 'macOS unverified' }])
  })
})

describe('report entries written as free text', () => {
  const context = { run: runView({ tickets: [], attempts: [] }), bundle: bundle(), now: NOW }
  const withEntries = (accepted: string[], failed: string[] = []): ReturnType<typeof reportView> =>
    reportView(reportFixture({ report: { ...reportFixture().report, accepted, failed } }), context)

  it('shows the leading ticket key in the key column and the rest of the entry as text', () => {
    expect(withEntries(['DM-203 Folder picker works: verified by hand', 'DM-201: MCP tools saved - 12 tests']).accepted).toEqual([
      { ticketId: 'tk_203', key: 'DM-203', title: 'Folder picker works: verified by hand', detail: '' },
      { ticketId: 'tk_201', key: 'DM-201', title: 'MCP tools saved - 12 tests', detail: '' }
    ])
  })

  it('keeps the key of a ticket the plan does not have, as unlinked', () => {
    expect(withEntries(['DM-999 Removed from the plan'], ['DM-998 Never started']).accepted).toEqual([
      { ticketId: null, key: 'DM-999', title: 'Removed from the plan', detail: '' }
    ])
    expect(withEntries([], ['DM-998 Never started']).failed).toEqual([{ ticketId: null, key: 'DM-998', title: 'Never started', detail: '' }])
  })

  it('leaves the key column empty when the entry does not start with a ticket key', () => {
    expect(withEntries(['Verified list_epics against the installed app', 'Rollback of DM-203 checked']).accepted).toEqual([
      { ticketId: null, key: '', title: 'Verified list_epics against the installed app', detail: '' },
      { ticketId: null, key: '', title: 'Rollback of DM-203 checked', detail: '' }
    ])
  })

  it('does not take a key-shaped prefix of a longer word for a ticket key', () => {
    expect(withEntries(['DM-203x is not a key']).accepted).toEqual([{ ticketId: null, key: '', title: 'DM-203x is not a key', detail: '' }])
  })

  it('looks up the run details of a failed ticket named at the start of a free-text entry', () => {
    const view = reportView(reportFixture({ report: { ...reportFixture().report, failed: ['DM-202 Import still flaky'] } }), {
      run: FAILED_RUN,
      bundle: bundle(),
      now: NOW
    })
    expect(view.failed).toEqual([
      {
        ticketId: 'tk_202',
        key: 'DM-202',
        title: 'Import still flaky',
        detail: 'attempt 2 of 2 · codesign: no identity found · retry limit reached'
      }
    ])
  })
})

const NO_RUN_CONTEXT = { run: runView({ tickets: [], attempts: [] }), bundle: bundle(), now: NOW }

describe('report blocked entries and outcome summary', () => {
  it('lists blocked entries like accepted ones: a plan ticket key links, other text stays unlinked', () => {
    const report = reportFixture({
      report: { ...reportFixture().report, blocked: ['DM-201 Waiting on signing key', 'Infrastructure unavailable'] }
    })
    expect(reportView(report, NO_RUN_CONTEXT).blocked).toEqual([
      { ticketId: 'tk_201', key: 'DM-201', title: 'Waiting on signing key', detail: '' },
      { ticketId: null, key: '', title: 'Infrastructure unavailable', detail: '' }
    ])
  })

  it('has no blocked rows when the report blocks nothing', () => {
    expect(reportView(reportFixture(), NO_RUN_CONTEXT).blocked).toEqual([])
  })

  it('includes the epic outcome summary next to its criteria', () => {
    const report = reportFixture({
      report: {
        ...reportFixture().report,
        epicOutcome: {
          summary: 'MCP authoring is ready for users.',
          successCriteria: [{ criterionId: 's1', met: true, note: 'verified' }]
        }
      }
    })
    const view = reportView(report, NO_RUN_CONTEXT)
    expect(view.outcome?.summary).toBe('MCP authoring is ready for users.')
    expect(view.outcome?.criteria).toEqual([{ text: 'An agent saves a plan through MCP', met: true, note: 'verified' }])
  })
})

describe('report changes', () => {
  const changesOf = (files: string[], commits: string[]): ReturnType<typeof reportView>['changes'] =>
    reportView(reportFixture({ report: { ...reportFixture().report, changes: { files, commits } } }), NO_RUN_CONTEXT).changes

  it('keeps the changed files as written', () => {
    expect(changesOf(['src/mcp/tools.ts', 'src/core/services/plans.ts'], []).files).toEqual(['src/mcp/tools.ts', 'src/core/services/plans.ts'])
  })

  it('shortens a full 40-character commit hash to 7 characters', () => {
    expect(changesOf([], ['f8de0e6dd12345ef0123456789abcdef01234567', 'a1b2c3d4e5f6a7b8']).commits).toEqual(['f8de0e6', 'a1b2c3d'])
  })

  it('shortens the hash and keeps the text that follows it', () => {
    expect(
      changesOf([], ['f8de0e6dd12345ef0123456789abcdef01234567 (squash of 3)', 'a1b2c3d4e5f6 fix the importer']).commits
    ).toEqual(['f8de0e6 (squash of 3)', 'a1b2c3d fix the importer'])
  })

  it('leaves anything that is not a leading hash as written', () => {
    const notHashes = ['deadbeefcafe-notes', 'Merge branch main', 'a1b2c3', 'a'.repeat(64), 'see f8de0e6dd12345']
    expect(changesOf([], notHashes).commits).toEqual(notHashes)
  })
})

describe('sprint report increment', () => {
  const withIncrement = (patch: Parameters<typeof incrementView>[0] = {}): ReturnType<typeof reportView> =>
    reportView(reportFixture({ increment: incrementView(patch) }), NO_RUN_CONTEXT)

  it('is absent when the sprint named no increment', () => {
    expect(reportView(reportFixture(), NO_RUN_CONTEXT).increment).toBe(null)
  })

  it('shows the commit as 7 characters with its branch, the commit it follows and the checks made', () => {
    expect(withIncrement().increment).toEqual({
      heading: 'INCREMENT · SPRINT 2',
      key: 'DM-290',
      commit: '5d3e1f0',
      fullCommit: '5d3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e',
      branch: 'epic/planning',
      passed: true,
      verdict: 'VERIFIED',
      base: "9f8e7d6 · previous sprint's increment",
      reasons: [],
      checks: [
        { name: 'One commit on the epic branch', status: 'passed', detail: 'epic/planning is at 5d3e1f0', icon: '✓' },
        { name: 'Parent is the previous increment', status: 'passed', detail: '9f8e7d6', icon: '✓' }
      ]
    })
  })

  it('says why an increment did not pass', () => {
    const base = incrementView().increment
    const view = withIncrement({
      increment: {
        ...base,
        passed: false,
        reasons: ['The commit has 2 parents; a sprint lands as one squashed commit.'],
        checks: [{ name: 'Single parent', status: 'failed', detail: '2 parents' }]
      }
    })
    expect(view.increment).toMatchObject({
      passed: false,
      verdict: 'NOT VERIFIED',
      reasons: ['The commit has 2 parents; a sprint lands as one squashed commit.'],
      checks: [{ name: 'Single parent', status: 'failed', detail: '2 parents', icon: '✗' }]
    })
  })

})

describe('sprint report increment base', () => {
  const withIncrement = (patch: Parameters<typeof incrementView>[0] = {}): ReturnType<typeof reportView> =>
    reportView(reportFixture({ increment: incrementView(patch) }), NO_RUN_CONTEXT)

  it('names what the commit had to follow: the previous increment, the epic start, or nothing yet', () => {
    const base = incrementView().increment
    const after = (kind: 'previous_increment' | 'epic_start' | 'none', commit: string | null): string | undefined =>
      withIncrement({ increment: { ...base, base: { kind, commit } } }).increment?.base
    expect(after('epic_start', '1234567890abcdef')).toBe('1234567 · epic start commit')
    expect(after('previous_increment', null)).toBe("the previous sprint's increment")
    expect(after('none', null)).toBe('no earlier increment or epic start commit to follow')
  })

  it('keeps a commit that git did not resolve exactly as the submission named it', () => {
    const base = incrementView().increment
    const view = withIncrement({ increment: { ...base, commit: 'not-a-commit', parent: null } })
    expect(view.increment).toMatchObject({ commit: 'not-a-commit', fullCommit: 'not-a-commit' })
  })
})

describe('follow-up proposals', () => {
  it('adds the proposal to the sprint after the checkpoint, else to the last sprint', () => {
    const proposal = { title: 'Provide a signing identity', body: 'Needs a person.' }
    expect(followUpOp(proposal, draftPlan().bundle, 2)).toEqual({
      sprintOrdinal: 3,
      op: { op: 'add_ticket', sprint: 'sp_3', ticket: { title: 'Provide a signing identity', body: 'Needs a person.' } }
    })
    expect(followUpOp(proposal, draftPlan().bundle, 3)?.sprintOrdinal).toBe(3)
    const reversed = { ...draftPlan().bundle, sprints: [...draftPlan().bundle.sprints].reverse() }
    expect(followUpOp(proposal, reversed, 3)?.sprintOrdinal).toBe(3)
    expect(followUpOp(proposal, { ...draftPlan().bundle, sprints: [] }, 1)).toBe(null)
  })
})
