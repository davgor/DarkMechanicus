// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DM, KEY, REPORT, SHOP, checkoutView, retroExperiment, xrLink, xrPreview, xrResult, xrTarget, xrTargetEpic } from '../__mocks__/crossRepoFixtures'
import { FakeCrossRepoCorrections, FakeSourceCheckout, ok, refused } from '../__mocks__/fakeCrossRepoCorrections'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { CrossRepoCorrectionPreview } from '../../../shared/domain/crossRepoCorrections'
import { CrossRepoCorrection, type CrossRepoCorrectionProps } from './CrossRepoCorrection'

let dm: FakeDm
let xr: FakeCrossRepoCorrections
let checkout: FakeSourceCheckout

beforeEach(() => {
  dm = new FakeDm()
  dm.folders = [folderView({ path: SHOP, name: 'shop' }), folderView({ path: DM, name: 'dm' })]
  xr = new FakeCrossRepoCorrections(xrPreview())
  checkout = new FakeSourceCheckout(checkoutView())
  dm.crossRepoCorrections = xr
  dm.sourceCheckout = checkout
  window.dm = dm
})

afterEach(cleanup)

interface Shell {
  opened: [string, string][]
  changed: string[]
}

function renderPanel(props: Partial<CrossRepoCorrectionProps> = {}): Shell {
  const shell: Shell = { opened: [], changed: [] }
  render(
    <CrossRepoCorrection
      folder={SHOP}
      reportId={REPORT}
      experiment={retroExperiment()}
      read={null}
      version={0}
      openFolderEpic={(path, epicId) => shell.opened.push([path, epicId])}
      folderChanged={(path) => shell.changed.push(path)}
      {...props}
    />
  )
  return shell
}

/** The text of the panel field labelled `label`. */
function field(label: string): string {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? ''
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

function outcome(): string {
  return screen.getByRole('status', { name: 'What the last request did' }).textContent ?? ''
}

const NEW_EPIC = '"Correction from Shop: slow claims" · owned by Dark Mechanicus: its own branch, runs, checkpoints and approvals, in its draft until someone there saves it'
const CREATE = 'Create the epic in Dark Mechanicus'
const OPEN_DRAFT = 'Open "Correction from Shop: slow claims" in Dark Mechanicus to review, Save and start it'

const UNAVAILABLE = xrTarget({ status: 'unavailable', problem: 'missing', message: 'The checkout at C:/code/dm is gone.', recovery: 'Choose your Dark Mechanicus checkout again.' })

function createdPreview(epic = xrTargetEpic()): CrossRepoCorrectionPreview {
  return xrPreview({ state: 'created', link: xrLink({ target: epic }), existing: epic, nextSteps: [] })
}

describe('DM-191 c1: the preview identifies the destination project and the new epic’s ownership', () => {
  it('names the chosen checkout’s project and exact folder, and the new epic as owned there', async () => {
    renderPanel()
    await screen.findByText('Ready')
    const target = screen.getByRole('group', { name: 'Target checkout' })
    expect(within(target).getByText('Dark Mechanicus (pj_dm)', { exact: false }).textContent).toBe('Dark Mechanicus (pj_dm) Available')
    expect(field('Folder')).toBe(DM)
    expect((within(target).getByRole('radio', { name: /^dm/ }) as HTMLInputElement).checked).toBe(true)
    expect((within(target).getByRole('radio', { name: /This folder \(shop\)/ }) as HTMLInputElement).checked).toBe(false)
    expect(field('New epic')).toBe(NEW_EPIC)
    expect(field('Tickets')).toBe('DM-7 Cache the claim packet small · 1 criteriaDM-8 Grade the corrective tests with Fireguard Fireguard · 2 criteriaDM-8 needs DM-7')
    expect(field('Request key')).toBe(KEY)
    expect(button(CREATE).disabled).toBe(false)
  })

  it('works with a separate local Dark Mechanicus checkout chosen among the tracked folders', async () => {
    checkout.view = checkoutView({ status: 'none', target: null, local: null, recovery: 'Choose your Dark Mechanicus checkout.' })
    xr.previewAnswer = ok(xrPreview({ target: xrTarget({ status: 'none', projectId: null, projectName: null, path: null }), key: null }))
    const chosen = checkout.onAssociate
    checkout.onAssociate = (folder) => {
      checkout.view = checkoutView()
      xr.previewAnswer = ok(xrPreview())
      return chosen(folder)
    }
    renderPanel()
    await screen.findByText('Ready')
    expect(field('Project')).toBe('No checkout chosen Not chosen')
    expect(button('Save the request (pending)').disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /^dm/ }))
    await settle()
    expect(checkout.associated).toEqual([DM])
    expect(outcome()).toContain(`Chosen: Dark Mechanicus at ${DM}`)
    expect(field('Project')).toBe('Dark Mechanicus (pj_dm) Available')
    expect(field('Folder')).toBe(DM)
    expect(button(CREATE).disabled).toBe(false)
  })

  it('works with the active repository as its own target, read as this folder', async () => {
    checkout.view = checkoutView({ local: { path: DM, displayPath: '~/code/dm', associatedAt: '2026-11-01T09:00:00.000Z' } })
    xr.onCreate = () => ok(xrResult())
    const shell = renderPanel({ folder: DM })
    await screen.findByText('Ready')
    expect((screen.getByRole('radio', { name: /This folder \(dm\)/ }) as HTMLInputElement).checked).toBe(true)
    expect(field('Folder')).toBe(DM)
    fireEvent.click(button(CREATE))
    await settle()
    expect(xr.callsOf('create')).toEqual([{ folder: DM, input: { reportId: REPORT, experimentId: 'xp_0001', expectedTargetProjectId: 'pj_dm', recreate: false } }])
    expect(shell.changed).toEqual([DM])
  })
})

describe('DM-191 c2: an unavailable checkout keeps a recoverable pending proposal', () => {
  it('says why, saves the request as pending, then Retry finishes it', async () => {
    xr.previewAnswer = ok(xrPreview({ target: UNAVAILABLE, validation: null }))
    const pendingLink = xrLink({ state: 'pending', target: null, linkedAt: null })
    xr.onCreate = () => {
      xr.previewAnswer = ok(xrPreview({ state: 'pending', target: UNAVAILABLE, link: pendingLink, validation: null }))
      return ok(xrResult({ progress: 'pending', link: pendingLink, target: null, failure: { step: 'target', error: { code: 'not_found', message: 'The checkout is gone.' }, retryable: true }, nextSteps: [] }))
    }
    xr.onRetry = () => {
      xr.previewAnswer = ok(createdPreview())
      return ok(xrResult())
    }
    const shell = renderPanel()
    await screen.findByText('Ready')
    expect(field('Why')).toBe('The checkout at C:/code/dm is gone.Choose your Dark Mechanicus checkout again.')
    expect(field('Plan check')).toBe('Checked against the target once its checkout is available.')
    fireEvent.click(button('Save the request (pending)'))
    await settle()
    expect(outcome()).toContain('Kept here as a pending request; the Dark Mechanicus source was not written')
    expect(outcome()).toContain('Retryable: yes')
    expect(screen.getByText('Pending')).toBeTruthy()
    expect(button('Withdraw the request').disabled).toBe(false)
    expect(shell.changed).toEqual([])
    fireEvent.click(button('Retry the request'))
    await settle()
    expect(xr.callsOf('retry')).toEqual([{ folder: SHOP, input: KEY }])
    expect(outcome()).toContain('Created in the Dark Mechanicus source and linked here')
    expect(shell.changed).toEqual([DM])
  })

  it('a preview that cannot be read says so and can be read again', async () => {
    xr.previewAnswer = refused({ code: 'internal', message: 'The source records are locked.' })
    renderPanel()
    expect((await screen.findByRole('alert')).textContent).toBe('The preview could not be read: The source records are locked.')
    xr.previewAnswer = ok(xrPreview())
    fireEvent.click(button('Check again'))
    await settle()
    expect(screen.queryByRole('alert')).toBe(null)
    expect(button(CREATE).disabled).toBe(false)
  })
})

describe('DM-191 c2: an already-created correction shows the epic the target holds', () => {
  it('shows an unsaved draft with its actual keys, and offers Open instead of Create', async () => {
    xr.previewAnswer = ok(createdPreview(xrTargetEpic({ keys: ['DM-31', 'DM-32'] })))
    renderPanel()
    await screen.findByText('Created')
    expect(field('Epic there')).toBe('"Correction from Shop: slow claims" (ep_fix) · owned by Dark Mechanicus: its own branch, runs, checkpoints and approvals · unsaved draft (revision 1)')
    expect(field('Its tickets there')).toBe('DM-31, DM-32')
    expect(screen.queryByRole('button', { name: /^Create/ })).toBe(null)
    expect(button(OPEN_DRAFT).disabled).toBe(false)
  })

  it('shows a saved plan with its status, opened to follow its runs', async () => {
    xr.previewAnswer = ok(createdPreview(xrTargetEpic({ saved: true, status: 'in_progress', draftRevision: null })))
    const shell = renderPanel()
    await screen.findByText('Created')
    expect(field('Epic there')).toContain('· saved plan, in progress')
    fireEvent.click(button('Open "Correction from Shop: slow claims" in Dark Mechanicus to follow its runs and checkpoints'))
    expect(shell.opened).toEqual([[DM, 'ep_fix']])
  })

  it('refuses to open it through a checkout of another project', async () => {
    xr.previewAnswer = ok({ ...createdPreview(), target: xrTarget({ projectId: 'pj_other', projectName: 'Other' }) })
    const shell = renderPanel()
    await screen.findByText('Created')
    const open = button('Open "Correction from Shop: slow claims" in the Dark Mechanicus source to review, Save and start it')
    expect(open.disabled).toBe(true)
    expect(open.title).toBe('The chosen checkout is project pj_other, not pj_dm that holds this epic: choose that project\'s checkout to open it.')
    fireEvent.click(open)
    expect(shell.opened).toEqual([])
  })
})

describe('DM-191 c2: duplicate clicks create one epic', () => {
  it('a double click on Create creates one epic', async () => {
    const hold = xr.hold('create')
    xr.onCreate = () => ok(xrResult())
    renderPanel()
    await screen.findByText('Ready')
    fireEvent.click(button(CREATE))
    fireEvent.click(screen.getByRole('button', { name: `${CREATE}…` }))
    expect(button(`${CREATE}…`).disabled).toBe(true)
    hold.resolve()
    await settle()
    expect(xr.callsOf('create')).toHaveLength(1)
    expect(outcome()).toContain('Created in the Dark Mechanicus source and linked here')
  })

  it('a request on its way is not repeated by a remounted panel', async () => {
    const hold = xr.hold('create')
    xr.onCreate = () => ok(xrResult())
    renderPanel()
    await screen.findByText('Ready')
    fireEvent.click(button(CREATE))
    cleanup()
    renderPanel()
    await screen.findByText('Ready')
    fireEvent.click(button(CREATE))
    await settle()
    expect(xr.callsOf('create')).toHaveLength(1)
    hold.resolve()
    await settle()
  })
})

describe('DM-191 c2: a partial routing failure is recoverable', () => {
  it('reports the target written but the link failed as retryable, and Retry links the same epic', async () => {
    const accepted = xrTargetEpic({ created: true })
    const pendingLink = xrLink({ state: 'pending', target: accepted, linkedAt: null })
    xr.onCreate = () => {
      xr.previewAnswer = ok(xrPreview({ state: 'pending', link: pendingLink, existing: accepted }))
      return ok(xrResult({ progress: 'target_created', link: pendingLink, target: accepted, failure: { step: 'link', error: { code: 'internal', message: 'disk I/O error' }, retryable: true }, nextSteps: [] }))
    }
    xr.onRetry = () => {
      xr.previewAnswer = ok(createdPreview())
      return ok(xrResult({ changed: true, target: xrTargetEpic({ created: false }) }))
    }
    const shell = renderPanel()
    await screen.findByText('Ready')
    fireEvent.click(button(CREATE))
    await settle()
    expect(outcome()).toContain('Created in the Dark Mechanicus source; recording the link here failed')
    expect(outcome()).toContain('Recording the link here failed (internal): disk I/O error')
    expect(outcome()).toContain('Retryable: yes')
    expect(shell.changed).toEqual([DM])
    fireEvent.click(button('Retry the request'))
    await settle()
    expect(xr.callsOf('retry')).toEqual([{ folder: SHOP, input: KEY }])
    expect(xr.callsOf('create')).toHaveLength(1)
    expect(field('Epic there')).toContain('(ep_fix)')
    expect(shell.changed).toEqual([DM, DM])
  })

  it('a refused create says so and tells the target folder nothing', async () => {
    xr.onCreate = () => refused({ code: 'conflict', message: 'The chosen checkout is now project pj_new.' })
    const shell = renderPanel()
    await screen.findByText('Ready')
    fireEvent.click(button(CREATE))
    await settle()
    expect(outcome()).toContain('Creating it refused (conflict)')
    expect(outcome()).toContain('The chosen checkout is now project pj_new.')
    expect(shell.changed).toEqual([])
  })
})

describe('DM-191 c2: refreshed target state', () => {
  it('Check again shows the epic missing there and creates a new one only once confirmed', async () => {
    xr.previewAnswer = ok(createdPreview())
    xr.onCreate = () => ok(xrResult())
    renderPanel()
    await screen.findByText('Created')
    xr.previewAnswer = ok({ ...createdPreview(), existing: null, needsRecreate: true })
    fireEvent.click(button('Check again'))
    await settle()
    expect(screen.getByText('Epic missing')).toBeTruthy()
    fireEvent.click(button('Create a new epic in Dark Mechanicus'))
    expect(screen.getByRole('alert').textContent).toBe('A second epic is made in the chosen checkout; the one reached before stays wherever it is. Cancel')
    expect(xr.callsOf('create')).toEqual([])
    fireEvent.click(button('Yes: Create a new epic in Dark Mechanicus'))
    await settle()
    expect(xr.callsOf('create')).toEqual([{ folder: SHOP, input: { reportId: REPORT, experimentId: 'xp_0001', expectedTargetProjectId: 'pj_dm', recreate: true } }])
  })

  it('reads everything again when the workspace reloads', async () => {
    const props = { folder: SHOP, reportId: REPORT, experiment: retroExperiment(), read: null, openFolderEpic: null, folderChanged: null }
    const view = render(<CrossRepoCorrection {...props} version={0} />)
    await screen.findByText('Ready')
    xr.previewAnswer = ok(createdPreview())
    view.rerender(<CrossRepoCorrection {...props} version={1} />)
    await screen.findByText('Created')
    expect(xr.callsOf('preview')).toHaveLength(2)
  })
})

describe('DM-191 c3: opening or creating a proposal executes nothing; the target uses its normal controls', () => {
  it('previews and creates through the broker only: no run, claim, save or approval is sent', async () => {
    xr.onCreate = () => {
      xr.previewAnswer = ok(createdPreview())
      return ok(xrResult())
    }
    const shell = renderPanel()
    await screen.findByText('Ready')
    expect(field('Asked by')).toBe(
      'Shop · epic "Checkout flow" (in_progress) · Sprint 1 report revision 3 · xp_0001This project\'s epic, runs, reports and scores stay exactly as they are.'
    )
    fireEvent.click(button(CREATE))
    await settle()
    expect(dm.commandCalls).toEqual([])
    expect([...new Set(xr.calls.map((call) => call.method))].sort()).toEqual(['create', 'list', 'preview'])
    expect(screen.queryByRole('button', { name: /^(Start run|Approve|Save)/ })).toBe(null)
    fireEvent.click(button(OPEN_DRAFT))
    expect(shell.opened).toEqual([[DM, 'ep_fix']])
  })

  it('tells the shell the target folder changed after Create and after Retry, with the target path', async () => {
    const pendingLink = xrLink({ state: 'pending', target: null })
    xr.onCreate = () => {
      xr.previewAnswer = ok(xrPreview({ state: 'pending', link: pendingLink }))
      return ok(xrResult())
    }
    xr.onRetry = () => ok(xrResult({ changed: false }))
    const shell = renderPanel()
    await screen.findByText('Ready')
    fireEvent.click(button(CREATE))
    await settle()
    expect(shell.changed).toEqual([DM])
    fireEvent.click(button('Retry the request'))
    await settle()
    expect(shell.changed).toEqual([DM, DM])
    expect(dm.commandCalls).toEqual([])
  })
})
