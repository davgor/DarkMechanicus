// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { githubKit, renderWithGithub } from '../__mocks__/githubKit'
import type { GithubKit } from '../__mocks__/githubKit'
import { settle } from '../__mocks__/settle'
import { storageStatus } from '../__mocks__/fixtures'
import type { StorageStatusView } from '../../../shared/domain/views'
import { SidebarFooter } from './SidebarFooter'

let kit: GithubKit

beforeEach(() => {
  kit = githubKit()
})

afterEach(cleanup)

interface Calls {
  flush: number
  reconcile: number
}

interface Options {
  status: StorageStatusView | null
  ready?: boolean
  busy?: { flush: boolean; reconcile: boolean }
}

function renderFooter(options: Options): Calls {
  const calls: Calls = { flush: 0, reconcile: 0 }
  renderWithGithub(
    kit,
    <SidebarFooter
      status={options.status}
      folderReady={options.ready ?? true}
      busy={options.busy ?? { flush: false, reconcile: false }}
      metricsOpen={false}
      onOpenMetrics={() => undefined}
      settingsOpen={false}
      onOpenSettings={() => undefined}
      onFlush={() => {
        calls.flush += 1
      }}
      onReconcile={() => {
        calls.reconcile += 1
      }}
    >
      <span>extra</span>
    </SidebarFooter>
  )
  return calls
}

const sessions = (byRole: Record<string, number>): StorageStatusView =>
  storageStatus({ sessions: { active: 0, byRole } })

describe('SidebarFooter MCP line', () => {
  it('waits for an agent without a status', () => {
    renderFooter({ status: null, ready: false })
    expect(screen.getByText('MCP')).toBeTruthy()
    expect(screen.getByText('Waiting for an agent').className).toContain('tone-muted')
  })

  it('counts connected agent sessions', () => {
    renderFooter({ status: sessions({ desktop: 1, orchestrator: 2 }) })
    expect(screen.getByText('2 agent sessions · stdio').className).toContain('tone-ok')
  })
})

describe('SidebarFooter storage line', () => {
  it('says the repository is not initialized and offers no flush', () => {
    renderFooter({ status: null, ready: false })
    expect(screen.getByText('Not initialized')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Flush' })).toBeNull()
  })

  it('shows uncommitted exported files with a Flush button', () => {
    const calls = renderFooter({ status: storageStatus({ uncommittedRecordFiles: 3 }) })
    expect(screen.getByText('Exported · 3 files uncommitted')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Flush' }))
    expect(calls.flush).toBe(1)
  })

  it('shows a pending save as a warning', () => {
    renderFooter({ status: storageStatus({ outbox: { pending: 1, failed: 0, lastError: null } }) })
    expect(screen.getByText('Save pending').className).toContain('tone-warn')
  })

  it('shows a failed export as an error with the last error as its tooltip', () => {
    renderFooter({ status: storageStatus({ outbox: { pending: 0, failed: 1, lastError: 'disk full' } }) })
    const line = screen.getByText('Export failed')
    expect(line.className).toContain('tone-error')
    expect(line.getAttribute('title')).toBe('disk full')
  })

  it('disables Flush while flushing', () => {
    renderFooter({ status: storageStatus(), busy: { flush: true, reconcile: false } })
    expect((screen.getByRole('button', { name: 'Flush' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SidebarFooter branch warning', () => {
  const changed = storageStatus({ branch: { recorded: 'main', current: 'feature/x', changed: true, repository: true } })

  it('is absent while the branch matches', () => {
    renderFooter({ status: storageStatus() })
    expect(screen.queryByText(/Branch changed/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reconcile' })).toBeNull()
  })

  it('warns and offers Reconcile after a branch change', () => {
    const calls = renderFooter({ status: changed })
    expect(screen.getByText('Branch changed: main → feature/x')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }))
    expect(calls.reconcile).toBe(1)
  })

  it('disables Reconcile while reconciling', () => {
    renderFooter({ status: changed, busy: { flush: false, reconcile: true } })
    expect((screen.getByRole('button', { name: 'Reconcile' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders extra footer content', () => {
    renderFooter({ status: null })
    expect(screen.getByText('extra')).toBeTruthy()
  })
})

describe('SidebarFooter GitHub line', () => {
  it('offers Sign in to GitHub while signed out, which opens the dialog', async () => {
    renderFooter({ status: null })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'Sign in to GitHub' })
    expect(within(dialog).getByRole('button', { name: 'Use my GitHub CLI login' })).toBeTruthy()
    expect(kit.github.calls).not.toContain('signIn')
  })

  it('shows @login with the name as title while signed in', async () => {
    kit.github.account = { login: 'octocat', name: 'Mona Lisa' }
    renderFooter({ status: null })
    await settle()
    expect(screen.getByText('@octocat').getAttribute('title')).toBe('Mona Lisa')
    expect(screen.queryByRole('button', { name: 'Sign in to GitHub' })).toBeNull()
  })

  it('signs out from the account menu', async () => {
    kit.github.account = { login: 'octocat', name: null }
    renderFooter({ status: null })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'GitHub account' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Sign out' }))
    await settle()
    expect(kit.github.calls).toContain('signOut')
    expect(screen.getByRole('button', { name: 'Sign in to GitHub' })).toBeTruthy()
  })

  it('opens the GitHub application settings from the account menu', async () => {
    kit.github.account = { login: 'octocat', name: null }
    renderFooter({ status: null })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'GitHub account' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage access on GitHub' }))
    expect(kit.dm.opened).toEqual(['https://github.com/settings/applications'])
  })

  it('follows an account change from main', async () => {
    renderFooter({ status: null })
    await settle()
    act(() => kit.github.changeAccount({ login: 'hubot', name: null }))
    expect(screen.getByText('@hubot')).toBeTruthy()
  })
})

function renderMetricsLink(options: { ready: boolean; open: boolean }): { opened: number } {
  const calls = { opened: 0 }
  renderWithGithub(
    kit,
    <SidebarFooter
      status={sessions({ desktop: 1, orchestrator: 1 })}
      folderReady={options.ready}
      busy={{ flush: false, reconcile: false }}
      metricsOpen={options.open}
      onOpenMetrics={() => {
        calls.opened += 1
      }}
      settingsOpen={false}
      onOpenSettings={() => undefined}
      onFlush={() => undefined}
      onReconcile={() => undefined}
    />
  )
  return calls
}

const lineOf = (text: string): Element | null => screen.getByText(text).closest('.footer-line')

describe('DM-267 c1: the Metrics link below the MCP line', () => {
  it('DM-272 c4: sits directly after the MCP line, before the export line, for an initialized folder', () => {
    renderMetricsLink({ ready: true, open: false })
    const link = screen.getByRole('button', { name: 'Metrics' })
    const mcpLine = lineOf('MCP')
    expect(mcpLine?.nextElementSibling).toBe(link.closest('.footer-line'))
    expect(link.closest('.footer-line')?.nextElementSibling).toBe(screen.getByRole('button', { name: 'Flush' }).closest('.footer-line'))
  })

  it('is absent for an uninitialized folder', () => {
    renderMetricsLink({ ready: false, open: false })
    expect(screen.queryByRole('button', { name: 'Metrics' })).toBeNull()
    expect(screen.getByText('MCP')).toBeTruthy()
  })

  it('opens the dashboard once per press and is keyboard-focusable', () => {
    const calls = renderMetricsLink({ ready: true, open: false })
    const link = screen.getByRole('button', { name: 'Metrics' })
    link.focus()
    expect(document.activeElement).toBe(link)
    fireEvent.click(link)
    expect(calls.opened).toBe(1)
  })

  it('is the current page only while the dashboard is open', () => {
    renderMetricsLink({ ready: true, open: true })
    expect(screen.getByRole('button', { name: 'Metrics' }).getAttribute('aria-current')).toBe('page')
    cleanup()
    renderMetricsLink({ ready: true, open: false })
    expect(screen.getByRole('button', { name: 'Metrics' }).hasAttribute('aria-current')).toBe(false)
  })
})

describe('sidebar footer disclosure', () => {
  it('keeps the chevron inside the footer and restores the notification row when expanded', async () => {
    renderFooter({ status: null })
    await settle()
    const footer = screen.getByRole('contentinfo')
    const controls = within(footer)
    const collapse = controls.getByRole('button', { name: 'Collapse footer' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(collapse.querySelector('svg')?.getAttribute('data-icon')).toBe('chevron-down')

    fireEvent.click(collapse)
    const expand = controls.getByRole('button', { name: 'Expand footer' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expect(expand.querySelector('svg')?.getAttribute('data-icon')).toBe('chevron-right')
    expect(controls.queryByRole('button', { name: 'Notifications' })).toBeNull()

    fireEvent.click(expand)
    const notifications = controls.getByRole('button', { name: 'Notifications' })
    const bell = notifications.closest('.footer-line')?.firstElementChild
    expect(bell?.getAttribute('data-icon')).toBe('bell')
    expect(bell?.nextElementSibling).toBe(notifications)
  })
})

function renderSettingsLink(open: boolean): { opened: number } {
  const calls = { opened: 0 }
  renderWithGithub(
    kit,
    <SidebarFooter
      status={sessions({ desktop: 1, orchestrator: 1 })}
      folderReady={false}
      busy={{ flush: false, reconcile: false }}
      metricsOpen={false}
      onOpenMetrics={() => undefined}
      settingsOpen={open}
      onOpenSettings={() => {
        calls.opened += 1
      }}
      onFlush={() => undefined}
      onReconcile={() => undefined}
    />
  )
  return calls
}

describe('DM-828 c1: the Settings link', () => {
  it('calls onOpenSettings once per press, with no folder needed, beside a gear icon', () => {
    const calls = renderSettingsLink(false)
    const link = screen.getByRole('button', { name: 'Settings' })
    expect(link.className).toBe('footer-link')
    expect(link.closest('.footer-line')?.querySelector('svg')).toBeTruthy()
    fireEvent.click(link)
    expect(calls.opened).toBe(1)
  })

  it('is the current page only while Settings is open', () => {
    renderSettingsLink(true)
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page')
    cleanup()
    renderSettingsLink(false)
    expect(screen.getByRole('button', { name: 'Settings' }).hasAttribute('aria-current')).toBe(false)
  })
})
