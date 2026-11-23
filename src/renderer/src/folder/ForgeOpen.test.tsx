// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ForgeMemberStatus } from '../../../shared/desktop/forgeWorld'
import { deferred } from '../__mocks__/deferred'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { FORGE_STATUS_MS, ForgeOpen } from './ForgeOpen'

afterEach(cleanup)

const ready: ForgeMemberStatus = { readiness: 'ready', syncing: false, error: null }

function harness(memberStatus: (root: string, member: string) => Promise<ForgeMemberStatus>) {
  const scheduler = new ManualScheduler()
  const sync = vi.fn(async () => undefined)
  const dm = new FakeDm()
  Object.assign(dm, { forge: { memberStatus, sync } })
  window.dm = dm
  const show = (root: string, member: string, title: string, identity?: string) => (
    <ForgeOpen root={root} member={member} identity={identity} scheduler={scheduler} fullHeight>
      <label>{title}<input /></label>
    </ForgeOpen>
  )
  const poll = async () => {
    act(() => scheduler.fireIntervals(FORGE_STATUS_MS))
    await settle()
  }
  return { show, poll, sync }
}

it('keeps a ready local editor editable while fetching and after the remote fails', async () => {
  let reply = ready
  const h = harness(async () => reply)
  render(h.show('/world', '/world/member', 'Ticket draft'))
  const draft = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Ticket draft' })
  fireEvent.change(draft, { target: { value: 'Work in progress' } })
  reply = { ...ready, syncing: true }
  await h.poll()
  expect(screen.getByRole('status').textContent).toContain('in the background')
  expect(screen.getByRole('textbox', { name: 'Ticket draft' })).toBe(draft)
  fireEvent.change(draft, { target: { value: 'Still editing during sync' } })
  reply = { ...ready, error: 'Forge remote is offline' }
  await h.poll()
  expect(screen.getByRole('status').textContent).toContain('Forge remote is offline')
  expect(draft.value).toBe('Still editing during sync')
  expect(h.sync).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
  await settle()
  expect(h.sync).toHaveBeenCalledExactlyOnceWith('/world')
  expect(draft.value).toBe('Still editing during sync')
})

it('renders a warmed member on revisit while its local status rechecks', async () => {
  const held = deferred()
  let block = false
  const h = harness(async () => {
    if (block) await held.promise
    return ready
  })
  const member = '/world/member'
  const first = render(h.show('/world', member, 'First view', 'same-project'))
  await screen.findByRole('textbox', { name: 'First view' })
  first.unmount()
  block = true
  const second = render(h.show('/world', member, 'Another view', 'same-project'))
  expect(screen.getByRole('textbox', { name: 'Another view' })).toBeTruthy()
  second.rerender(h.show('/world', member, 'Another project', 'new-project'))
  expect(screen.queryByRole('textbox')).toBeNull()
  held.resolve()
  await settle()
  expect(screen.getByRole('textbox', { name: 'Another project' })).toBeTruthy()
})

it('waits for a cold local import and removes vanished members', async () => {
  let reply: ForgeMemberStatus = { readiness: 'preparing', syncing: true, error: null }
  const h = harness(async () => reply)
  render(h.show('/world', '/world/member', 'Ticket draft'))
  await settle()
  expect(screen.getByRole('status').textContent).toContain('Preparing Forge World tickets')
  expect(screen.queryByRole('textbox')).toBeNull()
  reply = ready
  await h.poll()
  expect(screen.getByRole('textbox')).toBeTruthy()
  reply = { ...ready, readiness: 'removed' }
  await h.poll()
  expect(screen.getByRole('status').textContent).toContain('no longer in the Forge World')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(h.sync).not.toHaveBeenCalled()
})

it('coalesces mounted status checks and fences a late reply from the previous world', async () => {
  const old = deferred()
  const lane = vi.fn(async (root: string) => {
    if (root === '/old') {
      await old.promise
      return ready
    }
    return { ...ready, readiness: 'preparing' as const }
  })
  const h = harness(lane)
  const view = render(h.show('/old', '/old/member', 'Old editor'))
  await h.poll()
  expect(lane).toHaveBeenCalledTimes(1)
  view.rerender(h.show('/new', '/new/member', 'New editor'))
  old.resolve()
  await settle()
  expect(lane.mock.calls).toEqual([['/old', '/old/member'], ['/new', '/new/member']])
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Preparing local Forge World tickets')
})
