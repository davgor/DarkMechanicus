/**
 * A database-only workspace: everything lives in the Dark Mechanicus home directory, the repository
 * folder gains no file at all, and planning and running an epic work exactly as in `repo` mode.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCapabilityProfile } from '../shared/domain/bundle'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { createTestCtx } from '../test/testContext'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { openDatabase, type Db } from './db/database'
import { DomainError } from './errors'
import { dbProjectDir, type StorageMode } from './repo/storageMode'
import {
  acceptMessage,
  acknowledgeMessages,
  type AgentMailDeps,
  getEndpoint,
  markHumanSeen,
  provisionEndpoint,
  readHumanMailState,
  readInbox
} from './services/agentMailStore'
import type { Workspace } from './workspace'

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

function projectDir(): string {
  return dbProjectDir(harness.root, harness.homeDir)
}

/** Entries the repository folder holds; empty means the mode left the checkout untouched. */
function repoEntries(): string[] {
  return readdirSync(harness.root)
}

/** Every path under `dir`, recursively, relative to it. */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = `${dir}/${entry}`
      const shown = `${prefix}${entry}`
      return statSync(path).isDirectory() ? [shown, ...tree(path, `${shown}/`)] : [shown]
    })
}

async function initialized(role = 'orchestrator' as const): Promise<Workspace> {
  const agent = harness.open(role, { mode: 'db' })
  await agent.initializeRepository({ name: 'work-repo' })
  return agent
}

describe('initializing a database-only project', () => {
  it('creates the project in the home directory and nothing in the repository', async () => {
    const agent = harness.open('orchestrator', { mode: 'db' })
    const result = await agent.initializeRepository({ name: 'work-repo' })
    expect(result.storage).toEqual({ mode: 'db', projectDir: projectDir() })
    expect(result.createdFiles).toEqual(['project.json', 'local/machine.json'])
    expect(existsSync(join(projectDir(), 'project.json'))).toBe(true)
    expect(existsSync(join(projectDir(), 'local', 'state.sqlite'))).toBe(true)
    expect(repoEntries()).toEqual([])
  })

  it('reports the mode in the storage status, with the database outside the repository', async () => {
    const agent = await initialized()
    const status = await agent.getStorageStatus()
    expect(status.initialized).toBe(true)
    expect(status.storage).toEqual({
      mode: 'db',
      projectDir: projectDir(),
      databasePath: join(projectDir(), 'local', 'state.sqlite')
    })
    expect(status.uncommittedRecordFiles).toBeNull()
  })

  it('is picked up again by a later session without being told the mode', async () => {
    const first = await initialized()
    const projectId = (await first.getProject()).projectId
    first.close()
    const second = harness.open('orchestrator')
    expect(second.isInitialized()).toBe(true)
    expect((await second.getProject()).projectId).toBe(projectId)
  })

})

describe('one folder keeps one project', () => {
  it('refuses to set the folder up a second way once it is a database-only project', async () => {
    await initialized()
    const other = harness.open('orchestrator', { mode: 'repo' })
    await expect(other.initializeRepository({})).rejects.toMatchObject({ code: 'conflict' })
    expect(repoEntries()).toEqual([])
  })

  it('leaves a working session usable after it refuses the second mode', async () => {
    const repo = harness.open('orchestrator', { mode: 'repo' })
    await repo.initializeRepository({ name: 'tracked' })
    const epic = await repo.createEpic({ title: 'Still working' })
    // The same session is asked to set the folder up the other way, and refuses.
    await expect(repo.initializeRepository({ mode: 'db' })).rejects.toMatchObject({ code: 'conflict' })
    // It must still be the repo-backed session it was, not a broken half-switched one.
    expect((await repo.getStorageStatus()).storage.mode).toBe('repo')
    expect((await repo.getEpic({ epicId: epic.id })).title).toBe('Still working')
    expect(existsSync(projectDir())).toBe(false)
  })

  it('refuses a database-only project for a folder that already has repository records', async () => {
    const repo = harness.open('orchestrator', { mode: 'repo' })
    await repo.initializeRepository({ name: 'tracked' })
    repo.close()
    const other = harness.open('orchestrator', { mode: 'db' })
    await expect(other.initializeRepository({})).rejects.toMatchObject({ code: 'conflict' })
    expect(existsSync(projectDir())).toBe(false)
  })
})

describe('planning and running in a database-only project', () => {
  it('saves a plan and keeps it after reopening, with no record file anywhere', async () => {
    const agent = await initialized()
    const epic = await agent.createEpic({ title: 'Ship the thing' })
    await dropAcceptanceNodes(agent, epic.id)
    const draft = await agent.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }]
    })
    const saved = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    expect(saved.revisionNumber).toBe(1)
    expect(repoEntries()).toEqual([])
    expect(existsSync(join(projectDir(), 'epics'))).toBe(false)
    agent.close()

    const reopened = harness.open('orchestrator')
    const detail = await reopened.getEpic({ epicId: epic.id })
    expect(detail.currentRevisionNumber).toBe(1)
    expect(detail.ticketCount).toBe(1)
    expect(detail.pendingSave).toBe(false)
  })

  it('leaves nothing pending in the outbox after a save', async () => {
    const agent = await initialized()
    const epic = await agent.createEpic({ title: 'Outbox check' })
    await dropAcceptanceNodes(agent, epic.id)
    const draft = await agent.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }]
    })
    await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    const status = await agent.getStorageStatus()
    expect(status.outbox).toEqual({ pending: 0, failed: 0, lastError: null })
  })
})

describe('repository-shaped commands in a database-only project', () => {
  it('reconciles to an empty result, because nothing is tracked', async () => {
    const agent = await initialized()
    expect(await agent.reconcileRepository()).toEqual({
      imported: [],
      unchanged: [],
      conflicts: [],
      profileConflicts: [],
      kanbanConflicts: [],
      rejected: [],
      branchChanged: false,
      pausedRuns: []
    })
  })

  it('never blocks a save on the checkout moving to another branch', async () => {
    const agent = await initialized()
    const epic = await agent.createEpic({ title: 'Branch move' })
    await dropAcceptanceNodes(agent, epic.id)
    const draft = await agent.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }]
    })
    harness.git.setHead({ branch: 'feature/other', commit: 'b'.repeat(40), detached: false })
    agent.heartbeat()
    await expect(
      agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    ).resolves.toMatchObject({ revisionNumber: 1 })
  })

  it('reports no epics on other branches, because epics are not in the checkout', async () => {
    const agent = await initialized()
    expect(await agent.listBranchEpics()).toEqual([])
  })

  it('backs the database up inside the project directory, never into the repository, for the desktop only', async () => {
    const agent = await initialized()
    await expect(agent.backupDatabase({})).rejects.toMatchObject({ code: 'unauthorized' })
    const backup = await harness.open('desktop').backupDatabase({})
    expect(backup.path.startsWith(projectDir())).toBe(true)
    expect(repoEntries()).toEqual([])
  })
})

describe('a database-only project is invisible to the repository', () => {
  /**
   * The point of the mode: a checkout can be driven through a whole planning and run cycle and
   * come out byte-for-byte as it went in, so the workflow can be exercised in a repository that
   * must not carry Dark Mechanicus files.
   */
  it('leaves the checkout exactly as it was through a full plan, save and run cycle', async () => {
    const before = tree(harness.root)
    const agent = await initialized()
    const epic = await agent.createEpic({ title: 'Invisible work' })
    await dropAcceptanceNodes(agent, epic.id)
    const draft = await agent.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }]
    })
    await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    await agent.addComment({ epicId: epic.id, body: 'A note that would otherwise be a file.' })
    await agent.saveProfile({
      name: 'fast-lane',
      description: 'Quick work',
      capability: defaultCapabilityProfile()
    })
    const desktop = harness.open('desktop')
    await desktop.setDefinitionOfDone({ checks: [{ name: 'lint', command: 'npm run lint' }] })
    await agent.flushPortableState()
    await agent.reconcileRepository()

    expect(tree(harness.root)).toEqual(before)
    expect(before).toEqual([])
  })

})

describe('a database-only project keeps its records in the database', () => {
  it('keeps the comment, profile and Definition of Done there, not merely unwritten', async () => {
    const agent = await initialized()
    const epic = await agent.createEpic({ title: 'Invisible work' })
    await agent.addComment({ epicId: epic.id, body: 'A note.' })
    await agent.saveProfile({
      name: 'fast-lane',
      description: 'Quick work',
      capability: defaultCapabilityProfile()
    })
    const desktop = harness.open('desktop')
    await desktop.setDefinitionOfDone({ checks: [{ name: 'lint', command: 'npm run lint' }] })
    desktop.close()
    agent.close()

    const reopened = harness.open('orchestrator')
    expect((await reopened.listComments({ epicId: epic.id })).map((comment) => comment.body)).toEqual(['A note.'])
    expect((await reopened.listProfiles()).map((profile) => profile.name)).toContain('fast-lane')
    expect((await reopened.getProject()).definitionOfDone.map((check) => check.name)).toEqual(['lint'])
    expect(repoEntries()).toEqual([])
  })
})

describe('a stdio session inside a database-only folder', () => {
  /**
   * The headless MCP server resolves the repository root by walking up for a project or a `.git`.
   * A database-only folder nested in a Git repository must still resolve to the folder itself:
   * resolving to the enclosing Git root would make the session read as uninitialized and set that
   * repository up with records, writing into a checkout this mode promises never to touch.
   */
  function nestedDbFolder(): string {
    mkdirSync(join(harness.root, '.git'), { recursive: true })
    const nested = join(harness.root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    return nested
  }

  it('resolves to the folder itself, not the enclosing Git repository', async () => {
    const nested = nestedDbFolder()
    const setup = harness.open('orchestrator', { root: nested, mode: 'db' })
    await setup.initializeRepository({ name: 'nested' })
    setup.close()

    const stdio = harness.open('orchestrator', { root: join(nested, 'src'), transport: 'stdio' })
    expect(stdio.repoRoot).toBe(nested)
    expect(stdio.isInitialized()).toBe(true)
    expect((await stdio.getStorageStatus()).storage.mode).toBe('db')
  })

  it('writes no records into the enclosing repository when an agent initializes', async () => {
    const nested = nestedDbFolder()
    const setup = harness.open('orchestrator', { root: nested, mode: 'db' })
    await setup.initializeRepository({ name: 'nested' })
    setup.close()

    const stdio = harness.open('orchestrator', { root: nested, transport: 'stdio' })
    // An agent that calls it anyway must find the project it already has, not make a second one.
    const result = await stdio.initializeRepository({})
    expect(result.alreadyInitialized).toBe(true)
    expect(result.storage.mode).toBe('db')
    expect(existsSync(join(harness.root, '.darkmechanicus'))).toBe(false)
    expect(existsSync(join(nested, '.darkmechanicus'))).toBe(false)
  })

  it('still finds the enclosing Git repository for a folder that is no project', async () => {
    const nested = nestedDbFolder()
    const stdio = harness.open('orchestrator', { root: nested, transport: 'stdio' })
    expect(stdio.repoRoot).toBe(harness.root)
  })
})

describe('a session that opened before the folder was set up', () => {
  /**
   * The normal ordering for a long-lived agent session: it connects to a folder that is not set up
   * yet, and the person then sets the folder up in the desktop app. The session has to pick the
   * project up, whichever mode it was set up in, rather than staying wedged on the mode it guessed
   * when it opened.
   */
  it('picks up a database-only project created by another session afterwards', async () => {
    const waiting = harness.open('orchestrator')
    expect(waiting.isInitialized()).toBe(false)

    const desktop = harness.open('desktop', { mode: 'db' })
    await desktop.initializeRepository({ name: 'set-up-later' })
    desktop.close()

    expect(waiting.isInitialized()).toBe(true)
    expect((await waiting.getStorageStatus()).storage.mode).toBe('db')
    await expect(waiting.listEpics()).resolves.toEqual([])
  })

  it('still picks up a repository-backed project created afterwards', async () => {
    const waiting = harness.open('orchestrator')
    const desktop = harness.open('desktop', { mode: 'repo' })
    await desktop.initializeRepository({ name: 'set-up-later' })
    desktop.close()

    expect(waiting.isInitialized()).toBe(true)
    expect((await waiting.getStorageStatus()).storage.mode).toBe('repo')
  })

  it('keeps the mode it was told to use instead of re-resolving it', async () => {
    const waiting = harness.open('orchestrator', { mode: 'repo' })
    const desktop = harness.open('desktop', { mode: 'db' })
    await desktop.initializeRepository({ name: 'set-up-later' })
    desktop.close()

    // It was opened for repo mode explicitly, so it must not silently adopt the db project.
    expect(waiting.isInitialized()).toBe(false)
  })
})

/** Where a mode keeps its records: the repository's `.darkmechanicus/`, or the project directory in the home directory. */
function recordsDir(mode: StorageMode): string {
  return mode === 'repo' ? join(harness.root, '.darkmechanicus') : projectDir()
}

/** Every row of every table that is not agent mail, as text: where message data must never appear. */
function otherTablesText(db: Db): string {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'agent_mail_%' AND name NOT LIKE 'search_index_%'")
    .map((row) => row.name)
  return JSON.stringify(tables.map((name) => db.all(`SELECT * FROM "${name}"`)), (_key, value: unknown) =>
    value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value
  )
}

interface Mail {
  a: string
  b: string
  acked: string
  pending: string
  body: string
}

function sendMail(deps: AgentMailDeps, mode: StorageMode): Mail {
  const machineId = 'mc_00000000000000000000000001'
  const a = provisionEndpoint(deps, { machineId, chatId: 'chat-a', name: 'Planner chat' })
  const b = provisionEndpoint(deps, { machineId, chatId: 'chat-b', name: 'Worker chat' })
  const body = `private-mail-body-${mode}`
  const acked = acceptMessage(deps, { senderEndpointId: a.id, to: b.id, clientMessageId: 'm-1', body: `${body}-acked` })
  const pending = acceptMessage(deps, { senderEndpointId: a.id, to: b.id, clientMessageId: 'm-2', body: `${body}-pending` })
  acknowledgeMessages(deps, { endpointId: b.id, messageIds: [acked.messageId] })
  markHumanSeen(deps, { endpointId: b.id, throughSeq: 1 })
  return { a: a.id, b: b.id, acked: acked.messageId, pending: pending.messageId, body }
}

function expectMailKept(deps: AgentMailDeps, mail: Mail): void {
  expect(getEndpoint(deps, mail.b)).toMatchObject({ state: 'open', lastSeq: 2, humanSeenSeq: 1 })
  expect(readInbox(deps, { endpointId: mail.b }).messages.map((message) => [message.id, message.body, message.acknowledgedAt !== null])).toEqual([
    [mail.acked, `${mail.body}-acked`, true],
    [mail.pending, `${mail.body}-pending`, false]
  ])
  expect(readHumanMailState(deps, mail.b)).toMatchObject({ humanSeenSeq: 1, unseenCount: 1, pendingCount: 1 })
}

/** A project in `mode` with portable records of its own, and mail between two of its chats. */
async function setUpMail(mode: StorageMode): Promise<{ agent: Workspace; mail: Mail }> {
  const agent = harness.open('orchestrator', { mode })
  await agent.initializeRepository({ name: 'mail-project' })
  const epic = await agent.createEpic({ title: 'Portable work' })
  await agent.addComment({ epicId: epic.id, body: 'A portable note.' })
  return { agent, mail: sendMail(agent.ctx(), mode) }
}

describe.each(['repo', 'db'] as const)('local agent mail in %s mode', (mode) => {
  it('keeps mail through flush, reconcile, a branch change and a reopen, in the local database only', async () => {
    const { agent, mail } = await setUpMail(mode)
    await agent.flushPortableState()
    await agent.reconcileRepository()
    harness.git.setHead({ branch: 'feature/elsewhere', commit: 'c'.repeat(40), detached: false })
    await agent.reconcileRepository()
    expectMailKept(agent.ctx(), mail)
    expect(otherTablesText(agent.ctx().db)).not.toContain(mail.body)
    expect(otherTablesText(agent.ctx().db)).not.toContain(mail.pending)
    agent.close()

    const reopened = harness.open('orchestrator')
    expectMailKept(reopened.ctx(), mail)
    const tracked = tree(recordsDir(mode)).filter((path) => !path.startsWith('local'))
    expect(tracked.length).toBeGreaterThan(0)
    for (const path of tracked.filter((entry) => statSync(join(recordsDir(mode), entry)).isFile())) {
      expect(readFileSync(join(recordsDir(mode), path), 'latin1')).not.toContain(mail.body)
    }
    if (mode === 'db') {
      expect(repoEntries()).toEqual([])
    }
  })

  it('lets the desktop back the mail up and restore it from the copy', async () => {
    const { agent, mail } = await setUpMail(mode)
    await expect(agent.backupDatabase({})).rejects.toMatchObject({ code: 'unauthorized' })
    const backup = await harness.open('desktop').backupDatabase({})
    const copy = openDatabase(backup.path)
    try {
      expectMailKept(createTestCtx({ db: copy, clock: harness.clock }), mail)
    } finally {
      copy.close()
    }
  })
})

describe.each(['repo', 'db'] as const)('a project mismatch in %s mode', (mode) => {
  it('refuses a database of another project with advice that keeps the only copy of its mail', async () => {
    const { agent, mail } = await setUpMail(mode)
    agent.close()
    const projectFile = join(recordsDir(mode), 'project.json')
    const project = JSON.parse(readFileSync(projectFile, 'utf8')) as { projectId: string }
    writeFileSync(projectFile, `${JSON.stringify({ ...project, projectId: 'pj_0000000000zzzzzzzzzzzzzzzz' }, null, 2)}\n`)
    let refused: unknown
    try {
      harness.open('orchestrator')
    } catch (error: unknown) {
      refused = error
    }
    expect(refused).toBeInstanceOf(DomainError)
    const error = refused as DomainError
    expect(error.code).toBe('project_mismatch')
    expect(error.details).toMatchObject({ localDir: join(recordsDir(mode), 'local') })
    expect(error.message).toContain('do not delete it')
    expect(existsSync(join(recordsDir(mode), 'local', 'state.sqlite'))).toBe(true)
    if (mode === 'repo') {
      // Following the advice: the old database moved aside keeps its mail while tracked records rebuild a new one.
      const aside = join(harness.root, 'local-aside')
      renameSync(join(recordsDir(mode), 'local'), aside)
      expect((await harness.open('orchestrator').getProject()).projectId).toBe('pj_0000000000zzzzzzzzzzzzzzzz')
      const kept = openDatabase(join(aside, 'state.sqlite'))
      try {
        expectMailKept(createTestCtx({ db: kept, clock: harness.clock }), mail)
      } finally {
        kept.close()
      }
    }
  })
})
