import { describe, expect, it } from 'vitest'
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, tid } from '../../test/bundles'
import { criterionNeedsPerson } from './criterionWording'
import { validatePlan } from './graph'

const MESSAGE_TAIL = 'tickets must be agent-verifiable, so move it to the sprint acceptance node or make it checkable by an agent.'

/** One sprint: work tickets 1 and 2 (1 -> 2) and acceptance node 3 covering both. */
function planWith(work: Partial<TicketContent>, node: Partial<TicketContent> = {}): PlanBundle {
  return makeBundle([[1, 2, 3]], [[1, 2]], {
    tickets: [
      makeTicket(1, work),
      makeTicket(2),
      makeTicket(3, {
        kind: 'acceptance',
        acceptanceCriteria: [
          { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
          { id: 'c2', text: 'DM-2 verified', covers: tid(2) }
        ],
        ...node
      })
    ]
  })
}

function criteria(...texts: string[]): Pick<TicketContent, 'acceptanceCriteria'> {
  return { acceptanceCriteria: texts.map((text, i) => ({ id: `c${i + 1}`, text })) }
}

function personWarnings(bundle: PlanBundle) {
  return validatePlan(bundle).warnings.filter((warning) => warning.code === 'criterion_needs_person')
}

const ASKS_FOR_A_PERSON = [
  'Manually verify the export opens in Excel',
  'The layout was manually verified on Windows',
  'Manual check: the tray icon shows',
  'Passes a manual check of the settings page',
  'A person verifies the dialog copy',
  'Human verification of the installer flow',
  'Human-verified against the live board',
  'Ask the user whether the colours look right',
  'Ask the person to try the shortcut',
  'Checked by hand on a clean profile',
  'Verify the output by hand',
  'The user confirms the wording',
  'MANUALLY VERIFY THE LOGS',
  'ask THE USER to sign off',
  'Manually check the tray menu',
  'Manually test the shortcut on Windows',
  'Manual verification of the dialog',
  'Verify the output by hand on a clean profile'
]

const ORDINARY = [
  '`npm test` passes',
  'The person-facing dialog shows the epic title',
  'The dialog asks the user to confirm before deleting',
  'Deletes only after the user confirms',
  'Once the user confirms, the run starts',
  'Lists the files still to edit by hand',
  'Checks files to edit by hand are listed',
  'Documents the manual steps in the runbook',
  'Records who the person verifying the sprint is',
  'A screenshot the agent captures shows the human-readable label',
  'The user confirmation dialog renders',
  'Uses handlers registered by hand-written code',
  'The wizard will ask the user for a name',
  'When a user confirms, the run starts',
  'Proceeds once the signed-in user confirms',
  'No manual check is needed',
  'Replaces manual checks with a CI job',
  'Automates human verification of the installer',
  'Validates config created by hand',
  'Tests fixtures built by hand are kept',
  'Shows a "manually verify" warning',
  'Emits the code for `ask the user` wording',
  'Shows the “user confirms” hint'
]

describe('criterionNeedsPerson', () => {
  it.each(ASKS_FOR_A_PERSON)('flags %j', (text) => {
    expect(criterionNeedsPerson(text)).toBe(true)
  })

  it.each(ORDINARY)('does not flag %j', (text) => {
    expect(criterionNeedsPerson(text)).toBe(false)
  })
})

describe('criterion_needs_person warning', () => {
  it.each(ASKS_FOR_A_PERSON)('warns about a work ticket criterion %j, without making the plan invalid', (text) => {
    const report = validatePlan(planWith(criteria('`npm test` passes', text)))
    expect(report.valid).toBe(true)
    expect(report.errors).toEqual([])
    expect(personWarnings(planWith(criteria('`npm test` passes', text)))).toEqual([
      { code: 'criterion_needs_person', message: `Ticket DM-1 criterion needs a person; ${MESSAGE_TAIL}`, ticketIds: [tid(1)] }
    ])
  })

  it.each(ASKS_FOR_A_PERSON)('does not warn about the same text %j on an acceptance node', (text) => {
    const bundle = planWith({}, { acceptanceCriteria: [{ id: 'c1', text, covers: tid(1) }, { id: 'c2', text: 'DM-2 verified', covers: tid(2) }] })
    expect(personWarnings(bundle)).toEqual([])
  })

  it('does not warn about ordinary criteria', () => {
    expect(personWarnings(planWith(criteria(...ORDINARY)))).toEqual([])
  })

  it('warns once per ticket however many of its criteria ask for a person', () => {
    expect(personWarnings(planWith(criteria('Manually verify the tray', 'Ask the user about the colours')))).toHaveLength(1)
  })

  it('leaves the rest of the report unchanged', () => {
    const clean = validatePlan(planWith({}))
    const flagged = validatePlan(planWith(criteria('Manually verify the tray')))
    expect(flagged.valid).toBe(clean.valid)
    expect(flagged.errors).toEqual(clean.errors)
    expect(flagged.warnings.filter((warning) => warning.code !== 'criterion_needs_person')).toEqual(clean.warnings)
  })
})
