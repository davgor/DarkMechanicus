import { describe, expect, it } from 'vitest'
import {
  type CapabilityPatch,
  type Criterion,
  DEFAULT_POLICIES,
  defaultCapabilityProfile,
  PLAN_FORMAT_VERSION,
  type TicketContent
} from '../../shared/domain/bundle'
import { makeBundle, makeSprint, makeTicket, tid } from '../../test/bundles'
import {
  buildSprint,
  buildTicket,
  cloneBundle,
  createInitialBundle,
  CRITERION_ID_PATTERN,
  maxKeyNumber,
  mergeCapability,
  normalizeCriteria,
  normalizeTags,
  patchSprint,
  patchTicket
} from './normalize'

const IDENTITY = { id: tid(7), key: 'DM-7' }

function criterion(id: string, text: string): Criterion {
  return { id, text }
}

function ids(criteria: Criterion[]): string[] {
  return criteria.map((item) => item.id)
}

describe('CRITERION_ID_PATTERN', () => {
  it.each(['c1', 's42', 'x9999', 'n0'])('accepts %s', (id) => {
    expect(CRITERION_ID_PATTERN.test(id)).toBe(true)
  })

  it.each(['', 'c', 'C1', '1c', 'c12345', 'cc1', 'c-1', 'c1 ', ' c1', 'c1\n'])('rejects %j', (id) => {
    expect(CRITERION_ID_PATTERN.test(id)).toBe(false)
  })
})

describe('normalizeCriteria assigning ids', () => {
  it('returns nothing for no inputs', () => {
    expect(normalizeCriteria([], [], 'c')).toEqual([])
    expect(normalizeCriteria([], [criterion('c1', 'kept out')], 'c')).toEqual([])
  })

  it('numbers new criteria from 1 with the given prefix', () => {
    expect(normalizeCriteria(['first', { text: 'second' }], [], 'c')).toEqual([
      { id: 'c1', text: 'first' },
      { id: 'c2', text: 'second' }
    ])
    expect(ids(normalizeCriteria(['a'], [], 's'))).toEqual(['s1'])
    expect(ids(normalizeCriteria(['a'], [], 'x'))).toEqual(['x1'])
  })

  it('trims criterion text from strings and objects', () => {
    expect(normalizeCriteria(['  padded  ', { text: '\tobject\n' }], [], 'c').map((item) => item.text)).toEqual([
      'padded',
      'object'
    ])
  })

  it('continues after the highest existing number, even for criteria that were dropped', () => {
    const existing = [criterion('c2', 'x'), criterion('c5', 'y')]
    expect(ids(normalizeCriteria(['new'], existing, 'c'))).toEqual(['c6'])
    expect(ids(normalizeCriteria(['new', 'newer'], [criterion('c9', 'gone')], 'c'))).toEqual(['c10', 'c11'])
  })

  it('compares existing ids numerically and ignores ids without a number', () => {
    expect(ids(normalizeCriteria(['new'], [criterion('c9', 'a'), criterion('c10', 'b')], 'c'))).toEqual(['c11'])
    expect(ids(normalizeCriteria(['new'], [criterion('odd', 'a'), criterion('c3', 'b')], 'c'))).toEqual(['c4'])
    expect(ids(normalizeCriteria(['new'], [criterion('x', 'a')], 'c'))).toEqual(['c1'])
  })
})

describe('normalizeCriteria supplied ids', () => {
  it('keeps valid supplied ids', () => {
    const inputs = [{ id: 'c7', text: 'seven' }, { id: 'c3', text: 'three' }]
    expect(normalizeCriteria(inputs, [], 'c')).toEqual([
      { id: 'c7', text: 'seven' },
      { id: 'c3', text: 'three' }
    ])
  })

  it.each(['C1', 'c', 'c12345', '1c', 'cc1', 'c-1', ''])('replaces the invalid supplied id %j', (id) => {
    expect(normalizeCriteria([{ id, text: 'x' }], [], 'c')).toEqual([{ id: 'c1', text: 'x' }])
  })

  it('lets a supplied id keep its number while changing the text', () => {
    const existing = [criterion('c1', 'old wording')]
    expect(normalizeCriteria([{ id: 'c1', text: 'new wording' }], existing, 'c')).toEqual([
      { id: 'c1', text: 'new wording' }
    ])
  })

  it('prefers a supplied id over a text match', () => {
    const existing = [criterion('c1', 'A'), criterion('c2', 'B')]
    expect(normalizeCriteria([{ id: 'c2', text: 'A' }, 'B'], existing, 'c')).toEqual([
      { id: 'c2', text: 'A' },
      { id: 'c3', text: 'B' }
    ])
  })

  it('gives a repeated supplied id to the first use only', () => {
    const result = normalizeCriteria([{ id: 'c3', text: 'A' }, { id: 'c3', text: 'B' }], [], 'c')
    expect(result).toEqual([
      { id: 'c3', text: 'A' },
      { id: 'c1', text: 'B' }
    ])
  })
})

describe('normalizeCriteria reusing ids by text', () => {
  const existing = [criterion('c1', 'Alpha'), criterion('c2', 'Beta')]

  it('reuses the id of an existing criterion with the same text, in any order', () => {
    expect(normalizeCriteria(['Beta', 'Alpha'], existing, 'c')).toEqual([
      { id: 'c2', text: 'Beta' },
      { id: 'c1', text: 'Alpha' }
    ])
  })

  it('matches on trimmed text and on object inputs without an id', () => {
    expect(normalizeCriteria(['  Alpha  ', { text: 'Beta' }], existing, 'c')).toEqual([
      { id: 'c1', text: 'Alpha' },
      { id: 'c2', text: 'Beta' }
    ])
  })

  it('does not match different text or different case', () => {
    expect(ids(normalizeCriteria(['alpha', 'Gamma'], existing, 'c'))).toEqual(['c3', 'c4'])
  })

  it('uses each existing criterion only once', () => {
    const twins = [criterion('c1', 'Same'), criterion('c2', 'Same')]
    expect(ids(normalizeCriteria(['Same', 'Same', 'Same'], twins, 'c'))).toEqual(['c1', 'c2', 'c3'])
  })

  it('keeps existing criteria that are simply reordered', () => {
    expect(ids(normalizeCriteria(['Beta', 'Alpha', 'Gamma'], existing, 'c'))).toEqual(['c2', 'c1', 'c3'])
  })
})

describe('normalizeCriteria never duplicates ids', () => {
  it('skips generated ids that a later supplied id already claimed', () => {
    const result = normalizeCriteria([{ id: 'c1', text: 'kept' }, 'fresh'], [], 'c')
    expect(result).toEqual([
      { id: 'c1', text: 'kept' },
      { id: 'c2', text: 'fresh' }
    ])
  })

  it('skips generated ids that follow the existing maximum', () => {
    const result = normalizeCriteria([{ id: 'c2', text: 'kept' }, 'fresh'], [criterion('c1', 'old')], 'c')
    expect(ids(result)).toEqual(['c2', 'c3'])
  })

  it('skips several claimed ids in a row', () => {
    const inputs = [{ id: 'c1', text: 'a' }, { id: 'c2', text: 'b' }, { id: 'c3', text: 'c' }, 'd', 'e']
    expect(ids(normalizeCriteria(inputs, [], 'c'))).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('never returns the same id twice, whatever the input order', () => {
    const inputs = ['a', { id: 'c1', text: 'b' }, { id: 'c2', text: 'c' }, 'd', { id: 'c4', text: 'e' }, 'f']
    const result = ids(normalizeCriteria(inputs, [criterion('c1', 'a')], 'c'))
    expect(new Set(result).size).toBe(result.length)
  })
})

describe('normalizeTags', () => {
  it('trims tags and drops empty ones', () => {
    expect(normalizeTags(['  api  ', '', '   ', 'ui'])).toEqual(['api', 'ui'])
  })

  it('removes duplicates case-insensitively, keeping the first spelling', () => {
    expect(normalizeTags(['API', 'api', ' Api ', 'db', 'DB'])).toEqual(['API', 'db'])
    expect(normalizeTags(['Élan', 'élan'])).toEqual(['Élan'])
  })

  it('treats inherited property names as ordinary tags', () => {
    expect(normalizeTags(['constructor', 'Constructor', '__proto__', 'toString'])).toEqual([
      'constructor',
      '__proto__',
      'toString'
    ])
  })

  it('keeps order and distinct tags, and returns a new array', () => {
    const input = ['b', 'a', 'c']
    const result = normalizeTags(input)
    expect(result).toEqual(['b', 'a', 'c'])
    expect(result).not.toBe(input)
    expect(normalizeTags([])).toEqual([])
  })
})

describe('mergeCapability', () => {
  it('returns the base itself when there is no patch', () => {
    const base = defaultCapabilityProfile()
    expect(mergeCapability(base, undefined)).toBe(base)
  })

  it('returns an equal copy for an empty patch', () => {
    const base = defaultCapabilityProfile()
    const merged = mergeCapability(base, {})
    expect(merged).toEqual(base)
    expect(merged).not.toBe(base)
    expect(merged.reasoning).not.toBe(base.reasoning)
  })

  it('overrides scalar and array fields wholesale', () => {
    const merged = mergeCapability(defaultCapabilityProfile(), {
      workType: 'testing',
      modalities: ['text', 'images'],
      tools: ['shell']
    })
    expect(merged.workType).toBe('testing')
    expect(merged.modalities).toEqual(['text', 'images'])
    expect(merged.tools).toEqual(['shell'])
    expect(merged.skills).toEqual([])
  })
})

describe('mergeCapability nested groups', () => {
  it('merges nested groups one level deep', () => {
    const merged = mergeCapability(defaultCapabilityProfile(), {
      reasoning: { level: 'deep' },
      context: { estimatedInputTokens: 5000 },
      constraints: { maxCostUsd: 2 },
      preferences: { quality: 'high' }
    })
    expect(merged.reasoning).toEqual({ level: 'deep', rationale: '' })
    expect(merged.context).toEqual({ estimatedInputTokens: 5000, requiredArtifacts: [] })
    expect(merged.constraints).toEqual({ environments: [], dataLocation: null, maxDurationMinutes: null, maxCostUsd: 2 })
    expect(merged.preferences).toEqual({ quality: 'high', latency: null, cost: null, autonomy: null, modelOverride: null })
  })

  it('normalizes patched skills and lets an empty list clear them', () => {
    const base = { ...defaultCapabilityProfile(), skills: ['sql'] }
    expect(mergeCapability(base, { skills: [' TS ', 'ts', '', 'go'] }).skills).toEqual(['TS', 'go'])
    expect(mergeCapability(base, { skills: [] }).skills).toEqual([])
    expect(mergeCapability(base, { workType: 'review' }).skills).toEqual(['sql'])
  })

  it('does not modify its inputs', () => {
    const base = defaultCapabilityProfile()
    const patch: CapabilityPatch = { reasoning: { level: 'deep', rationale: 'hard' }, skills: ['a'] }
    mergeCapability(base, patch)
    expect(base).toEqual(defaultCapabilityProfile())
    expect(patch).toEqual({ reasoning: { level: 'deep', rationale: 'hard' }, skills: ['a'] })
  })
})

describe('buildTicket', () => {
  it('fills defaults for a title-only input', () => {
    expect(buildTicket({ title: '  Ship it  ' }, IDENTITY)).toEqual({
      id: IDENTITY.id,
      key: 'DM-7',
      title: 'Ship it',
      body: '',
      acceptanceCriteria: [],
      tags: [],
      priority: 'normal',
      capability: defaultCapabilityProfile(),
      references: [],
      expectedArtifacts: [],
      optional: false
    })
  })

  it('applies every supplied field', () => {
    const reference = { kind: 'url' as const, label: 'Spec', location: 'https://example.com', hash: null, remoteOnly: true }
    const ticket = buildTicket(
      {
        title: 'Full',
        body: '## Notes',
        acceptanceCriteria: ['works', { id: 'c9', text: 'ships' }],
        tags: [' api ', 'API', 'ui'],
        priority: 'critical',
        capability: { workType: 'architecture', reasoning: { level: 'deep' } },
        references: [reference],
        expectedArtifacts: ['docs/x.md'],
        optional: true
      },
      IDENTITY
    )
    expect(ticket).toMatchObject({
      body: '## Notes',
      acceptanceCriteria: [{ id: 'c1', text: 'works' }, { id: 'c9', text: 'ships' }],
      tags: ['api', 'ui'],
      priority: 'critical',
      references: [reference],
      expectedArtifacts: ['docs/x.md'],
      optional: true
    })
    expect(ticket.capability.workType).toBe('architecture')
    expect(ticket.capability.reasoning).toEqual({ level: 'deep', rationale: '' })
    expect(ticket.capability.tools).toEqual(['repo_read', 'repo_write'])
  })
})

describe('buildTicket isolation', () => {
  it('gives every ticket its own capability profile', () => {
    const first = buildTicket({ title: 'a' }, IDENTITY)
    const second = buildTicket({ title: 'b' }, IDENTITY)
    first.capability.skills.push('mutated')
    expect(second.capability.skills).toEqual([])
    expect(first.capability).not.toBe(second.capability)
  })
})

describe('patchTicket', () => {
  const base = (): TicketContent =>
    makeTicket(1, {
      title: 'Original',
      body: 'original body',
      acceptanceCriteria: [criterion('c1', 'one'), criterion('c2', 'two')],
      tags: ['a'],
      priority: 'low',
      references: [],
      expectedArtifacts: ['x'],
      optional: false
    })

  it('changes nothing for an empty patch', () => {
    expect(patchTicket(base(), {})).toEqual(base())
  })

  it('patches the title (trimmed) and body, including an emptied body', () => {
    expect(patchTicket(base(), { title: '  Renamed ' }).title).toBe('Renamed')
    expect(patchTicket(base(), { title: '  Renamed ' }).body).toBe('original body')
    expect(patchTicket(base(), { body: '' }).body).toBe('')
    expect(patchTicket(base(), { body: 'new' }).title).toBe('Original')
  })

  it('re-numbers acceptance criteria against the existing ones', () => {
    const patched = patchTicket(base(), { acceptanceCriteria: ['two', 'brand new', { id: 'c1', text: 'one reworded' }] })
    expect(patched.acceptanceCriteria).toEqual([
      { id: 'c2', text: 'two' },
      { id: 'c3', text: 'brand new' },
      { id: 'c1', text: 'one reworded' }
    ])
    expect(patchTicket(base(), {}).acceptanceCriteria).toEqual(base().acceptanceCriteria)
    expect(patchTicket(base(), { acceptanceCriteria: [] }).acceptanceCriteria).toEqual([])
  })
})

describe('patchTicket other fields', () => {
  const base = (): TicketContent =>
    makeTicket(1, { title: 'Original', tags: ['a'], priority: 'low', expectedArtifacts: ['x'], optional: false })

  it('normalizes tags and allows clearing them', () => {
    expect(patchTicket(base(), { tags: [' B ', 'b', 'c'] }).tags).toEqual(['B', 'c'])
    expect(patchTicket(base(), { tags: [] }).tags).toEqual([])
    expect(patchTicket(base(), { priority: 'high' }).tags).toEqual(['a'])
  })

  it('patches priority, references, artifacts and the optional flag', () => {
    const reference = { kind: 'file' as const, label: 'f', location: 'a.ts', hash: null, remoteOnly: false }
    const patched = patchTicket(base(), {
      priority: 'high',
      references: [reference],
      expectedArtifacts: [],
      optional: true
    })
    expect(patched).toMatchObject({ priority: 'high', references: [reference], expectedArtifacts: [], optional: true })
    expect(patchTicket({ ...base(), optional: true }, { optional: false }).optional).toBe(false)
  })

  it('merges capability patches and keeps identity', () => {
    const patched = patchTicket(base(), { capability: { workType: 'review', tools: ['shell'] } })
    expect(patched.capability.workType).toBe('review')
    expect(patched.capability.tools).toEqual(['shell'])
    expect(patched.capability.reasoning).toEqual(base().capability.reasoning)
    expect(patched.id).toBe(tid(1))
    expect(patched.key).toBe('DM-1')
  })

  it('does not modify the original ticket', () => {
    const original = base()
    patchTicket(original, { title: 'x', tags: ['q'], acceptanceCriteria: ['z'] })
    expect(original).toEqual(base())
  })
})

describe('buildSprint', () => {
  const identity = { id: 'sp_test', ordinal: 3 }

  it('fills defaults for a goal-only input', () => {
    expect(buildSprint({ goal: '  Ship the core  ' }, identity)).toEqual({
      id: 'sp_test',
      ordinal: 3,
      goal: 'Ship the core',
      ticketIds: [],
      entryCriteria: [],
      exitCriteria: [],
      concurrencyCap: null,
      checkpoint: { mode: 'human' }
    })
  })

  it('numbers entry criteria with n and exit criteria with x', () => {
    const sprint = buildSprint({ goal: 'g', entryCriteria: ['ready', 'staffed'], exitCriteria: ['tests pass'] }, identity)
    expect(sprint.entryCriteria).toEqual([{ id: 'n1', text: 'ready' }, { id: 'n2', text: 'staffed' }])
    expect(sprint.exitCriteria).toEqual([{ id: 'x1', text: 'tests pass' }])
  })

  it('takes the concurrency cap and checkpoint mode from the input', () => {
    const sprint = buildSprint({ goal: 'g', concurrencyCap: 4, checkpoint: { mode: 'auto' } }, identity)
    expect(sprint.concurrencyCap).toBe(4)
    expect(sprint.checkpoint).toEqual({ mode: 'auto' })
    expect(buildSprint({ goal: 'g', concurrencyCap: null }, identity).concurrencyCap).toBeNull()
  })
})

describe('patchSprint', () => {
  const base = () =>
    makeSprint(2, [1, 2], {
      goal: 'Original goal',
      entryCriteria: [criterion('n1', 'entry')],
      exitCriteria: [criterion('x1', 'exit')],
      concurrencyCap: 3,
      checkpoint: { mode: 'human' }
    })

  it('changes nothing for an empty patch', () => {
    expect(patchSprint(base(), {})).toEqual(base())
  })

  it('patches the goal, trimmed, keeping identity and tickets', () => {
    const patched = patchSprint(base(), { goal: '  New goal ' })
    expect(patched.goal).toBe('New goal')
    expect(patched.id).toBe(base().id)
    expect(patched.ordinal).toBe(2)
    expect(patched.ticketIds).toEqual(base().ticketIds)
  })

  it('re-numbers entry and exit criteria against the existing ones', () => {
    const patched = patchSprint(base(), { entryCriteria: ['entry', 'another'], exitCriteria: ['fresh', 'exit'] })
    expect(patched.entryCriteria).toEqual([{ id: 'n1', text: 'entry' }, { id: 'n2', text: 'another' }])
    expect(patched.exitCriteria).toEqual([{ id: 'x2', text: 'fresh' }, { id: 'x1', text: 'exit' }])
    expect(patchSprint(base(), { entryCriteria: [] }).entryCriteria).toEqual([])
    expect(patchSprint(base(), { exitCriteria: [] }).exitCriteria).toEqual([])
    expect(patchSprint(base(), { goal: 'x' }).entryCriteria).toEqual(base().entryCriteria)
    expect(patchSprint(base(), { goal: 'x' }).exitCriteria).toEqual(base().exitCriteria)
  })

  it('keeps the cap when it is omitted, replaces it with a number and clears it with null', () => {
    expect(patchSprint(base(), { goal: 'x' }).concurrencyCap).toBe(3)
    expect(patchSprint(base(), { concurrencyCap: 5 }).concurrencyCap).toBe(5)
    expect(patchSprint(base(), { concurrencyCap: null }).concurrencyCap).toBeNull()
    expect(patchSprint({ ...base(), concurrencyCap: null }, { concurrencyCap: 2 }).concurrencyCap).toBe(2)
  })

  it('patches the checkpoint mode', () => {
    expect(patchSprint(base(), { checkpoint: { mode: 'auto' } }).checkpoint).toEqual({ mode: 'auto' })
    expect(patchSprint({ ...base(), checkpoint: { mode: 'auto' } }, {}).checkpoint).toEqual({ mode: 'auto' })
  })
})

describe('createInitialBundle', () => {
  const epic = { title: 'Epic', intent: 'Intent', successCriteria: [criterion('s1', 'done')], ownerRole: null }

  it('creates an empty plan with one empty sprint', () => {
    expect(createInitialBundle(epic, 'sp_first')).toEqual({
      formatVersion: PLAN_FORMAT_VERSION,
      epic,
      tickets: [],
      sprints: [
        {
          id: 'sp_first',
          ordinal: 1,
          goal: '',
          ticketIds: [],
          entryCriteria: [],
          exitCriteria: [],
          concurrencyCap: null,
          checkpoint: { mode: 'human' }
        }
      ],
      edges: [],
      relations: [],
      policies: DEFAULT_POLICIES,
      rationale: ''
    })
  })

  it('copies the default policies instead of sharing them', () => {
    const bundle = createInitialBundle(epic, 'sp_first')
    expect(bundle.policies).not.toBe(DEFAULT_POLICIES)
    bundle.policies.retryLimit = 99
    expect(DEFAULT_POLICIES.retryLimit).toBe(3)
    expect(createInitialBundle(epic, 'sp_second').policies.retryLimit).toBe(3)
  })
})

describe('cloneBundle', () => {
  it('produces an equal but fully independent copy', () => {
    const original = makeBundle([[1, 2], [3]], [[1, 3]])
    const copy = cloneBundle(original)
    expect(copy).toEqual(original)
    expect(copy).not.toBe(original)
    copy.tickets[0]?.acceptanceCriteria.push(criterion('c9', 'added'))
    copy.sprints[0]?.ticketIds.push('tk_extra')
    copy.edges.push({ from: 'a', to: 'b' })
    copy.epic.title = 'changed'
    copy.policies.retryLimit = 50
    expect(original).toEqual(makeBundle([[1, 2], [3]], [[1, 3]]))
  })
})

describe('maxKeyNumber', () => {
  it('finds the highest numeric suffix', () => {
    expect(maxKeyNumber(['DM-1', 'DM-12', 'DM-3'])).toBe(12)
    expect(maxKeyNumber(['DM-9', 'DM-10'])).toBe(10)
  })

  it('returns 0 when nothing carries a numeric suffix', () => {
    expect(maxKeyNumber([])).toBe(0)
    expect(maxKeyNumber(['DM', 'DM-x', 'DM-12-draft', '12'])).toBe(0)
  })

  it('ignores the prefix and reads only the trailing number', () => {
    expect(maxKeyNumber(['AB-100', 'DM-7'])).toBe(100)
    expect(maxKeyNumber(['A-1-2', 'DM-007'])).toBe(7)
  })

  it('accepts any iterable', () => {
    expect(maxKeyNumber(new Set(['DM-4', 'DM-8']))).toBe(8)
    expect(maxKeyNumber(makeBundle([[1, 5, 2]]).tickets.map((ticket) => ticket.key))).toBe(5)
  })
})

describe('ticket size and reasoning effort', () => {
  it('builds a ticket with the size and effort it was given', () => {
    const ticket = buildTicket({ title: 'Tiny', size: 'micro', capability: { reasoning: { level: 'routine', effort: 'low' } } }, IDENTITY)
    expect(ticket.size).toBe('micro')
    expect(ticket.capability.reasoning).toEqual({ level: 'routine', rationale: '', effort: 'low' })
  })

  it('builds a ticket without a size or an effort when none is given', () => {
    const ticket = buildTicket({ title: 'Plain' }, IDENTITY)
    expect(Object.keys(ticket)).not.toContain('size')
    expect(Object.keys(ticket.capability.reasoning)).not.toContain('effort')
  })

  it('patches the size and keeps it through unrelated patches', () => {
    const base = makeTicket(1)
    const sized = patchTicket(base, { size: 'large' })
    expect(sized.size).toBe('large')
    expect(patchTicket(sized, { title: 'Renamed' }).size).toBe('large')
    expect(patchTicket(sized, { size: 'small' }).size).toBe('small')
    expect(Object.keys(patchTicket(base, { title: 'Renamed' }))).not.toContain('size')
  })

  it('patches the effort without losing the reasoning level and rationale', () => {
    const base = makeTicket(1, { capability: mergeCapability(defaultCapabilityProfile(), { reasoning: { level: 'deep', rationale: 'hard' } }) })
    const patched = patchTicket(base, { capability: { reasoning: { effort: 'high' } } })
    expect(patched.capability.reasoning).toEqual({ level: 'deep', rationale: 'hard', effort: 'high' })
    expect(patchTicket(patched, { capability: { reasoning: { level: 'routine' } } }).capability.reasoning).toEqual({
      level: 'routine',
      rationale: 'hard',
      effort: 'high'
    })
  })

  it('does not modify the original ticket when it patches a size or an effort', () => {
    const original = makeTicket(1)
    patchTicket(original, { size: 'micro', capability: { reasoning: { effort: 'low' } } })
    expect(original).toEqual(makeTicket(1))
  })
})

describe('clearing a ticket size and reasoning effort with null', () => {
  const sizedAndEffortful = (): TicketContent =>
    makeTicket(1, {
      size: 'small',
      capability: mergeCapability(defaultCapabilityProfile(), { reasoning: { level: 'deep', rationale: 'hard', effort: 'high' } })
    })

  it('removes the size key from a patched ticket, never storing null', () => {
    const cleared = patchTicket(sizedAndEffortful(), { size: null })
    expect(Object.keys(cleared)).not.toContain('size')
    expect(JSON.stringify(cleared)).not.toContain('"size"')
    expect(cleared.title).toBe(sizedAndEffortful().title)
  })

  it('removes the effort key and keeps the reasoning level and rationale', () => {
    const cleared = patchTicket(sizedAndEffortful(), { capability: { reasoning: { effort: null } } })
    expect(cleared.capability.reasoning).toEqual({ level: 'deep', rationale: 'hard' })
    expect(Object.keys(cleared.capability.reasoning)).not.toContain('effort')
    expect(cleared.size).toBe('small')
  })

  it('clears the size and the effort in one patch together with other reasoning edits', () => {
    const cleared = patchTicket(sizedAndEffortful(), {
      size: null,
      capability: { reasoning: { level: 'routine', effort: null } }
    })
    expect(Object.keys(cleared)).not.toContain('size')
    expect(cleared.capability.reasoning).toEqual({ level: 'routine', rationale: 'hard' })
  })

  it('leaves a ticket that has no size or effort exactly as it was', () => {
    const base = makeTicket(1)
    const cleared = patchTicket(base, { size: null, capability: { reasoning: { effort: null } } })
    expect(cleared).toEqual(base)
    expect(Object.keys(cleared)).not.toContain('size')
    expect(Object.keys(cleared.capability.reasoning)).not.toContain('effort')
  })

  it('does not modify the original ticket when it clears a size or an effort', () => {
    const original = sizedAndEffortful()
    patchTicket(original, { size: null, capability: { reasoning: { effort: null } } })
    expect(original).toEqual(sizedAndEffortful())
  })

  it('merges a null effort out of a profile without storing it', () => {
    const base = mergeCapability(defaultCapabilityProfile(), { reasoning: { effort: 'low' } })
    const merged = mergeCapability(base, { reasoning: { effort: null } })
    expect(Object.keys(merged.reasoning)).not.toContain('effort')
    expect(base.reasoning.effort).toBe('low')
  })

  it('builds a ticket without a size or an effort when the input clears them', () => {
    const ticket = buildTicket({ title: 'Plain', size: null, capability: { reasoning: { effort: null } } }, IDENTITY)
    expect(Object.keys(ticket)).not.toContain('size')
    expect(Object.keys(ticket.capability.reasoning)).not.toContain('effort')
  })
})
