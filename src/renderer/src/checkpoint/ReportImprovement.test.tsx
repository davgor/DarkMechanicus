// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { comparison, experiment, experimentRead, finding, findings, improvementReport, outcome } from '../__mocks__/improvementFixtures'
import { renderImprovement } from '../__mocks__/improvementRig'
import { settle } from '../__mocks__/settle'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'

allowSlowRendering()

const scrolled: string[] = []

beforeEach(() => {
  scrolled.length = 0
  // jsdom has no layout: record where a chain link moves the view instead.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this.id)
  }
})

afterEach(() => {
  cleanup()
})

function folder(): string {
  return `C:/improvement/${expect.getState().currentTestName ?? ''}`
}

const XP_A = experiment('xp_a')
const section = (name: string): HTMLElement => screen.getByRole('region', { name })
const card = (id: string): HTMLElement => within(section('Experiments')).getByText(id).closest('li') ?? section('Experiments')

describe('DM-187 c1: assessment → finding → experiment → resulting work, with evidence links', () => {
  it('reads the chain in order from the frozen grade', async () => {
    renderImprovement({ folder: folder(), report: improvementReport([XP_A]), findings: findings([finding('f1')]), host: null })
    await settle()
    const sections = [...screen.getByRole('group', { name: 'Improvement' }).querySelectorAll('section[aria-label]')].map((item) => item.getAttribute('aria-label'))
    expect(sections).toEqual(['Measured result', 'Findings', 'Experiments'])
    expect(within(section('Measured result')).getByRole('img', { name: 'Sprint grade C' })).toBeTruthy()
    expect(within(section('Measured result')).getByText('Report revision 1 (sr_1)')).toBeTruthy()
    expect(within(section('Findings')).getByText('2 · FINDINGS · 1')).toBeTruthy()
  })

  it('links a finding to its experiment and back, and opens cited evidence on its ticket', async () => {
    const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A]), findings: findings([finding('f1')]), host: null })
    await settle()
    const found = within(section('Findings')).getByText('DM-202 used 90 minutes of active time against a 30 minute budget.').closest('li')!
    fireEvent.click(within(found).getByRole('button', { name: '→ xp_a · xp_a: DM-202 ran 90 minutes against a 30 minute budget' }))
    expect(scrolled).toEqual([card('xp_a').id])
    expect(document.activeElement).toBe(card('xp_a'))
    fireEvent.click(within(card('xp_a')).getByRole('button', { name: /^← #1 DM-202 used 90 minutes/ }))
    expect(scrolled[1]).toBe(found.id)
    fireEvent.click(within(within(found).getByRole('list', { name: 'Evidence' })).getByRole('button'))
    fireEvent.click(within(within(card('xp_a')).getByRole('list', { name: 'Evidence' })).getByRole('button', { name: /^attempt at_202_1/ }))
    expect(world.selected).toEqual(['tk_202', 'tk_202'])
  })

  it('shows the resulting work of an experiment and where it is held', async () => {
    const read = experimentRead(XP_A, {
      status: 'in_progress',
      outcome: outcome('xp_a', {
        corrections: {
          tickets: [{ epicId: 'ep_f', epicTitle: 'Follow-up: Checkout', ticketId: 'tk_f1', key: 'FU-1', title: 'Name the files', role: 'work', workIndex: 0, revisionNumber: null, accepted: null }],
          runIds: []
        }
      })
    })
    const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A]), reads: { xp_a: read } })
    await settle()
    const item = card('xp_a')
    const standing = within(item).getByText('Standing', { selector: 'dt' }).nextElementSibling
    expect(standing?.textContent).toBe('In progress')
    expect(within(item).getByText(/Not accepted yet · in the draft, not saved/)).toBeTruthy()
    expect(within(item).getByText('Follow-up epic "Follow-up: Checkout" (ep_f)')).toBeTruthy()
    fireEvent.click(within(item).getByRole('button', { name: 'Open it' }))
    expect(world.host.opened).toEqual(['ep_f'])
  })

  it('says a report from before scorecards has no findings, and reads none', async () => {
    const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A], { scorecard: undefined }), host: null })
    await settle()
    expect(within(section('Findings')).getByText('No findings: the report was submitted before scorecards, so nothing measured them.')).toBeTruthy()
    expect(world.dm.callsOf('getRetroFindings')).toEqual([])
  })
})

describe('DM-187 c3: unavailable evidence is recoverable', () => {
  it('keeps the rest of the report when the findings cannot be read, and Try again reads them', async () => {
    const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A]), findings: findings([finding('f1')]) })
    world.dm.failures.getRetroFindings = { code: 'not_found', message: 'The scorecard is not here.' }
    world.rerender({ source: { ...world.props.source, version: 1 } })
    await settle()
    const alert = within(section('Findings')).getByRole('alert')
    expect(alert.textContent).toContain('The findings could not be read: The scorecard is not here. The rest of the report is still shown, and nothing was changed.')
    expect(within(section('Measured result')).getByText('Report revision 1 (sr_1)')).toBeTruthy()
    delete world.dm.failures.getRetroFindings
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(within(section('Findings')).queryByRole('alert')).toBeNull()
    expect(within(section('Findings')).getByText('2 · FINDINGS · 1')).toBeTruthy()
  })

  it('does not let an experiment whose standing failed to read be selected until it reads', async () => {
    const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A]) })
    world.dm.failures.getExperiment = { code: 'not_found', message: 'Gone.' }
    world.rerender({ source: { ...world.props.source, version: 1 } })
    await settle()
    const box = screen.getByRole('checkbox', { name: 'Select xp_a for corrective work' })
    expect(box).toHaveProperty('disabled', true)
    expect(within(card('xp_a')).getByText('Not selectable')).toBeTruthy()
    delete world.dm.failures.getExperiment
    fireEvent.click(within(card('xp_a')).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(screen.getByRole('checkbox', { name: 'Select xp_a for corrective work' })).toHaveProperty('disabled', false)
  })

  it('leaves a selected experiment that became finished out of the request, and unticking clears it', async () => {
    const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A]) })
    await settle()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select xp_a for corrective work' }))
    world.dm.handlers.getExperiment = () => experimentRead(XP_A, { status: 'completed' })
    world.rerender({ source: { ...world.props.source, version: 1 } })
    await settle()
    expect(within(card('xp_a')).getByText('Left out: untick to clear')).toBeTruthy()
    const planner = section('Corrective work')
    expect(within(planner).getByText('xp_a is left out: It is completed: it takes no new work. Untick it to clear it from your selection.')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select xp_a for corrective work' }))
    expect(within(planner).getByText('Selected: none yet: tick experiments above.')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Select xp_a for corrective work' })).toHaveProperty('disabled', true)
  })
})

describe('DM-188 c4 (view): the before/after comparison with its supporting evidence', () => {
  it('shows the classification, target, baseline and measured after-result with sample, window, guardrail and evidence', async () => {
    const read = experimentRead(XP_A, { status: 'in_progress', outcome: outcome('xp_a') })
    renderImprovement({ folder: folder(), report: improvementReport([XP_A]), reads: { xp_a: read }, host: null })
    await settle()
    const item = card('xp_a')
    expect(within(item).getByText('Improved', { selector: '.ew-pill' })).toBeTruthy()
    expect(within(item).getByText('Decrease by 20 percent from 5,400,000 to 4,320,000 milliseconds')).toBeTruthy()
    expect(within(item).getByText('Result #2 · Improved')).toBeTruthy()
    expect(within(item).getByText('Before: 5,400,000 milliseconds (observed) · stated with evidence · planned Small')).toBeTruthy()
    expect(
      within(item).getByText('After: 3,600,000 milliseconds (observed) · stated with evidence · planned Small · window 2026-10-01T09:00:00.000Z to 2026-10-06T17:00:00.000Z')
    ).toBeTruthy()
    expect(within(item).getByText('Change: -1,800,000 (-33.3%) against a target of 4,320,000')).toBeTruthy()
    expect(within(item).getByText('Guardrail: A.delivered 5 at least 4 (held)')).toBeTruthy()
    expect(within(item).getByText('Evidence: run rn_3 (sprint 3 run)')).toBeTruthy()
    expect(within(item).getByText('Observational: a before/after difference over different work, not proof of cause.')).toBeTruthy()
  })

  it('shows a failed guardrail as regressed even with a lower total, and missing data as insufficient evidence', async () => {
    const breached = comparison({
      classification: 'regressed',
      guardrails: [{ measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 4, after: 2, verdict: 'breached', detail: 'A.delivered 2 at least 4' }],
      reasons: ['A guardrail was breached.']
    })
    const missing = comparison({ eventId: 'ev_3', eventNumber: 3, classification: 'insufficient_evidence', difference: null, after: { ...comparison().after, value: null, state: 'missing' }, reasons: ['No value.'] })
    const read = experimentRead(XP_A, { outcome: outcome('xp_a', { classification: 'regressed', comparisons: [breached, missing] }) })
    renderImprovement({ folder: folder(), report: improvementReport([XP_A]), reads: { xp_a: read }, host: null })
    await settle()
    const item = card('xp_a')
    expect(within(item).getByText('Result #2 · Regressed')).toBeTruthy()
    expect(within(item).getByText('Guardrail: A.delivered 2 at least 4 (breached)')).toBeTruthy()
    expect(within(item).getByText('Result #3 · Insufficient evidence')).toBeTruthy()
    expect(within(item).getByText(/^After: no value \(missing\)/)).toBeTruthy()
    expect(within(item).getByText('Change: Not compared')).toBeTruthy()
  })

  it('falls back to the outcome carried on the report while the experiment is still being read', async () => {
    const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A], { experimentOutcomes: [outcome('xp_a')] }), host: null })
    world.dm.holdNext('getExperiment')
    world.rerender({ source: { ...world.props.source, version: 1 } })
    await settle()
    expect(within(card('xp_a')).getByText('Result #2 · Improved')).toBeTruthy()
    expect(within(card('xp_a')).getByText('Reading…')).toBeTruthy()
  })
})
