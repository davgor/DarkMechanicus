import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCapabilityProfile } from '../shared/domain/bundle'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { SCHEMA_VERSION } from './db/migrations'
import { scanKanban } from './repo/kanbanImport'
import { resolveLayout } from './repo/layout'
import { nodeFs } from './repo/nodeFs'
import { observeReconcileInputs } from './repo/reconcileFingerprint'
import type { Workspace } from './workspace'

// Every full reconcile scans the Kanban folder once (before the writer lock, or again under it when the inputs moved).
vi.mock('./repo/kanbanImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repo/kanbanImport')>()
  return { ...actual, scanKanban: vi.fn(actual.scanKanban) }
})

const scans = (): number => vi.mocked(scanKanban).mock.calls.length

/** Full reconcile scans while `action` runs. */
async function scansDuring(action: () => unknown): Promise<number> {
  const before = scans()
  await action()
  return scans() - before
}

function profileFile(harness: Harness, name: string): string {
  return join(harness.root, '.darkmechanicus', 'profiles', `${name}.json`)
}

/** A valid profile record written straight into the tracked records, as a pull would. */
function writeTrackedProfile(harness: Harness, name: string, description = 'Careful review'): void {
  const record = {
    format: 'darkmechanicus.profile', formatVersion: 1, name, description, capability: defaultCapabilityProfile(),
    createdAt: '2026-03-01T09:00:00.000Z', updatedAt: '2026-03-01T09:00:00.000Z'
  }
  writeFileSync(profileFile(harness, name), `${JSON.stringify(record, null, 2)}\n`)
}

async function profiles(workspace: Workspace): Promise<{ name: string; description: string }[]> {
  return (await workspace.listProfiles()).map(({ name, description }) => ({ name, description }))
}

async function savedEpic(agent: Workspace): Promise<string> {
  const epic = await agent.createEpic({ title: 'Fingerprint epic' })
  await dropAcceptanceNodes(agent, epic.id)
  const draft = await agent.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }] })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return epic.id
}

function trackedStatus(harness: Harness, epicId: string): string {
  const state: { status: string } = JSON.parse(readFileSync(join(harness.root, '.darkmechanicus', 'epics', epicId, 'state.json'), 'utf8'))
  return state.status
}

let harness: Harness
let desktop: Workspace

beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'fingerprint-repo' })
  // Settle: the first session after a write reconciles the tree that write exported, and records its fingerprint.
  harness.open('reader')
})

afterEach(() => {
  harness.cleanup()
})

describe('Automatic reconcile on unchanged inputs', () => {
  it('skips the full scan on open and heartbeat while the tree, HEAD and outbox are unchanged', async () => {
    expect(await scansDuring(() => {
      const reader = harness.open('reader')
      reader.heartbeat()
      reader.heartbeat()
    })).toBe(0)
  })

  it('keeps a Kanban heartbeat off the full scan once its card records are exported', async () => {
    const card = await desktop.createKanbanCard({ title: 'Isolated fix', acceptanceCriteria: ['It is fixed'] })
    await desktop.playKanbanCard({ cardId: card.id })
    const packet = await harness.open('orchestrator').claimKanbanCard({ cardId: card.id })
    const claim = { attemptId: packet.attemptId, claimToken: packet.claimToken ?? '' }
    // The first heartbeat moves the attempt to running, a card event that is exported to the tree.
    await harness.open('worker').heartbeatKanbanCard({ ...claim, progressNote: 'Started' })
    expect(await scansDuring(() => harness.open('reader'))).toBe(1)
    expect(await scansDuring(async () => {
      for (const note of ['Editing', 'Testing']) {
        const worker = harness.open('worker')
        expect((await worker.heartbeatKanbanCard({ ...claim, progressNote: note })).progressNote).toBe(note)
        worker.heartbeat()
      }
    })).toBe(0)
  })
})

describe('Automatic reconcile on changed inputs', () => {
  it('reconciles and imports an added, modified or deleted tracked file', async () => {
    writeTrackedProfile(harness, 'deep-review')
    let session = harness.open('reader')
    expect(await profiles(session)).toEqual([{ name: 'deep-review', description: 'Careful review' }])

    writeTrackedProfile(harness, 'deep-review', 'A much more careful review')
    expect(await scansDuring(() => { session = harness.open('reader') })).toBe(1)
    expect(await profiles(session)).toEqual([{ name: 'deep-review', description: 'A much more careful review' }])

    rmSync(profileFile(harness, 'deep-review'))
    expect(await scansDuring(() => harness.open('reader'))).toBe(1)
    expect(await scansDuring(() => harness.open('reader'))).toBe(0)
  })

  it('reconciles on heartbeat when a tracked file changes under an open session', async () => {
    const agent = harness.open('orchestrator')
    writeTrackedProfile(harness, 'deep-review')
    expect(await scansDuring(() => agent.heartbeat())).toBe(1)
    expect(await profiles(agent)).toEqual([{ name: 'deep-review', description: 'Careful review' }])
    expect(await scansDuring(() => agent.heartbeat())).toBe(0)
  })

  it('reconciles when HEAD moves to another commit on the same branch', async () => {
    harness.git.setHead({ branch: 'main', commit: 'b'.repeat(40), detached: false })
    expect(await scansDuring(() => harness.open('reader'))).toBe(1)
    expect(await scansDuring(() => harness.open('reader'))).toBe(0)
  })
})

describe('Automatic reconcile guards', () => {
  it('keeps the branch guard: a moved branch is not reconciled or acknowledged automatically', async () => {
    const epicId = await savedEpic(desktop)
    harness.open('reader')
    harness.git.setHead({ branch: 'feature', commit: 'c'.repeat(40), detached: false })
    let agent = harness.open('orchestrator')
    expect(await scansDuring(() => { agent = harness.open('orchestrator'); agent.heartbeat() })).toBe(0)
    expect((await agent.getStorageStatus()).branch.changed).toBe(true)
    await expect(agent.startRun({ epicId })).rejects.toMatchObject({ code: 'branch_changed' })
    expect((await agent.reconcileRepository()).branchChanged).toBe(true)
    expect((await agent.startRun({ epicId })).state).toBe('running')
  })

  it('still flushes an export left failed when the fingerprint holds', async () => {
    const epicId = await savedEpic(desktop)
    harness.open('reader')
    // Every tracked epic write fails: the status export stays in the outbox, pending with its error, for a retry.
    const epics = join(harness.root, '.darkmechanicus', 'epics')
    const failing = { ...nodeFs, fsyncFile: () => undefined, writeFile: (path: string, data: string) => {
      if (path.startsWith(epics)) throw new Error('Disk full')
      nodeFs.writeFile(path, data)
    } }
    await harness.open('orchestrator', { fs: failing }).setEpicStatus({ epicId, status: 'in_progress' })
    // The new entry changes the local part: this open reconciles in full, records the fingerprint, then fails to flush
    // again, which leaves the entry pending and the fingerprint holding.
    expect(await scansDuring(() => harness.open('reader', { fs: failing }))).toBe(1)
    const held = (await desktop.getStorageStatus()).outbox
    expect([trackedStatus(harness, epicId), held.pending, held.lastError]).toEqual(['backlog', 1, 'Disk full'])

    let reader = desktop
    expect(await scansDuring(() => { reader = harness.open('reader') })).toBe(0)
    expect(trackedStatus(harness, epicId)).toBe('in_progress')
    expect((await reader.getStorageStatus()).outbox).toEqual(expect.objectContaining({ pending: 0, failed: 0 }))
  })

  it('reconciles when only machine-local state the import reads changed', async () => {
    desktop.ctx().db.run("UPDATE meta SET value = '0' WHERE key = 'attachment_registration'")
    expect(await scansDuring(() => harness.open('reader'))).toBe(1)
    expect(desktop.ctx().db.get("SELECT value FROM meta WHERE key = 'attachment_registration'")).toEqual({ value: '1' })
    expect(await scansDuring(() => harness.open('reader'))).toBe(0)
  })
})

describe('Full reconcile', () => {
  it('always runs an explicit reconcile in full', async () => {
    const agent = harness.open('orchestrator')
    expect(await scansDuring(() => agent.reconcileRepository())).toBe(1)
    expect(await scansDuring(() => agent.reconcileRepository())).toBe(1)
    expect(await scansDuring(() => harness.open('reader'))).toBe(0)
  })

  it('keeps reconciling in full while a tracked file is rejected', async () => {
    writeFileSync(profileFile(harness, 'broken'), '{ not json')
    expect((await harness.open('orchestrator').reconcileRepository()).rejected).toHaveLength(1)
    expect(await scansDuring(() => harness.open('reader'))).toBe(1)
    expect(await scansDuring(() => harness.open('reader'))).toBe(1)
  })

  it('belongs to one schema version', () => {
    const db = desktop.ctx().db
    const layout = resolveLayout(harness.root, { mode: 'repo', homeDir: harness.homeDir })
    const deps = { db, layout, fs: nodeFs, git: harness.git }
    expect(observeReconcileInputs(deps).current()).toBe(true)
    expect(observeReconcileInputs({ ...deps, schemaVersion: SCHEMA_VERSION + 1 }).current()).toBe(false)
  })
})
