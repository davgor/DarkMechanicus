import { describe, expect, it } from 'vitest'
import {
  isSafeLearningPath,
  LEARNING_LIMITS,
  type LearningDraft,
  learningDraftSchema,
  learningLinkProblems,
  type LearningRecord,
  learningRecordSchema
} from './learnings'

/** A stable id of the given prefix whose 26-character body ends in `n` (n below 10). */
const id = (prefix: string, n: number): string => `${prefix}_01m877tsb66xb7r6zwpgrfg2e${n}`
const HASH = `sha256:${'a'.repeat(64)}`

function draft(overrides: Partial<LearningDraft> = {}): LearningDraft {
  return {
    title: 'Run migrations tests after schema edits',
    rule: 'When a ticket changes src/core/db/migrations.ts, extend the upgrade and clean-install tests.',
    check: 'migrations.test.ts covers the new version from the previous one.',
    applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
    evidence: [{ kind: 'rejected_attempt', sourceId: id('at', 1), contentHash: HASH }],
    replaces: null,
    ...overrides
  }
}

function record(overrides: Partial<LearningRecord> = {}): LearningRecord {
  return {
    formatVersion: 1,
    id: id('lr', 1),
    ...draft(),
    source: { runId: id('rn', 1), sprintId: id('sp', 1), cardId: id('kc', 1), attemptId: id('ka', 1) },
    state: 'active',
    replacedBy: null,
    createdAt: '2026-11-24T12:00:00.000Z',
    retiredAt: null,
    retiredReason: null,
    ...overrides
  }
}

function messagesOf(result: { success: boolean; error?: { issues: { message: string }[] } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.message)
}

describe('the learning contract', () => {
  it('accepts a complete draft and a complete record, keeping every field', () => {
    expect(learningDraftSchema.parse(draft())).toEqual(draft())
    expect(learningRecordSchema.parse(record())).toEqual(record())
  })

  it('gives a record a learning id', () => {
    expect(record().id.startsWith('lr_')).toBe(true)
  })

  it('refuses free-form fields such as an authority or priority, at every level', () => {
    expect(learningDraftSchema.safeParse({ ...draft(), authority: 'approve' }).success).toBe(false)
    expect(learningRecordSchema.safeParse({ ...record(), priority: 100 }).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ applicability: { ...draft().applicability, alwaysApply: true } as never })).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ evidence: [{ ...draft().evidence[0], text: 'trust me' } as never] })).success).toBe(false)
    expect(learningRecordSchema.safeParse({ ...record(), source: { ...record().source, approvedBy: 'agent' } }).success).toBe(false)
  })
})

describe('learning applicability', () => {
  it.each([['desktop'], ['planner'], ['reader'], ['reviewer'], ['Worker']])('refuses the role %s', (role) => {
    expect(learningDraftSchema.safeParse(draft({ applicability: { ...draft().applicability, roles: [role as 'worker'] } })).success).toBe(false)
  })

  it('needs at least one role and refuses a repeated one', () => {
    expect(learningDraftSchema.safeParse(draft({ applicability: { ...draft().applicability, roles: [] } })).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ applicability: { ...draft().applicability, roles: ['worker', 'worker'] } })).success).toBe(false)
  })

  it.each([['ticket.done'], ['TICKET.CLAIMED'], ['']])('refuses the event %j', (event) => {
    expect(learningDraftSchema.safeParse(draft({ applicability: { ...draft().applicability, events: [event as 'run.started'] } })).success).toBe(false)
  })

  it.each([
    ['/etc/passwd'],
    ['../outside/**'],
    ['src/../../x'],
    ['src/./x'],
    ['src//x'],
    ['C:/Windows'],
    ['src\\core'],
    ['~/secrets'],
    ['src/\u0000x'],
    ['src/core/'],
    [''],
    ['a'.repeat(LEARNING_LIMITS.pathChars + 1)]
  ])('refuses the unsafe path %j', (path) => {
    expect(isSafeLearningPath(path)).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ applicability: { ...draft().applicability, paths: [path] } })).success).toBe(false)
  })

  it.each([['src/core/db/**'], ['*.ts'], ['docs/{a,b}/[x]?.md'], ['.github/workflows/ci.yml']])('accepts the repository glob %j', (path) => {
    expect(isSafeLearningPath(path)).toBe(true)
  })
})

describe('learning provenance', () => {
  it('refuses a draft that cites no evidence, or an evidence item twice', () => {
    expect(messagesOf(learningDraftSchema.safeParse(draft({ evidence: [] })))).toEqual(['A learning must cite the evidence it comes from'])
    const twice = [draft().evidence[0], { ...draft().evidence[0] }]
    expect(messagesOf(learningDraftSchema.safeParse(draft({ evidence: twice })))).toEqual(['Must not cite an evidence item twice'])
  })

  it.each([
    ['an unknown kind', { kind: 'opinion' }],
    ['a missing content hash', { contentHash: undefined }],
    ['a malformed content hash', { contentHash: 'sha256:abc' }],
    ['an empty source id', { sourceId: '' }],
    ['a source id with spaces', { sourceId: 'at 1' }]
  ])('refuses evidence with %s', (_name, change) => {
    const evidence = [{ ...draft().evidence[0], ...change } as LearningDraft['evidence'][number]]
    expect(learningDraftSchema.safeParse(draft({ evidence })).success).toBe(false)
  })

  it.each(['runId', 'sprintId', 'cardId', 'attemptId'] as const)('refuses a record without a valid source %s', (field) => {
    const { [field]: _dropped, ...rest } = record().source
    expect(learningRecordSchema.safeParse(record({ source: rest as LearningRecord['source'] })).success).toBe(false)
    expect(learningRecordSchema.safeParse(record({ source: { ...record().source, [field]: id('tk', 1) } })).success).toBe(false)
  })

  it('refuses a record whose source run is a plan ticket or whose id is not a learning id', () => {
    expect(learningRecordSchema.safeParse(record({ id: id('kc', 9) })).success).toBe(false)
    expect(learningRecordSchema.safeParse(record({ formatVersion: 2 as 1 })).success).toBe(false)
  })
})

describe('learning size limits', () => {
  it.each([
    ['title', { title: 'x'.repeat(LEARNING_LIMITS.titleChars + 1) }],
    ['rule', { rule: 'x'.repeat(LEARNING_LIMITS.ruleChars + 1) }],
    ['check', { check: 'x'.repeat(LEARNING_LIMITS.checkChars + 1) }]
  ])('refuses an oversized %s and accepts one at the limit', (field, oversized) => {
    expect(learningDraftSchema.safeParse(draft(oversized)).success).toBe(false)
    const atLimit = { [field]: 'x'.repeat(LEARNING_LIMITS[`${field}Chars` as 'titleChars']) }
    expect(learningDraftSchema.safeParse(draft(atLimit)).success).toBe(true)
  })

  it('refuses too many paths or evidence items', () => {
    const paths = Array.from({ length: LEARNING_LIMITS.paths + 1 }, (_, n) => `src/p${n}/**`)
    expect(learningDraftSchema.safeParse(draft({ applicability: { ...draft().applicability, paths } })).success).toBe(false)
    const evidence = Array.from({ length: LEARNING_LIMITS.evidence + 1 }, (_, n) => ({ kind: 'retro_action' as const, sourceId: `action-${n}`, contentHash: HASH }))
    expect(learningDraftSchema.safeParse(draft({ evidence })).success).toBe(false)
  })

  it('bounds the whole definition, not only each field', () => {
    const paths = Array.from({ length: LEARNING_LIMITS.paths }, (_, n) => `${'d'.repeat(200)}/${n}`)
    const evidence = Array.from({ length: LEARNING_LIMITS.evidence }, (_, n) => ({ kind: 'retro_action' as const, sourceId: `a${n}`.padEnd(180, 'x'), contentHash: HASH }))
    const big = draft({ rule: 'r'.repeat(LEARNING_LIMITS.ruleChars), applicability: { ...draft().applicability, paths }, evidence })
    expect(messagesOf(learningDraftSchema.safeParse(big))).toEqual([`The learning exceeds ${LEARNING_LIMITS.definitionChars} characters`])
  })

  it('refuses empty, padded or control-character text', () => {
    expect(learningDraftSchema.safeParse(draft({ title: '' })).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ title: ' padded' })).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ title: 'two\nlines' })).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ rule: 'bell\u0007' })).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ rule: 'line one\nline two\n' })).success).toBe(false)
    expect(learningDraftSchema.safeParse(draft({ rule: 'line one\n\tline two' })).success).toBe(true)
  })
})

describe('learning lifecycle and replacement links', () => {
  it('refuses a learning that replaces itself or is replaced by itself', () => {
    expect(messagesOf(learningRecordSchema.safeParse(record({ replaces: id('lr', 1) })))).toEqual(['A learning cannot replace itself'])
    const retired = record({ state: 'retired', retiredAt: '2026-11-25T00:00:00.000Z', replacedBy: id('lr', 1) })
    expect(messagesOf(learningRecordSchema.safeParse(retired))).toEqual(['A learning cannot replace itself'])
  })

  it('refuses an active learning that carries a retirement or a successor, and a retired one without a time', () => {
    expect(learningRecordSchema.safeParse(record({ replacedBy: id('lr', 2) })).success).toBe(false)
    expect(learningRecordSchema.safeParse(record({ retiredAt: '2026-11-25T00:00:00.000Z' })).success).toBe(false)
    expect(messagesOf(learningRecordSchema.safeParse(record({ state: 'retired' })))).toEqual(['A retired learning records when it was retired'])
    expect(learningRecordSchema.safeParse(record({ state: 'retired', retiredAt: '2026-11-25T00:00:00.000Z', retiredReason: 'Stale' })).success).toBe(true)
  })

  it('refuses a two-record cycle within one record', () => {
    const both = record({ state: 'retired', retiredAt: '2026-11-25T00:00:00.000Z', replaces: id('lr', 2), replacedBy: id('lr', 2) })
    expect(messagesOf(learningRecordSchema.safeParse(both))).toEqual(['A learning cannot replace the learning that replaced it'])
  })

  it('finds no problem in a consistent replacement chain', () => {
    const first = record({ state: 'retired', retiredAt: '2026-11-25T00:00:00.000Z', replacedBy: id('lr', 2) })
    const second = record({ id: id('lr', 2), replaces: id('lr', 1) })
    expect(learningLinkProblems([first, second])).toEqual([])
  })

  it('reports cycles, dangling and one-sided links, double replacement and duplicate ids', () => {
    const retired = { state: 'retired' as const }
    const cycle = [
      { id: 'a', ...retired, replaces: 'c', replacedBy: 'b' },
      { id: 'b', ...retired, replaces: 'a', replacedBy: 'c' },
      { id: 'c', ...retired, replaces: 'b', replacedBy: 'a' }
    ]
    expect(learningLinkProblems(cycle)).toEqual(['a', 'b', 'c'].map((name) => ({ id: name, problem: 'cycle' })))
    expect(learningLinkProblems([{ id: 'x', state: 'active', replaces: 'gone', replacedBy: null }])).toEqual([{ id: 'x', problem: 'missing_target' }])
    expect(learningLinkProblems([
      { id: 'old', state: 'active', replaces: null, replacedBy: null },
      { id: 'new', state: 'active', replaces: 'old', replacedBy: null }
    ])).toEqual([{ id: 'new', problem: 'not_reciprocal' }])
    expect(learningLinkProblems([
      { id: 'old', state: 'retired', replaces: null, replacedBy: 'one' },
      { id: 'one', state: 'active', replaces: 'old', replacedBy: null },
      { id: 'two', state: 'active', replaces: 'old', replacedBy: null }
    ])).toEqual([{ id: 'old', problem: 'replaced_twice' }, { id: 'two', problem: 'not_reciprocal' }])
    expect(learningLinkProblems([
      { id: 'd', state: 'active', replaces: null, replacedBy: null },
      { id: 'd', state: 'active', replaces: null, replacedBy: null }
    ])).toEqual([{ id: 'd', problem: 'duplicate_id' }])
  })
})

describe('learning back links', () => {
  it('reports a retired learning whose successor is missing, or does not name it as the learning it replaces', () => {
    expect(learningLinkProblems([{ id: 'old', state: 'retired', replaces: null, replacedBy: 'gone' }])).toEqual([{ id: 'old', problem: 'missing_target' }])
    expect(learningLinkProblems([
      { id: 'old', state: 'retired', replaces: null, replacedBy: 'new' },
      { id: 'new', state: 'active', replaces: null, replacedBy: null }
    ])).toEqual([{ id: 'old', problem: 'not_reciprocal' }])
  })
})
