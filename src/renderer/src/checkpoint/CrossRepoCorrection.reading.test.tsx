// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DM, KEY, REPORT, SHOP, checkoutView, retroExperiment, xrLink, xrPreview, xrTarget, xrTargetEpic } from '../__mocks__/crossRepoFixtures'
import { FakeCrossRepoCorrections, FakeSourceCheckout, ok, refused } from '../__mocks__/fakeCrossRepoCorrections'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { comparison, experimentRead, outcome } from '../__mocks__/improvementFixtures'
import { settle } from '../__mocks__/settle'
import type { ExperimentView } from '../../../shared/domain/experiments'
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

async function renderPanel(props: Partial<CrossRepoCorrectionProps> = {}): Promise<[string, string][]> {
  const opened: [string, string][] = []
  render(
    <CrossRepoCorrection
      folder={SHOP}
      reportId={REPORT}
      experiment={retroExperiment()}
      read={null}
      version={0}
      openFolderEpic={(path, epicId) => opened.push([path, epicId])}
      folderChanged={null}
      {...props}
    />
  )
  await settle()
  return opened
}

function field(label: string): string {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? ''
}

function outcome0(): string | null {
  return screen.queryByRole('status', { name: 'What the last request did' })?.textContent ?? null
}

const [WORK, FIREGUARD] = xrPreview().tickets

describe('what creating it would write, read in words', () => {
  it('names unsized and acceptance tickets, the problems, an invalid plan check and an unknown sprint', async () => {
    const acceptance = { ...FIREGUARD!, ref: 'acceptance', role: 'acceptance' as const, key: 'DM-9', title: 'Accept the correction' }
    const source = { ...xrPreview().source, sprintOrdinal: null }
    xr.previewAnswer = ok(
      xrPreview({ tickets: [{ ...WORK!, size: null }, acceptance], dependencies: [], problems: ['Work 1 is vague.'], source, validation: { valid: false, errors: [{ code: 'cycle', message: 'DM-7 needs itself.' }], warnings: [] } })
    )
    await renderPanel()
    expect(field('Tickets')).toBe('DM-7 Cache the claim packet Unsized · 1 criteriaDM-9 Accept the correction Acceptance · 2 criteria')
    expect(within(screen.getByRole('group', { name: 'Where it stands' })).getByText('Work 1 is vague.')).toBeTruthy()
    expect(field('Plan check')).toBe('Not valid there: DM-7 needs itself.')
    expect(field('Asked by')).toContain('Sprint ? report revision 3')
  })

  it('counts the warnings of a valid plan check', async () => {
    xr.previewAnswer = ok(xrPreview({ validation: { valid: true, errors: [], warnings: [{ code: 'w', message: 'No size.' }, { code: 'w', message: 'No goal.' }] } }))
    await renderPanel()
    expect(field('Plan check')).toBe('Valid there, with 2 warning(s).')
  })

  it('says when the epic there has no tickets under this request, and opens it in an unnamed project’s checkout', async () => {
    const held = xrTargetEpic({ keys: [] })
    xr.previewAnswer = ok(xrPreview({ state: 'created', link: xrLink({ target: held }), existing: held, target: xrTarget({ projectName: null }) }))
    const opened = await renderPanel()
    expect(field('Its tickets there')).toBe('none found under this request')
    fireEvent.click(screen.getByRole('button', { name: 'Open "Correction from Shop: slow claims" in the Dark Mechanicus source to review, Save and start it' }))
    expect(opened).toEqual([[DM, 'ep_fix']])
  })
})

function carriedRead(): ExperimentView {
  const carried = (projectId: string) => ({ projectId, key: KEY, epicId: `ep_${projectId}`, epicTitle: 'Correction from Shop: slow claims' })
  return experimentRead(retroExperiment(), {
    outcome: outcome('xp_0001', { comparisons: [comparison({ eventNumber: 2, crossRepo: carried('pj_dm') }), comparison({ eventNumber: 3, crossRepo: carried('pj_other') })] })
  })
}

describe('before and after, read from the correction epic', () => {
  it('opens the correction epic of a result through the checkout of its project only', async () => {
    const opened = await renderPanel({ read: carriedRead() })
    const rows = within(screen.getByText('Before / after', { selector: 'dt' }).nextElementSibling as HTMLElement).getAllByRole('listitem')
    expect(rows.map((row) => within(row).queryAllByRole('button').length)).toEqual([1, 0])
    expect(rows[0]?.textContent).toContain('Result #2 · improved Before: 5,400,000 milliseconds (baseline, report ? of this project) → After: 3,600,000 milliseconds')
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Open the correction epic' }))
    expect(opened).toEqual([[DM, 'ep_pj_dm']])
  })

  it('offers no opening where the screen cannot navigate or no checkout folder is chosen', async () => {
    await renderPanel({ read: carriedRead(), openFolderEpic: null })
    expect(screen.queryByRole('button', { name: 'Open the correction epic' })).toBeNull()
    cleanup()
    xr.previewAnswer = ok(xrPreview({ target: xrTarget({ status: 'none', path: null }) }))
    await renderPanel({ read: carriedRead() })
    expect(screen.getAllByText(/^Result #/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Open the correction epic' })).toBeNull()
  })
})

describe('reading the panel when parts of it fail', () => {
  it('still reads the preview when the checkout, the folder list and the receipts cannot be read', async () => {
    checkout.get = () => Promise.reject(new Error('Settings locked'))
    dm.listFolders = () => Promise.reject(new Error('Registry locked'))
    xr.list = () => Promise.resolve(refused({ code: 'internal', message: 'Receipts locked' }))
    await renderPanel()
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(within(screen.getByRole('radiogroup', { name: 'Choose the target checkout' })).queryAllByRole('radio')).toEqual([])
    expect(screen.queryByText('Its grades', { selector: 'dt' })).toBeNull()
  })

  it('says why when reading the preview throws', async () => {
    xr.preview = () => Promise.reject(new Error('The broker is gone.'))
    await renderPanel()
    expect(screen.getByRole('alert').textContent).toBe('The preview could not be read: The broker is gone.')
  })

  it('keeps the answer of the latest read when an earlier one comes back after it', async () => {
    const first = xr.hold('preview')
    const props = { folder: SHOP, reportId: REPORT, experiment: retroExperiment(), read: null, openFolderEpic: null, folderChanged: null }
    const view = render(<CrossRepoCorrection {...props} version={0} />)
    xr.previewAnswer = ok(xrPreview({ state: 'created', link: xrLink(), existing: xrTargetEpic() }))
    view.rerender(<CrossRepoCorrection {...props} version={1} />)
    await settle()
    expect(screen.getByText('Created')).toBeTruthy()
    xr.previewAnswer = ok(xrPreview())
    first.resolve()
    await settle()
    expect(screen.getByText('Created')).toBeTruthy()
    expect(screen.queryByText('Ready')).toBeNull()
  })
})

describe('choosing or forgetting the checkout', () => {
  it('reads a cancelled dialog as no change, and a dialog that fails as refused', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Choose another folder…' }))
    await settle()
    expect(checkout.picks).toBe(1)
    expect(outcome0()).toBeNull()
    checkout.pick = () => Promise.reject(new Error('The dialog could not open.'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose another folder…' }))
    await settle()
    expect(outcome0()).toContain('Choosing the checkout refused (unauthorized)')
    expect(outcome0()).toContain('The dialog could not open.')
  })

  it('forgets the choice, and says so when forgetting fails', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Forget the choice' }))
    await settle()
    expect(checkout.clears).toBe(1)
    expect(outcome0()).toContain('The checkout choice was forgotten (the folder and its data stay as they are).')
    expect(screen.queryByRole('button', { name: 'Forget the choice' })).toBeNull()
    checkout.view = checkoutView()
    checkout.clear = () => Promise.reject(new Error('Settings are read-only.'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Forget the choice' }))
    await settle()
    expect(outcome0()).toContain('Forgetting the choice refused (internal)')
    expect(outcome0()).toContain('Settings are read-only.')
  })
})
