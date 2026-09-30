import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeBundle, sid, tid } from '../../test/bundles'
import { createMemoryFs } from '../../test/memoryFs'
import {
  domainErrorOf,
  idOf,
  insertAttempt,
  insertCheckpoint,
  insertComment,
  insertEpic,
  insertProfile,
  insertReport,
  insertRevision,
  insertRun,
  insertTicketStatus,
  T0
} from '../../test/repoFixtures'
import { createTestDb } from '../../test/testContext'
import { defaultCapabilityProfile } from '../../shared/domain/bundle'
import { contentHash, prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { LIMITS } from '../schemas'
import { resolveLayout } from './layout'
import {
  buildCommentRecord,
  buildEpicPointerRecord,
  buildEpicStateRecord,
  buildProfileRecord,
  buildRunHistoryRecord,
  buildSnapshotRecord,
  commentRecord,
  epicPointerRecord,
  epicStateRecord,
  MAX_RECORD_BYTES,
  parseRecord,
  profileRecord,
  projectRecord,
  readCommentRecord,
  readOwnedRecord,
  readOwnedText,
  runHistoryRecord,
  snapshotRecord,
  trackedCommentHash,
  trackedEpicHash,
  trackedProfileHash,
  trackedRunHash
} from './portable'

const EPIC = idOf('epic', 1)
const REV = idOf('revision', 1)
const RUN = idOf('run', 1)
const PATH = '.darkmechanicus/project.json'
const BUNDLE = makeBundle([[1, 2]], [[1, 2]])

const PROJECT = {
  format: 'darkmechanicus.project',
  formatVersion: 1,
  projectId: idOf('project', 1),
  name: 'Demo',
  keyPrefix: 'DM',
  createdAt: T0
}

function rejection(action: () => unknown): { code: string; message: string } {
  const error = domainErrorOf(action)
  return { code: error.code, message: error.message }
}

function padTo(text: string, length: number): string {
  return text + ' '.repeat(length - text.length)
}

describe('parseRecord size and markers', () => {
  it('parses a valid record written with prettyJson', () => {
    expect(parseRecord(projectRecord, prettyJson(PROJECT), PATH)).toEqual(PROJECT)
  })

  it('accepts a record of exactly 8 MiB and rejects one byte more', () => {
    const padded = padTo(prettyJson(PROJECT), MAX_RECORD_BYTES)
    expect(parseRecord(projectRecord, padded, PATH)).toEqual(PROJECT)
    const error = rejection(() => parseRecord(projectRecord, `${padded} `, PATH))
    expect(error).toEqual({ code: 'import_rejected', message: `${PATH} is larger than the 8 MiB record limit.` })
  })

  it('counts bytes, not characters, against the size limit', () => {
    const padded = padTo(prettyJson({ ...PROJECT, name: 'é' }), MAX_RECORD_BYTES)
    expect(rejection(() => parseRecord(projectRecord, padded, PATH)).code).toBe('import_rejected')
  })

  it.each([
    ['<<<<<<< HEAD', `<<<<<<< HEAD\n${prettyJson(PROJECT)}`],
    ['>>>>>>> theirs', `${prettyJson(PROJECT)}>>>>>>> theirs\n`],
    ['=======', `{\n=======\n}`],
    ['======= (CRLF)', `{\r\n=======\r\n}`],
    ['||||||| base', `{\n||||||| base\n}`]
  ])('rejects unresolved merge markers (%s)', (_label, text) => {
    expect(rejection(() => parseRecord(projectRecord, text, PATH))).toEqual({
      code: 'import_rejected',
      message: `${PATH} contains unresolved merge conflict markers.`
    })
  })

  it('does not mistake marker-like lines for merge markers', () => {
    for (const text of ['{\n========\n}', '{\n======= x\n}', '<<<<<<<HEAD\n', '  <<<<<<< HEAD\n']) {
      expect(rejection(() => parseRecord(projectRecord, text, PATH)).message).toBe(`${PATH} is not valid JSON.`)
    }
  })
})

describe('parseRecord schema errors', () => {
  it('names the first schema issue and its path', () => {
    const error = rejection(() => parseRecord(projectRecord, JSON.stringify({ ...PROJECT, keyPrefix: 'lower' }), PATH))
    expect(error.code).toBe('import_rejected')
    expect(error.message).toMatch(/^\.darkmechanicus\/project\.json is not a valid record: keyPrefix: /)
  })

  it('reports root-level schema issues', () => {
    expect(rejection(() => parseRecord(projectRecord, '[]', PATH)).message).toMatch(/is not a valid record: \(root\): /)
  })

  it('rejects unknown keys, unsupported format versions, and wrong-kind ids', () => {
    const variants = [
      { ...PROJECT, extra: true },
      { ...PROJECT, formatVersion: 2 },
      { ...PROJECT, projectId: idOf('epic', 1) },
      { ...PROJECT, name: '' },
      { ...PROJECT, createdAt: 'yesterday' }
    ]
    for (const variant of variants) {
      expect(rejection(() => parseRecord(projectRecord, JSON.stringify(variant), PATH)).code).toBe('import_rejected')
    }
  })
})

const SNAPSHOT = {
  format: 'darkmechanicus.plan-snapshot',
  formatVersion: 1,
  epicId: EPIC,
  revisionId: REV,
  number: 1,
  baseRevisionId: null,
  contentHash: contentHash(BUNDLE),
  createdAt: T0,
  savedAt: T0,
  bundle: BUNDLE
}

function stateWith(ticketStatuses: Record<string, string>): unknown {
  return {
    format: 'darkmechanicus.epic-state',
    formatVersion: 1,
    epicId: EPIC,
    title: 'Epic',
    status: 'backlog',
    branch: null,
    provenance: null,
    outcome: null,
    createdAt: T0,
    completedAt: null,
    ticketStatuses,
    generation: 1,
    updatedAt: T0
  }
}

function statuses(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [tid(index + 1), 'backlog']))
}

describe('snapshot, state, and pointer schemas', () => {
  it('accepts a snapshot whose hash matches its bundle and rejects a mismatch', () => {
    expect(snapshotRecord.parse(SNAPSHOT)).toEqual(SNAPSHOT)
    const tampered = { ...SNAPSHOT, bundle: { ...BUNDLE, rationale: 'changed' } }
    const error = rejection(() => parseRecord(snapshotRecord, JSON.stringify(tampered), 'snap.json'))
    expect(error.message).toBe('snap.json is not a valid record: contentHash: Snapshot contentHash does not match its bundle.')
  })

  it('bounds ticket statuses at the ticket limit and requires ticket ids as keys', () => {
    expect(Object.keys(epicStateRecord.parse(stateWith(statuses(LIMITS.tickets))).ticketStatuses)).toHaveLength(LIMITS.tickets)
    expect(epicStateRecord.safeParse(stateWith(statuses(LIMITS.tickets + 1))).success).toBe(false)
    expect(epicStateRecord.safeParse(stateWith({ [EPIC]: 'backlog' })).success).toBe(false)
  })

  it('requires positive revision numbers and generations in pointers', () => {
    const pointer = {
      format: 'darkmechanicus.epic-pointer',
      formatVersion: 1,
      epicId: EPIC,
      revisionId: REV,
      revisionNumber: 1,
      contentHash: contentHash(BUNDLE),
      generation: 1,
      updatedAt: T0
    }
    expect(epicPointerRecord.parse(pointer)).toEqual(pointer)
    expect(epicPointerRecord.safeParse({ ...pointer, generation: 0 }).success).toBe(false)
    expect(epicPointerRecord.safeParse({ ...pointer, contentHash: 'sha256:abc' }).success).toBe(false)
  })
})

const OUTCOME = { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: '' }], recordedAt: T0, runId: RUN }

function seededDb(): Db {
  const db = createTestDb()
  insertEpic(db, {
    id: EPIC,
    title: 'Seeded epic',
    status: 'in_progress',
    currentRevisionId: REV,
    branch: { repository: null, name: 'epic/seeded', startCommit: 'abcdef1' },
    provenance: { sourceEpicId: idOf('epic', 9), note: 'follow-up' },
    outcome: OUTCOME
  })
  insertRevision(db, { id: REV, epicId: EPIC, number: 1, bundle: makeBundle([[1, 2]]), createdAt: '2026-01-02T00:00:00.000Z' })
  insertTicketStatus(db, { ticketId: tid(2), epicId: EPIC, status: 'in_progress' })
  insertTicketStatus(db, { ticketId: tid(1), epicId: EPIC, status: 'completed' })
  return db
}

describe('buildSnapshotRecord', () => {
  it('builds a snapshot record from a pending revision, dating it by its creation', () => {
    const db = seededDb()
    expect(buildSnapshotRecord(db, REV)).toEqual({
      format: 'darkmechanicus.plan-snapshot',
      formatVersion: 1,
      epicId: EPIC,
      revisionId: REV,
      number: 1,
      baseRevisionId: null,
      contentHash: contentHash(makeBundle([[1, 2]])),
      createdAt: '2026-01-02T00:00:00.000Z',
      savedAt: '2026-01-02T00:00:00.000Z',
      bundle: makeBundle([[1, 2]])
    })
    db.run("UPDATE plan_revisions SET saved_at = '2026-01-03T00:00:00.000Z' WHERE id = ?", REV)
    expect(buildSnapshotRecord(db, REV).savedAt).toBe('2026-01-03T00:00:00.000Z')
  })

  it('refuses to export a missing revision or one whose hash does not match its bundle', () => {
    const db = seededDb()
    expect(domainErrorOf(() => buildSnapshotRecord(db, idOf('revision', 99))).code).toBe('not_found')
    db.run('UPDATE plan_revisions SET content_hash = ? WHERE id = ?', `sha256:${'f'.repeat(64)}`, REV)
    const error = domainErrorOf(() => buildSnapshotRecord(db, REV))
    expect(error.code).toBe('internal')
    expect(error.message).toBe(`Cannot export snapshot ${REV}: contentHash: Snapshot contentHash does not match its bundle`)
  })
})

describe('buildEpicPointerRecord', () => {
  it('points at the snapshot with the given generation and refuses generation 0', () => {
    const snapshot = buildSnapshotRecord(seededDb(), REV)
    expect(buildEpicPointerRecord(snapshot, { generation: 2, updatedAt: T0 })).toEqual({
      format: 'darkmechanicus.epic-pointer',
      formatVersion: 1,
      epicId: EPIC,
      revisionId: REV,
      revisionNumber: 1,
      contentHash: snapshot.contentHash,
      generation: 2,
      updatedAt: T0
    })
    const error = domainErrorOf(() => buildEpicPointerRecord(snapshot, { generation: 0, updatedAt: T0 }))
    expect(error.code).toBe('internal')
    expect(error.message).toMatch(new RegExp(`^Cannot export pointer for ${EPIC}: generation: `))
  })
})

describe('buildEpicStateRecord', () => {
  it('builds epic state with sorted ticket statuses and the given generation', () => {
    const db = seededDb()
    const record = buildEpicStateRecord(db, EPIC, { generation: 3, updatedAt: '2026-02-01T00:00:00.000Z' })
    expect(record).toEqual({
      format: 'darkmechanicus.epic-state',
      formatVersion: 1,
      epicId: EPIC,
      title: 'Seeded epic',
      status: 'in_progress',
      branch: { repository: null, name: 'epic/seeded', startCommit: 'abcdef1' },
      provenance: { sourceEpicId: idOf('epic', 9), note: 'follow-up' },
      outcome: OUTCOME,
      createdAt: T0,
      completedAt: null,
      ticketStatuses: { [tid(1)]: 'completed', [tid(2)]: 'in_progress' },
      generation: 3,
      updatedAt: '2026-02-01T00:00:00.000Z'
    })
    expect(Object.keys(record.ticketStatuses)).toEqual([tid(1), tid(2)])
  })

  it('refuses a missing epic', () => {
    const db = seededDb()
    expect(domainErrorOf(() => buildEpicStateRecord(db, idOf('epic', 99), { generation: 1, updatedAt: T0 })).code).toBe('not_found')
  })
})

function seedRunHistory(db: Db): void {
  insertRun(db, { id: RUN, epicId: EPIC, revisionId: REV, autoContinue: true, host: { label: 'Host', type: 'test' }, activeSprintId: sid(1) })
  insertAttempt(db, {
    id: idOf('attempt', 2),
    runId: RUN,
    ticketId: tid(2),
    revisionId: REV,
    state: 'running',
    claimSecret: 'top-secret',
    leaseExpiresAt: '2026-01-01T00:15:00.000Z'
  })
  insertAttempt(db, {
    id: idOf('attempt', 1),
    runId: RUN,
    ticketId: tid(1),
    revisionId: REV,
    outputs: { summary: 'Built it' },
    evidence: { checks: [{ name: 'unit', status: 'passed', detail: '' }] },
    failure: { reason: 'flaky' },
    decision: { outcome: 'accepted', notes: 'ok', reasons: [], decidedBy: 'desktop' }
  })
  insertReport(db, { id: idOf('report', 1), runId: RUN, sprintId: sid(1), content: { summary: 'Sprint done' } })
  insertCheckpoint(db, { id: idOf('checkpoint', 1), runId: RUN, sprintId: sid(1), reportId: idOf('report', 1) })
}

describe('buildRunHistoryRecord exclusions', () => {
  it('builds run history without leases, secrets, sessions, approvals, or auto-continue', () => {
    const db = seededDb()
    seedRunHistory(db)
    const record = buildRunHistoryRecord(db, RUN)
    const text = prettyJson(record)
    for (const secret of ['top-secret', 'lease', 'heartbeat', 'claimSecret', 'autoContinue', 'approval', 'ss_00000000000000000000000009']) {
      expect(text).not.toContain(secret)
    }
    expect(record).toMatchObject({ runId: RUN, epicId: EPIC, state: 'running', host: { label: 'Host', type: 'test' }, activeSprintId: sid(1) })
    expect(parseRecord(runHistoryRecord, text, 'run.json')).toEqual(record)
  })

  it('refuses to export a missing run or one with malformed stored JSON', () => {
    const db = seededDb()
    expect(domainErrorOf(() => buildRunHistoryRecord(db, RUN)).code).toBe('not_found')
    insertRun(db, { id: RUN, epicId: EPIC, revisionId: REV })
    insertAttempt(db, { id: idOf('attempt', 1), runId: RUN, ticketId: tid(1), revisionId: REV, worker: { label: 'w', surprise: 1 } })
    const error = domainErrorOf(() => buildRunHistoryRecord(db, RUN))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('attempts.0.worker')
  })
})

describe('buildRunHistoryRecord contents', () => {
  it('orders rows by id and fills defaults for partially stored JSON', () => {
    const db = seededDb()
    seedRunHistory(db)
    const record = buildRunHistoryRecord(db, RUN)
    expect(record.attempts.map((attempt) => attempt.id)).toEqual([idOf('attempt', 1), idOf('attempt', 2)])
    expect(record.attempts[0]?.worker).toEqual({
      sessionId: null,
      label: 'worker-1',
      modelId: null,
      hostId: null,
      catalogRevision: null,
      rationale: null
    })
    expect(record.attempts[0]?.outputs).toEqual({ summary: 'Built it', artifacts: [], commits: [], changedFiles: [], branch: null })
    expect(record.attempts[0]?.evidence?.notes).toBe('')
    expect(record.attempts[0]?.failure).toEqual({ reason: 'flaky', details: '', retryable: false })
    expect(record.attempts[1]?.outputs).toBeNull()
    expect(record.reports[0]?.content.risks).toEqual([])
    expect(record.checkpoints).toEqual([
      { id: idOf('checkpoint', 1), sprintId: sid(1), reportId: idOf('report', 1), outcome: 'advanced', policy: 'human', decidedBy: 'desktop', decidedAt: T0 }
    ])
  })
})

function runRecord(attempts: unknown[], reports: unknown[] = []): unknown {
  return {
    format: 'darkmechanicus.run',
    formatVersion: 1,
    runId: RUN,
    epicId: EPIC,
    number: 1,
    revisionId: REV,
    state: 'running',
    activeSprintId: null,
    host: null,
    hostCatalogId: null,
    skillVersion: null,
    ownerMachineId: idOf('machine', 1),
    pauseReason: null,
    createdAt: T0,
    startedAt: null,
    updatedAt: T0,
    endedAt: null,
    attempts,
    reports,
    checkpoints: []
  }
}

function attempt(n: number, ticket: number, state: string, number = 1): unknown {
  return {
    id: idOf('attempt', n),
    ticketId: tid(ticket),
    number,
    kind: 'work',
    state,
    fencingToken: number,
    worker: { label: 'w' },
    revisionId: REV,
    ticketContentHash: 'sha256:x',
    outputs: null,
    evidence: null,
    failure: null,
    decision: null,
    createdAt: T0,
    updatedAt: T0,
    submittedAt: null,
    decidedAt: null,
    reconciledAt: null,
    supersededAt: null
  }
}

function report(n: number, revision: number): unknown {
  return { id: idOf('report', n), sprintId: sid(1), reportRevision: revision, contentHash: 'h', content: { summary: 's' }, submittedBy: null, createdAt: T0 }
}

function firstIssue(value: unknown): string {
  const result = runHistoryRecord.safeParse(value)
  return result.success ? 'ok' : (result.error.issues[0]?.message ?? '')
}

describe('run history consistency', () => {
  it('accepts distinct attempts and one open attempt per ticket', () => {
    const attempts = [attempt(1, 1, 'failed'), attempt(2, 1, 'running', 2), attempt(3, 2, 'submitted')]
    expect(firstIssue(runRecord(attempts, [report(1, 1), report(2, 2)]))).toBe('ok')
  })

  it('rejects duplicate ids, numbers, open attempts, and report revisions', () => {
    expect(firstIssue(runRecord([attempt(1, 1, 'failed'), attempt(1, 2, 'failed')]))).toBe(`Duplicate attempt id: ${idOf('attempt', 1)}`)
    expect(firstIssue(runRecord([attempt(1, 1, 'failed'), attempt(2, 1, 'failed')]))).toBe(`Duplicate attempt number for a ticket: ${tid(1)}#1`)
    expect(firstIssue(runRecord([attempt(1, 1, 'claimed'), attempt(2, 1, 'submitted', 2)]))).toBe(`Duplicate open attempt for a ticket: ${tid(1)}`)
    expect(firstIssue(runRecord([], [report(1, 1), report(1, 2)]))).toBe(`Duplicate report id: ${idOf('report', 1)}`)
    expect(firstIssue(runRecord([], [report(1, 1), report(2, 1)]))).toBe(`Duplicate report revision for a sprint: ${sid(1)}#1`)
  })
})

describe('tracked hashes', () => {
  it('hash the exact texts, ignoring only CRLF line endings', () => {
    const pointer = '{\n  "a": 1\n}\n'
    const state = '{\n  "b": 2\n}\n'
    const base = trackedEpicHash(pointer, state)
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(trackedEpicHash(pointer.replace(/\n/g, '\r\n'), state.replace(/\n/g, '\r\n'))).toBe(base)
    expect(trackedEpicHash(state, pointer)).not.toBe(base)
    expect(trackedEpicHash(pointer, `${state} `)).not.toBe(base)
    expect(trackedEpicHash(`${pointer}${state}`, '')).not.toBe(base)
    expect(trackedRunHash(pointer)).toBe(trackedRunHash(pointer.replace(/\n/g, '\r\n')))
    expect(trackedRunHash(pointer)).not.toBe(trackedRunHash(state))
  })
})

const COMMENT_ID = idOf('comment', 1)

const COMMENT = {
  format: 'darkmechanicus.comment',
  formatVersion: 1,
  id: COMMENT_ID,
  epicId: EPIC,
  ticketId: tid(1),
  body: 'Blocked on **DM-2**',
  author: { role: 'worker', label: 'worker-1' },
  createdAt: T0
}

function commentIssue(record: unknown): string {
  const result = commentRecord.safeParse(record)
  return result.success ? 'ok' : `${result.error.issues[0]?.path.join('.')}: ${result.error.issues[0]?.message}`
}

describe('comment record schema', () => {
  it('accepts ticket and epic comments of every author role', () => {
    expect(commentRecord.parse(COMMENT)).toEqual(COMMENT)
    expect(commentIssue({ ...COMMENT, ticketId: null })).toBe('ok')
    for (const role of ['desktop', 'planner', 'orchestrator', 'worker', 'reviewer']) {
      expect(commentIssue({ ...COMMENT, author: { role, label: 'x' } })).toBe('ok')
    }
    expect(commentIssue({ ...COMMENT, body: 'b'.repeat(LIMITS.comment), author: { role: 'worker', label: 'l'.repeat(LIMITS.label) } })).toBe('ok')
  })

  it('rejects blank or oversized bodies, unknown roles, and long labels', () => {
    expect(commentIssue({ ...COMMENT, body: ' \n' })).toBe('body: A comment needs some text')
    expect(commentIssue({ ...COMMENT, body: 'b'.repeat(LIMITS.comment + 1) })).toBe('body: A comment is at most 20000 characters')
    expect(commentIssue({ ...COMMENT, author: { role: 'admin', label: 'x' } })).toMatch(/^author\.role: /)
    expect(commentIssue({ ...COMMENT, author: { role: 'worker', label: 'l'.repeat(LIMITS.label + 1) } })).toMatch(/^author\.label: /)
  })

  it('rejects wrong-kind ids, unknown keys, other formats and versions, and bad times', () => {
    expect(commentIssue({ ...COMMENT, id: idOf('ticket', 1) })).toBe('id: Expected a comment id')
    expect(commentIssue({ ...COMMENT, epicId: COMMENT_ID })).toBe('epicId: Expected a epic id')
    expect(commentIssue({ ...COMMENT, ticketId: 'DM-1' })).toMatch(/^ticketId: /)
    expect(commentIssue({ ...COMMENT, ticketId: `zz_${'0'.repeat(26)}` })).toBe('ok')
    expect(commentIssue({ ...COMMENT, editedAt: T0 })).toMatch(/^: Unrecognized key/)
    expect(commentIssue({ ...COMMENT, author: { role: 'worker', label: 'x', sessionId: 'ss_1' } })).toMatch(/^author: Unrecognized key/)
    expect(commentIssue({ ...COMMENT, formatVersion: 2 })).toMatch(/^formatVersion: /)
    expect(commentIssue({ ...COMMENT, format: 'darkmechanicus.run' })).toMatch(/^format: /)
    expect(commentIssue({ ...COMMENT, createdAt: 'yesterday' })).toMatch(/^createdAt: /)
  })
})

describe('buildCommentRecord', () => {
  it('builds the record of a ticket comment and of an epic comment from their rows', () => {
    const db = createTestDb()
    insertEpic(db, { id: EPIC })
    insertComment(db, { id: COMMENT_ID, epicId: EPIC, ticketId: tid(1), body: 'Blocked on **DM-2**' })
    insertComment(db, { id: idOf('comment', 2), epicId: EPIC, role: 'desktop', label: 'Ada', createdAt: '2026-02-03T04:05:06.007Z' })
    expect(buildCommentRecord(db, COMMENT_ID)).toEqual(COMMENT)
    expect(buildCommentRecord(db, idOf('comment', 2))).toEqual({
      ...COMMENT,
      id: idOf('comment', 2),
      ticketId: null,
      body: 'A **comment**',
      author: { role: 'desktop', label: 'Ada' },
      createdAt: '2026-02-03T04:05:06.007Z'
    })
  })

  it('reads a comment row in record shape without validating it', () => {
    const db = createTestDb()
    insertEpic(db, { id: EPIC })
    insertComment(db, { id: COMMENT_ID, epicId: EPIC, ticketId: tid(1), body: '   ', label: 'l'.repeat(LIMITS.label + 1) })
    expect(readCommentRecord(db, COMMENT_ID)).toEqual({ ...COMMENT, body: '   ', author: { role: 'worker', label: 'l'.repeat(LIMITS.label + 1) } })
    expect(readCommentRecord(db, idOf('comment', 9))).toBeNull()
  })

  it('refuses a missing comment and one the importer would reject', () => {
    const db = createTestDb()
    insertEpic(db, { id: EPIC })
    insertComment(db, { id: COMMENT_ID, epicId: EPIC, body: '   ' })
    expect(rejection(() => buildCommentRecord(db, idOf('comment', 9)))).toEqual({
      code: 'not_found',
      message: `Comment ${idOf('comment', 9)} does not exist.`
    })
    expect(rejection(() => buildCommentRecord(db, COMMENT_ID))).toEqual({
      code: 'internal',
      message: `Cannot export comment ${COMMENT_ID}: body: A comment needs some text`
    })
  })

  it('hashes comment text for change detection, ignoring only CRLF line endings', () => {
    const text = prettyJson(COMMENT)
    expect(trackedCommentHash(text)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(trackedCommentHash(text.replace(/\n/g, '\r\n'))).toBe(trackedCommentHash(text))
    expect(trackedCommentHash(`${text} `)).not.toBe(trackedCommentHash(text))
    expect(trackedCommentHash(text)).not.toBe(trackedRunHash(text))
  })
})

const LAYOUT = resolveLayout(resolve('/repo'))

describe('reading owned record files', () => {
  it('returns null for a missing file and the parsed record for a valid one', () => {
    const fs = createMemoryFs()
    fs.mkdirp(LAYOUT.dmDir)
    expect(readOwnedText({ layout: LAYOUT, fs }, LAYOUT.projectFile)).toBeNull()
    expect(readOwnedRecord({ layout: LAYOUT, fs }, projectRecord, LAYOUT.projectFile)).toBeNull()
    fs.put(LAYOUT.projectFile, prettyJson(PROJECT))
    expect(readOwnedRecord({ layout: LAYOUT, fs }, projectRecord, LAYOUT.projectFile)).toEqual(PROJECT)
  })

  it('rejects empty and oversized files without reading them', () => {
    const fs = createMemoryFs()
    fs.put(LAYOUT.projectFile, '')
    fs.failOn({ op: 'readFile' })
    expect(rejection(() => readOwnedText({ layout: LAYOUT, fs }, LAYOUT.projectFile))).toEqual({
      code: 'import_rejected',
      message: `${PATH} is empty.`
    })
    fs.put(LAYOUT.projectFile, 'x'.repeat(MAX_RECORD_BYTES + 1))
    expect(rejection(() => readOwnedText({ layout: LAYOUT, fs }, LAYOUT.projectFile)).message).toBe(`${PATH} is larger than the 8 MiB record limit.`)
    fs.put(LAYOUT.projectFile, 'x'.repeat(MAX_RECORD_BYTES))
    expect(() => readOwnedText({ layout: LAYOUT, fs }, LAYOUT.projectFile)).toThrow(/Injected readFile fault/)
  })

  it('refuses a linked record file with unsafe_path', () => {
    const fs = createMemoryFs()
    fs.mkdirp(LAYOUT.dmDir)
    fs.put(resolve('/outside/project.json'), prettyJson(PROJECT))
    fs.symlink(LAYOUT.projectFile, resolve('/outside/project.json'))
    expect(rejection(() => readOwnedRecord({ layout: LAYOUT, fs }, projectRecord, LAYOUT.projectFile)).code).toBe('unsafe_path')
    expect(fs.reads).not.toContain(resolve('/outside/project.json'))
  })

  it('names files by their repository-relative path', () => {
    const fs = createMemoryFs()
    fs.put(join(LAYOUT.dmDir, 'project.json'), '{')
    expect(rejection(() => readOwnedRecord({ layout: LAYOUT, fs }, projectRecord, LAYOUT.projectFile)).message).toBe(`${PATH} is not valid JSON.`)
  })
})

const REVIEW = { ...defaultCapabilityProfile(), workType: 'review', reasoning: { level: 'deep', rationale: 'Careful' } }

const PROFILE = {
  format: 'darkmechanicus.profile',
  formatVersion: 1,
  name: 'deep-review',
  description: 'Careful review',
  capability: REVIEW,
  createdAt: T0,
  updatedAt: '2026-01-02T00:00:00.000Z'
}

function profileIssue(record: unknown): string {
  const result = profileRecord.safeParse(record)
  return result.success ? 'ok' : `${result.error.issues[0]?.path.join('.')}: ${result.error.issues[0]?.message}`
}

describe('profile record schema', () => {
  it('accepts a complete profile record', () => {
    expect(parseRecord(profileRecord, prettyJson(PROFILE), 'p')).toEqual(PROFILE)
    expect(profileIssue({ ...PROFILE, description: 'x'.repeat(LIMITS.profileDescription) })).toBe('ok')
  })

  it('rejects wrong formats, unknown keys, unsafe names, long descriptions, and invalid capabilities', () => {
    expect(profileIssue({ ...PROFILE, format: 'darkmechanicus.run' })).toBe('format: Invalid input: expected "darkmechanicus.profile"')
    expect(profileIssue({ ...PROFILE, formatVersion: 2 })).toBe('formatVersion: Invalid input: expected 1')
    expect(profileIssue({ ...PROFILE, revision: 3 })).toBe(': Unrecognized key: "revision"')
    expect(profileIssue({ ...PROFILE, name: 'con' })).toMatch(/^name: Use 1-64 lowercase letters/)
    expect(profileIssue({ ...PROFILE, name: '../x' })).toMatch(/^name: Use 1-64 lowercase letters/)
    expect(profileIssue({ ...PROFILE, description: 'x'.repeat(LIMITS.profileDescription + 1) })).toMatch(/^description: Too big/)
    expect(profileIssue({ ...PROFILE, capability: { ...REVIEW, workType: 'vendor-x' } })).toMatch(/^capability.workType: Invalid option/)
    expect(profileIssue({ ...PROFILE, capability: { ...REVIEW, extra: true } })).toBe('capability: Unrecognized key: "extra"')
    expect(profileIssue({ ...PROFILE, updatedAt: 'yesterday' })).toMatch(/^updatedAt: Invalid ISO datetime/)
  })
})

describe('buildProfileRecord', () => {
  it('builds the tracked record from the stored profile, without its local revision', () => {
    const db = createTestDb()
    insertProfile(db, { name: 'deep-review', description: 'Careful review', capability: REVIEW, revision: 4, updatedAt: '2026-01-02T00:00:00.000Z' })
    expect(buildProfileRecord(db, 'deep-review')).toEqual(PROFILE)
  })

  it('refuses a missing profile or one whose stored capability is invalid', () => {
    const db = createTestDb()
    expect(rejection(() => buildProfileRecord(db, 'ghost'))).toEqual({ code: 'not_found', message: 'Profile ghost does not exist.' })
    insertProfile(db, { name: 'broken', capability: { workType: 'nope' } })
    expect(rejection(() => buildProfileRecord(db, 'broken'))).toEqual({
      code: 'internal',
      message: 'Cannot export profile broken: capability.workType: Invalid option: expected one of "implementation"|"architecture"|"investigation"|"testing"|"review"|"documentation"'
    })
  })

  it('hashes profile text for change detection, ignoring only CRLF line endings', () => {
    const text = prettyJson(PROFILE)
    expect(trackedProfileHash(text)).toBe(contentHash([text]))
    expect(trackedProfileHash(text.replace(/\n/g, '\r\n'))).toBe(trackedProfileHash(text))
    expect(trackedProfileHash(`${text} `)).not.toBe(trackedProfileHash(text))
  })
})
