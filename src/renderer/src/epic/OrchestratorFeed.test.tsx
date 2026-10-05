// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry, RunTimelineView } from '../../../shared/domain/activity'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { TIMELINE_POLL_MS } from '../app/useActivityTimeline'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { iso, runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

let scheduler: ManualScheduler
let requests: unknown[]

beforeAll(() => {
  installDomShims()
})

beforeEach(() => {
  scheduler = new ManualScheduler()
  requests = []
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SECOND = 1000

function started(): ActivityEntry {
  return { kind: 'run', id: 'event:1', at: iso(-60 * SECOND), sessionId: 'ss_orch', change: 'started', reason: null }
}

function claimed(): ActivityEntry {
  return {
    kind: 'claim',
    id: 'event:2',
    at: iso(-30 * SECOND),
    sessionId: 'ss_orch',
    attemptId: 'at_202_1',
    ticketId: 'tk_202',
    number: 1,
    worker: { label: 'Claude Code subagent', modelId: 'claude-sonnet-5-5', hostId: 'host_1', effort: 'low', rationale: 'Top fit for <b>small</b> tickets' }
  }
}

function submitted(): ActivityEntry {
  return { kind: 'submitted', id: 'event:3', at: iso(-5 * SECOND), sessionId: 'ss_w', attemptId: 'at_202_1', ticketId: 'tk_202', summary: 'Drawer added' }
}

function page(entries: ActivityEntry[], cursor: number, patch: Partial<RunTimelineView> = {}): RunTimelineView {
  const orchestrator = entries.filter((entry) => entry.sessionId === 'ss_orch')
  const worker = entries.filter((entry) => entry.sessionId === 'ss_w')
  const groups = [
    { session: { id: 'ss_orch', role: 'orchestrator' as const, label: 'Claude Code in chat' }, entries: orchestrator },
    { session: { id: 'ss_w', role: 'worker' as const, label: 'Claude Code subagent' }, entries: worker }
  ].filter((group) => group.entries.length > 0)
  return { runId: 'rn_2', epicId: 'ep_1', state: 'running', isLive: true, cursor, groups, ...patch }
}

function serve(backend: FakeBackend, ...pages: RunTimelineView[]): void {
  backend.handlers.getRunTimeline = (input: unknown) => {
    requests.push(input)
    return pages.length > 1 ? pages.shift() : pages[0]
  }
}

async function poll(): Promise<void> {
  act(() => scheduler.fireIntervals())
  await settle()
}

function open(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Orchestrator feed' })
}

describe('the orchestrator chip', () => {
  it('appears while the run is active, named for the orchestrator session', async () => {
    const backend = new FakeBackend()
    serve(backend, page([started()], 1))
    renderWorkspace(backend, { scheduler })
    expect(await screen.findByRole('button', { name: 'Claude Code in chat' })).toBeTruthy()
    expect(within(screen.getByLabelText('Run')).getByRole('button', { name: 'Claude Code in chat' })).toBeTruthy()
  })

  it('says Orchestrator until an orchestrator session has acted', async () => {
    renderWorkspace(new FakeBackend(), { scheduler })
    expect(await screen.findByRole('button', { name: 'Orchestrator' })).toBeTruthy()
  })

  it.each(['queued', 'paused', 'awaiting_checkpoint'] as const)('stays for a %s run', async (state) => {
    renderWorkspace(new FakeBackend(scenario({ run: runView({ state }) })), { scheduler })
    expect(await screen.findByRole('button', { name: 'Orchestrator' })).toBeTruthy()
  })

  it('is absent when the run has ended and when there is no run', async () => {
    renderWorkspace(new FakeBackend(scenario({ run: runView({ state: 'canceled', endedAt: iso(-SECOND) }) })), { scheduler })
    await screen.findByText(/Run #2/)
    expect(screen.queryByRole('button', { name: 'Orchestrator' })).toBe(null)
    expect(scheduler.intervals()).toEqual([])
    cleanup()
    renderWorkspace(new FakeBackend(scenario({ run: null })), { scheduler })
    await screen.findByLabelText('Epic workspace')
    await settle()
    expect(screen.queryByRole('button', { name: 'Orchestrator' })).toBe(null)
  })

  it('has a hourglass that turns, and holds still when the person prefers reduced motion', async () => {
    renderWorkspace(new FakeBackend(), { scheduler })
    const chip = await screen.findByRole('button', { name: 'Orchestrator' })
    expect(chip.getAttribute('data-motion')).toBe('turning')
    expect(chip.querySelector('svg[data-icon="hourglass"]')).not.toBe(null)
    cleanup()
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }))
    renderWorkspace(new FakeBackend(), { scheduler })
    expect((await screen.findByRole('button', { name: 'Orchestrator' })).getAttribute('data-motion')).toBe('still')
  })
})

describe('the live feed', () => {
  it('opens from the chip and shows the run, with a claim’s model and rationale as plain text', async () => {
    const backend = new FakeBackend()
    serve(backend, page([started(), claimed()], 2))
    renderWorkspace(backend, { scheduler })
    const chip = await screen.findByRole('button', { name: 'Claude Code in chat' })
    expect(screen.queryByRole('region', { name: 'Orchestrator feed' })).toBe(null)
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chip)
    const feed = await open()
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(within(feed).getByText('Run started')).toBeTruthy()
    expect(within(feed).getByText('attempt #1 by Claude Code subagent')).toBeTruthy()
    expect(within(feed).getByText('claude-sonnet-5-5')).toBeTruthy()
    expect(within(feed).getByText('Top fit for <b>small</b> tickets')).toBeTruthy()
    expect(feed.querySelector('b')).toBe(null)
  })

  it('opens the ticket panel from an entry about a ticket', async () => {
    const backend = new FakeBackend()
    serve(backend, page([started(), claimed()], 2))
    renderWorkspace(backend, { scheduler })
    fireEvent.click(await screen.findByRole('button', { name: 'Claude Code in chat' }))
    const feed = await open()
    expect(screen.queryByLabelText('Ticket DM-202')).toBe(null)
    fireEvent.click(within(feed).getByRole('button', { name: 'DM-202' }))
    expect(await screen.findByLabelText('Ticket DM-202')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Orchestrator feed' })).toBe(null)
  })
})

describe('the drawer', () => {
  it('closes with Escape and with its Close button', async () => {
    renderWorkspace(new FakeBackend(), { scheduler })
    const chip = await screen.findByRole('button', { name: 'Orchestrator' })
    fireEvent.click(chip)
    fireEvent.keyDown(await open(), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Orchestrator feed' })).toBe(null)
    fireEvent.click(chip)
    fireEvent.click(within(await open()).getByRole('button', { name: 'Close feed' }))
    expect(screen.queryByRole('region', { name: 'Orchestrator feed' })).toBe(null)
  })

  it('says so while there is nothing to show, and when the feed cannot be read', async () => {
    const backend = new FakeBackend()
    renderWorkspace(backend, { scheduler })
    fireEvent.click(await screen.findByRole('button', { name: 'Orchestrator' }))
    expect(await within(await open()).findByText('Nothing has happened in this run yet.')).toBeTruthy()
    cleanup()
    const broken = new FakeBackend()
    broken.handlers.getRunTimeline = () => {
      throw new Error('feed offline')
    }
    renderWorkspace(broken, { scheduler })
    fireEvent.click(await screen.findByRole('button', { name: 'Orchestrator' }))
    expect(await within(await open()).findByText('The run feed could not be read.')).toBeTruthy()
  })
})

describe('following the run', () => {
  it('updates without a reload, then stops polling once the run has ended', async () => {
    const backend = new FakeBackend()
    serve(
      backend,
      page([started(), claimed()], 2),
      page([submitted()], 3),
      page([], 3, { state: 'canceled', isLive: false })
    )
    renderWorkspace(backend, { scheduler })
    fireEvent.click(await screen.findByRole('button', { name: 'Claude Code in chat' }))
    const feed = await open()
    expect(scheduler.intervals()).toEqual([TIMELINE_POLL_MS])
    expect(within(feed).queryByText('Drawer added')).toBe(null)
    expect(within(feed).getByText('Live')).toBeTruthy()

    await poll()
    expect(within(feed).getByText('Drawer added')).toBeTruthy()
    expect(within(feed).getByText('Run started')).toBeTruthy()
    expect(requests).toEqual([
      { runId: 'rn_2', sinceSeq: 0, limit: 200 },
      { runId: 'rn_2', sinceSeq: 2, limit: 200 }
    ])
    expect(scheduler.intervals()).toEqual([TIMELINE_POLL_MS])

    await poll()
    expect(within(feed).getByText('Run ended')).toBeTruthy()
    expect(scheduler.intervals()).toEqual([])
    const asked = requests.length
    await poll()
    expect(requests.length).toBe(asked)
  })

  it('stops polling when the workspace goes away', async () => {
    const view = renderWorkspace(new FakeBackend(), { scheduler })
    await screen.findByRole('button', { name: 'Orchestrator' })
    expect(scheduler.intervals()).toEqual([TIMELINE_POLL_MS])
    view.unmount()
    expect(scheduler.intervals()).toEqual([])
  })
})
