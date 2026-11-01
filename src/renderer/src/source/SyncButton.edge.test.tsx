// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoStatus } from '../../../shared/git/status'
import { FakeGit } from '../__mocks__/fakeGit'
import { githubKit, renderWithGithub } from '../__mocks__/githubKit'
import type { GithubKit } from '../__mocks__/githubKit'
import { settle } from '../__mocks__/settle'
import { SyncButton } from './SyncButton'

const FOLDER = '/work/alpha'
const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const MINUTE = 60_000

let kit: GithubKit

beforeEach(() => {
  kit = githubKit()
  window.git = new FakeGit()
})

afterEach(cleanup)

function status(lastFetchedAt: string | null, branch: Partial<RepoStatus['branch']> = {}): RepoStatus {
  return {
    root: FOLDER,
    branch: { name: 'main', headOid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, ...branch },
    files: [],
    inProgress: null,
    lastFetchedAt,
    remote: { name: 'origin', githubHttps: false }
  }
}

async function mount(value: RepoStatus): Promise<void> {
  renderWithGithub(kit, <SyncButton folderPath={FOLDER} status={value} scheduler={kit.scheduler} now={() => NOW} onRefresh={() => undefined} />)
  await settle()
}

const fetchedAgo = (ms: number): string => new Date(NOW - ms).toISOString()
const fetchedLine = (): string => screen.getByTestId('sync-primary').querySelector('.sync-fetched')?.textContent ?? ''

describe('SyncButton last fetched line', () => {
  it.each([
    { ago: 30_000, line: 'Last fetched just now' },
    { ago: -5 * MINUTE, line: 'Last fetched just now' },
    { ago: MINUTE, line: 'Last fetched 1 minute ago' },
    { ago: 60 * MINUTE, line: 'Last fetched 1 hour ago' },
    { ago: 5 * 60 * MINUTE + 59 * MINUTE, line: 'Last fetched 5 hours ago' },
    { ago: 24 * 60 * MINUTE, line: 'Last fetched 1 day ago' },
    { ago: 3 * 24 * 60 * MINUTE, line: 'Last fetched 3 days ago' }
  ])('says "$line" $ago ms after the fetch', async ({ ago, line }) => {
    await mount(status(fetchedAgo(ago)))
    expect(fetchedLine()).toBe(line)
  })

  it('says Never fetched for a timestamp it cannot read', async () => {
    await mount(status('not a date'))
    expect(fetchedLine()).toBe('Never fetched')
  })
})

describe('SyncButton counts', () => {
  it('shows no counts when even, and only the behind count when not ahead', async () => {
    await mount(status(null))
    expect(screen.getByTestId('sync-primary').querySelector('.sync-counts')).toBeNull()
    cleanup()
    await mount(status(null, { behind: 4 }))
    expect(screen.getByTestId('sync-primary').querySelector('.sync-counts')?.textContent).toBe('↓4')
  })

  it('separates behind and ahead with a space', async () => {
    await mount(status(null, { behind: 1, ahead: 7 }))
    expect(screen.getByTestId('sync-primary').querySelector('.sync-counts')?.textContent).toBe('↓1 ↑7')
  })
})
