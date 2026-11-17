// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import type { TicketBudget } from '../../../shared/domain/bundle'
import type { PlannedBaselinesView, TicketPlannedBaselinesView } from '../../../shared/domain/metrics'
import type { SetTicketBudgetResultView } from '../../../shared/domain/scoreReads'
import { bindRunner } from '../epic/runner'
import type { Result } from '../epic/workspaceActions'
import { localTime } from '../scorecard/scorecardFormat'
import { BudgetFields, type BudgetFieldsProps } from './BudgetFields'

let dm: FakeDm
let setCalls: (TicketBudget | null)[]
let answer: Result<SetTicketBudgetResultView>

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  setCalls = []
  answer = { ok: true, value: { epicId: 'ep_1', draftRevision: 5, ticket: null, appliesTo: 'next_dispatch' } }
})

afterEach(cleanup)

function ticketView(dispatchedAt: string | null): TicketPlannedBaselinesView {
  return {
    ticketId: 'tk_1',
    key: 'DM-7',
    title: 'Checkout',
    dispatchedAt,
    pinnedRevisionId: 'rv_1',
    budgets: [
      {
        metric: 'tokens',
        unit: 'tokens',
        state: dispatchedAt === null ? 'planned' : 'frozen',
        applied: null,
        draft: null,
        versions: [
          { baselineId: 'bl_1', metric: 'tokens', unit: 'tokens', version: 1, value: 4000, basis: 'prior_tickets', revisionId: 'rv_1', revisionNumber: 2, frozenAt: '2026-03-01T10:00:00.000Z', status: 'pinned' },
          { baselineId: 'bl_2', metric: 'tokens', unit: 'tokens', version: 2, value: 6000, basis: 'planner_estimate', revisionId: 'rv_2', revisionNumber: 3, frozenAt: '2026-03-02T10:00:00.000Z', status: 'prospective' }
        ]
      }
    ]
  }
}

function baselines(ticket: TicketPlannedBaselinesView): PlannedBaselinesView {
  return { epicId: 'ep_1', runId: 'rn_1', currentRevisionId: 'rv_2', runRevisionId: 'rv_1', tickets: [ticket] }
}

function fields(overrides: Partial<BudgetFieldsProps> = {}): JSX.Element {
  return (
    <BudgetFields
      runner={bindRunner('/repo')}
      epicId="ep_1"
      ticketId="tk_1"
      runId="rn_1"
      runEnded={false}
      draftBudget={undefined}
      draftRevision={4}
      busy={false}
      setBudget={(budget) => {
        setCalls.push(budget)
        return Promise.resolve(answer)
      }}
      {...overrides}
    />
  )
}

const input = (name: RegExp): HTMLInputElement => screen.getByRole('textbox', { name }) as HTMLInputElement
const setButton = (): HTMLElement => screen.getByRole('button', { name: 'Set budget in draft' })

describe('DM-183 c3: token and time estimates with units and provenance', () => {
  it('sets tokens, minutes as milliseconds and the basis in the draft', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields())
    fireEvent.change(input(/^Tokens/), { target: { value: '12000' } })
    fireEvent.change(input(/^Active time/), { target: { value: '90' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Where the numbers come from' }), { target: { value: 'person_estimate' } })
    fireEvent.click(setButton())
    await settle()
    expect(setCalls).toEqual([{ tokens: 12_000, activeMs: 5_400_000, basis: 'person_estimate' }])
    expect(screen.getByRole('status').textContent).toBe('Set in the draft: 12,000 tokens and 1 h 30 min active · A person’s estimate. It is frozen when the plan is saved, and applies from the ticket’s next dispatch.')
  })

  it('refuses a basis with both amounts blank', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields())
    await settle()
    fireEvent.change(screen.getByRole('combobox', { name: 'Where the numbers come from' }), { target: { value: 'planner_estimate' } })
    expect(screen.getByText('A basis needs an amount: enter tokens, minutes or both, or set the basis to Not stated.')).toBeTruthy()
    expect(setButton()).toHaveProperty('disabled', true)
  })

  it('a never-saved epic says the budget becomes the first version on save', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields())
    await settle()
    expect(screen.getByText('No saved version yet: the budget becomes this ticket\'s first version when the plan is saved.')).toBeTruthy()
  })

  it('a failed versions read is said, not shown as no versions', async () => {
    dm.failures.getPlannedBaselines = { code: 'busy', message: 'Store busy.' }
    render(fields())
    await settle()
    expect(screen.getByText('Could not read the saved budget versions: Store busy.')).toBeTruthy()
  })
})

describe('DM-183 c3: entries kept through conflicts and moved drafts', () => {
  it('a conflict keeps the typed entry to set again', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    answer = { ok: false, failure: { code: 'conflict', message: 'stale' } }
    render(fields())
    fireEvent.change(input(/^Tokens/), { target: { value: '300' } })
    fireEvent.click(setButton())
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('The draft changed while you were editing, so nothing was set. Your entry is kept below; check it against the draft’s budget and set it again.')
    expect(input(/^Tokens/).value).toBe('300')
  })

  it('a draft budget that moved under an open edit is shown, the edit kept', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    const view = render(fields({ draftBudget: { tokens: 100 } }))
    fireEvent.change(input(/^Tokens/), { target: { value: '250' } })
    view.rerender(fields({ draftBudget: { tokens: 900 }, draftRevision: 5 }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe("The draft's budget changed meanwhile (now 900 tokens · basis not stated). Your entry is kept: set it to replace that, or discard it.")
    expect(input(/^Tokens/).value).toBe('250')
  })
})

describe('DM-183 c3: frozen at dispatch, later changes only prospective', () => {
  it('lists each saved version with where it stands', async () => {
    dm.responses.getPlannedBaselines = baselines(ticketView('2026-03-01T12:00:00.000Z'))
    render(fields())
    await settle()
    const items = within(screen.getByRole('list', { name: 'Saved budget versions' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      `v1 · 4,000 tokens · Similar earlier tickets · saved in revision 2 at ${localTime('2026-03-01T10:00:00.000Z')} · frozen at this run’s dispatch: the one its grade uses`,
      `v2 · 6,000 tokens · The planner’s estimate · saved in revision 3 at ${localTime('2026-03-02T10:00:00.000Z')} · prospective: applies only to later dispatches, never to a grade already read`
    ])
    expect(dm.callsOf('getPlannedBaselines').map((call) => call.input)).toEqual([{ epicId: 'ep_1', runId: 'rn_1' }])
  })

  it('a ticket dispatched in a finished run says a change is prospective for a later run', async () => {
    dm.responses.getPlannedBaselines = baselines(ticketView('2026-03-01T12:00:00.000Z'))
    render(fields({ runEnded: true }))
    await settle()
    expect(
      screen.getByText('Dispatched in this finished run: its budget was frozen at that dispatch. A change you save now is a new, prospective version for a later run.')
    ).toBeTruthy()
  })
})

describe('DM-183 c3: dispatch notes and where a set budget applies', () => {
  it('dispatched and not yet dispatched in a running run, and not dispatched in a finished one', async () => {
    dm.responses.getPlannedBaselines = baselines(ticketView('2026-03-01T12:00:00.000Z'))
    render(fields())
    await settle()
    expect(screen.getByText('Already dispatched in this run: its budget was frozen at dispatch. A change you save now is a new, prospective version.')).toBeTruthy()
    cleanup()
    dm.responses.getPlannedBaselines = baselines(ticketView(null))
    render(fields())
    await settle()
    expect(screen.getByText('Not dispatched in this run yet: the version in effect at its dispatch is frozen then.')).toBeTruthy()
    cleanup()
    render(fields({ runEnded: true }))
    await settle()
    expect(screen.getByText('Not dispatched in this finished run: a later run freezes the version in effect at its dispatch.')).toBeTruthy()
  })

  it('setting a budget on a dispatched ticket says it applies only to later dispatches', async () => {
    dm.responses.getPlannedBaselines = baselines(ticketView('2026-03-01T12:00:00.000Z'))
    answer = { ok: true, value: { epicId: 'ep_1', draftRevision: 5, ticket: ticketView('2026-03-01T12:00:00.000Z'), appliesTo: 'later_dispatches' } }
    render(fields({ draftBudget: { tokens: 4000, basis: 'prior_tickets' } }))
    await settle()
    fireEvent.change(input(/^Tokens/), { target: { value: '7000' } })
    fireEvent.click(setButton())
    await settle()
    expect(screen.getByRole('status').textContent).toBe(
      'Set in the draft: 7,000 tokens · Similar earlier tickets. This ticket was already dispatched: its frozen budget stays, and once saved this applies only to later dispatches.'
    )
  })

  it('a run without a run id reads versions for the epic only', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields({ runId: null }))
    await settle()
    expect(dm.callsOf('getPlannedBaselines').map((call) => call.input)).toEqual([{ epicId: 'ep_1' }])
  })
})

describe('DM-183 c3 review fix: a stored non-round time budget', () => {
  it('shows 100000 ms rounded and sends back exactly 100000 ms when untouched', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields({ draftBudget: { activeMs: 100_000, basis: 'planner_estimate' } }))
    expect(input(/^Active time/).value).toBe('1.66667')
    fireEvent.change(screen.getByRole('combobox', { name: 'Where the numbers come from' }), { target: { value: 'prior_tickets' } })
    fireEvent.click(setButton())
    await settle()
    expect(setCalls).toEqual([{ activeMs: 100_000, basis: 'prior_tickets' }])
  })
})

describe('DM-183 c3 review fix: the duration hint follows the strict parser', () => {
  it.each(['1e2', '-', '1e-9', '0'])('shows no duration for refused text %j', (text) => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields())
    fireEvent.change(input(/^Active time/), { target: { value: text } })
    expect(screen.queryByText(/^= /)).toBeNull()
  })

  it('shows the duration for accepted minutes', () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields())
    fireEvent.change(input(/^Active time/), { target: { value: '2.5' } })
    expect(screen.getByText('= 2 min 30 s')).toBeTruthy()
  })
})

describe('discarding, clearing and versions the read does not hold', () => {
  it('a refused set shows the core\'s reason, and Discard drops the entry and the message', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    answer = { ok: false, failure: { code: 'busy', message: 'Store busy.' } }
    render(fields({ draftBudget: { tokens: 100 } }))
    fireEvent.change(input(/^Tokens/), { target: { value: '250' } })
    fireEvent.click(setButton())
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Store busy.')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(input(/^Tokens/).value).toBe('100')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true)
  })

  it('Clear budget sets no budget in the draft and says so', async () => {
    dm.failures.getPlannedBaselines = { code: 'not_found', message: 'Never saved.' }
    render(fields({ draftBudget: { tokens: 100 } }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Clear budget' }))
    await settle()
    expect(setCalls).toEqual([null])
    expect(screen.getByRole('status').textContent).toBe('Budget cleared in the draft. It is frozen when the plan is saved, and applies from the ticket’s next dispatch.')
    expect(input(/^Tokens/).value).toBe('')
  })

  it('a read that holds no entry for this ticket reads as never saved', async () => {
    dm.responses.getPlannedBaselines = baselines({ ...ticketView(null), ticketId: 'tk_other' })
    render(fields())
    await settle()
    expect(screen.getByText('No saved version yet: the budget becomes this ticket\'s first version when the plan is saved.')).toBeTruthy()
  })

  it('a saved ticket with no budget version says so beside its dispatch note', async () => {
    dm.responses.getPlannedBaselines = baselines({ ...ticketView(null), budgets: [] })
    render(fields())
    await settle()
    expect(screen.getByText('No budget version saved.')).toBeTruthy()
    expect(within(screen.getByRole('list', { name: 'Saved budget versions' })).queryAllByRole('listitem')).toEqual([])
  })
})
