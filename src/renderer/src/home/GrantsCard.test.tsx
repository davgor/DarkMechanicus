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

function renderCard(): void {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <GrantsCard folder={folderView()} />
    </ToastProvider>
  )
}

const card = (): HTMLElement => screen.getByRole('region', { name: 'Agent access' })

describe('GrantsCard listing', () => {
  it('says so when the folder has delegated nothing', async () => {
    dm.responses.listGrants = []
    renderCard()
    await settle()
    expect(card().textContent).toContain('No grants yet')
  })

  it('shows each grant with its role and state', async () => {
    dm.responses.listGrants = [
      grant({ label: 'Live one' }),
      grant({ id: 'gr_2', label: 'Old one', active: false, revokedAt: '2026-01-01T01:00:00.000Z' })
    ]
    renderCard()
    await settle()
    expect(card().textContent).toContain('Live one')
    expect(card().textContent).toContain('Active')
    expect(card().textContent).toContain('Revoked')
  })

  it('offers Revoke only for a grant that still works', async () => {
    dm.responses.listGrants = [grant({ active: false, revokedAt: '2026-01-01T01:00:00.000Z' })]
    renderCard()
    await settle()
    expect(within(card()).queryByRole('button', { name: 'Revoke' })).toBeNull()
  })
})

describe('GrantsCard issuing', () => {
  it('issues the chosen role and shows the token once, with a warning', async () => {
    dm.responses.listGrants = []
    dm.responses.issueGrant = { grant: grant(), token: 'dmg_secret' }
    renderCard()
    await settle()
    fireEvent.click(within(card()).getByRole('button', { name: 'Authorize an agent' }))
    fireEvent.click(within(card()).getByRole('button', { name: 'Authorize' }))
    await settle()
    expect(dm.callsOf('issueGrant')[0]?.input).toMatchObject({ role: 'orchestrator', label: 'dm CLI' })
    const shown = within(card()).getByRole('group', { name: 'New grant token' })
    expect(shown.textContent).toContain('dmg_secret')
    expect(shown.textContent).toMatch(/shown once/i)
  })

  it('offers the save option only for a role that can author a plan', async () => {
    dm.responses.listGrants = []
    renderCard()
    await settle()
    fireEvent.click(within(card()).getByRole('button', { name: 'Authorize an agent' }))
    const saveOption = (): HTMLElement | null => within(card()).queryByRole('checkbox', { name: /save plans/i })
    expect(saveOption()).not.toBeNull()
    fireEvent.change(within(card()).getByLabelText('Role'), { target: { value: 'worker' } })
    expect(saveOption()).toBeNull()
  })

  it('reloads the list after issuing, so the new grant appears', async () => {
    dm.responses.listGrants = []
    dm.responses.issueGrant = { grant: grant(), token: 'dmg_secret' }
    renderCard()
    await settle()
    fireEvent.click(within(card()).getByRole('button', { name: 'Authorize an agent' }))
    fireEvent.click(within(card()).getByRole('button', { name: 'Authorize' }))
    await settle()
    expect(dm.callsOf('listGrants')).toHaveLength(2)
  })

  it('reports a refusal instead of pretending it worked', async () => {
    dm.responses.listGrants = []
    dm.failures.issueGrant = { code: 'unauthorized', message: 'Not permitted' }
    renderCard()
    await settle()
    fireEvent.click(within(card()).getByRole('button', { name: 'Authorize an agent' }))
    fireEvent.click(within(card()).getByRole('button', { name: 'Authorize' }))
    await settle()
    expect(within(card()).queryByRole('group', { name: 'New grant token' })).toBeNull()
  })
})

describe('GrantsCard revoking', () => {
  it('revokes the grant and reloads', async () => {
    dm.responses.listGrants = [grant()]
    dm.responses.revokeGrant = grant({ active: false, revokedAt: '2026-01-01T02:00:00.000Z' })
    renderCard()
    await settle()
    fireEvent.click(within(card()).getByRole('button', { name: 'Revoke' }))
    await settle()
    expect(dm.callsOf('revokeGrant')[0]?.input).toEqual({ grantId: 'gr_00000000000000000000000001' })
    expect(dm.callsOf('listGrants')).toHaveLength(2)
  })
})
