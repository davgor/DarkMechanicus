/** Validation rules for ticket repositories: each work ticket of a folder of repositories targets one it lists. */
import { describe, expect, it } from 'vitest'
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type { RepositoryEntry } from '../repo/portable'
import { makeBundle, makeTicket, tid } from '../../test/bundles'
import { validatePlan } from './graph'

const TWO_REPOS: RepositoryEntry[] = [{ name: 'api' }, { name: 'web' }]

/** Sprint 1: work 1 in `api`, work 2 in `web`, acceptance 3 covering both. */
function twoRepoPlan(): PlanBundle {
  const plan = makeBundle([[1, 2, 3]])
  plan.tickets = [
    makeTicket(1, { repo: 'api', title: 'api - Ticket 1' }),
    makeTicket(2, { repo: 'web', title: 'web - Ticket 2' }),
    makeTicket(3, {
      kind: 'acceptance',
      acceptanceCriteria: [
        { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
        { id: 'c2', text: 'DM-2 verified', covers: tid(2) }
      ]
    })
  ]
  return plan
}

/** `twoRepoPlan` with ticket `n` replaced by the given overrides. */
function planWith(n: number, overrides: Partial<TicketContent>): PlanBundle {
  const plan = twoRepoPlan()
  plan.tickets = plan.tickets.map((ticket) => (ticket.id === tid(n) ? { ...ticket, ...overrides } : ticket))
  return plan
}

describe('validatePlan ticket repositories', () => {
  it('accepts a two-repository plan whose work tickets each target a listed repository', () => {
    expect(validatePlan(twoRepoPlan(), { repositories: TWO_REPOS })).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it('accepts a single-repository plan without repo exactly as without options', () => {
    const plan = makeBundle([[1, 2]], [[1, 2]])
    expect(validatePlan(plan, { repositories: null })).toEqual(validatePlan(plan))
    expect(validatePlan(plan, { repositories: null }).valid).toBe(true)
  })

  it('reports a work ticket without a repository in a folder of repositories as missing_repo', () => {
    const plan = planWith(1, { repo: undefined, title: 'Ticket 1' })
    expect(validatePlan(plan, { repositories: TWO_REPOS }).errors).toEqual([
      {
        code: 'missing_repo',
        message: "DM-1 needs a repository; this folder's repositories: api, web.",
        ticketIds: [tid(1)]
      }
    ])
  })

  it('reports a repository the project does not list as unknown_repo', () => {
    const report = validatePlan(planWith(2, { repo: 'docs' }), { repositories: TWO_REPOS })
    expect(report.valid).toBe(false)
    expect(report.errors).toEqual([
      {
        code: 'unknown_repo',
        message: 'DM-2 targets the repository "docs", which this project does not list.',
        ticketIds: [tid(2)]
      }
    ])
  })

})

describe('validatePlan repositories that are not allowed or missing on disk', () => {
  it('reports repo on a ticket of a single-repository project as repo_not_allowed', () => {
    const plan = makeBundle([[1]])
    plan.tickets = [makeTicket(1, { repo: 'api' })]
    expect(validatePlan(plan, { repositories: null }).errors).toEqual([
      {
        code: 'repo_not_allowed',
        message: 'This project is a single repository: DM-1 can\'t target the repository "api".',
        ticketIds: [tid(1)]
      }
    ])
  })

  it('reports repo on an acceptance node as repo_not_allowed', () => {
    expect(validatePlan(planWith(3, { repo: 'api' }), { repositories: TWO_REPOS }).errors).toEqual([
      {
        code: 'repo_not_allowed',
        message: 'DM-3 is an acceptance node and can\'t target the repository "api".',
        ticketIds: [tid(3)]
      }
    ])
  })

  it('warns about a ticket whose repository a rescan marked missing, without blocking', () => {
    const report = validatePlan(twoRepoPlan(), { repositories: [{ name: 'api' }, { name: 'web', missing: true }] })
    expect(report).toEqual({
      valid: true,
      errors: [],
      warnings: [
        {
          code: 'repo_missing_on_disk',
          message: 'DM-2 targets the repository "web", which a rescan marked missing.',
          ticketIds: [tid(2)]
        }
      ]
    })
  })

  it('skips the repository check without options', () => {
    expect(validatePlan(planWith(1, { repo: undefined })).errors).toEqual([])
  })
})
