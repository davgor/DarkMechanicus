// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GrantView } from '../../../shared/domain/views'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { GrantsCard } from './GrantsCard'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  dm.responses.listGrants = []
})

afterEach(cleanup)

function grant(patch: Partial<GrantView> = {}): GrantView {
  return {
    id: 'gr_00000000000000000000000001',
    role: 'orchestrator',
    allowSave: false,
    label: 'dm CLI',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T08:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    active: true,
    ...patch
  }
}

async function renderCard(): Promise<void> {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <GrantsCard folder={folderView()} />
    </ToastProvider>
  )
  await settle()
}

const card = (): HTMLElement => screen.getByRole('region', { name: 'Agent access' })
const press = (name: string): void => {
  fireEvent.click(within(card()).getByRole('button', { name }))
}

describe('GrantsCard: the issue form', () => {
  it('issues what the person chose: label, expiry and the save option', async () => {
    dm.responses.issueGrant = { grant: grant(), token: 'dmg_secret' }
    await renderCard()
    press('Authorize an agent')

    fireEvent.change(within(card()).getByLabelText('Label'), { target: { value: '  Release bot  ' } })
    fireEvent.change(within(card()).getByLabelText('Expires after'), { target: { value: String(24 * 60) } })
    fireEvent.click(within(card()).getByRole('checkbox', { name: /save plans/i }))
    press('Authorize')
    await settle()

    expect(dm.callsOf('issueGrant')[0]?.input).toEqual({ role: 'orchestrator', label: 'Release bot', minutes: 24 * 60, allowSave: true })
  })

  it('falls back to the default label when the person clears it', async () => {
    dm.responses.issueGrant = { grant: grant(), token: 'dmg_secret' }
    await renderCard()
    press('Authorize an agent')

    fireEvent.change(within(card()).getByLabelText('Label'), { target: { value: '   ' } })
    press('Authorize')
    await settle()

    expect(dm.callsOf('issueGrant')[0]?.input).toMatchObject({ label: 'dm CLI' })
  })

  it('closes the form with Cancel, issuing nothing', async () => {
    await renderCard()
    press('Authorize an agent')

    press('Cancel')

    expect(within(card()).queryByLabelText('Role')).toBeNull()
    expect(within(card()).getByRole('button', { name: 'Authorize an agent' })).toBeTruthy()
    expect(dm.callsOf('issueGrant')).toEqual([])
  })
})

describe('GrantsCard: the token shown once', () => {
  it('copies the token, says so, and is gone once the person is done', async () => {
    dm.responses.issueGrant = { grant: grant(), token: 'dmg_secret' }
    await renderCard()
    press('Authorize an agent')
    press('Authorize')
    await settle()

    press('Copy')
    expect(dm.copied).toEqual(['dmg_secret'])
    expect(screen.getByRole('status').textContent).toContain('Token copied.')
    press('Done')

    expect(within(card()).queryByRole('group', { name: 'New grant token' })).toBeNull()
    expect(card().textContent).not.toContain('dmg_secret')
  })
})

describe('GrantsCard: states and failures', () => {
  it('shows a grant past its expiry as expired, with nothing to revoke', async () => {
    dm.responses.listGrants = [grant({ active: false })]
    await renderCard()

    expect(card().textContent).toContain('Expired')
    expect(within(card()).queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('says why the grants could not be read, and keeps loading', async () => {
    dm.failures.listGrants = { code: 'internal', message: 'The database is locked.' }
    await renderCard()

    expect(screen.getByRole('alert').textContent).toContain('The database is locked.')
    expect(card().textContent).toContain('Loading grants…')
  })

  it('says why a revoke was refused, and keeps the grant listed as active', async () => {
    dm.responses.listGrants = [grant()]
    dm.failures.revokeGrant = { code: 'unauthorized', message: 'Not permitted' }
    await renderCard()

    press('Revoke')
    await settle()

    expect(screen.getByRole('alert').textContent).toContain('Not permitted')
    expect(card().textContent).toContain('Active')
    expect(dm.callsOf('listGrants')).toHaveLength(1)
  })
})
