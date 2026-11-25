import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { attachmentRefOf, claimAttachments, createStagedAttachment } from '../../src/core/services/attachments'
import { createKanbanCard } from '../../src/core/services/kanban/cards'
import { makeBundle, tid } from '../../src/test/bundles'
import { pngBytes } from '../../src/test/images'
import { createRepoEnv, flush, initProject, saveRevision, type RepoEnv } from '../../src/test/repoEnv'
import { idOf, insertAttempt, insertComment, insertOutbox, insertRun, T0 } from '../../src/test/repoFixtures'
import { createTestCtx, type TestCtx } from '../../src/test/testContext'

export interface ProfileProject {
  root: string
  dbFile: string
  cardId: string
  /** One Backlog card per CLI agent of the revamp matrix, each launched and claimed by that agent. */
  agentCardIds: string[]
  /** The first epic, its sidebar title and its first ticket: the plan-view and ticket-panel samples. */
  sample: { epicId: string; epicTitle: string; ticketId: string }
  tickets: number
  epics: number
  revisions: number
  runs: number
  images: number
  comments: number
  bytes: number
}

/** The synchronous callback must finish its handles before the fixture is removed. */
export function withFixture<T>(use: (root: string) => T): T {
  const temp = realpathSync.native(tmpdir())
  const root = mkdtempSync(join(temp, 'dm-forge-perf-'))
  try {
    return use(root)
  } finally {
    removeFixture(temp, root)
  }
}

function removeFixture(temp: string, root: string): void {
  const checked = realpathSync.native(root)
  if (dirname(checked) !== temp || checked !== root) throw new Error('Fixture path moved outside its temporary parent.')
  rmSync(checked, { recursive: true })
}

function seedEpic(env: RepoEnv, ctx: TestCtx, epic: number, tickets: number): void {
  const first = epic * 1000
  const count = Math.min(tickets - first, 1000)
  const numbers = Array.from({ length: count }, (_, index) => first + index + 1)
  const epicId = idOf('epic', epic + 1)
  const runId = idOf('run', epic + 1)
  const firstRevision = idOf('revision', epic * 2 + 1)
  const revisionId = idOf('revision', epic * 2 + 2)
  const bundle = makeBundle([numbers])
  requireFlushed(saveRevision(env, { epicId, revisionId: firstRevision, number: 1, bundle }))
  bundle.rationale = 'Synthetic second revision'
  requireFlushed(saveRevision(env, { epicId, revisionId, number: 2, baseRevisionId: firstRevision, bundle }))
  // A distinct title per epic, so the native click scenarios can pick one sidebar row.
  env.db.run("UPDATE epics SET title = ?, status = 'completed', completed_at = ? WHERE id = ?", epicTitle(tickets, epic), T0, epicId)
  env.db.run("UPDATE ticket_status SET status = 'completed' WHERE epic_id = ?", epicId)
  insertOutbox(env.db, { kind: 'epic_state', epicId })
  insertRun(env.db, { id: runId, epicId, revisionId, state: 'completed' })
  // Keep history representative without making its size the primary variable.
  for (const number of numbers.slice(0, 16)) {
    insertAttempt(env.db, { id: idOf('attempt', number), runId, ticketId: tid(number), revisionId })
  }
  const owner = { kind: 'attempt' as const, id: idOf('attempt', first + 1) }
  const attachment = createStagedAttachment(ctx, {
    bytes: Buffer.concat([pngBytes(40, 30, epic), Buffer.alloc(128 * 1024, epic)]),
    label: 'Synthetic image evidence',
    purpose: 'evidence'
  })
  const refs = claimAttachments(ctx, [attachment.id], owner).map(attachmentRefOf)
  env.db.run('UPDATE attempts SET evidence_json = ? WHERE id = ?', JSON.stringify({ checks: [], criteria: [], attachments: refs }), owner.id)
  insertOutbox(env.db, { kind: 'run_history', epicId, runId })
  for (let index = 0; index < 32; index += 1) {
    const commentId = idOf('comment', epic * 32 + index + 1)
    insertComment(env.db, { id: commentId, epicId, body: 'Synthetic comment in completed history' })
    insertOutbox(env.db, { kind: 'comment', epicId, entityId: commentId })
  }
  requireFlushed(flush(env))
}

function writePortableFiles(env: RepoEnv): number {
  let bytes = 0
  for (const [path, content] of env.fs.files()) {
    const name = relative(env.layout.dmDir, path)
    if (isAbsolute(name) || name.startsWith('..') || name.split(sep)[0] === 'local') continue
    const data = env.fs.getBytes(path) ?? Buffer.from(content)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    bytes += data.byteLength
  }
  return bytes
}

export function seedProject(root: string, tickets: number): ProfileProject {
  if (!Number.isInteger(tickets) || tickets < 1 || tickets > 10_000) {
    throw new Error('Fixture ticket count must be an integer from 1 through 10,000.')
  }
  mkdirSync(root)
  const canonicalRoot = realpathSync.native(root)
  execFileSync('git', ['-C', canonicalRoot, 'init', '-q', '-b', 'main'])
  const env = createRepoEnv({ root: canonicalRoot })
  const epics = Math.ceil(tickets / 1000)
  try {
    initProject(env)
    const ctx = createTestCtx({ db: env.db, clock: env.clock })
    const cardId = createKanbanCard(ctx, { title: 'Synthetic contention card' }).id
    const agentCardIds = Array.from({ length: AGENT_CARDS }, (_, index) => createKanbanCard(ctx, { title: `Synthetic agent card ${index + 1}` }).id)
    for (let epic = 0; epic < epics; epic += 1) seedEpic(env, ctx, epic, tickets)
    const bytes = writePortableFiles(env)
    return {
      root: canonicalRoot, dbFile: env.layout.dbFile, cardId, agentCardIds, tickets, epics,
      revisions: epics * 2, runs: epics, images: epics, comments: epics * 32, bytes,
      sample: { epicId: idOf('epic', 1), epicTitle: epicTitle(tickets, 0), ticketId: tid(1) }
    }
  } finally {
    env.db.close()
  }
}

/** Unique across the matrix's projects, so a sidebar click picks one row. */
function epicTitle(tickets: number, epic: number): string {
  return `Synthetic ${tickets}-ticket epic ${epic + 1}`
}

/** The revamp matrix runs twelve concurrent CLI agents. */
const AGENT_CARDS = 12

function requireFlushed(outcome: ReturnType<typeof flush>): void {
  if (outcome.failed !== 0) throw new Error(JSON.stringify(outcome.errors))
}
