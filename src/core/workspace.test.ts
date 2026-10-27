import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCapabilityProfile } from '../shared/domain/bundle'
import type { SessionView } from '../shared/domain/views'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { nodeFs } from './repo/nodeFs'
import type { FsAdapter } from './repo/types'
import type { Workspace } from './workspace'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

async function savedEpic(agent: Workspace): Promise<string> {
  await agent.initializeRepository({ name: 'branch-repo' })
  const epic = await agent.createEpic({ title: 'Branch epic' })
  await dropAcceptanceNodes(agent, epic.id)
  const draft = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }]
  })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return epic.id
}

function trackedStatus(harness: Harness, epicId: string): string {
  const file = join(harness.root, '.darkmechanicus', 'epics', epicId, 'state.json')
  return (JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status
}

describe('Workspace branch guard', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('holds portable exports after the checkout moved until the repository is reconciled', async () => {
    const agent = harness.open('orchestrator')
    const epicId = await savedEpic(agent)
    harness.git.setHead({ branch: 'feature', commit: 'c'.repeat(40), detached: false })

    await agent.setEpicStatus({ epicId, status: 'in_progress' })
    expect(trackedStatus(harness, epicId)).toBe('backlog')
    expect(await codeOf(agent.flushPortableState())).toBe('branch_changed')
    const held = await agent.getStorageStatus()
    expect([held.branch.changed, held.outbox.pending]).toEqual([true, 1])

    const reconciled = await agent.reconcileRepository()
    expect(reconciled.branchChanged).toBe(true)
    expect(trackedStatus(harness, epicId)).toBe('in_progress')
    expect((await agent.getStorageStatus()).outbox.pending).toBe(0)
  })

  it('does not silently acknowledge a branch switch that happened while closed', async () => {
    const first = harness.open('orchestrator')
    const epicId = await savedEpic(first)
    first.close()
    harness.git.setHead({ branch: 'feature', commit: 'd'.repeat(40), detached: false })

    const reopened = harness.open('orchestrator')
    expect((await reopened.getStorageStatus()).branch.changed).toBe(true)
    expect(await codeOf(reopened.startRun({ epicId }))).toBe('branch_changed')
    await reopened.reconcileRepository()
    expect((await reopened.startRun({ epicId })).state).toBe('running')
  })
})

describe('Workspace save durability and pinning', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('reports a save as pending, keeping the draft, until the snapshot is durable', async () => {
    let failSnapshots = true
    const fs = {
      ...nodeFs,
      rename: (from: string, to: string) => {
        if (failSnapshots && to.includes(`${sep}snapshots${sep}`)) {
          throw new Error('disk full')
        }
        nodeFs.rename(from, to)
      }
    }
    const agent = harness.open('orchestrator', { fs })
    await agent.initializeRepository({ name: 'durable-repo' })
    const epic = await agent.createEpic({ title: 'Durable epic' })
    const draft = await agent.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'One' } }] })
    const pending = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    expect([pending.status, pending.error]).toEqual(['pending', 'disk full'])
    expect((await agent.getEpic({ epicId: epic.id })).hasDraft).toBe(true)
    expect(await codeOf(agent.getPlan({ epicId: epic.id, view: 'saved' }))).toBe('not_found')

    failSnapshots = false
    expect((await agent.flushPortableState()).failed).toBe(0)
    const saved = await agent.getPlan({ epicId: epic.id, view: 'saved' })
    expect([saved.revisionNumber, (await agent.getEpic({ epicId: epic.id })).hasDraft]).toEqual([1, false])
  })

  it('keeps a running run on its pinned revision after a newer save', async () => {
    const agent = harness.open('orchestrator')
    const epicId = await savedEpic(agent)
    const run = await agent.startRun({ epicId })
    const draft = await agent.updatePlanDraft({ epicId, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Later ticket' } }] })
    const second = await agent.savePlan({ epicId, expectedDraftRevision: draft.draftRevision })
    const current = await agent.getRun({ runId: run.id })
    expect([second.revisionNumber, current?.revisionNumber, current?.revisionId]).toEqual([2, 1, run.revisionId])
    expect(current?.tickets.map((ticket) => ticket.key)).toEqual(['BR-1'])
  })
})

/** A valid profile record written straight into the tracked records, as a pull would. */
function writeTrackedProfile(root: string, name: string): void {
  const record = {
    format: 'darkmechanicus.profile',
    formatVersion: 1,
    name,
    description: 'Careful review',
    capability: defaultCapabilityProfile(),
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z'
  }
  writeFileSync(join(root, '.darkmechanicus', 'profiles', `${name}.json`), `${JSON.stringify(record, null, 2)}\n`)
}

async function profileNames(workspace: Workspace): Promise<string[]> {
  return (await workspace.listProfiles()).map((profile) => profile.name)
}

function roles(sessions: SessionView[]): string[] {
  return sessions.map((session) => session.role).sort()
}

describe('Workspace repository root', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('searches upward for the repository root in stdio sessions only', async () => {
    await harness.open('orchestrator').initializeRepository({ name: 'root-repo' })
    const nested = join(harness.root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    const stdio = harness.open('worker', { root: nested, transport: 'stdio' })
    const inProcess = harness.open('worker', { root: nested })
    expect([stdio.repoRoot, stdio.isInitialized()]).toEqual([realpathSync.native(harness.root), true])
    expect([inProcess.repoRoot, inProcess.isInitialized()]).toEqual([nested, false])
  })
})

describe('Workspace heartbeat', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('stays idle before the repository exists and joins it once another session initializes it', async () => {
    const desktop = harness.open('desktop')
    desktop.heartbeat()
    expect([desktop.isInitialized(), existsSync(join(harness.root, '.darkmechanicus'))]).toEqual([false, false])
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'late-repo' })
    expect(roles(await agent.listSessions())).toEqual(['orchestrator'])
    desktop.heartbeat()
    expect(roles(await agent.listSessions())).toEqual(['desktop', 'orchestrator'])
  })

  it('imports tracked records that changed on disk', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'pull-repo' })
    writeTrackedProfile(harness.root, 'deep-review')
    expect(await profileNames(agent)).toEqual([])
    agent.heartbeat()
    expect(await profileNames(agent)).toEqual(['deep-review'])
  })

  it('leaves changed records for an explicit reconcile when auto-reconcile is off', async () => {
    const agent = harness.open('orchestrator', { autoReconcile: false })
    await agent.initializeRepository({ name: 'manual-repo' })
    writeTrackedProfile(harness.root, 'deep-review')
    agent.heartbeat()
    expect(await profileNames(agent)).toEqual([])
    await agent.reconcileRepository()
    expect(await profileNames(agent)).toEqual(['deep-review'])
  })

  it('does not reconcile on heartbeat once the checkout has moved', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'moved-repo' })
    harness.git.setHead({ branch: 'feature', commit: 'e'.repeat(40), detached: false })
    writeTrackedProfile(harness.root, 'deep-review')
    agent.heartbeat()
    expect(await profileNames(agent)).toEqual([])
  })
})

/** nodeFs that logs the path of every file read. */
function readLoggingFs(reads: string[]): FsAdapter {
  return {
    ...nodeFs,
    readFile: (path) => {
      reads.push(path)
      return nodeFs.readFile(path)
    }
  }
}

describe('Workspace reconcile reads', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('reads a tracked comment or profile file once, not again on every heartbeat while it is unchanged', async () => {
    const reads: string[] = []
    const agent = harness.open('orchestrator', { fs: readLoggingFs(reads) })
    const epicId = await savedEpic(agent)
    const comment = await agent.addComment({ epicId, body: 'Read once' })
    writeTrackedProfile(harness.root, 'deep-review')
    const dm = join(harness.root, '.darkmechanicus')
    const tracked = [join(dm, 'epics', epicId, 'comments', `${comment.id}.json`), join(dm, 'profiles', 'deep-review.json')]
    const trackedReadsSince = (mark: number): string[] => reads.slice(mark).filter((path) => tracked.includes(path))
    const first = reads.length
    agent.heartbeat()
    expect(trackedReadsSince(first)).toEqual(tracked)
    const settled = reads.length
    agent.heartbeat()
    agent.heartbeat()
    expect(trackedReadsSince(settled)).toEqual([])
    expect(await profileNames(agent)).toEqual(['deep-review'])
  })
})

describe('Workspace open with a broken profiles directory', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('opens and reports a file or a link in place of the profiles directory instead of failing', async () => {
    const first = harness.open('desktop')
    await first.initializeRepository({ name: 'broken-profiles' })
    first.close()
    const profiles = join(harness.root, '.darkmechanicus', 'profiles')
    rmSync(profiles, { recursive: true })
    writeFileSync(profiles, 'oops')
    const onFile = harness.open('orchestrator')
    expect(onFile.isInitialized()).toBe(true)
    expect((await onFile.reconcileRepository()).rejected).toEqual([{ path: '.darkmechanicus/profiles', message: '.darkmechanicus/profiles is not a directory.' }])
    onFile.close()
    rmSync(profiles)
    mkdirSync(join(harness.root, 'elsewhere'))
    symlinkSync(join(harness.root, 'elsewhere'), profiles, 'junction')
    const onLink = harness.open('orchestrator')
    expect(onLink.isInitialized()).toBe(true)
    // Windows may report the junction as a link or only by where it resolves; either way it is rejected.
    expect((await onLink.reconcileRepository()).rejected).toEqual([
      { path: '.darkmechanicus/profiles', message: expect.stringContaining('Unsafe repository path .darkmechanicus/profiles: ') }
    ])
  })
})

describe('Workspace open with a broken epics or history directory', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('opens and reports a file in place of epics, and a link in place of history, instead of failing', async () => {
    const first = harness.open('desktop')
    const epicId = await savedEpic(first)
    first.close()
    const epics = join(harness.root, '.darkmechanicus', 'epics')
    rmSync(epics, { recursive: true })
    writeFileSync(epics, 'oops')
    const onFile = harness.open('orchestrator')
    expect((await onFile.getEpic({ epicId })).title).toBe('Branch epic')
    expect((await onFile.reconcileRepository()).rejected).toEqual([{ path: '.darkmechanicus/epics', message: '.darkmechanicus/epics is not a directory.' }])
    onFile.close()
    const history = join(harness.root, '.darkmechanicus', 'history')
    rmSync(history, { recursive: true, force: true })
    mkdirSync(join(harness.root, 'elsewhere'))
    symlinkSync(join(harness.root, 'elsewhere'), history, 'junction')
    const onLink = harness.open('orchestrator')
    // Windows may report the junction as a link or only by where it resolves; either way it is rejected.
    expect((await onLink.reconcileRepository()).rejected).toContainEqual({
      path: '.darkmechanicus/history',
      message: expect.stringContaining('Unsafe repository path .darkmechanicus/history: ')
    })
  })
})

