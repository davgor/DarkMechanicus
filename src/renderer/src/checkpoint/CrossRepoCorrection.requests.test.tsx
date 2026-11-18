// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DM, KEY, REPORT, SHOP, checkoutView, retroExperiment, xrLink, xrPreview, xrResult, xrTargetEpic } from '../__mocks__/crossRepoFixtures'
import { FakeCrossRepoCorrections, FakeSourceCheckout, ok, refused } from '../__mocks__/fakeCrossRepoCorrections'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { CrossRepoCorrectionLinkView, CrossRepoResultsView } from '../../../shared/domain/crossRepoCorrections'
import { CrossRepoCorrection } from './CrossRepoCorrection'

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

const PROPS = { folder: SHOP, reportId: REPORT, experiment: retroExperiment(), read: null, openFolderEpic: null, folderChanged: null }

async function renderPanel(): Promise<void> {
  render(<CrossRepoCorrection {...PROPS} version={0} />)
  await settle()
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

function outcome(): string | null {
  return screen.queryByRole('status', { name: 'What the last request did' })?.textContent ?? null
}

const PENDING_LINK = xrLink({ state: 'pending', target: null, linkedAt: null })

function results(patch: Partial<CrossRepoResultsView> = {}): CrossRepoResultsView {
  return {
    readAt: '2026-11-12T09:00:00.000Z',
    epicId: 'ep_fix',
    epicTitle: 'Correction from Shop: slow claims',
    tickets: [
      { key: 'DM-7', title: 'Cache the claim packet', role: 'work', acceptedAt: '2026-11-11T09:00:00.000Z' },
      { key: 'DM-8', title: 'Grade it', role: 'fireguard', acceptedAt: null }
    ],
    grades: [],
    ...patch
  }
}

describe('withdrawing a pending request whose target cannot be checked', () => {
  it('asks for confirmation, withdraws without checking once confirmed, and dismisses the outcome', async () => {
    xr.previewAnswer = ok(xrPreview({ state: 'pending', link: PENDING_LINK }))
    xr.onWithdraw = (input) =>
      input.confirmUnverified === true ? ok({ withdrawn: PENDING_LINK, verified: false }) : refused({ code: 'conflict', message: 'The checkout cannot be read.', details: { problem: 'unverified' } })
    await renderPanel()
    fireEvent.click(button('Withdraw the request'))
    await settle()
    expect(outcome()).toBe('Withdrawal refused (conflict) The checkout cannot be read.Withdraw anyway, without checking the targetDismiss')
    fireEvent.click(button('Withdraw anyway, without checking the target'))
    await settle()
    expect(xr.callsOf('withdraw')).toEqual([
      { folder: SHOP, input: { key: KEY, confirmUnverified: false } },
      { folder: SHOP, input: { key: KEY, confirmUnverified: true } }
    ])
    expect(outcome()).toMatch(/^Withdrawn without checking the Dark Mechanicus source/)
    expect(screen.queryByRole('button', { name: 'Withdraw anyway, without checking the target' })).toBeNull()
    fireEvent.click(button('Dismiss'))
    expect(outcome()).toBeNull()
  })

  it('reads a checked withdrawal as verified and offers no unchecked one', async () => {
    xr.previewAnswer = ok(xrPreview({ state: 'pending', link: PENDING_LINK }))
    xr.onWithdraw = () => ok({ withdrawn: PENDING_LINK, verified: true })
    await renderPanel()
    fireEvent.click(button('Withdraw the request'))
    await settle()
    expect(outcome()).toMatch(/^Withdrawn: the Dark Mechanicus source was checked and holds none of it/)
    expect(screen.queryByRole('button', { name: 'Withdraw anyway, without checking the target' })).toBeNull()
  })
})

describe('a retry that cannot succeed', () => {
  it('says retrying cannot change it', async () => {
    xr.previewAnswer = ok(xrPreview({ state: 'pending', link: PENDING_LINK }))
    xr.onRetry = () => ok(xrResult({ progress: 'pending', target: null, failure: { step: 'target', error: { code: 'conflict', message: 'Another payload.' }, retryable: false }, nextSteps: [] }))
    await renderPanel()
    fireEvent.click(button('Retry the request'))
    await settle()
    expect(outcome()).toContain('Retryable: no')
    expect(outcome()).toContain('Retrying the same request cannot change this')
  })
})

function linkedWith(found: CrossRepoResultsView | null): CrossRepoCorrectionLinkView {
  return xrLink({ results: found })
}

describe('bringing back the correction epic’s grades', () => {
  it('collects the grades of a linked request and shows them with what can be cited', async () => {
    const grade = { reportId: 'rp_dm1', reportRevision: 1, runId: 'rn_dm', sprintId: 'sp_fix', assessmentId: 'as_dm', subject: { level: 'sprint' as const, id: 'sp_fix' }, from: null, to: '2026-11-11T17:00:00.000Z', value: 3_000_000, state: 'observed' as const }
    xr.previewAnswer = ok(xrPreview({ state: 'created', link: xrLink(), existing: xrTargetEpic() }))
    xr.links = [linkedWith(null)]
    xr.onCollect = () => {
      xr.links = [linkedWith(results({ grades: [grade] }))]
      return ok(xr.links[0]!)
    }
    await renderPanel()
    expect(screen.queryByText('Its grades', { selector: 'dt' })).toBeNull()
    fireEvent.click(button('Bring back its grades'))
    await settle()
    expect(xr.callsOf('collectResults')).toEqual([{ folder: SHOP, input: KEY }])
    expect(outcome()).toContain('Brought back 1 grade(s) of "Correction from Shop: slow claims"')
    const grades = screen.getByText('Its grades', { selector: 'dt' }).nextElementSibling!
    expect(grades.textContent).toContain('Work tickets accepted: 1 of 1.')
    expect(within(grades as HTMLElement).getByText(/^T\.actual_ms 3,000,000 milliseconds \(observed\) · sprint grade of report rp_dm1 revision 1 · window no dispatch to/)).toBeTruthy()
  })

  it('says when no grade was brought back yet', async () => {
    xr.previewAnswer = ok(xrPreview({ state: 'created', link: xrLink(), existing: xrTargetEpic() }))
    xr.links = [linkedWith(results())]
    xr.onCollect = () => ok(linkedWith(null))
    await renderPanel()
    expect(screen.getByText('No frozen sprint grade yet: its runs have not reached a checkpoint report.')).toBeTruthy()
    fireEvent.click(button('Bring back its grades'))
    await settle()
    expect(outcome()).toContain('Brought back 0 grade(s) of "the correction epic"')
  })
})

describe('creating a new epic after the earlier one went missing', () => {
  it('can be cancelled at the confirmation, creating nothing', async () => {
    xr.previewAnswer = ok(xrPreview({ state: 'created', link: xrLink(), needsRecreate: true }))
    await renderPanel()
    fireEvent.click(button('Create a new epic in Dark Mechanicus'))
    fireEvent.click(button('Cancel'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button('Create a new epic in Dark Mechanicus').disabled).toBe(false)
    expect(xr.callsOf('create')).toEqual([])
  })
})
