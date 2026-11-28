/**
 * DM-975: the record maintenance a session does around its commands. An ordinary session flushes the pending outbox and
 * drops staged images past their retention when it opens, and flushes again after each mutating command; a `dm` CLI
 * lease session (a heartbeat) does neither, and a desktop that defers its open reconcile leaves the open flush to its
 * sync lane.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pngBytes } from '../test/images'
import { createHarness, TEST_STORAGE, type Harness } from '../test/workspaceHarness'
import { addSeconds } from './clock'
import { createStagedAttachment } from './services/attachments'
import { enqueueOutbox } from './services/outbox'
import { openWorkspace, type OpenWorkspaceOptions, type Workspace } from './workspace'

let harness: Harness
let desktop: Workspace
let epicId: string

beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Open modes' })
  epicId = (await desktop.createEpic({ title: 'Tracked work' })).id
})

afterEach(() => {
  harness.cleanup()
})

const count = (sql: string) => desktop.ctx().db.get<{ n: number }>(sql)?.n ?? -1
const pendingOutbox = () => count("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'")
const stagedImages = () => count('SELECT COUNT(*) AS n FROM attachments WHERE owner_kind IS NULL')

/** Leaves one pending epic record. */
function queueEpicRecord(): void {
  enqueueOutbox(desktop.ctx(), { kind: 'epic_state', epicId })
  expect(pendingOutbox()).toBe(1)
}

/** Leaves one pending epic record and one staged image past its seven-day retention. */
function leavePendingWork(): void {
  createStagedAttachment(desktop.ctx(), { bytes: pngBytes(8, 8), label: 'Unclaimed shot', purpose: 'evidence' })
  harness.clock.advanceSeconds(8 * 24 * 60 * 60)
  queueEpicRecord()
  expect(stagedImages()).toBe(1)
}

/** Opens a session as the `dm` CLI does, with `options` over that. */
function cliSession(options: Partial<OpenWorkspaceOptions>): Workspace {
  return openWorkspace({
    repoRoot: harness.root, role: 'reader', label: 'dm CLI', transport: 'cli', homeDir: harness.homeDir,
    clock: harness.clock, git: harness.git, ...TEST_STORAGE, ...options
  })
}

describe('opening a session', () => {
  it.each<[string, Partial<OpenWorkspaceOptions>]>([
    ['an ordinary dm CLI session', {}],
    ['a dm CLI session that asked to defer reconcile, which only a desktop may', { deferOpenReconcile: true }],
    ['a stdio session that asked for a lease session, which only the dm CLI opens', { transport: 'stdio', label: 'MCP', leaseOnly: true }],
    ['a desktop session that does not defer reconcile', { transport: 'desktop', role: 'desktop', label: 'Second desktop' }]
  ])('flushes the outbox and prunes stale staged images for %s', (_name, options) => {
    leavePendingWork()
    cliSession(options).close()
    expect([pendingOutbox(), stagedImages()]).toEqual([0, 0])
  })

  it('leaves both to the next ordinary session in a dm CLI lease session', () => {
    leavePendingWork()
    cliSession({ leaseOnly: true }).close()
    expect([pendingOutbox(), stagedImages()]).toEqual([1, 1])
    cliSession({}).close()
    expect([pendingOutbox(), stagedImages()]).toEqual([0, 0])
  })

  it('leaves the flush to the sync lane of a desktop that defers its open reconcile, but still prunes', () => {
    leavePendingWork()
    cliSession({ transport: 'desktop', role: 'desktop', label: 'Deferring desktop', deferOpenReconcile: true }).close()
    expect([pendingOutbox(), stagedImages()]).toEqual([1, 0])
  })
})

describe('after a command', () => {
  it('flushes what is pending after a mutating command, and not after a read', async () => {
    queueEpicRecord()
    await desktop.listEpics()
    expect(pendingOutbox()).toBe(1)
    await desktop.createEpic({ title: 'Another' })
    expect(pendingOutbox()).toBe(0)
  })

  it('renews a heartbeat\'s claim in a dm CLI lease session but flushes nothing, unlike an ordinary session', async () => {
    const { token: grantToken } = await desktop.issueGrant({ role: 'worker', label: 'Card worker' })
    const card = await desktop.createKanbanCard({ title: 'Isolated fix', acceptanceCriteria: ['It is fixed'] })
    await desktop.playKanbanCard({ cardId: card.id })
    const packet = await harness.open('orchestrator').claimKanbanCard({ cardId: card.id })
    const heartbeat = { attemptId: packet.attemptId, claimToken: packet.claimToken ?? '' }
    const lease = cliSession({ grantToken, leaseOnly: true })
    const ordinary = cliSession({ grantToken })
    try {
      queueEpicRecord()
      harness.clock.advanceSeconds(600)
      expect(await lease.heartbeatKanbanCard(heartbeat)).toMatchObject({ state: 'running', leaseExpiresAt: addSeconds(harness.clock.nowIso(), 3600) })
      expect(pendingOutbox()).toBeGreaterThan(0)
      await ordinary.heartbeatKanbanCard(heartbeat)
      expect(pendingOutbox()).toBe(0)
    } finally {
      lease.close()
      ordinary.close()
    }
  })
})
