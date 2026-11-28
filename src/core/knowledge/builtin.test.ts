import { describe, expect, it } from 'vitest'
import kernelSource from '../../../skills/orchestrator.md?raw'
import { BUILTIN_KNOWLEDGE } from './builtin'
import { KNOWLEDGE_EVENTS, type KnowledgeEvent } from './events'
import { parseFact, type KnowledgeFact } from './fact'
import { mergeLayers } from './merge'
import { DEFAULT_CONTEXT_BUDGET, selectFacts } from './select'

const parsed = BUILTIN_KNOWLEDGE.map(({ path, source }) => parseFact(source, { layer: 'builtin', path }))
const facts: KnowledgeFact[] = parsed.flatMap((result) => (result.ok ? [result.fact] : []))
const merged = mergeLayers(facts)

/** The pull-only topics the kernel lists after "Topics, pulled only:". */
function kernelTopics(): string[] {
  const line = kernelSource.split(/\r?\n/).find((text) => text.startsWith('Topics, pulled only:'))
  return [...(line ?? '').matchAll(/`([a-z-]+)`/g)].map((match) => match[1])
}

describe('built-in knowledge', () => {
  it('bundles the fact files under skills/knowledge', () => {
    expect(BUILTIN_KNOWLEDGE.length).toBeGreaterThan(0)
    for (const { path } of BUILTIN_KNOWLEDGE) expect(path).toMatch(/^skills\/knowledge\/.+\.md$/)
  })

  it('parses and merges every built-in fact with no diagnostic', () => {
    const diagnostics = parsed.flatMap((result) => (result.ok ? [] : [result.diagnostic]))
    expect([...diagnostics, ...merged.diagnostics]).toEqual([])
    expect(merged.facts).toHaveLength(BUILTIN_KNOWLEDGE.length)
  })

  it('keeps each built-in fact to one rule cluster of at most 400 tokens', () => {
    const oversized = merged.facts.filter((fact) => fact.tokens > 400).map((fact) => `${fact.id}: ${fact.tokens}`)
    expect(oversized).toEqual([])
  })

  it('resolves every fact id that the kernel or a fact refers to', () => {
    const ids = new Set(merged.facts.map((fact) => fact.id))
    const texts = [kernelSource, ...merged.facts.map((fact) => fact.body)]
    const referenced = texts.flatMap((text) => [...text.matchAll(/`(orchestrator\.[a-z0-9.-]+)`/g)].map((match) => match[1]))
    expect(referenced.filter((id) => !ids.has(id))).toEqual([])
  })
})

describe('built-in knowledge selection', () => {
  it.each(KNOWLEDGE_EVENTS.map((event) => event.id))(
    'pushes at least one built-in orchestrator fact for %s within the default budget, omitting nothing',
    (event) => {
      const result = selectFacts(merged.facts, { role: 'orchestrator', event, budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.length).toBeGreaterThan(0)
      expect(result.omitted).toEqual([])
      expect(result.usedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET)
    }
  )

  it('lists the pull-only topics in the kernel, and each pulls its facts within the default budget', () => {
    const topics = kernelTopics()
    expect(topics).toEqual([
      'folders-of-repositories',
      'fallback-claim',
      'lost-claim-response',
      'integration-worktree',
      'plan-changes',
      'retro-redraft',
      'required-leftover',
      'record-keeping',
      'host-catalog',
      'time-box',
      'final-validation-ci',
      'post-checkpoint-delivery',
      'sprint-delivery',
      'learning-card',
      'agent-browser'
    ])
    for (const topic of topics) {
      const result = selectFacts(merged.facts, { role: 'orchestrator', topics: [topic], budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.length, topic).toBeGreaterThan(0)
      expect(result.omitted, topic).toEqual([])
    }
  })

  it('names every catalog event in the kernel', () => {
    for (const { id } of KNOWLEDGE_EVENTS) expect(kernelSource).toContain(`\`${id}\``)
  })
})

describe('progress supervision delivered to orchestrators', () => {
  it.each(['ticket.claimed', 'acceptance.claimed', 'kanban.claimed', 'run.recovery'])(
    'delivers productive-worker continuation and evidence-led stall diagnosis for %s',
    (event) => {
      const result = selectFacts(merged.facts, { role: 'orchestrator', event, budgetTokens: DEFAULT_CONTEXT_BUDGET })
      const watchdog = result.facts.find((fact) => fact.id === 'orchestrator.time-box')?.body ?? ''
      const limits = result.facts.find((fact) => fact.id === 'orchestrator.time-box-limits')?.body ?? ''
      expect(result.omitted).toEqual([])
      // These are the decisions the recipient must be able to make, not a simulated scheduler.
      expect(watchdog).toMatch(/5-minute.*10-minute.*alarm/i)
      expect(watchdog).toMatch(/progress.*current operation.*expected next result.*blockers/i)
      expect(watchdog).toMatch(/productive.*continue.*same.*claim/i)
      expect(watchdog).toMatch(/elapsed time alone.*not.*(?:fail|stop)/i)
      expect(limits).toMatch(/stalled.*hypothesis.*observation.*intervention.*reason/i)
      expect(limits).toMatch(/long-running.*authorized deadline.*not.*stalled/i)
      expect(limits).toMatch(/consent.*cost.*cleanup.*lease fencing/i)
    }
  )

  it('pulls compatible time-box guidance without a saved exception or forced epic for a single card', () => {
    const result = selectFacts(merged.facts, {
      role: 'orchestrator', topics: ['time-box'], budgetTokens: DEFAULT_CONTEXT_BUDGET
    })
    const text = result.facts.map((fact) => fact.body).join('\n')
    expect(result.omitted).toEqual([])
    expect(text).toMatch(/no.*(?:saved exception|pre-saved exception).*productive/i)
    expect(text).toMatch(/single card.*(?:epic|Save)/i)
    expect(text).not.toMatch(/default 10-minute deadline|Beyond 10 minutes needs|fits? .*5[–-]10 minute/i)
  })

  it('delivers bounded stall intervention rather than clock-only failure, including recovery', () => {
    const selected = selectFacts(merged.facts, {
      role: 'orchestrator', event: 'run.recovery', budgetTokens: DEFAULT_CONTEXT_BUDGET
    })
    const limits = selected.facts.find((fact) => fact.id === 'orchestrator.time-box-limits')?.body ?? ''
    expect(limits).toMatch(/two rounds closing no gap.*reassess.*blocker/i)
    expect(limits).toMatch(/intervention.*recorded reason\/evidence/i)
    expect(limits).toMatch(/Actual failures.*partial artifacts\/unmet criteria.*safe containment/i)
  })

  it('delivers long-check supervision through final-validation-ci as well as claim guidance', () => {
    const selected = selectFacts(merged.facts, {
      role: 'orchestrator', topics: ['final-validation-ci'], budgetTokens: DEFAULT_CONTEXT_BUDGET
    })
    const text = selected.facts.map((fact) => fact.body).join('\n')
    expect(text).toMatch(/alarms are not deadlines or saved-exception gates/i)
    expect(text).toMatch(/immutable head.*genuine authorized limits/i)
    expect(text).toMatch(/claim.*live reporter.*secret claim token and heartbeats/i)
    expect(text).toMatch(/source change invalidates.*artifact/i)
    expect(text).not.toMatch(/Only.*noninterruptible.*may exceed.*time box/i)
  })
})

describe('the orchestrator kernel', () => {
  it('is at most 800 words', () => {
    expect(kernelSource.trim().split(/\s+/).length).toBeLessThanOrEqual(800)
  })
})

describe('retrying a ticket at its retry limit', () => {
  const body = (id: string): string => merged.facts.find((fact) => fact.id === id)?.body ?? ''

  it('tells the orchestrator to retry from a different angle with retry_ticket instead of asking the person', () => {
    const escalation = body('orchestrator.retry-escalation')
    for (const phrase of [
      '`retry_ticket`',
      'do not ask the person',
      'genuinely different `newApproach`',
      'honest `failureReason`',
      'Escalate to the person only on `retry_escalation_required`'
    ]) {
      expect(escalation).toContain(phrase)
    }
    const repeated = body('orchestrator.repeated-escalations')
    expect(repeated).toContain('retry it from that different angle with `retry_ticket`')
    expect(repeated).toContain('instead of asking the person')
    expect(repeated).not.toContain('tell the person: it may need splitting')
    expect(kernelSource).toContain('Retry-limited tickets: `retry_ticket`.')
  })

  it('pushes the retry_ticket rule after a rejection and after a failure', () => {
    for (const event of ['attempt.rejected', 'attempt.failed'] as const) {
      const result = selectFacts(merged.facts, { role: 'orchestrator', event, budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.map((fact) => fact.body).join('\n'), event).toContain('`retry_ticket`')
    }
  })
})

describe('the sprint learning card delivered to orchestrators', () => {
  const context = (query: { event?: KnowledgeEvent; topics?: string[] }) =>
    selectFacts(merged.facts, { role: 'orchestrator', ...query, budgetTokens: DEFAULT_CONTEXT_BUDGET })
  const ids = (result: { facts: KnowledgeFact[] }): string[] => result.facts.map((fact) => fact.id)
  const text = (result: { facts: KnowledgeFact[] }): string => result.facts.map((fact) => fact.body).join('\n')

  it('parses the learning-card fact as one bounded procedure for the orchestrator', () => {
    const fact = merged.facts.find((candidate) => candidate.id === 'orchestrator.learning-card')
    expect(fact).toMatchObject({ type: 'procedure', layer: 'builtin', scope: { roles: ['orchestrator'], events: ['kanban.claimed'] } })
    expect(fact?.scope.topics).toEqual(['learning-card', 'lost-claim-response'])
    expect(fact?.tokens).toBeLessThanOrEqual(400)
  })

  it('pushes the post-advance priority with the advance_sprint response, whole and within budget', () => {
    const result = context({ event: 'checkpoint.approved' })
    expect(result.omitted).toEqual([])
    expect(result.usedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET)
    expect(ids(result)).toContain('orchestrator.advance-sprint')
    // The same context names the claim and the ordinary polling it must come before, and denies the card is a gate.
    const advance = result.facts.find((fact) => fact.id === 'orchestrator.advance-sprint')?.body ?? ''
    const claimAt = advance.indexOf('`claim_kanban_card`')
    const pollAt = advance.indexOf('`get_ready_tickets`')
    expect(claimAt).toBeGreaterThan(-1)
    expect(pollAt).toBeGreaterThan(claimAt)
    expect(advance).toMatch(/learningCard/)
    expect(advance).toMatch(/not a sprint gate/i)
  })

  it('pushes the learning-card procedure with every Kanban claim, beside the ordinary card rules, omitting nothing', () => {
    const result = context({ event: 'kanban.claimed' })
    expect(result.omitted).toEqual([])
    expect(result.usedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET)
    expect(ids(result)).toEqual(expect.arrayContaining(['orchestrator.kanban-run', 'orchestrator.learning-card']))
    const body = text(result)
    for (const tool of ['`claim_kanban_card`', '`fail_kanban_card`', '`submit_kanban_card`']) expect(body).toContain(tool)
    expect(body).toMatch(/task data/)
    expect(body).toMatch(/Ready for review/)
  })

  it('keeps the learning card out of claim contexts for plan tickets and acceptance nodes', () => {
    for (const event of ['ticket.claimed', 'acceptance.claimed'] as const) {
      expect(ids(context({ event })), event).not.toContain('orchestrator.learning-card')
    }
  })

  it('pulls the whole learning-card workflow by topic, and lost-claim handling with the lost-claim topic', () => {
    const topic = context({ topics: ['learning-card'] })
    expect(topic.omitted).toEqual([])
    expect(ids(topic).sort()).toEqual(['orchestrator.advance-sprint', 'orchestrator.learning-card'])
    const lost = context({ topics: ['lost-claim-response'] })
    expect(lost.omitted).toEqual([])
    expect(ids(lost)).toEqual(expect.arrayContaining(['orchestrator.lost-claim-replay', 'orchestrator.learning-card']))
  })
})

/**
 * Each SPACE measurement obligation (the orchestrator guide's former section 9), a phrase that states it, and every
 * event after which its trigger can occur. A person may report an escaped defect or ask for a grade at any time, and a
 * takeover leaves submitted attempts to review, so those come with the run's start and with recovery; corrective work
 * starts when its ticket is claimed and lands when it is accepted. The full rules are the facts of topic `space`.
 */
const SPACE_OBLIGATIONS: [string, string, KnowledgeEvent[]][] = [
  ['records are kept complete and honest', 'complete and honest', ['run.started', 'run.recovery', 'sprint.reported']],
  ['usage is recorded after each row', "row's usage", ['run.started', 'run.recovery']],
  ['the row check points at the usage rule', '`orchestrator.space-usage`', ['attempt.accepted', 'row_check.failed']],
  ['acceptance needs a review decision', 'review decision', ['run.started', 'run.recovery', 'ticket.claimed', 'acceptance.claimed']],
  ['grades are relayed as returned', 'as returned', ['run.started', 'run.recovery', 'sprint.reported']],
  ['a grade never decides', 'never decides', ['run.started', 'run.recovery']],
  ['a grade is never a reason to accept or reject', 'A grade is never a reason to accept, reject', ['sprint.reported']],
  ['escaped defects are reported', '`record_attempt_metrics` against', ['run.started', 'run.recovery', 'row_check.failed']],
  ['kept experiments are restated', 'restate each experiment you keep', ['sprint.reported']],
  ['an experiment is in progress when its work starts', '`in_progress`', ['run.started', 'run.recovery', 'ticket.claimed', 'checkpoint.approved']],
  ['an experiment is completed when its work lands', '`completed`', ['attempt.accepted', 'sprint.reported', 'checkpoint.approved']],
  ['corrective work is created as drafts', '`create_corrections`', ['sprint.reported', 'checkpoint.approved']]
]

/** The facts topic `space` pulls: every SPACE rule in full. */
const SPACE_TOPIC = [
  'orchestrator.space-corrective-work',
  'orchestrator.space-duties',
  'orchestrator.space-escaped-defects',
  'orchestrator.space-experiment-progress',
  'orchestrator.space-experiments',
  'orchestrator.space-grades',
  'orchestrator.space-review-evidence',
  'orchestrator.space-usage'
]

describe('built-in SPACE measurement facts', () => {
  it.each(SPACE_OBLIGATIONS)('pushes "%s" with every event after which its trigger can occur', (_rule, phrase, events) => {
    for (const event of events) {
      const result = selectFacts(merged.facts, { role: 'orchestrator', event, budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.map((fact) => fact.body).join('\n'), event).toContain(phrase)
    }
  })

  it('pulls every SPACE rule in full with topic `space`, which each pushed SPACE pointer names', () => {
    const pulled = selectFacts(merged.facts, { role: 'orchestrator', topics: ['space'], budgetTokens: DEFAULT_CONTEXT_BUDGET })
    expect(pulled.facts.map((fact) => fact.id).sort()).toEqual(SPACE_TOPIC)
    expect(pulled.omitted).toEqual([])
    const pointers = merged.facts.filter((fact) => fact.id.startsWith('orchestrator.space-') && !SPACE_TOPIC.includes(fact.id))
    expect(pointers.map((fact) => fact.id).sort()).toEqual(['orchestrator.space-claim', 'orchestrator.space-landing'])
    for (const fact of [...pointers, ...merged.facts.filter((each) => each.id === 'orchestrator.space-duties')]) {
      expect(fact.body, fact.id).toContain('topic `space`')
    }
  })

  it.each(KNOWLEDGE_EVENTS.map((event) => event.id))('leaves room for folder facts after %s', (event) => {
    const result = selectFacts(merged.facts, { role: 'orchestrator', event, budgetTokens: DEFAULT_CONTEXT_BUDGET })
    expect(DEFAULT_CONTEXT_BUDGET - result.usedTokens).toBeGreaterThanOrEqual(50)
  })
})
