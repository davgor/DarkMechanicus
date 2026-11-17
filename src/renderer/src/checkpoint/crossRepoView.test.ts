import { describe, expect, it } from 'vitest'
import { DM, KEY, SHOP, checkoutView, xrLink, xrPreview, xrResult, xrTarget, xrTargetEpic } from '../__mocks__/crossRepoFixtures'
import { folderView } from '../__mocks__/fixtures'
import { comparison, experiment, experimentRead, outcome, reading } from '../__mocks__/improvementFixtures'
import type { ExperimentReading } from '../../../shared/domain/experiments'
import {
  actionBlock,
  checkoutTarget,
  choiceOutcome,
  crossRepoResults,
  destinationView,
  experimentLink,
  gradeValue,
  heldEpic,
  mainAction,
  needsUnverifiedConfirmation,
  openBlock,
  refusalOutcome,
  resultOutcome,
  stateView,
  targetOptions,
  withdrawalOutcome
} from './crossRepoView'

const UNAVAILABLE = xrTarget({
  status: 'unavailable',
  problem: 'missing',
  message: 'The checkout at C:/code/dm is gone.',
  recovery: 'Choose your Dark Mechanicus checkout again.'
})

describe('DM-191 c1: the preview names the destination project, its folder and who owns the new epic', () => {
  it('names an available checkout by project name and id, with its exact folder and no problems', () => {
    expect(destinationView(xrTarget({ message: 'stale note', recovery: 'stale step' }))).toEqual({
      project: 'Dark Mechanicus (pj_dm)',
      path: DM,
      status: { label: 'Available', tone: 'accepted' },
      problems: []
    })
  })

  it('names a checkout without a recorded name as Dark Mechanicus, and no choice as "No checkout chosen"', () => {
    expect(destinationView(xrTarget({ projectName: null, projectId: 'pj_x' })).project).toBe('Dark Mechanicus (pj_x)')
    const none = destinationView(xrTarget({ status: 'none', projectId: null, projectName: null, path: null, recovery: 'Choose your Dark Mechanicus checkout.' }))
    expect(none).toEqual({ project: 'No checkout chosen', path: null, status: { label: 'Not chosen', tone: 'attention' }, problems: ['Choose your Dark Mechanicus checkout.'] })
  })

  it('reads the chosen checkout in the same terms before any preview arrives', () => {
    expect(checkoutTarget(checkoutView())).toEqual({
      status: 'available',
      projectId: 'pj_dm',
      projectName: 'Dark Mechanicus',
      path: DM,
      displayPath: '~/code/dm',
      problem: null,
      message: null,
      recovery: null
    })
    const none = checkoutTarget(checkoutView({ status: 'none', target: null, local: null, recovery: 'Choose one.' }))
    expect(none).toEqual({ status: 'none', projectId: null, projectName: null, path: null, displayPath: null, problem: null, message: null, recovery: 'Choose one.' })
  })
})

describe('DM-191 c1: the target selector offers this folder and the other tracked checkouts', () => {
  it('lists this folder first as "This folder", then the other usable tracked folders, each with its path', () => {
    const folders = [
      folderView({ path: DM, name: 'dm' }),
      folderView({ path: 'C:/code/new', name: 'new', initialized: false }),
      folderView({ path: 'C:/code/gone', name: 'gone', available: false }),
      folderView({ path: SHOP, name: 'shop' })
    ]
    expect(targetOptions(folders, SHOP)).toEqual([
      { path: SHOP, label: 'This folder (shop)' },
      { path: DM, label: 'dm' }
    ])
  })

  it('offers the active repository as its own target, read as this folder', () => {
    const folders = [folderView({ path: SHOP, name: 'shop' }), folderView({ path: DM, name: 'dm' })]
    expect(targetOptions(folders, DM)).toEqual([
      { path: DM, label: 'This folder (dm)' },
      { path: SHOP, label: 'shop' }
    ])
  })

  it('creates the epic in the named target project', () => {
    expect(mainAction(xrPreview())).toEqual({ kind: 'create', label: 'Create the epic in Dark Mechanicus' })
    expect(mainAction(xrPreview({ target: xrTarget({ projectName: null }) }))).toEqual({ kind: 'create', label: 'Create the epic in the Dark Mechanicus source' })
    expect(stateView(xrPreview())).toEqual({ label: 'Ready', tone: 'neutral', meaning: 'Creating it writes a new epic in the Dark Mechanicus source; nothing has been written yet.' })
  })
})

describe('DM-191 c2: unavailable checkout — the request is kept as a pending proposal', () => {
  it('shows what is wrong and how to recover, and saves the request instead of creating it', () => {
    expect(destinationView(UNAVAILABLE)).toEqual({
      project: 'Dark Mechanicus (pj_dm)',
      path: DM,
      status: { label: 'Unavailable', tone: 'blocked' },
      problems: ['The checkout at C:/code/dm is gone.', 'Choose your Dark Mechanicus checkout again.']
    })
    const preview = xrPreview({ target: UNAVAILABLE })
    expect(mainAction(preview)).toEqual({ kind: 'create', label: 'Save the request (pending)' })
    expect(actionBlock(preview, mainAction(preview), false)).toBe(null)
  })

  it('needs a chosen checkout before anything can be requested', () => {
    const preview = xrPreview({ target: xrTarget({ status: 'none', projectId: null, projectName: null, path: null }) })
    expect(actionBlock(preview, mainAction(preview), false)).toBe('Choose your Dark Mechanicus checkout first: the request names its project.')
  })

  it('offers Retry for a pending request, ahead of creating again', () => {
    const pending = xrPreview({ state: 'pending', link: xrLink({ state: 'pending', target: null }) })
    expect(mainAction(pending)).toEqual({ kind: 'retry', label: 'Retry the request' })
    expect(stateView(pending)).toEqual({
      label: 'Pending',
      tone: 'attention',
      meaning: 'Requested here, not confirmed by the Dark Mechanicus source yet: retry it to finish it, or withdraw it.'
    })
  })

  it('reports a request saved while the target was unavailable as pending and retryable', () => {
    const view = resultOutcome(
      xrResult({
        progress: 'pending',
        target: null,
        failure: { step: 'target', error: { code: 'not_found', message: 'The checkout is gone.' }, retryable: true },
        nextSteps: ['Make the checkout available, then retry.']
      })
    )
    expect(view).toEqual({
      heading: 'Kept here as a pending request; the Dark Mechanicus source was not written',
      tone: 'attention',
      lines: ['Writing the Dark Mechanicus source failed (not_found): The checkout is gone.', 'Retrying can finish it.', 'Make the checkout available, then retry.'],
      retryable: true
    })
  })
})

describe('DM-191 c2: an already-created correction writes nothing new', () => {
  it('reads Created with no create button once the target holds it and the link is recorded', () => {
    const created = xrPreview({ state: 'created', link: xrLink(), existing: xrTargetEpic() })
    expect(stateView(created)).toEqual({ label: 'Created', tone: 'accepted', meaning: 'The Dark Mechanicus source holds this work.' })
    expect(mainAction(created)).toBe(null)
    expect(actionBlock(created, null, false)).toBe(null)
  })

  it('offers to record a missing link without writing the target again', () => {
    const unlinked = xrPreview({ state: 'created', link: null, existing: xrTargetEpic() })
    expect(mainAction(unlinked)).toEqual({ kind: 'record', label: 'Record the link here' })
    expect(stateView(unlinked).meaning).toBe(
      'The Dark Mechanicus source already holds this work, but this project has no link to it: create it to record the link (nothing new is written there).'
    )
    expect(actionBlock(unlinked, mainAction(unlinked), false)).toBe(null)
    const away = { ...unlinked, target: UNAVAILABLE }
    expect(actionBlock(away, mainAction(away), false)).toBe('The chosen checkout must be available to check what it holds.')
  })

  it('says an identical request wrote nothing', () => {
    expect(resultOutcome(xrResult({ changed: false, nextSteps: [] }))).toEqual({ heading: 'Already linked: nothing new was written', tone: 'accepted', lines: [], retryable: null })
    expect(resultOutcome(xrResult({ nextSteps: [] })).heading).toBe('Created in the Dark Mechanicus source and linked here')
  })

  it('refuses a second request while one is on its way, whatever it is', () => {
    expect(actionBlock(xrPreview(), mainAction(xrPreview()), true)).toBe('A request is on its way: wait for its answer.')
    expect(actionBlock(xrPreview({ state: 'conflict' }), null, true)).toBe('A request is on its way: wait for its answer.')
  })

  it('creates nothing for a conflicting or blocked request', () => {
    expect(mainAction(xrPreview({ state: 'conflict' }))).toBe(null)
    expect(mainAction(xrPreview({ state: 'blocked' }))).toBe(null)
    expect(stateView(xrPreview({ state: 'conflict' })).label).toBe('Conflict')
  })
})

describe('DM-191 c2: the epic the target holds is shown with its actual keys and state', () => {
  it('shows the epic the target holds with its actual keys and state: an unsaved draft', () => {
    const preview = xrPreview({ state: 'created', link: xrLink(), existing: xrTargetEpic({ draftRevision: 2, keys: ['DM-31', 'DM-32'] }) })
    expect(heldEpic(preview)).toEqual({
      projectId: 'pj_dm',
      epicId: 'ep_fix',
      title: 'Correction from Shop: slow claims',
      keys: ['DM-31', 'DM-32'],
      current: true,
      standing: 'unsaved draft (revision 2)',
      saved: false
    })
  })

  it('shows a saved plan with its status, and a draft that is gone as no open draft', () => {
    const saved = heldEpic(xrPreview({ existing: xrTargetEpic({ saved: true, status: 'in_progress', draftRevision: null }) }))
    expect([saved?.standing, saved?.saved]).toEqual(['saved plan, in progress', true])
    expect(heldEpic(xrPreview({ existing: xrTargetEpic({ draftRevision: null }) }))?.standing).toBe('no open draft')
  })

  it('falls back to the receipt when the target cannot be read now, saying so', () => {
    const preview = xrPreview({ target: UNAVAILABLE, existing: null, link: xrLink({ target: xrTargetEpic({ epicId: 'ep_old', draftRevision: 3 }) }) })
    expect(heldEpic(preview)).toMatchObject({ epicId: 'ep_old', current: false, standing: 'unsaved draft (revision 3), as last linked' })
    expect(heldEpic(xrPreview({ existing: xrTargetEpic({ epicId: 'ep_now' }), link: xrLink({ target: xrTargetEpic({ epicId: 'ep_old' }) }) }))?.epicId).toBe('ep_now')
    expect(heldEpic(xrPreview())).toBe(null)
  })
})

describe('DM-191 c2: a partial routing failure is recoverable', () => {
  it('reports a target write whose link failed as retryable', () => {
    const view = resultOutcome(
      xrResult({
        progress: 'target_created',
        changed: true,
        failure: { step: 'link', error: { code: 'internal', message: 'disk I/O error' }, retryable: true },
        nextSteps: ['Retry to record the link.']
      })
    )
    expect(view).toEqual({
      heading: 'Created in the Dark Mechanicus source; recording the link here failed',
      tone: 'attention',
      lines: ['Recording the link here failed (internal): disk I/O error', 'Retrying can finish it.', 'Retry to record the link.'],
      retryable: true
    })
  })

  it('says when retrying cannot help', () => {
    const view = resultOutcome(xrResult({ progress: 'pending', failure: { step: 'target', error: { code: 'conflict', message: 'Closed.' }, retryable: false }, nextSteps: [] }))
    expect(view.lines).toEqual([
      'Writing the Dark Mechanicus source failed (conflict): Closed.',
      'Retrying the same request cannot change this: withdraw it (or change what blocks it).'
    ])
    expect(view.retryable).toBe(false)
  })

  it('tells a linked request the checkout could not confirm this time apart from a fresh one', () => {
    const view = resultOutcome(xrResult({ changed: false, failure: { step: 'target', error: { code: 'not_found', message: 'Gone.' }, retryable: true }, nextSteps: [] }))
    expect([view.heading, view.tone]).toEqual(['Linked before; the chosen checkout could not confirm it this time', 'attention'])
  })
})

describe('DM-191 c2: refusals and withdrawals read accurately', () => {
  it('shows a refusal with its code, and asks to confirm only an unverifiable withdrawal', () => {
    expect(refusalOutcome({ code: 'conflict', message: 'Another payload.' }, 'Creating it')).toEqual({
      heading: 'Creating it refused (conflict)',
      tone: 'blocked',
      lines: ['Another payload.'],
      retryable: null
    })
    expect(needsUnverifiedConfirmation({ code: 'conflict', message: 'x', details: { problem: 'unverified' } })).toBe(true)
    expect(needsUnverifiedConfirmation({ code: 'conflict', message: 'x', details: { problem: 'payload' } })).toBe(false)
    expect(needsUnverifiedConfirmation({ code: 'not_found', message: 'x', details: { problem: 'unverified' } })).toBe(false)
  })

  it('warns that an unverified withdrawal may leave the work in the target', () => {
    expect(withdrawalOutcome({ withdrawn: xrLink({ state: 'pending' }), verified: true })).toEqual({
      heading: 'Withdrawn: the Dark Mechanicus source was checked and holds none of it',
      tone: 'neutral',
      lines: ['The experiment can be requested again.'],
      retryable: null
    })
    const unverified = withdrawalOutcome({ withdrawn: xrLink({ state: 'pending' }), verified: false })
    expect([unverified.heading, unverified.tone]).toEqual(['Withdrawn without checking the Dark Mechanicus source', 'attention'])
  })
})

describe('DM-191 c2: refreshed target state', () => {
  it('reads a lost target epic as missing, ahead of its recorded state, and asks to create a new one', () => {
    const missing = xrPreview({ state: 'created', needsRecreate: true, link: xrLink() })
    expect(stateView(missing)).toEqual({ label: 'Epic missing', tone: 'blocked', meaning: 'The chosen checkout no longer holds the epic this request reached before.' })
    expect(mainAction(missing)).toEqual({ kind: 'recreate', label: 'Create a new epic in Dark Mechanicus' })
    expect(mainAction({ ...missing, state: 'pending' })?.kind).toBe('recreate')
    expect(actionBlock(missing, mainAction(missing), false)).toBe(null)
    const away = { ...missing, target: UNAVAILABLE }
    expect(actionBlock(away, mainAction(away), false)).toBe('The chosen checkout must be available to check what it holds.')
  })

  it('opens the held epic only through an available checkout of the very project holding it', () => {
    const held = { projectId: 'pj_dm' }
    expect(openBlock(xrPreview(), held)).toBe(null)
    expect(openBlock(xrPreview({ target: UNAVAILABLE }), held)).toBe('The chosen checkout is unavailable: make it available to open the epic there.')
    expect(openBlock(xrPreview({ target: xrTarget({ path: null }) }), held)).toBe('The chosen checkout is unavailable: make it available to open the epic there.')
    expect(openBlock(xrPreview({ target: xrTarget({ projectId: 'pj_other' }) }), held)).toBe(
      'The chosen checkout is project pj_other, not pj_dm that holds this epic: choose that project\'s checkout to open it.'
    )
    expect(openBlock(xrPreview({ link: xrLink({ targetProjectId: 'pj_old' }) }), held)).toBe(
      'The chosen checkout is project pj_dm, not pj_old that holds this epic: choose that project\'s checkout to open it.'
    )
  })

  it('reads the receipt of this experiment for the chosen project, else its only one', () => {
    const mine = xrLink()
    const other = xrLink({ key: 'other' })
    expect(experimentLink([other, mine], KEY)).toBe(mine)
    expect(experimentLink([other, mine], null)).toBe(other)
    expect(experimentLink([], KEY)).toBe(null)
  })

  it('states a brought-back grade with its unit and state, and a missing one as no value', () => {
    expect(gradeValue({ value: 1200, state: 'observed' }, 'milliseconds')).toBe('1,200 milliseconds (observed)')
    expect(gradeValue({ value: null, state: 'missing' }, 'milliseconds')).toBe('no value (missing)')
  })
})

describe('DM-191 c1/c2: choosing the target checkout reads accurately, refused choices included', () => {
  it('says what choosing a checkout did', () => {
    expect(choiceOutcome({ outcome: 'cancelled' })).toBe(null)
    expect(choiceOutcome({ outcome: 'associated', checkout: checkoutView(), folder: folderView({ path: DM }), added: true })).toEqual({
      heading: `Chosen: Dark Mechanicus at ${DM}`,
      tone: 'accepted',
      lines: ['The folder was also added to your folder list.'],
      retryable: null
    })
    expect(choiceOutcome({ outcome: 'associated', checkout: checkoutView({ target: null }), folder: folderView({ path: DM }), added: false })?.lines).toEqual([])
    expect(choiceOutcome({ outcome: 'needs_initialization', folder: folderView({ path: DM }), added: true, message: 'Not set up.', recovery: 'Set it up.' })).toEqual({
      heading: 'Not set up yet',
      tone: 'attention',
      lines: ['Not set up.', 'Set it up.', `It is in your folder list as ${DM}.`],
      retryable: null
    })
    expect(choiceOutcome({ outcome: 'refused', problem: 'not_dm_source', message: 'Not it.', recovery: 'Pick the clone.' })?.lines).toEqual(['Not it.', 'Pick the clone.'])
    expect(choiceOutcome({ outcome: 'refused', problem: 'not_dm_source', message: 'Not it.', recovery: 'Pick the clone.', folder: folderView({ path: SHOP }) })?.lines).toEqual([
      'Not it.',
      'Pick the clone.',
      `It was added to your folder list as ${SHOP}.`
    ])
  })
})

describe('DM-191 c3: a created correction routes to the target, it runs nothing here', () => {
  it('offers no request of its own once the target holds the epic: only its epic there, to open', () => {
    const created = xrPreview({ state: 'created', link: xrLink(), existing: xrTargetEpic() })
    expect(mainAction(created)).toBe(null)
    expect(heldEpic(created)?.epicId).toBe('ep_fix')
    expect(openBlock(created, { projectId: 'pj_dm' })).toBe(null)
  })
})

function gradedIn(reportId: string, epicId: string): ExperimentReading['assessment'] {
  return { ...experiment('x').source, revision: 'earlier', reportId, epicId, reportContentHash: 'rh', snapshotHash: 'sh' }
}

describe('DM-191 c4: before/after pairs read from a Dark Mechanicus correction epic', () => {
  const carried = { projectId: 'pj_dm', key: KEY, epicId: 'ep_fix', epicTitle: 'Fix packets' }

  it('pairs each carried result with the baseline, naming the reports both sides were read from', () => {
    const read = experimentRead(experiment('xp_a'), {
      outcome: outcome('xp_a', {
        baseline: reading({ assessment: gradedIn('sr_1', 'ep_1') }),
        comparisons: [comparison({ eventNumber: 4, classification: 'insufficient_evidence', crossRepo: carried, after: reading({ value: 3_000_000, assessment: gradedIn('sr_dm', 'ep_fix') }) })]
      })
    })
    expect(crossRepoResults(read)).toEqual([
      {
        label: 'Result #4 · insufficient evidence',
        epicId: 'ep_fix',
        projectId: 'pj_dm',
        before: '5,400,000 milliseconds (baseline, report sr_1 of this project)',
        after: '3,000,000 milliseconds (report sr_dm of "Fix packets")'
      }
    ])
  })

  it('leaves out results of this project, and says when a side has no value or no report', () => {
    const read = experimentRead(experiment('xp_a'), {
      outcome: outcome('xp_a', {
        baseline: reading({ value: null }),
        comparisons: [comparison(), comparison({ eventNumber: 3, crossRepo: carried, after: reading({ value: null }) })]
      })
    })
    const rows = crossRepoResults(read)
    expect(rows.map((row) => [row.before, row.after])).toEqual([['no value milliseconds (baseline, report ? of this project)', 'no value milliseconds (report ? of "Fix packets")']])
    expect(crossRepoResults(null)).toEqual([])
  })

  it('names an unknown project when the chosen checkout has none', () => {
    expect(openBlock(xrPreview({ target: xrTarget({ projectId: null }) }), { projectId: 'pj_dm' })).toBe(
      "The chosen checkout is project unknown, not pj_dm that holds this epic: choose that project's checkout to open it."
    )
  })
})
