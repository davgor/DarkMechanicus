// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DmApi } from '../../../shared/desktop/api'
import type { PlanBundle } from '../../../shared/domain/bundle'
import {
  NOW,
  attempt,
  bundle,
  checkpointView,
  condition,
  draftPlan,
  execution,
  reportView,
  reportWithRetro,
  retroView,
  runView,
  ticket
} from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import { CheckpointScreen, type CheckpointScreenProps } from './CheckpointScreen'
import type { NextSprintItem } from './gateView'
import type { RedraftRefusal } from './redraftView'

allowSlowRendering()

const opened: string[] = []

beforeEach(() => {
  opened.length = 0
  window.dm = {
    openExternal: (url: string) => {
      opened.push(url)
      return Promise.resolve(true)
    }
  } as Pick<DmApi, 'openExternal'> as DmApi
})

afterEach(() => {
  cleanup()
})

interface Recorded {
  approved: string[]
  followUps: NextSprintItem[]
  redrafts: { reportId: string; revision: number }[]
  selected: string[]
}

const RUN = runView({ state: 'awaiting_checkpoint', tickets: [execution('DM-202', 'sp_2', 'failed', { attemptCount: 2 })] })

/** Every gate met except the plan: a draft holds changes the saved plan lacks. */
const REDRAFT_CHECKPOINT = checkpointView({
  report: reportWithRetro(),
  gatesMet: false,
  conditions: [
    condition('report_submitted', true, 'Required by checkpoint policy'),
    condition('retro', true, 'The report includes a retro'),
    condition('plan_current', false, 'The draft has changes the saved plan lacks: save it and adopt the new revision, or discard the draft')
  ]
})

function screenFor(recorded: Recorded, patch: Partial<CheckpointScreenProps>, refusal: RedraftRefusal | null): JSX.Element {
  return (
    <CheckpointScreen
      checkpoint={checkpointView({ report: reportWithRetro() })}
      run={RUN}
      bundle={bundle()}
      draft={null}
      now={NOW}
      busy={false}
      onApprove={(id) => recorded.approved.push(id)}
      onApproveWithRedraft={(reportId, revision) => {
        recorded.redrafts.push({ reportId, revision })
        return Promise.resolve(refusal)
      }}
      onRetry={() => undefined}
      onAutoContinue={() => undefined}
      onAddFollowUp={(item) => {
        recorded.followUps.push(item)
        return Promise.resolve(true)
      }}
      onEditDraft={() => undefined}
      onSelectTicket={(id) => recorded.selected.push(id)}
      {...patch}
    />
  )
}

function newRecorded(): Recorded {
  return { approved: [], followUps: [], redrafts: [], selected: [] }
}

function renderScreen(patch: Partial<CheckpointScreenProps> = {}, refusal: RedraftRefusal | null = null): Recorded {
  const recorded = newRecorded()
  render(screenFor(recorded, patch, refusal))
  return recorded
}

/** A refusal at the adopt step, after the save: the draft is saved but adoption is still needed. */
const REFUSAL: RedraftRefusal = {
  message: 'Approve with redraft stopped at step 2 of 5 (adopt): Run #2 has an open attempt. Nothing was approved or advanced.',
  step: 'adopt',
  stepNumber: 2,
  savedRevisionNumber: 5,
  adoptionNeeded: true
}

const textOf = (items: HTMLElement[]): string[] => items.map((item) => item.textContent ?? '')

describe('checkpoint sprint demo and retro', () => {
  it('reads as the demo, then the retro, then the tier fit, then what is next, ahead of the existing sections', () => {
    renderScreen()
    const sections = [...screen.getByLabelText('Sprint report').querySelectorAll('section[aria-label]')]
    expect(sections.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Delivered',
      'Went well',
      'Went poorly',
      'Actions',
      'Tier fit',
      'Discoveries',
      'Leftovers',
      'ACCEPTED',
      'FAILED',
      'Changes',
      'Checks',
      'EXIT CRITERIA',
      'Proposed follow-ups',
      'Risks'
    ])
  })

  it('shows each delivered item with its ticket, what to look at and its evidence links', () => {
    const recorded = renderScreen()
    const delivered = screen.getByLabelText('Delivered')
    expect(within(delivered).getByText('DELIVERED · 2').textContent).toBe('DELIVERED · 2')
    const rows = within(delivered).getAllByRole('listitem')
    expect(rows.length).toBe(2)
    const first = rows[0] as HTMLElement
    expect(within(first).getByText('Folder registry & picker')).toBeTruthy()
    expect(within(first).getByText('Settings').tagName).toBe('STRONG')
    expect(first.textContent).toContain('Open Settings and pick a folder.')
    expect(first.textContent).toContain('shots/dm-203/picker.png')
    fireEvent.click(within(first).getByRole('button', { name: 'DM-203' }))
    expect(recorded.selected).toEqual(['tk_203'])
    const link = within(first).getByRole('link', { name: 'https://example.test/pull/12' })
    fireEvent.click(link)
    expect(opened).toEqual(['https://example.test/pull/12'])
    expect(within(rows[1] as HTMLElement).queryAllByRole('link')).toEqual([])
    expect(within(rows[1] as HTMLElement).getByText('create_epic').tagName).toBe('CODE')
  })

})

describe('checkpoint sprint demo and retro (2)', () => {
  it('lists what went well, what went poorly and the actions for the next sprint', () => {
    renderScreen()
    const list = (label: string): string[] => textOf(within(screen.getByLabelText(label)).getAllByRole('listitem'))
    expect(list('Went well')).toEqual(['Row checks caught a bad merge early'])
    expect(list('Went poorly')).toEqual(['DM-202 needed a second attempt'])
    expect(list('Actions')).toEqual(['Run the replay test before submitting'])
    expect(within(screen.getByLabelText('Actions')).getByText('ACTIONS FOR THE NEXT SPRINT').tagName).toBe('H3')
  })

  it('sets what each ticket was planned at against the models and efforts it used, with attempts and the verdict', () => {
    renderScreen()
    const table = within(screen.getByLabelText('Tier fit')).getByRole('table')
    const [head, ...body] = within(table).getAllByRole('row')
    expect(textOf(within(head as HTMLElement).getAllByRole('columnheader'))).toEqual(['Ticket', 'Planned', 'Used', 'Attempts', 'Verdict'])
    expect(body.map((row) => textOf(within(row).getAllByRole('cell')))).toEqual([
      ['DM-201MCP authoring tools', 'No size · Multi-step · Low effort', '#1 Orchestrator (fallback) · accepted', '1 attempt', 'no verdict'],
      [
        'DM-202Transactional bundle import',
        'Medium · Multi-step · Medium effort',
        '#1 model-small · low effort · rejected#2 model-large · high effort · failed',
        '2 attempts · 1 rejected · escalated',
        'UndersizedNeeded the larger model on attempt 2'
      ],
      ['DM-203Folder registry & picker', 'Small · Routine · no effort set', '#1 model-small · accepted', '1 attempt', 'Right-sized']
    ])
  })

  it('shows the discoveries and the leftovers with the work they name', () => {
    const recorded = renderScreen()
    const discoveries = screen.getByLabelText('Discoveries')
    expect(within(discoveries).getByText('DISCOVERIES · 2').textContent).toBe('DISCOVERIES · 2')
    expect(textOf(within(discoveries).getAllByRole('listitem')).map((text) => text.replace('+ Add to next sprint', ''))).toEqual([
      'Cache the folder registryReads hit the disk on every poll.Came up on DM-203',
      'Document the idempotency key'
    ])
    fireEvent.click(within(discoveries).getByRole('button', { name: 'DM-203' }))
    const leftovers = screen.getByLabelText('Leftovers')
    expect(within(leftovers).getByText('LEFTOVERS · 1').textContent).toBe('LEFTOVERS · 1')
    expect(textOf(within(leftovers).getAllByRole('listitem')).map((text) => text.replace('Move to next sprint', ''))).toEqual([
      'DM-202Transactional bundle importThe replay test is still flaky after 2 attempts'
    ])
    fireEvent.click(within(leftovers).getByRole('button', { name: 'DM-202' }))
    expect(recorded.selected).toEqual(['tk_203', 'tk_202'])
  })

})

describe('checkpoint sprint demo and retro (3)', () => {
  it('shows none of it for a report written without a retro', () => {
    renderScreen({ checkpoint: checkpointView({ report: reportView() }) })
    for (const label of ['Delivered', 'Went well', 'Went poorly', 'Actions', 'Tier fit', 'Discoveries', 'Leftovers']) {
      expect(screen.queryByLabelText(label), label).toBeNull()
    }
    expect(screen.getByLabelText('ACCEPTED')).toBeTruthy()
  })

  it('leaves out the sections the retro has nothing for', () => {
    const retro = retroView({ delivered: [], wentWell: [], wentPoorly: [], actions: [], discoveries: [], leftovers: [], tierFit: [] })
    renderScreen({ checkpoint: checkpointView({ report: reportWithRetro(retro, { tierFacts: [] }) }) })
    const sections = [...screen.getByLabelText('Sprint report').querySelectorAll('section[aria-label]')]
    expect(sections.map((item) => item.getAttribute('aria-label'))).toEqual(
      ['ACCEPTED', 'FAILED', 'Changes', 'Checks', 'EXIT CRITERIA', 'Proposed follow-ups', 'Risks']
    )
  })
})

/** The draft with these tickets also in it, in the sprint after the checkpoint. */
function draftHolding(tickets: { id: string; key: string; title: string }[]): ReturnType<typeof draftPlan> {
  const base = draftPlan().bundle
  const next: PlanBundle = {
    ...base,
    tickets: [...base.tickets, ...tickets.filter((item) => !base.tickets.some((held) => held.id === item.id)).map((item) => ticket(item.key, item.title, { id: item.id }))],
    sprints: base.sprints.map((item) =>
      item.id === 'sp_3' ? { ...item, ticketIds: [...item.ticketIds, ...tickets.map((entry) => entry.id)] } : { ...item, ticketIds: item.ticketIds.filter((id) => !tickets.some((entry) => entry.id === id)) }
    )
  }
  return draftPlan({ bundle: next })
}

describe('discoveries and leftovers go to the next sprint', () => {
  it('offers + Add to next sprint on each discovery and Move to next sprint on each leftover', () => {
    const recorded = renderScreen()
    const discoveries = screen.getByLabelText('Discoveries')
    const adds = within(discoveries).getAllByRole('button', { name: '+ Add to next sprint' })
    expect(adds.length).toBe(2)
    fireEvent.click(adds[0] as HTMLElement)
    fireEvent.click(adds[1] as HTMLElement)
    fireEvent.click(within(screen.getByLabelText('Leftovers')).getByRole('button', { name: 'Move to next sprint' }))
    expect(recorded.followUps).toEqual([
      { kind: 'discovery', title: 'Cache the folder registry', body: 'Reads hit the disk on every poll.' },
      { kind: 'discovery', title: 'Document the idempotency key', body: '' },
      { kind: 'leftover', ticketId: 'tk_202' }
    ])
  })

  it('keeps the proposed follow-ups on their own + Add to draft', () => {
    renderScreen()
    expect(within(screen.getByLabelText('Proposed follow-ups')).getAllByRole('button', { name: '+ Add to draft' }).length).toBe(2)
  })

  it('shows where an item already is in the draft instead of offering it again', () => {
    const draft = draftHolding([
      { id: 'tk_202', key: 'DM-202', title: 'Transactional bundle import' },
      { id: 'tk_306', key: 'DM-306', title: 'Cache the folder registry' }
    ])
    renderScreen({ draft })
    const discoveries = screen.getByLabelText('Discoveries')
    expect(within(discoveries).getAllByRole('button', { name: '+ Add to next sprint' }).length).toBe(1)
    expect(within(discoveries).getByText('In Sprint 3 of the draft')).toBeTruthy()
    expect(within(screen.getByLabelText('Leftovers')).queryAllByRole('button', { name: 'Move to next sprint' })).toEqual([])
    expect(within(screen.getByLabelText('Leftovers')).getByText('In Sprint 3 of the draft')).toBeTruthy()
  })

  it('offers an item again while the draft does not hold it, and while the screen is busy it disables the buttons', () => {
    renderScreen({ draft: draftPlan({ changes: [] }), busy: true })
    const buttons = [
      ...within(screen.getByLabelText('Discoveries')).getAllByRole('button', { name: '+ Add to next sprint' }),
      ...within(screen.getByLabelText('Leftovers')).getAllByRole('button', { name: 'Move to next sprint' })
    ] as HTMLButtonElement[]
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, true])
  })

  it('says a leftover was accepted since the retro and does not offer to move it', () => {
    const accepted = runView({ state: 'awaiting_checkpoint', attempts: [attempt('DM-202', 3, 'accepted')] })
    renderScreen({ run: accepted })
    const leftovers = screen.getByLabelText('Leftovers')
    expect(within(leftovers).getByText('Accepted since the retro')).toBeTruthy()
    expect(within(leftovers).queryAllByRole('button', { name: 'Move to next sprint' })).toEqual([])
  })
})

describe('checkpoint redraft', () => {
  it('shows the draft changes against the run revision with Approve retro & redraft as the primary action', () => {
    const recorded = renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan() })
    const panel = screen.getByLabelText('Redraft')
    expect(within(panel).getByText('REDRAFT · CHANGES AGAINST REV 4').tagName).toBe('H3')
    expect(textOf(within(panel).getAllByRole('listitem'))).toEqual([
      '+DM-305 Plan list view: added to Sprint 3',
      '~DM-302: acceptance criteria edited (2 lines)',
      '~Sprint 3: concurrency cap 2 → 3',
      '−DM-202: no longer requires DM-102'
    ])
    expect(within(panel).getByText('Approving saves this draft as rev 5, adopts it into Run #2, approves this report and advances.')).toBeTruthy()
    const gate = screen.getByLabelText('Checkpoint gate')
    const approve = within(gate).getByRole('button', { name: 'Approve retro & redraft' }) as HTMLButtonElement
    expect(approve.className).toContain('btn-primary')
    expect(approve.disabled).toBe(false)
    expect(within(gate).queryByRole('button', { name: /^Approve & advance/ })).toBeNull()
    fireEvent.click(approve)
    expect(recorded.redrafts).toEqual([{ reportId: 'sr_1', revision: 7 }])
    expect(recorded.approved).toEqual([])
  })

  it('shows the plan gate as met by the approval, not as a failure to fix first', () => {
    renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan() })
    const gate = screen.getByLabelText('Checkpoint gate')
    const conditions = gate.querySelector('.cp-conditions') as HTMLElement
    expect(textOf(within(conditions).getAllByRole('listitem'))).toEqual([
      '✓Sprint report submittedRequired by checkpoint policy',
      '✓Sprint retro includedThe report includes a retro',
      '→Run executes the current planApprove retro & redraft saves this draft as rev 5 and adopts it into Run #2.'
    ])
    expect(within(gate).getByLabelText('met by approving')).toBeTruthy()
    expect(within(gate).queryByText(/Blocked by/)).toBeNull()
  })

  it('keeps Approve & advance as it is, with no redraft panel, when there is no draft', () => {
    const checkpoint = checkpointView({ report: reportWithRetro(), gatesMet: true, conditions: [condition('report_submitted', true, 'ok')] })
    const recorded = renderScreen({ checkpoint })
    expect(screen.queryByLabelText('Redraft')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve retro & redraft' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve & advance to Sprint 3' }))
    expect(recorded.approved).toEqual(['sr_1'])
    expect(recorded.redrafts).toEqual([])
  })

  it('keeps Approve & advance for a draft that holds no changes', () => {
    const checkpoint = checkpointView({ report: reportWithRetro(), gatesMet: true, conditions: [condition('report_submitted', true, 'ok')] })
    renderScreen({ checkpoint, draft: draftPlan({ changes: [] }) })
    expect(screen.queryByLabelText('Redraft')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve & advance to Sprint 3' })).toBeTruthy()
  })

})

describe('checkpoint redraft (2)', () => {
  it('is approvable although the unfinished required ticket still shows as unmet, because the redraft moves it on', () => {
    const checkpoint = checkpointView({
      report: reportWithRetro(),
      conditions: [
        condition('required_accepted', false, 'DM-202 failed after 2 attempts'),
        condition('plan_current', false, 'The draft has changes the saved plan lacks')
      ]
    })
    renderScreen({ checkpoint, draft: draftHolding([{ id: 'tk_202', key: 'DM-202', title: 'Transactional bundle import' }]) })
    expect((screen.getByRole('button', { name: 'Approve retro & redraft' }) as HTMLButtonElement).disabled).toBe(false)
    const conditions = screen.getByLabelText('Checkpoint gate').querySelector('.cp-conditions') as HTMLElement
    expect(textOf(within(conditions).getAllByRole('listitem'))[0]).toBe(
      '→Every required ticket acceptedMoved to the next sprint by the redraft: DM-202 failed after 2 attempts'
    )
  })

  it('blocks approving while another gate is unmet, and while the screen is busy', () => {
    const blocked = checkpointView({
      report: reportWithRetro(),
      conditions: [condition('required_accepted', false, 'DM-202 failed after 2 attempts'), condition('plan_current', false, 'The draft has changes')]
    })
    renderScreen({ checkpoint: blocked, draft: draftPlan() })
    expect((screen.getByRole('button', { name: 'Approve retro & redraft' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/^Blocked by 1 gate condition\./)).toBeTruthy()
    cleanup()
    renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan(), busy: true })
    expect((screen.getByRole('button', { name: 'Approve retro & redraft' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('explains a stale draft and a draft built on a revision the run has not adopted', () => {
    renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan({ stale: true }) })
    const panel = screen.getByLabelText('Redraft')
    expect(within(panel).getByRole('note').textContent).toContain('The saved plan changed since this draft was opened.')
    expect((screen.getByRole('button', { name: 'Approve retro & redraft' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan(), run: runView({ state: 'awaiting_checkpoint', revisionId: 'rv_3', revisionNumber: 3 }) })
    expect(within(screen.getByLabelText('Redraft')).getByText('REDRAFT · CHANGES SINCE REV 4')).toBeTruthy()
    expect(within(screen.getByLabelText('Redraft')).getByRole('note').textContent).toContain('Run #2 executes rev 3; this draft builds on rev 4')
  })
})

describe('refusal of approve with redraft', () => {
  it('says which step stopped, why, and that the draft was saved but adoption is still needed', async () => {
    renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan() }, REFUSAL)
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Approve retro & redraft stopped at step 2 of 5: adopting the revision.')).toBeTruthy()
    expect(within(alert).getByText(REFUSAL.message)).toBeTruthy()
    expect(within(alert).getByText(/^The draft was saved as rev 5, but adoption is still needed/)).toBeTruthy()
  })

  it('leaves out the adoption line when nothing was saved, and can be dismissed', async () => {
    renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan() }, { ...REFUSAL, step: 'save', stepNumber: 1, savedRevisionNumber: null, adoptionNeeded: false })
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).queryByText(/adoption is still needed/)).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

})

describe('refusal of approve with redraft (2)', () => {
  it('clears an earlier refusal when the next attempt goes through', async () => {
    let answer: RedraftRefusal | null = REFUSAL
    renderScreen({ checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan(), onApproveWithRedraft: () => Promise.resolve(answer) })
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    await screen.findByRole('alert')
    answer = null
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('keeps showing the refusal after the draft is saved and gone, so the adoption notice stays visible', async () => {
    const recorded = newRecorded()
    const patch = { checkpoint: REDRAFT_CHECKPOINT, draft: draftPlan() }
    const view = render(screenFor(recorded, patch, REFUSAL))
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    await screen.findByRole('alert')
    view.rerender(screenFor(recorded, { ...patch, draft: null }, REFUSAL))
    expect(screen.queryByLabelText('Redraft')).toBeNull()
    expect(within(screen.getByRole('alert')).getByText(/^The draft was saved as rev 5, but adoption is still needed/)).toBeTruthy()
  })
})
