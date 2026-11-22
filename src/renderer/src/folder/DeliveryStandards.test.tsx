// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StoredDeliveryPolicy } from '../../../shared/domain/deliveryPolicy'
import { defaultPrompts } from '../../../shared/domain/standardsPrompts'
import { folderView } from '../__mocks__/fixtures'
import { DeliveryStandards } from './DeliveryStandards'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const world = folderView({ path: '/world', forgeWorld: { version: 1, owner: 'maintainers', syncMinutes: 5, projects: [] } })
const first = folderView({ name: 'Engine', path: '/world/engine', forgeParent: world.path })
const second = folderView({ name: 'Editor', path: '/world/editor', forgeParent: world.path })

function harness() {
  const records = new Map<string, StoredDeliveryPolicy>()
  const command = vi.fn(async (folder: string, command: string, input?: { policy: StoredDeliveryPolicy['policy']; expectedRevision: number }) => {
    const saved = records.get(folder)
    if (command === 'getProject') return { ok: true, data: { deliveryStandards: saved } }
    if (command !== 'setDeliveryStandards' || !input || input.expectedRevision !== (saved?.revision ?? 0)) throw new Error('Reload and review')
    const next = { revision: input.expectedRevision + 1, policy: input.policy }
    records.set(folder, next)
    return { ok: true, data: next }
  })
  vi.stubGlobal('dm', { command, forge: { sync: async () => {} } })
  const launch = vi.fn(async () => {})
  const show = (folder = first, compact = false) => render(<DeliveryStandards folder={folder} folders={[first, second]} launch={launch} compact={compact} />)
  return { show, records, command, launch }
}

it('accepts defaults in setup, reopens with the four saved prompts, and launches an explicitly confirmed revision', async () => {
  const h = harness()
  h.show(first, true)
  fireEvent.click(await screen.findByRole('button', { name: 'Accept defaults' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept defaults' })).toBeNull())
  expect(h.records.get(first.path)?.policy).toMatchObject({ prompts: defaultPrompts, setupDecision: 'defaults' })
  cleanup()
  h.show()
  expect(await screen.findByText('Saved revision 1')).toBeTruthy()
  expect(screen.getAllByRole('textbox')).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: 'Standardize tickets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Later' }))
  expect(h.launch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Standardize tickets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Yes, apply revision 1' }))
  expect(h.launch).toHaveBeenCalledWith(first, expect.stringContaining('revision 1'))
})

it('edits only the expanded member and prepares a chat for the other member', async () => {
  const h = harness()
  h.show(world)
  fireEvent.click(await screen.findByText('Engine'))
  const ticket = await screen.findByRole('textbox', { name: 'Ticket standards' })
  fireEvent.change(ticket, { target: { value: 'Run both interface contract cases.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save standards' }))
  expect(await screen.findByText('Saved revision 1')).toBeTruthy()
  expect(h.records.get(first.path)?.policy.prompts).toEqual({ ...defaultPrompts, ticket: 'Run both interface contract cases.' })
  expect(h.records.has(second.path)).toBe(false)
  fireEvent.click(screen.getByText('Editor', { selector: 'summary' }))
  const member = screen.getByText('Editor', { selector: 'summary' }).parentElement!
  fireEvent.click(await within(member).findByRole('button', { name: 'Prepare with agent' }))
  expect(h.launch).toHaveBeenCalledWith(second, expect.stringContaining('set_delivery_standards'))
  expect(h.records.has(world.path)).toBe(false)
})

it('surfaces a failed read before offering setup and recovers on explicit reload', async () => {
  const h = harness()
  h.command.mockRejectedValueOnce(new Error('Store unavailable'))
  h.show()
  expect(await screen.findByText(/Store unavailable/)).toBeTruthy()
  expect(screen.queryByText('Accept defaults')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'Accept defaults' })).toBeTruthy()
})
