/**
 * DM-192 c3: docs/runbooks/corrective-work.md covers both destination flows, the missing-checkout and part-way recovery,
 * and what is never changed; the checkout problems, panel states and buttons it names are checked against the code, so
 * the runbook cannot drift from the app.
 */
import { describe, expect, it } from 'vitest'
import runbook from '../../../../docs/runbooks/corrective-work.md?raw'
import grading from '../../../../docs/space-grading.md?raw'
import sourceCheckout from '../../../shared/desktop/sourceCheckout.ts?raw'
import type { CrossRepoCorrectionPreview } from '../../../shared/domain/crossRepoCorrections'
import { markdownSection, missingPhrases } from '../../../test/markdownSections'
import { xrLink, xrPreview } from '../__mocks__/crossRepoFixtures'
import correctivePlanner from './CorrectivePlanner.tsx?raw'
import crossRepoCorrection from './CrossRepoCorrection.tsx?raw'
import reportImprovement from './ReportImprovement.tsx?raw'
import reportScorecard from './ReportScorecard.tsx?raw'
import crossRepoViewSource from './crossRepoView.ts?raw'
import { mainAction, stateView } from './crossRepoView'

describe('the corrective-work runbook: both destination flows', () => {
  it('walks corrective work in this repository through preview, draft and the normal Save, adopt and run', () => {
    expect(
      missingPhrases(markdownSection(runbook, 'Flow 1: corrective work in this repository'), [
        '`source_repository`',
        "a new sprint after the draft's last one",
        'follow-up epic',
        'completed epic itself stays completed',
        'Keep the Fireguard ticket',
        'say why in the plan rationale',
        '**Preview corrective work**',
        '**Preview again**',
        '**Create draft work**',
        'Save, adopt',
        '`preview_corrections`',
        '`create_corrections`',
        "under the experiment's `existing` (its `epicId`"
      ])
    ).toEqual([])
  })

  it('walks corrective work in the Dark Mechanicus source through a local target, an epic it owns and separate runs', () => {
    expect(
      missingPhrases(markdownSection(runbook, 'Flow 2: corrective work in the Dark Mechanicus source'), [
        '`darkmechanicus_source`',
        '**Choose the target checkout** (local target selection)',
        'stored on this machine only',
        'never by a path',
        'new backlog epic owned by that project',
        "its own branch, runs, checkpoints and approvals, separate from the source epic's run",
        '**Bring back its grades**',
        '`record_experiment_event`',
        '`{ reportId, assessmentId }`'
      ])
    ).toEqual([])
  })
})

/** The members of the `SourceCheckoutProblem` union, read from its declaration. */
function checkoutProblems(): string[] {
  const start = sourceCheckout.indexOf('export type SourceCheckoutProblem =')
  const declaration = sourceCheckout.slice(start, sourceCheckout.indexOf('\nexport ', start + 1))
  return [...declaration.matchAll(/\|\s*'([a-z_]+)'/g)].map((match) => match[1] ?? '')
}

describe('the corrective-work runbook: a missing or changed checkout', () => {
  const missing = markdownSection(runbook, 'The checkout is missing or changed')

  it('gives every checkout problem the app reports a recovery row', () => {
    const problems = checkoutProblems()
    expect(problems.length).toBeGreaterThanOrEqual(9)
    expect(problems.filter((problem) => !missing.includes(`\`${problem}\``))).toEqual([])
  })

  it('keeps the request pending, to be retried or withdrawn, and never redirects', () => {
    expect(
      missingPhrases(missing, ['Nothing clones, searches or redirects', '**Pending**', '**Retry the request**', '**Withdraw the request**', '**Withdraw anyway**'])
    ).toEqual([])
  })
})

/** A preview as the broker answers it, in the state the panel reads its label and main button from. */
function answer(state: CrossRepoCorrectionPreview['state'], link: 'pending' | 'linked' | null, needsRecreate = false): CrossRepoCorrectionPreview {
  return xrPreview({ state, needsRecreate, link: link === null ? null : xrLink({ state: link }) })
}

/** [runbook row prefix, the broker's answer, the label the panel shows, the main button it offers (null: none)]. */
const STOPPED_STATES: [string, CrossRepoCorrectionPreview, string, string | null][] = [
  ['| **Pending** (the receipt is pending)', answer('pending', 'pending'), 'Pending', 'Retry the request'],
  ['| **Created**, no link here', answer('created', null), 'Created', 'Record the link here'],
  ['| **Created**, linked', answer('created', 'linked'), 'Created', null],
  ['| **Epic missing**', answer('ready', 'pending', true), 'Epic missing', 'Create a new epic in Dark Mechanicus'],
  ['| **Conflict**', answer('conflict', 'pending'), 'Conflict', null],
  ['| **Blocked**', answer('blocked', 'pending'), 'Blocked', null]
]

describe('the corrective-work runbook: a request stopped part way', () => {
  const stopped = markdownSection(runbook, 'A request stopped part way')
  const rows = stopped.split('\n').filter((line) => line.startsWith('| **'))

  it('names each part-way state with its recovery', () => {
    expect(
      missingPhrases(stopped, [
        '**Pending** (the receipt is pending)',
        'it accepted the epic but recording the link here failed',
        'the retry links that very epic and never writes a second one',
        '**Created**, no link here',
        '**Created**, linked',
        '**Epic missing**',
        '**Conflict**',
        '**Blocked**',
        'idempotent by request key',
        'duplicate epic'
      ])
    ).toEqual([])
  })

  it.each(STOPPED_STATES)('%s: the panel shows the documented label and main button', (prefix, preview, label, button) => {
    const row = rows.find((line) => line.startsWith(prefix)) ?? ''
    expect(row).not.toBe('')
    expect(stateView(preview).label).toBe(label)
    expect(mainAction(preview)?.label ?? null).toBe(button)
    const documented = button === null ? /No main button|Nothing to recover/.test(row) : row.includes(`**${button.replace('Dark Mechanicus', '…')}**`)
    expect(documented).toBe(true)
  })

  it('documents "Record the link here" only for a checkout with no receipt, and "Retry the request" only for a pending one', () => {
    const statesNaming = (button: string): string[] => rows.filter((line) => line.includes(button)).map((line) => line.split('|')[1]?.trim() ?? '')
    expect(statesNaming('Record the link here')).toEqual(['**Created**, no link here'])
    expect(statesNaming('Retry the request')).toEqual(['**Pending** (the receipt is pending)'])
  })

  it('agrees with space-grading.md that a failed link is retried onto that very epic', () => {
    expect(missingPhrases(grading, ['a link that failed after the target accepted the work is retried onto that very epic'])).toEqual([])
  })
})

describe('the corrective-work runbook: preserved history and separate runs', () => {
  it('says the source epic is only read, events are appended, and the correction runs and results stay separate', () => {
    expect(
      missingPhrases(markdownSection(runbook, 'What is never changed'), [
        'only read',
        'A completed source epic stays completed',
        'never reopened',
        'Experiment events are appended',
        'run separately: their own runs, branches, checkpoints and approvals',
        'sealed'
      ])
    ).toEqual([])
  })
})

const RENDERER_SOURCES = [crossRepoCorrection, crossRepoViewSource, correctivePlanner, reportScorecard, reportImprovement].join('\n')

describe('the corrective-work runbook: the labels it names', () => {
  it.each([
    'Retry the request',
    'Record the link here',
    'Withdraw the request',
    'Withdraw anyway',
    'Bring back its grades',
    'Create draft work',
    'Preview corrective work',
    'Preview again',
    'Create a new epic in ',
    'Epic missing',
    'Choose another folder…',
    'Open the draft to review and Save',
    'Reassess now'
  ])('"%s" is a label in the renderer', (label) => {
    expect(RENDERER_SOURCES).toContain(label)
  })
})
