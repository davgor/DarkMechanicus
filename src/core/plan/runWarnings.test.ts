/**
 * Warnings a draft earns while a run is executing the plan: editing a sprint the run has already passed,
 * and inserting a sprint before the one it is on. Both are warnings, never errors: the person decides.
 */
import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, sid, tid } from '../../test/bundles'
import { applyDraftOps } from './draftOps'
import { maxKeyNumber } from './normalize'
import { runAwareWarnings } from './runWarnings'

/** Sprint 1 {DM-1, DM-2}, sprint 2 {DM-3, DM-4}, sprint 3 {DM-5, DM-6}; the run is on sprint 2 (run #4). */
function planned(): PlanBundle {
  return makeBundle([[1, 2], [3, 4], [5, 6]])
}

function warningsFor(draft: PlanBundle, options: { run?: PlanBundle; active?: number } = {}): ReturnType<typeof runAwareWarnings> {
  const run = options.run ?? planned()
  return runAwareWarnings(draft, { number: 4, activeSprintId: sid(options.active ?? 2), bundle: run })
}

/** The run's plan with `ops` applied: what a draft looks like after those edits. */
function drafted(...ops: DraftOp[]): PlanBundle {
  const bundle = planned()
  let key = maxKeyNumber(bundle.tickets.map((ticket) => ticket.key))
  let counter = 0
  const deps = {
    newId: (kind: 'ticket' | 'sprint') => `${kind === 'ticket' ? 'tk' : 'sp'}_new${(counter += 1)}`,
    nextKey: () => `DM-${(key += 1)}`
  }
  return applyDraftOps(bundle, ops, deps).bundle
}

function retitle(bundle: PlanBundle, ticketNumber: number): PlanBundle {
  return {
    ...bundle,
    tickets: bundle.tickets.map((ticket) => (ticket.id === tid(ticketNumber) ? { ...ticket, title: `${ticket.title} (revised)` } : ticket))
  }
}

describe('a draft that matches the run', () => {
  it('has no run warnings', () => {
    expect(warningsFor(planned())).toEqual([])
  })

  it('has none for an edit to the active sprint, to a later sprint, or an added sprint at the end', () => {
    const edited = drafted(
      { op: 'update_ticket', ticket: 'DM-3', patch: { title: 'Active, revised' } },
      { op: 'update_ticket', ticket: 'DM-5', patch: { title: 'Later, revised' } },
      { op: 'update_sprint', sprint: '2', patch: { goal: 'A better goal' } },
      { op: 'add_ticket', sprint: '3', ticket: { title: 'New later work' } },
      { op: 'add_sprint', sprint: { goal: 'After it all' } }
    )
    expect(warningsFor(edited)).toEqual([])
  })
})

describe('editing a sprint the run has already passed', () => {
  it('warns when a ticket of a passed sprint changes, naming the sprint, the run and the ticket', () => {
    const [warning, ...rest] = warningsFor(retitle(planned(), 2))
    expect(rest).toEqual([])
    expect(warning).toMatchObject({ code: 'edits_passed_sprint', sprintIds: [sid(1)], ticketIds: [tid(2)] })
    expect(warning?.message).toContain('Sprint 1')
    expect(warning?.message).toContain('run #4')
    expect(warning?.message).toContain('DM-2')
  })

  it('warns when a ticket is added to a passed sprint', () => {
    const [warning] = warningsFor(drafted({ op: 'add_ticket', sprint: '1', ticket: { title: 'Late addition' } }))
    expect(warning).toMatchObject({ code: 'edits_passed_sprint', sprintIds: [sid(1)], ticketIds: ['tk_new1'] })
    expect(warning?.message).toContain('DM-7 added')
  })

  it('warns when a ticket is removed from a passed sprint', () => {
    const [warning] = warningsFor(drafted({ op: 'remove_ticket', ticket: 'DM-1' }))
    expect(warning).toMatchObject({ code: 'edits_passed_sprint', sprintIds: [sid(1)], ticketIds: [tid(1)] })
    expect(warning?.message).toContain('DM-1 removed')
  })

  it('warns when a ticket moves out of a passed sprint', () => {
    const [warning] = warningsFor(drafted({ op: 'move_ticket', ticket: 'DM-1', toSprint: '3' }))
    expect(warning).toMatchObject({ code: 'edits_passed_sprint', sprintIds: [sid(1)], ticketIds: [tid(1)] })
    expect(warning?.message).toContain('DM-1 moved')
  })

  it('warns when the sprint itself changes', () => {
    const [warning] = warningsFor(drafted({ op: 'update_sprint', sprint: '1', patch: { goal: 'A new goal' } }))
    expect(warning).toMatchObject({ code: 'edits_passed_sprint', sprintIds: [sid(1)] })
    expect(warning?.ticketIds).toBeUndefined()
    expect(warning?.message).toContain('sprint settings changed')
  })

  it('warns when a ticket of a passed sprint gains a prerequisite, but not when a later ticket does', () => {
    expect(warningsFor(drafted({ op: 'add_dependency', from: 'DM-1', to: 'DM-2' }))).toMatchObject([
      { code: 'edits_passed_sprint', sprintIds: [sid(1)], ticketIds: [tid(2)] }
    ])
    expect(warningsFor(drafted({ op: 'add_dependency', from: 'DM-1', to: 'DM-5' }))).toEqual([])
  })

})

describe('editing several passed sprints, or removing one', () => {
  it('warns once for each passed sprint that changed, in sprint order', () => {
    const edited = retitle(retitle(planned(), 4), 1)
    const warnings = warningsFor(edited, { active: 3 })
    expect(warnings.map((warning) => [warning.code, warning.sprintIds])).toEqual([
      ['edits_passed_sprint', [sid(1)]],
      ['edits_passed_sprint', [sid(2)]]
    ])
  })

  it('warns when a passed sprint is removed from the draft', () => {
    const draft = drafted({ op: 'remove_ticket', ticket: 'DM-1' }, { op: 'remove_ticket', ticket: 'DM-2' }, { op: 'remove_sprint', sprint: '1' })
    const warnings = warningsFor(draft)
    expect(warnings.map((warning) => warning.code)).toEqual(['edits_passed_sprint'])
    expect(warnings[0]?.sprintIds).toEqual([sid(1)])
    expect(warnings[0]?.message).toContain('removed')
  })
})

describe('inserting a sprint before the active one', () => {
  it('warns about a sprint inserted before the active sprint, and not about the passed sprints it renumbers', () => {
    const draft = drafted({ op: 'add_sprint', sprint: { goal: 'Squeezed in' }, position: 2 })
    const warnings = warningsFor(draft)
    expect(warnings).toMatchObject([{ code: 'sprint_before_active', sprintIds: ['sp_new1'] }])
    expect(warnings[0]?.message).toContain('Sprint 2')
    expect(warnings[0]?.message).toContain('run #4')
  })

  it('warns about a sprint inserted ahead of every passed sprint', () => {
    const warnings = warningsFor(drafted({ op: 'add_sprint', sprint: { goal: 'First of all' }, position: 1 }))
    expect(warnings.map((warning) => warning.code)).toEqual(['sprint_before_active'])
  })

  it('warns about a sprint inserted when nothing has been passed yet', () => {
    const warnings = warningsFor(drafted({ op: 'add_sprint', sprint: { goal: 'First of all' }, position: 1 }), { active: 1 })
    expect(warnings.map((warning) => warning.code)).toEqual(['sprint_before_active'])
  })

  it('does not warn about a sprint inserted right after the active sprint', () => {
    expect(warningsFor(drafted({ op: 'add_sprint', sprint: { goal: 'Next' }, position: 3 }))).toEqual([])
  })

  it('does not take the automatic title of a renumbered acceptance node for an edit', () => {
    const nodeOf = new Map([[tid(1), 1], [tid(3), 2], [tid(5), 3]])
    const run = planned()
    run.tickets = run.tickets.map((ticket) => {
      const ordinal = nodeOf.get(ticket.id)
      return ordinal === undefined ? ticket : { ...ticket, kind: 'acceptance' as const, title: `Sprint ${ordinal} acceptance` }
    })
    const draft = applyDraftOps(
      run,
      [{ op: 'add_sprint', sprint: { goal: 'Squeezed in' }, position: 1 }],
      { newId: (kind) => `${kind === 'ticket' ? 'tk' : 'sp'}_new1`, nextKey: () => 'DM-90' }
    ).bundle
    expect(draft.tickets.find((ticket) => ticket.id === tid(1))?.title).toBe('Sprint 2 acceptance')
    expect(warningsFor(draft, { run }).map((warning) => warning.code)).toEqual(['sprint_before_active'])
  })

  it('reads the active position from the run when the draft no longer has the active sprint', () => {
    const draft = drafted(
      { op: 'add_sprint', sprint: { goal: 'Squeezed in' }, position: 2 },
      { op: 'move_ticket', ticket: 'DM-3', toSprint: '4' },
      { op: 'move_ticket', ticket: 'DM-4', toSprint: '4' },
      { op: 'remove_sprint', sprint: sid(2) }
    )
    expect(warningsFor(draft).map((warning) => warning.code)).toEqual(['sprint_before_active'])
  })
})

describe('both kinds together', () => {
  it('reports the edit and the insertion', () => {
    const draft = drafted(
      { op: 'update_ticket', ticket: 'DM-1', patch: { title: 'Changed' } },
      { op: 'add_sprint', sprint: { goal: 'Squeezed in' }, position: 2 }
    )
    expect(warningsFor(draft).map((warning) => warning.code).sort()).toEqual(['edits_passed_sprint', 'sprint_before_active'])
  })
})
