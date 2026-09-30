import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { defaultCapabilityProfile, type PlanBundle } from '../shared/domain/bundle'
import { makeBundle, makeSprint, makeTicket, sid, tid } from '../test/bundles'
import { thrownBy } from '../test/thrownBy'
import { DomainError } from './errors'
import {
  artifactRef,
  attemptEvidenceInput,
  attemptOutputsInput,
  capabilityPatch,
  capabilityProfile,
  checkResult,
  commentBody,
  criterion,
  criterionInput,
  criterionResult,
  draftOp,
  draftOps,
  entityRef,
  epicBranch,
  hostCatalog,
  idempotencyKey,
  LIMITS,
  parseInput,
  planBundle,
  policiesPatch,
  sprintDef,
  sprintInput,
  sprintReportInput,
  stableId,
  ticketContent,
  ticketInput,
  ticketKey,
  ticketReference,
  workStatus
} from './schemas'

type Case = [label: string, value: unknown]

function text(length: number): string {
  return 'x'.repeat(length)
}

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success
}

describe('LIMITS', () => {
  it('pins every size limit', () => {
    expect(LIMITS).toEqual({
      title: 300,
      shortText: 2_000,
      markdown: 100_000,
      label: 200,
      criteria: 100,
      tags: 50,
      tag: 64,
      references: 100,
      tickets: 1_000,
      sprints: 100,
      edges: 10_000,
      relations: 5_000,
      opsPerRequest: 500,
      listItems: 500,
      models: 200,
      comment: 20_000,
      commentsPerEpic: 10_000
    })
  })
})

describe('commentBody', () => {
  it('accepts Markdown up to exactly 20,000 characters, whitespace kept', () => {
    expect(commentBody.parse(text(20_000))).toBe(text(20_000))
    expect(commentBody.parse('  **Blocked** on DM-3\n')).toBe('  **Blocked** on DM-3\n')
    expect(commentBody.parse('x')).toBe('x')
  })

  it('rejects 20,001 characters with a readable message', () => {
    const error = thrownBy(() => parseInput(commentBody, text(20_001), 'comment')) as DomainError
    expect(error.code).toBe('invalid_input')
    expect(error.message).toBe('Invalid comment: A comment is at most 20000 characters.')
  })

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['newlines and tabs', '\n\t \r\n']
  ])('rejects a %s body as blank', (_label, value) => {
    const error = thrownBy(() => parseInput(commentBody, value, 'comment')) as DomainError
    expect(error.message).toBe('Invalid comment: A comment needs some text.')
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', { body: 'x' }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(commentBody, value)).toBe(false)
  })
})

const VALID_IDS: Case[] = [
  ['ticket id', tid(1)],
  ['sprint id', sid(1)],
  ['any two-letter prefix', `zz_${'0'.repeat(26)}`],
  ['all alphabet characters', `ab_${'0123456789abcdefghjkmnpqrs'}`]
]

const INVALID_IDS: Case[] = [
  ['empty', ''],
  ['too short', 'tk_abc'],
  ['one char too long', `${tid(1)}0`],
  ['uppercase', tid(1).toUpperCase()],
  ['dash separator', `tk-${'0'.repeat(26)}`],
  ['excluded letter u', `tk_${'0'.repeat(25)}u`],
  ['number', 42],
  ['null', null],
  ['undefined', undefined]
]

describe('stableId', () => {
  it.each(VALID_IDS)('accepts %s', (_label, value) => {
    expect(accepts(stableId, value)).toBe(true)
  })

  it.each(INVALID_IDS)('rejects %s', (_label, value) => {
    expect(accepts(stableId, value)).toBe(false)
  })

  it('explains the expected format', () => {
    const result = stableId.safeParse('nope')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Expected a stable id such as tk_…')
  })
})

const VALID_REFS: Case[] = [
  ['a ticket key', 'DM-12'],
  ['a stable id', tid(3)],
  ['a single character', 'x'],
  ['dots, colons, dashes and underscores', 'a.b:c-d_e'],
  ['64 characters', text(64)],
  ['an ordinal', '12']
]

const INVALID_REFS: Case[] = [
  ['empty', ''],
  ['65 characters', text(65)],
  ['a space', 'a b'],
  ['a slash', 'a/b'],
  ['non-ASCII letters', 'ünï'],
  ['a newline', 'a\nb'],
  ['a number', 12]
]

describe('entityRef', () => {
  it.each(VALID_REFS)('accepts %s', (_label, value) => {
    expect(accepts(entityRef, value)).toBe(true)
  })

  it.each(INVALID_REFS)('rejects %s', (_label, value) => {
    expect(accepts(entityRef, value)).toBe(false)
  })
})

describe('idempotencyKey', () => {
  it.each([
    ['undefined', undefined],
    ['a short key', 'k'],
    ['200 characters', text(200)]
  ])('accepts %s', (_label, value) => {
    expect(accepts(idempotencyKey, value)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['201 characters', text(201)],
    ['a number', 7],
    ['null', null]
  ])('rejects %s', (_label, value) => {
    expect(accepts(idempotencyKey, value)).toBe(false)
  })
})

describe('criterion', () => {
  it.each([
    ['a normal criterion', { id: 'c1', text: 'Works' }],
    ['empty text', { id: 's12', text: '' }],
    ['2000 characters of text', { id: 'x9999', text: text(2000) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(criterion, value)).toBe(true)
  })

  it.each([
    ['a missing id', { text: 'x' }],
    ['a missing text', { id: 'c1' }],
    ['an uppercase id', { id: 'C1', text: 'x' }],
    ['an id without digits', { id: 'c', text: 'x' }],
    ['an extra key', { id: 'c1', text: 'x', extra: 1 }],
    ['2001 characters of text', { id: 'c1', text: text(2001) }],
    ['a string', 'c1']
  ])('rejects %s', (_label, value) => {
    expect(accepts(criterion, value)).toBe(false)
  })
})

describe('criterionInput', () => {
  it.each([
    ['a bare string', 'plain'],
    ['an object without an id', { text: 'x' }],
    ['an object with an id', { id: 'c3', text: 'x' }],
    ['a 2000 character string', text(2000)]
  ])('accepts %s', (_label, value) => {
    expect(accepts(criterionInput, value)).toBe(true)
  })

  it.each([
    ['an invalid id', { id: 'BAD', text: 'x' }],
    ['an object without text', { id: 'c1' }],
    ['non-string text', { text: 5 }],
    ['an extra key', { text: 'x', extra: true }],
    ['a 2001 character string', text(2001)],
    ['null', null],
    ['an empty object', {}]
  ])('rejects %s', (_label, value) => {
    expect(accepts(criterionInput, value)).toBe(false)
  })
})

const ALL_TOOLS = ['repo_read', 'repo_write', 'shell', 'browser', 'test_execution', 'network']

function profileWith(change: (profile: Record<string, unknown>) => void): unknown {
  const profile = structuredClone(defaultCapabilityProfile()) as unknown as Record<string, unknown>
  change(profile)
  return profile
}

function nested(profile: Record<string, unknown>, key: string): Record<string, unknown> {
  return profile[key] as Record<string, unknown>
}

const VALID_PROFILES: Case[] = [
  ['the default profile', defaultCapabilityProfile()],
  ['a fully populated profile', profileWith((profile) => {
    profile.workType = 'documentation'
    profile.skills = ['ts', 'sql']
    profile.modalities = ['text', 'images']
    profile.tools = ALL_TOOLS
    Object.assign(nested(profile, 'reasoning'), { level: 'deep', rationale: 'why' })
    Object.assign(nested(profile, 'context'), { estimatedInputTokens: 100_000_000, requiredArtifacts: ['a'] })
    Object.assign(nested(profile, 'constraints'), { maxDurationMinutes: 100_000, maxCostUsd: 1_000_000, dataLocation: 'eu' })
    Object.assign(nested(profile, 'preferences'), {
      quality: 'high',
      latency: 'low',
      cost: 'normal',
      autonomy: 'autonomous',
      modelOverride: 'm'
    })
  })],
  ['zero tokens and zero cost', profileWith((profile) => {
    Object.assign(nested(profile, 'context'), { estimatedInputTokens: 0 })
    Object.assign(nested(profile, 'constraints'), { maxCostUsd: 0 })
  })]
]

const INVALID_PROFILES: Case[] = [
  ['a missing tools list', profileWith((profile) => { Reflect.deleteProperty(profile, 'tools') })],
  ['an unknown work type', profileWith((profile) => { profile.workType = 'sorcery' })],
  ['an extra key', profileWith((profile) => { profile.extra = 1 })],
  ['an unknown reasoning level', profileWith((profile) => { nested(profile, 'reasoning').level = 'genius' })],
  ['an extra key in a nested group', profileWith((profile) => { nested(profile, 'context').extra = 1 })],
  ['negative estimated tokens', profileWith((profile) => { nested(profile, 'context').estimatedInputTokens = -1 })],
  ['fractional estimated tokens', profileWith((profile) => { nested(profile, 'context').estimatedInputTokens = 1.5 })],
  ['too many estimated tokens', profileWith((profile) => { nested(profile, 'context').estimatedInputTokens = 100_000_001 })],
  ['a zero duration limit', profileWith((profile) => { nested(profile, 'constraints').maxDurationMinutes = 0 })],
  ['a negative cost limit', profileWith((profile) => { nested(profile, 'constraints').maxCostUsd = -0.5 })],
  ['three modalities', profileWith((profile) => { profile.modalities = ['text', 'images', 'text'] })],
  ['an unknown tool', profileWith((profile) => { profile.tools = ['teleport'] })],
  ['seven tools', profileWith((profile) => { profile.tools = [...ALL_TOOLS, 'shell'] })],
  ['an unknown quality preference', profileWith((profile) => { nested(profile, 'preferences').quality = 'medium' })],
  ['51 skills', profileWith((profile) => { profile.skills = Array.from({ length: 51 }, () => 's') })],
  ['a 65 character skill', profileWith((profile) => { profile.skills = [text(65)] })]
]

describe('capabilityProfile', () => {
  it.each(VALID_PROFILES)('accepts %s', (_label, value) => {
    expect(accepts(capabilityProfile, value)).toBe(true)
  })

  it.each(INVALID_PROFILES)('rejects %s', (_label, value) => {
    expect(accepts(capabilityProfile, value)).toBe(false)
  })

  it('accepts 50 skills of 64 characters', () => {
    const profile = profileWith((value) => { value.skills = Array.from({ length: 50 }, () => text(64)) })
    expect(accepts(capabilityProfile, profile)).toBe(true)
  })
})

describe('capabilityPatch', () => {
  it.each([
    ['an empty patch', {}],
    ['a work type', { workType: 'review' }],
    ['a partial reasoning group', { reasoning: { level: 'deep' } }],
    ['a partial context group', { context: { estimatedInputTokens: null } }],
    ['a partial constraints group', { constraints: { maxCostUsd: 1 } }],
    ['a partial preferences group', { preferences: { quality: null } }],
    ['lists', { skills: ['a'], modalities: ['text'], tools: ['shell'] }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(capabilityPatch, value)).toBe(true)
  })

  it.each([
    ['an extra key', { color: 'red' }],
    ['an extra nested key', { reasoning: { level: 'deep', mood: 'calm' } }],
    ['an invalid enum value', { workType: 'juggling' }],
    ['a wrongly typed list', { tools: 'shell' }],
    ['an invalid nested value', { constraints: { maxDurationMinutes: 0 } }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(capabilityPatch, value)).toBe(false)
  })
})

const REFERENCE = { kind: 'url', label: 'Spec', location: 'https://example.com/spec', hash: null, remoteOnly: false }

describe('ticketReference', () => {
  it.each([
    ['a url reference', REFERENCE],
    ['every reference kind', { ...REFERENCE, kind: 'commit', hash: 'abc123' }],
    ['a remote-only file', { ...REFERENCE, kind: 'file', location: 'src/a.ts', remoteOnly: true }],
    ['the longest label and location', { ...REFERENCE, label: text(200), location: text(2000), hash: text(200) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(ticketReference, value)).toBe(true)
  })

  it.each([
    ['an unknown kind', { ...REFERENCE, kind: 'video' }],
    ['a missing hash', { kind: 'url', label: 'a', location: 'b', remoteOnly: false }],
    ['a missing remoteOnly flag', { kind: 'url', label: 'a', location: 'b', hash: null }],
    ['an extra key', { ...REFERENCE, extra: 1 }],
    ['a 201 character label', { ...REFERENCE, label: text(201) }],
    ['a 2001 character location', { ...REFERENCE, location: text(2001) }],
    ['a 201 character hash', { ...REFERENCE, hash: text(201) }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(ticketReference, value)).toBe(false)
  })
})

const FULL_TICKET_INPUT = {
  title: 'T',
  body: 'b',
  acceptanceCriteria: ['a', { id: 'c2', text: 'b' }],
  tags: ['x'],
  priority: 'critical',
  capability: { workType: 'testing' },
  references: [REFERENCE],
  expectedArtifacts: ['docs/a.md'],
  optional: false
}

const criteria = (count: number): string[] => Array.from({ length: count }, (_, index) => `criterion ${index}`)

describe('ticketInput accepted shapes', () => {
  it.each([
    ['only a title', { title: 'T' }],
    ['a 300 character title', { title: text(300) }],
    ['a 100000 character body', { title: 'T', body: text(100_000) }],
    ['every field', FULL_TICKET_INPUT],
    ['100 acceptance criteria', { title: 'T', acceptanceCriteria: criteria(100) }],
    ['50 tags of 64 characters', { title: 'T', tags: Array.from({ length: 50 }, () => text(64)) }],
    ['100 references', { title: 'T', references: Array.from({ length: 100 }, () => REFERENCE) }],
    ['100 artifacts of 200 characters', { title: 'T', expectedArtifacts: Array.from({ length: 100 }, () => text(200)) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(ticketInput, value)).toBe(true)
  })
})

describe('ticketInput rejected shapes', () => {
  it.each([
    ['no title', {}],
    ['an empty title', { title: '' }],
    ['a 301 character title', { title: text(301) }],
    ['a 100001 character body', { title: 'T', body: text(100_001) }],
    ['101 acceptance criteria', { title: 'T', acceptanceCriteria: criteria(101) }],
    ['51 tags', { title: 'T', tags: Array.from({ length: 51 }, () => 't') }],
    ['a 65 character tag', { title: 'T', tags: [text(65)] }],
    ['101 references', { title: 'T', references: Array.from({ length: 101 }, () => REFERENCE) }],
    ['101 expected artifacts', { title: 'T', expectedArtifacts: Array.from({ length: 101 }, () => 'a') }],
    ['a 201 character artifact', { title: 'T', expectedArtifacts: [text(201)] }],
    ['an unknown priority', { title: 'T', priority: 'urgent' }],
    ['a non-boolean optional flag', { title: 'T', optional: 'yes' }],
    ['an extra key', { title: 'T', bogus: 1 }],
    ['an invalid capability patch', { title: 'T', capability: { workType: 'nope' } }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(ticketInput, value)).toBe(false)
  })
})

const FULL_SPRINT_INPUT = {
  goal: 'g',
  entryCriteria: ['a'],
  exitCriteria: [{ text: 'b' }],
  concurrencyCap: 3,
  checkpoint: { mode: 'auto' }
}

describe('sprintInput', () => {
  it.each([
    ['an empty goal', { goal: '' }],
    ['a 2000 character goal', { goal: text(2000) }],
    ['a full sprint', FULL_SPRINT_INPUT],
    ['the smallest cap', { goal: 'g', concurrencyCap: 1 }],
    ['the largest cap', { goal: 'g', concurrencyCap: 1000 }],
    ['an unlimited cap', { goal: 'g', concurrencyCap: null }],
    ['100 entry criteria', { goal: 'g', entryCriteria: criteria(100) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(sprintInput, value)).toBe(true)
  })

  it.each([
    ['a missing goal', {}],
    ['a 2001 character goal', { goal: text(2001) }],
    ['a zero cap', { goal: 'g', concurrencyCap: 0 }],
    ['a 1001 cap', { goal: 'g', concurrencyCap: 1001 }],
    ['a fractional cap', { goal: 'g', concurrencyCap: 1.5 }],
    ['an unknown checkpoint mode', { goal: 'g', checkpoint: { mode: 'never' } }],
    ['an extra checkpoint key', { goal: 'g', checkpoint: { mode: 'human', by: 'me' } }],
    ['101 exit criteria', { goal: 'g', exitCriteria: criteria(101) }],
    ['an extra key', { goal: 'g', extra: true }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(sprintInput, value)).toBe(false)
  })
})

describe('policiesPatch', () => {
  it.each([
    ['an empty patch', {}],
    ['retry limit 1', { retryLimit: 1 }],
    ['retry limit 100', { retryLimit: 100 }],
    ['lease 30 seconds', { leaseSeconds: 30 }],
    ['lease 86400 seconds', { leaseSeconds: 86_400 }],
    ['unlimited concurrency', { maxConcurrency: null }],
    ['concurrency 1000', { maxConcurrency: 1000 }],
    ['a failure policy', { onTicketFailure: 'fail_run' }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(policiesPatch, value)).toBe(true)
  })

  it.each([
    ['retry limit 0', { retryLimit: 0 }],
    ['retry limit 101', { retryLimit: 101 }],
    ['a fractional retry limit', { retryLimit: 1.5 }],
    ['lease 29 seconds', { leaseSeconds: 29 }],
    ['lease 86401 seconds', { leaseSeconds: 86_401 }],
    ['concurrency 0', { maxConcurrency: 0 }],
    ['concurrency 1001', { maxConcurrency: 1001 }],
    ['an unknown failure policy', { onTicketFailure: 'ignore' }],
    ['an extra key', { color: 'red' }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(policiesPatch, value)).toBe(false)
  })
})

describe('ticketKey', () => {
  it.each(['DM-1', 'dm-1', 'A-0', 'ABC123-999999999', 'ABCDEFGHIJKL-1'])('accepts %s', (key) => {
    expect(accepts(ticketKey, key)).toBe(true)
  })

  it.each(['', 'DM-', 'DM1', '-1', 'DM-1234567890', 'ABCDEFGHIJKLM-1', 'D_M-1', 'DM-1a', 'DM--1', 'DM 1', 7])(
    'rejects %j',
    (key) => {
      expect(accepts(ticketKey, key)).toBe(false)
    }
  )
})

describe('ticketContent', () => {
  const valid = (): Record<string, unknown> => structuredClone(makeTicket(1)) as unknown as Record<string, unknown>

  it('accepts a complete ticket', () => {
    expect(accepts(ticketContent, makeTicket(1))).toBe(true)
    expect(accepts(ticketContent, makeTicket(2, { optional: true, tags: ['a'], priority: 'low' }))).toBe(true)
  })

  it.each([
    ['a bad id', { id: 'DM-1' }],
    ['a bad key', { key: 'DM' }],
    ['an empty title', { title: '' }],
    ['an unknown priority', { priority: 'meh' }],
    ['a bad criterion id', { acceptanceCriteria: [{ id: 'CRIT', text: 'x' }] }],
    ['a non-boolean optional flag', { optional: 'no' }],
    ['an extra key', { bogus: 1 }]
  ])('rejects %s', (_label, change) => {
    expect(accepts(ticketContent, { ...valid(), ...change })).toBe(false)
  })

  it('rejects a ticket missing a field', () => {
    for (const field of Object.keys(valid())) {
      const partial = valid()
      Reflect.deleteProperty(partial, field)
      expect(accepts(ticketContent, partial)).toBe(false)
    }
  })
})

describe('sprintDef', () => {
  const valid = (): Record<string, unknown> => structuredClone(makeSprint(1, [1, 2])) as unknown as Record<string, unknown>

  it('accepts complete sprints', () => {
    expect(accepts(sprintDef, makeSprint(1, [1, 2]))).toBe(true)
    expect(accepts(sprintDef, makeSprint(100, [], { concurrencyCap: 5, checkpoint: { mode: 'auto' } }))).toBe(true)
  })

  it.each([
    ['ordinal 0', { ordinal: 0 }],
    ['ordinal 101', { ordinal: 101 }],
    ['a fractional ordinal', { ordinal: 1.5 }],
    ['a bad ticket id', { ticketIds: ['DM-1'] }],
    ['a zero cap', { concurrencyCap: 0 }],
    ['a bad checkpoint', { checkpoint: { mode: 'sometimes' } }],
    ['a bad criterion', { entryCriteria: [{ id: 'bad', text: 'x' }] }],
    ['an extra key', { extra: 1 }]
  ])('rejects %s', (_label, change) => {
    expect(accepts(sprintDef, { ...valid(), ...change })).toBe(false)
  })

  it('rejects a sprint missing a field', () => {
    for (const field of Object.keys(valid())) {
      const partial = valid()
      Reflect.deleteProperty(partial, field)
      expect(accepts(sprintDef, partial)).toBe(false)
    }
  })
})

const MIXED_CRITERIA = ['a', { text: 'b' }, { id: 's3', text: 'c' }]

const VALID_OPS: Case[] = [
  ['set_epic with everything', { op: 'set_epic', title: 'T', intent: 'I', successCriteria: MIXED_CRITERIA, ownerRole: null }],
  ['set_epic with nothing', { op: 'set_epic' }],
  ['add_sprint', { op: 'add_sprint', ref: 'r1', sprint: { goal: 'g', concurrencyCap: 2 }, position: 1 }],
  ['update_sprint by id', { op: 'update_sprint', sprint: sid(1), patch: { goal: 'g' } }],
  ['update_sprint with an empty patch', { op: 'update_sprint', sprint: '2', patch: {} }],
  ['remove_sprint', { op: 'remove_sprint', sprint: '1' }],
  ['add_ticket', { op: 'add_ticket', ref: 't.1', sprint: 's', ticket: { title: 'T' } }],
  ['update_ticket', { op: 'update_ticket', ticket: 'DM-1', patch: { title: 'T2', tags: [] } }],
  ['remove_ticket', { op: 'remove_ticket', ticket: 'DM-1' }],
  ['move_ticket with a position', { op: 'move_ticket', ticket: 'DM-1', toSprint: '2', position: 0 }],
  ['add_dependency', { op: 'add_dependency', from: 'DM-1', to: 'DM-2' }],
  ['remove_dependency', { op: 'remove_dependency', from: 'DM-1', to: 'DM-2' }],
  ['add_relation', { op: 'add_relation', kind: 'related_to', from: 'DM-1', to: 'DM-2' }],
  ['remove_relation', { op: 'remove_relation', kind: 'duplicate_of', from: 'DM-1', to: 'DM-2' }],
  ['set_policies', { op: 'set_policies', patch: { retryLimit: 2 } }],
  ['set_rationale', { op: 'set_rationale', rationale: 'why' }],
  ['the largest position', { op: 'add_sprint', sprint: { goal: 'g' }, position: 1000 }]
]

const INVALID_OPS: Case[] = [
  ['an unknown operation', { op: 'explode' }],
  ['an upper-case operation', { op: 'SET_EPIC' }],
  ['a missing operation', { rationale: 'x' }],
  ['a numeric operation', { op: 5 }],
  ['a string instead of an object', 'set_rationale'],
  ['null', null],
  ['an extra key', { op: 'set_rationale', rationale: 'x', extra: true }],
  ['an extra key inside a ticket', { op: 'add_ticket', sprint: '1', ticket: { title: 'T', bogus: 1 } }],
  ['a missing required field', { op: 'set_rationale' }],
  ['a missing dependency target', { op: 'add_dependency', from: 'a' }],
  ['an unknown relation kind', { op: 'add_relation', kind: 'blocks', from: 'a', to: 'b' }],
  ['an empty epic title', { op: 'set_epic', title: '' }],
  ['a negative position', { op: 'add_sprint', sprint: { goal: 'g' }, position: -1 }],
  ['a fractional position', { op: 'move_ticket', ticket: 'a', toSprint: 'b', position: 1.5 }],
  ['a position above 1000', { op: 'add_sprint', sprint: { goal: 'g' }, position: 1001 }],
  ['a client ref with a space', { op: 'add_sprint', ref: 'a b', sprint: { goal: 'g' } }],
  ['a client ref with a colon', { op: 'add_ticket', ref: 'a:b', sprint: '1', ticket: { title: 'T' } }],
  ['an empty client ref', { op: 'add_sprint', ref: '', sprint: { goal: 'g' } }],
  ['an empty entity ref', { op: 'remove_ticket', ticket: '' }],
  ['an entity ref with a slash', { op: 'remove_ticket', ticket: 'a/b' }],
  ['a blank new ticket title', { op: 'add_ticket', sprint: '1', ticket: { title: '' } }],
  ['a blanked ticket title in a patch', { op: 'update_ticket', ticket: 'a', patch: { title: '' } }],
  ['an out-of-range policy', { op: 'set_policies', patch: { retryLimit: 0 } }],
  ['an unknown policy', { op: 'set_policies', patch: { color: 'red' } }],
  ['a zero sprint cap in a patch', { op: 'update_sprint', sprint: '1', patch: { concurrencyCap: 0 } }]
]

describe('draftOp', () => {
  it.each(VALID_OPS)('accepts %s', (_label, value) => {
    expect(accepts(draftOp, value)).toBe(true)
  })

  it.each(INVALID_OPS)('rejects %s', (_label, value) => {
    expect(accepts(draftOp, value)).toBe(false)
  })

  it('names the unknown discriminator value in its error', () => {
    const result = draftOp.safeParse({ op: 'explode' })
    expect(result.error?.issues[0]?.path).toEqual(['op'])
    expect(result.error?.issues[0]?.message).toContain('Invalid discriminator value')
  })
})

describe('draftOps', () => {
  const op = { op: 'set_rationale', rationale: 'x' }

  it('accepts between one and 500 operations', () => {
    expect(accepts(draftOps, [op])).toBe(true)
    expect(accepts(draftOps, Array.from({ length: 500 }, () => op))).toBe(true)
  })

  it('rejects no operations, 501 operations, non-arrays and invalid members', () => {
    expect(accepts(draftOps, [])).toBe(false)
    expect(accepts(draftOps, Array.from({ length: 501 }, () => op))).toBe(false)
    expect(accepts(draftOps, op)).toBe(false)
    expect(accepts(draftOps, [op, { op: 'explode' }])).toBe(false)
  })
})

function bundleWith(change: (bundle: PlanBundle) => void): PlanBundle {
  const bundle = structuredClone(makeBundle([[1, 2], [3]], [[1, 3]]))
  change(bundle)
  return bundle
}

function loose(value: object): Record<string, unknown> {
  return value as Record<string, unknown>
}

const VALID_BUNDLES: Case[] = [
  ['a two-sprint plan', makeBundle([[1, 2], [3]], [[1, 3]])],
  ['an empty single-sprint plan', makeBundle([[]])],
  ['a fork/join plan', makeBundle([[1, 2, 3, 4]], [[1, 2], [1, 3], [2, 4], [3, 4]])],
  ['relations and an owner role', bundleWith((bundle) => {
    bundle.relations = [{ kind: 'duplicate_of', from: tid(1), to: tid(2) }]
    bundle.epic.ownerRole = 'lead'
  })],
  ['boundary policies', bundleWith((bundle) => {
    bundle.policies = { maxConcurrency: 1000, retryLimit: 100, onTicketFailure: 'fail_run', leaseSeconds: 86_400 }
  })],
  ['the smallest policies', bundleWith((bundle) => {
    bundle.policies = { maxConcurrency: null, retryLimit: 1, onTicketFailure: 'pause_run', leaseSeconds: 30 }
  })]
]

const INVALID_BUNDLES: Case[] = [
  ['a missing rationale', bundleWith((bundle) => { Reflect.deleteProperty(bundle, 'rationale') })],
  ['a missing policies block', bundleWith((bundle) => { Reflect.deleteProperty(bundle, 'policies') })],
  ['an extra root key', { ...makeBundle([[1]]), extra: 1 }],
  ['another format version', bundleWith((bundle) => { loose(bundle).formatVersion = 2 })],
  ['no sprints', bundleWith((bundle) => { bundle.sprints = [] })],
  ['an empty epic title', bundleWith((bundle) => { bundle.epic.title = '' })],
  ['a bad ticket id', bundleWith((bundle) => { loose(bundle.tickets[0] ?? {}).id = 'DM-1' })],
  ['a bad ticket key', bundleWith((bundle) => { loose(bundle.tickets[0] ?? {}).key = 'DM' })],
  ['an extra ticket key', bundleWith((bundle) => { loose(bundle.tickets[0] ?? {}).bogus = 1 })],
  ['a bad edge id', bundleWith((bundle) => { bundle.edges = [{ from: 'a', to: tid(1) }] })],
  ['an extra edge key', bundleWith((bundle) => { bundle.edges = [{ from: tid(1), to: tid(2), weight: 1 } as never] })],
  ['an unknown relation kind', bundleWith((bundle) => {
    bundle.relations = [{ kind: 'blocks' as never, from: tid(1), to: tid(2) }]
  })],
  ['retry limit 0', bundleWith((bundle) => { bundle.policies.retryLimit = 0 })],
  ['retry limit 101', bundleWith((bundle) => { bundle.policies.retryLimit = 101 })],
  ['lease 29 seconds', bundleWith((bundle) => { bundle.policies.leaseSeconds = 29 })],
  ['lease 86401 seconds', bundleWith((bundle) => { bundle.policies.leaseSeconds = 86_401 })],
  ['concurrency 0', bundleWith((bundle) => { bundle.policies.maxConcurrency = 0 })],
  ['a sprint ordinal of 0', bundleWith((bundle) => { loose(bundle.sprints[0] ?? {}).ordinal = 0 })],
  ['a bad sprint checkpoint', bundleWith((bundle) => { loose(bundle.sprints[0] ?? {}).checkpoint = { mode: 'x' } })],
  ['a bad success criterion id', bundleWith((bundle) => { bundle.epic.successCriteria = [{ id: 'S1', text: 'x' }] })],
  ['null', null]
]

describe('planBundle', () => {
  it.each(VALID_BUNDLES)('accepts %s', (_label, value) => {
    expect(accepts(planBundle, value)).toBe(true)
  })

  it.each(INVALID_BUNDLES)('rejects %s', (_label, value) => {
    expect(accepts(planBundle, value)).toBe(false)
  })

  it('accepts exactly 1000 tickets and rejects 1001', () => {
    const many = (count: number): PlanBundle =>
      bundleWith((bundle) => {
        bundle.tickets = Array.from({ length: count }, (_, index) => makeTicket(index + 1))
      })
    expect(accepts(planBundle, many(1000))).toBe(true)
    expect(accepts(planBundle, many(1001))).toBe(false)
  })

  it('parses a valid bundle back to the same data', () => {
    const bundle = makeBundle([[1, 2], [3]], [[1, 3]])
    expect(parseInput(planBundle, bundle, 'plan')).toEqual(bundle)
  })
})

const BRANCH = { repository: null, name: 'feature/x-1', startCommit: null }

describe('epicBranch', () => {
  it.each([
    ['a plain branch', BRANCH],
    ['a remote repository', { ...BRANCH, repository: 'https://example.com/repo.git' }],
    ['a 255 character name', { ...BRANCH, name: text(255) }],
    ['a name with dots, dashes and slashes', { ...BRANCH, name: 'release/1.2.3-rc.1' }],
    ['a 7 character commit', { ...BRANCH, startCommit: 'abcdef0' }],
    ['a 64 character commit', { ...BRANCH, startCommit: 'a'.repeat(64) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(epicBranch, value)).toBe(true)
  })

  it.each([
    ['an empty name', { ...BRANCH, name: '' }],
    ['a 256 character name', { ...BRANCH, name: text(256) }],
    ['a name with a space', { ...BRANCH, name: 'my branch' }],
    ['a name with a tab', { ...BRANCH, name: 'my\tbranch' }],
    ['a name with a tilde', { ...BRANCH, name: 'a~1' }],
    ['a name with a caret', { ...BRANCH, name: 'a^' }],
    ['a name with a colon', { ...BRANCH, name: 'a:b' }],
    ['a name with a question mark', { ...BRANCH, name: 'a?' }],
    ['a name with an asterisk', { ...BRANCH, name: 'a*' }],
    ['a name with a bracket', { ...BRANCH, name: 'a[0]' }],
    ['a name with a backslash', { ...BRANCH, name: 'a\\b' }],
    ['a 6 character commit', { ...BRANCH, startCommit: 'abcdef' }],
    ['a 65 character commit', { ...BRANCH, startCommit: 'a'.repeat(65) }],
    ['an upper-case commit', { ...BRANCH, startCommit: 'ABCDEF0' }],
    ['a missing repository', { name: 'a', startCommit: null }],
    ['an extra key', { ...BRANCH, remote: 'origin' }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(epicBranch, value)).toBe(false)
  })

  it('says why a name is invalid', () => {
    const result = epicBranch.safeParse({ ...BRANCH, name: 'a b' })
    expect(result.error?.issues[0]?.message).toBe('Not a valid branch name')
  })
})

describe('workStatus', () => {
  it.each(['backlog', 'in_progress', 'completed'])('accepts %s', (status) => {
    expect(accepts(workStatus, status)).toBe(true)
  })

  it.each(['done', 'paused', '', 'Backlog', null])('rejects %j', (status) => {
    expect(accepts(workStatus, status)).toBe(false)
  })
})

describe('criterionResult', () => {
  it('defaults the note to an empty string', () => {
    expect(criterionResult.parse({ criterionId: 'c1', met: true })).toEqual({ criterionId: 'c1', met: true, note: '' })
    expect(criterionResult.parse({ criterionId: 'x2', met: false, note: 'nope' })).toEqual({
      criterionId: 'x2',
      met: false,
      note: 'nope'
    })
  })

  it.each([
    ['a bad criterion id', { criterionId: 'CRIT', met: true }],
    ['a missing met flag', { criterionId: 'c1' }],
    ['a non-boolean met flag', { criterionId: 'c1', met: 'yes' }],
    ['a 2001 character note', { criterionId: 'c1', met: true, note: text(2001) }],
    ['an extra key', { criterionId: 'c1', met: true, extra: 1 }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(criterionResult, value)).toBe(false)
  })
})

describe('checkResult', () => {
  it('defaults the detail to an empty string', () => {
    expect(checkResult.parse({ name: 'lint', status: 'passed' })).toEqual({ name: 'lint', status: 'passed', detail: '' })
  })

  it.each(['passed', 'failed', 'skipped'])('accepts the %s status', (status) => {
    expect(accepts(checkResult, { name: 'n', status })).toBe(true)
  })

  it.each([
    ['an unknown status', { name: 'n', status: 'flaky' }],
    ['a missing name', { status: 'passed' }],
    ['a 201 character name', { name: text(201), status: 'passed' }],
    ['a 2001 character detail', { name: 'n', status: 'passed', detail: text(2001) }],
    ['an extra key', { name: 'n', status: 'passed', extra: 1 }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(checkResult, value)).toBe(false)
  })
})

describe('artifactRef', () => {
  it('defaults the hash to null and remoteOnly to false', () => {
    expect(artifactRef.parse({ label: 'a', location: 'b' })).toEqual({
      label: 'a',
      location: 'b',
      hash: null,
      remoteOnly: false
    })
  })

  it('keeps supplied values', () => {
    const full = { label: 'a', location: 'b', hash: 'sha256:1', remoteOnly: true }
    expect(artifactRef.parse(full)).toEqual(full)
  })

  it.each([
    ['a missing location', { label: 'a' }],
    ['a 201 character label', { label: text(201), location: 'b' }],
    ['a 2001 character location', { label: 'a', location: text(2001) }],
    ['a 201 character hash', { label: 'a', location: 'b', hash: text(201) }],
    ['an extra key', { label: 'a', location: 'b', extra: 1 }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(artifactRef, value)).toBe(false)
  })
})

const FULL_OUTPUTS = {
  summary: 's',
  artifacts: [{ label: 'a', location: 'b' }],
  commits: ['abc'],
  changedFiles: ['a.ts'],
  branch: 'x'
}

describe('attemptOutputsInput', () => {
  it.each([
    ['only a summary', { summary: 's' }],
    ['every field', FULL_OUTPUTS],
    ['a null branch', { summary: 's', branch: null }],
    ['a 255 character branch', { summary: 's', branch: text(255) }],
    ['100 artifacts', { summary: 's', artifacts: Array.from({ length: 100 }, () => ({ label: 'a', location: 'b' })) }],
    ['500 commits of 200 characters', { summary: 's', commits: Array.from({ length: 500 }, () => text(200)) }],
    ['5000 changed files', { summary: 's', changedFiles: Array.from({ length: 5000 }, () => 'f') }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(attemptOutputsInput, value)).toBe(true)
  })

  it.each([
    ['no summary', {}],
    ['a non-string summary', { summary: 5 }],
    ['101 artifacts', { summary: 's', artifacts: Array.from({ length: 101 }, () => ({ label: 'a', location: 'b' })) }],
    ['501 commits', { summary: 's', commits: Array.from({ length: 501 }, () => 'c') }],
    ['a 201 character commit', { summary: 's', commits: [text(201)] }],
    ['5001 changed files', { summary: 's', changedFiles: Array.from({ length: 5001 }, () => 'f') }],
    ['a 256 character branch', { summary: 's', branch: text(256) }],
    ['an extra key', { summary: 's', extra: 1 }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(attemptOutputsInput, value)).toBe(false)
  })
})

const FULL_EVIDENCE = {
  checks: [{ name: 'lint', status: 'passed' }],
  criteria: [{ criterionId: 'c1', met: true }],
  notes: 'n'
}

describe('attemptEvidenceInput', () => {
  it.each([
    ['an empty object', {}],
    ['checks, criteria and notes', FULL_EVIDENCE],
    ['500 checks', { checks: Array.from({ length: 500 }, () => ({ name: 'n', status: 'skipped' })) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(attemptEvidenceInput, value)).toBe(true)
  })

  it.each([
    ['an invalid check', { checks: [{ name: 'n', status: 'bad' }] }],
    ['an invalid criterion result', { criteria: [{ criterionId: 'bad', met: true }] }],
    ['501 checks', { checks: Array.from({ length: 501 }, () => ({ name: 'n', status: 'passed' })) }],
    ['101 criteria', { criteria: Array.from({ length: 101 }, () => ({ criterionId: 'c1', met: true })) }],
    ['non-string notes', { notes: 5 }],
    ['an extra key', { extra: true }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(attemptEvidenceInput, value)).toBe(false)
  })
})

const FULL_REPORT = {
  summary: 's',
  accepted: ['a'],
  failed: ['f'],
  blocked: ['b'],
  changes: { files: ['x'], commits: ['c'] },
  checks: [{ name: 'n', status: 'passed' }],
  risks: ['r'],
  followUps: [{ title: 't', body: 'b' }],
  exitCriteria: [{ criterionId: 'x1', met: true }],
  epicOutcome: { summary: 'done', successCriteria: [{ criterionId: 's1', met: true }] }
}

describe('sprintReportInput', () => {
  it('accepts a summary alone and leaves the optional fields absent', () => {
    expect(sprintReportInput.parse({ summary: 's' })).toEqual({ summary: 's' })
  })

  it('defaults follow-up bodies to an empty string', () => {
    expect(sprintReportInput.parse({ summary: 's', followUps: [{ title: 't' }] }).followUps).toEqual([
      { title: 't', body: '' }
    ])
  })

  it.each([
    ['a full report', FULL_REPORT],
    ['a null epic outcome', { summary: 's', epicOutcome: null }],
    ['500 accepted entries of 2000 characters', { summary: 's', accepted: Array.from({ length: 500 }, () => text(2000)) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(sprintReportInput, value)).toBe(true)
  })

  it.each([
    ['a missing summary', {}],
    ['changes without commits', { summary: 's', changes: { files: [] } }],
    ['changes without files', { summary: 's', changes: { commits: [] } }],
    ['a blank follow-up title', { summary: 's', followUps: [{ title: '' }] }],
    ['501 accepted entries', { summary: 's', accepted: Array.from({ length: 501 }, () => 'a') }],
    ['a 2001 character risk', { summary: 's', risks: [text(2001)] }],
    ['an invalid exit criterion result', { summary: 's', exitCriteria: [{ criterionId: 'bad', met: true }] }],
    ['an epic outcome without a summary', { summary: 's', epicOutcome: { successCriteria: [] } }],
    ['an extra key', { summary: 's', extra: 1 }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(sprintReportInput, value)).toBe(false)
  })
})

const CATALOG = { hostId: 'host', hostType: 'cli', catalogRevision: '1', tools: [], canSelectWorkerModel: false, models: [] }
const MODEL = { id: 'm1', reasoningLevels: [], modalities: [] }

describe('hostCatalog', () => {
  it('fills model defaults', () => {
    expect(hostCatalog.parse({ ...CATALOG, models: [MODEL] }).models).toEqual([
      {
        id: 'm1',
        label: '',
        reasoningLevels: [],
        modalities: [],
        contextWindowTokens: null,
        skills: [],
        costTier: null,
        latencyTier: null
      }
    ])
  })

  it('keeps supplied model details', () => {
    const model = {
      id: 'm2',
      label: 'Model',
      reasoningLevels: ['deep'],
      modalities: ['text', 'images'],
      contextWindowTokens: 200_000,
      skills: ['ts'],
      costTier: 'high',
      latencyTier: 'low'
    }
    expect(hostCatalog.parse({ ...CATALOG, models: [model] }).models).toEqual([model])
  })
})

describe('hostCatalog acceptance', () => {
  it.each([
    ['an empty catalog', CATALOG],
    ['tools', { ...CATALOG, tools: ['shell', 'browser'], canSelectWorkerModel: true }],
    ['200 models', { ...CATALOG, models: Array.from({ length: 200 }, (_, index) => ({ ...MODEL, id: `m${index}` })) }]
  ])('accepts %s', (_label, value) => {
    expect(accepts(hostCatalog, value)).toBe(true)
  })

  it.each([
    ['a missing host id', { ...CATALOG, hostId: undefined }],
    ['an empty host id', { ...CATALOG, hostId: '' }],
    ['an empty host type', { ...CATALOG, hostType: '' }],
    ['an empty catalog revision', { ...CATALOG, catalogRevision: '' }],
    ['a missing capability flag', { ...CATALOG, canSelectWorkerModel: undefined }],
    ['51 tools', { ...CATALOG, tools: Array.from({ length: 51 }, () => 't') }],
    ['201 models', { ...CATALOG, models: Array.from({ length: 201 }, (_, index) => ({ ...MODEL, id: `m${index}` })) }],
    ['a model without an id', { ...CATALOG, models: [{ reasoningLevels: [], modalities: [] }] }],
    ['an unknown reasoning level', { ...CATALOG, models: [{ ...MODEL, reasoningLevels: ['genius'] }] }],
    ['three modalities', { ...CATALOG, models: [{ ...MODEL, modalities: ['text', 'images', 'text'] }] }],
    ['a zero context window', { ...CATALOG, models: [{ ...MODEL, contextWindowTokens: 0 }] }],
    ['an unknown cost tier', { ...CATALOG, models: [{ ...MODEL, costTier: 'free' }] }],
    ['an extra key', { ...CATALOG, extra: 1 }]
  ])('rejects %s', (_label, value) => {
    expect(accepts(hostCatalog, value)).toBe(false)
  })
})

describe('parseInput', () => {
  it('returns the parsed data, applying schema defaults', () => {
    const input = { criterionId: 'c1', met: false }
    const parsed = parseInput(criterionResult, input, 'result')
    expect(parsed).toEqual({ criterionId: 'c1', met: false, note: '' })
    expect(parsed).not.toBe(input)
  })

  it('throws invalid_input naming what was parsed and the path of the problem', () => {
    const error = thrownBy(() => parseInput(ticketInput, { title: '' }, 'ticket'))
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('invalid_input')
    expect((error as DomainError).message).toMatch(/^Invalid ticket at title: /)
    expect((error as DomainError).details).toBeUndefined()
  })

  it('joins nested paths with dots, including array indexes', () => {
    const bundle = { ...makeBundle([[1]]), tickets: [{}] }
    const error = thrownBy(() => parseInput(planBundle, bundle, 'plan')) as DomainError
    expect(error.message).toMatch(/^Invalid plan at tickets\.0\.id: /)
    const ops = thrownBy(() => parseInput(draftOps, [{ op: 'set_rationale', rationale: 1 }], 'ops')) as DomainError
    expect(ops.message).toMatch(/^Invalid ops at 0\.rationale: /)
  })

  it('omits the path when the whole value is wrong', () => {
    const error = thrownBy(() => parseInput(ticketInput, 5, 'ticket')) as DomainError
    expect(error.message).toMatch(/^Invalid ticket: /)
    expect(error.message).not.toContain(' at ')
  })
})

describe('parseInput hostile input', () => {
  it('rejects a __proto__ key without polluting Object.prototype', () => {
    const hostile: unknown = JSON.parse('{"title":"t","__proto__":{"polluted":true}}')
    const error = thrownBy(() => parseInput(ticketInput, hostile, 'ticket')) as DomainError
    expect(error.code).toBe('invalid_input')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects hostile keys nested inside operations and bundles', () => {
    const op: unknown = JSON.parse('{"op":"add_ticket","sprint":"1","ticket":{"title":"t","constructor":{}}}')
    const bundle: unknown = JSON.parse(JSON.stringify(makeBundle([[1]])).replace('"rationale"', '"__proto__":{"x":1},"rationale"'))
    expect(accepts(draftOp, op)).toBe(false)
    expect(accepts(planBundle, bundle)).toBe(false)
  })
})

describe('parseInput messages', () => {
  it('reports schema messages, including custom ones', () => {
    const id = thrownBy(() => parseInput(stableId, 'x', 'id')) as DomainError
    expect(id.message).toBe('Invalid id: Expected a stable id such as tk_…')
    const branch = thrownBy(() => parseInput(epicBranch, { ...BRANCH, name: 'a b' }, 'branch')) as DomainError
    expect(branch.message).toBe('Invalid branch at name: Not a valid branch name')
  })

  it('reports only the first problem', () => {
    const error = thrownBy(() => parseInput(ticketInput, { title: '', priority: 'urgent' }, 'ticket')) as DomainError
    expect(error.message).toMatch(/^Invalid ticket at title: /)
    expect(error.message).not.toContain('priority')
  })

  it('names unrecognized keys', () => {
    const error = thrownBy(() => parseInput(ticketInput, { title: 't', bogus: 1 }, 'ticket')) as DomainError
    expect(error.message).toContain('bogus')
  })
})

describe('epicBranch git ref rules', () => {
  it.each([
    ['a leading dash', '-rf'],
    ['a double dot', 'feature..main'],
    ['a reflog selector', 'main@{1}'],
    ['a .lock suffix', 'feature.lock'],
    ['a trailing slash', 'feature/'],
    ['a trailing dot', 'feature.']
  ])('rejects %s', (_label, name) => {
    expect(accepts(epicBranch, { ...BRANCH, name })).toBe(false)
  })

  it.each([['feature/plan-v2'], ['epic/dm-12.a'], ['release-2026.09']])('accepts %s', (name) => {
    expect(accepts(epicBranch, { ...BRANCH, name })).toBe(true)
  })
})
