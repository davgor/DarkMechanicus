import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

interface FactSpec {
  id: string
  events?: string[]
  topics?: string[]
  paths?: string[]
  priority?: number
  body?: string
}

/** Writes a repository-layer fact; built-in facts are never asserted on, only facts these tests write. */
function writeFact(fact: FactSpec): void {
  mkdirSync(knowledgeDir(), { recursive: true })
  const lines = [
    '---',
    `id: ${fact.id}`,
    'type: convention',
    `title: Fact ${fact.id}`,
    'scope.roles: [orchestrator]',
    `scope.events: [${(fact.events ?? []).join(', ')}]`,
    `scope.topics: [${(fact.topics ?? []).join(', ')}]`,
    `scope.paths: [${(fact.paths ?? []).join(', ')}]`,
    `priority: ${fact.priority ?? 50}`,
    '---',
    '',
    fact.body ?? `Body of ${fact.id}.`
  ]
  writeFileSync(join(knowledgeDir(), `${fact.id}.md`), `${lines.join('\n')}\n`)
}

function repoIds(result: { facts: { id: string; layer: string }[] }): string[] {
  return result.facts.filter((fact) => fact.layer === 'repo').map((fact) => fact.id)
}

let harness: Harness

/** The repository layer of a repo-mode project. */
const knowledgeDir = (): string => join(harness.root, '.darkmechanicus', 'knowledge')
let orchestrator: Workspace

beforeEach(async () => {
  harness = createHarness()
  orchestrator = harness.open('orchestrator')
  await orchestrator.initializeRepository({ name: 'knowledge-repo' })
})

afterEach(() => {
  harness.cleanup()
})

describe('getContext', () => {
  it('returns the facts scoped to an event with the full envelope', async () => {
    writeFact({ id: 'repo.on-claim', events: ['ticket.claimed'], body: 'Run the targeted tests first.' })
    writeFact({ id: 'repo.on-reject', events: ['attempt.rejected'] })

    const result = await orchestrator.getContext({ event: 'ticket.claimed' })

    expect(repoIds(result)).toEqual(['repo.on-claim'])
    expect(result.facts.find((fact) => fact.id === 'repo.on-claim')).toEqual({
      id: 'repo.on-claim',
      type: 'convention',
      title: 'Fact repo.on-claim',
      layer: 'repo',
      body: 'Run the targeted tests first.'
    })
    expect(result.budgetTokens).toBe(1500)
    expect(result.usedTokens).toBeLessThanOrEqual(1500)
    expect(result.omitted).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.layers.repo).toEqual({ path: knowledgeDir(), count: 2 })
    expect(result.layers.overall).toEqual({ configured: false, path: null, count: 0 })
  })

  it('selects by topic', async () => {
    writeFact({ id: 'repo.topic-hit', topics: ['kl-release'] })
    writeFact({ id: 'repo.topic-miss', topics: ['kl-other'] })

    const result = await orchestrator.getContext({ topics: ['kl-release'] })

    expect(repoIds(result)).toEqual(['repo.topic-hit'])
  })

  it('fails with invalid_input when neither event nor topics is given', async () => {
    await expect(orchestrator.getContext({ paths: ['src/a.ts'] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(orchestrator.getContext({ topics: [] })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('getContext ranking', () => {
  it('adds the file references of ticketId to the path boost', async () => {
    writeFact({ id: 'repo.a-plain', topics: ['kl-paths'] })
    writeFact({ id: 'repo.z-core', topics: ['kl-paths'], paths: ['src/core/**'] })
    const epic = await orchestrator.createEpic({ title: 'Knowledge epic' })
    const draft = await orchestrator.updatePlanDraft({
      epicId: epic.id,
      ops: [
        {
          op: 'add_ticket',
          ref: 'one',
          sprint: '1',
          ticket: {
            title: 'Touch the core',
            references: [{ kind: 'file', label: 'Core file', location: 'src/core/thing.ts', hash: null, remoteOnly: false }]
          }
        }
      ]
    })
    await harness.open('planner', { allowSave: true }).savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    const ticketId = draft.refMap['one'] ?? ''

    const plain = await orchestrator.getContext({ topics: ['kl-paths'] })
    const boosted = await orchestrator.getContext({ topics: ['kl-paths'], ticketId })

    expect(repoIds(plain)).toEqual(['repo.a-plain', 'repo.z-core'])
    expect(repoIds(boosted)).toEqual(['repo.z-core', 'repo.a-plain'])
  })
})

describe('getContext ticket lookup', () => {
  it('fails with not_found for a ticket that is only in a draft, and ranks without a boost for a saved ticket with no file references', async () => {
    writeFact({ id: 'repo.a-plain', topics: ['kl-paths'] })
    writeFact({ id: 'repo.z-core', topics: ['kl-paths'], paths: ['src/core/**'] })
    const epic = await orchestrator.createEpic({ title: 'Knowledge epic' })
    const draft = await orchestrator.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'No references' } }]
    })
    const ticketId = draft.refMap['one'] ?? ''

    await expect(orchestrator.getContext({ topics: ['kl-paths'], ticketId })).rejects.toMatchObject({ code: 'not_found' })

    await harness.open('planner', { allowSave: true }).savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    expect(repoIds(await orchestrator.getContext({ topics: ['kl-paths'], ticketId }))).toEqual(['repo.a-plain', 'repo.z-core'])
  })
})

describe('getContext budget', () => {
  it('respects the token budget and lists what it omitted', async () => {
    const body = 'x'.repeat(400)
    writeFact({ id: 'repo.budget-high', topics: ['kl-budget'], priority: 90, body })
    writeFact({ id: 'repo.budget-low', topics: ['kl-budget'], priority: 10, body })

    const result = await orchestrator.getContext({ topics: ['kl-budget'], budgetTokens: 200 })

    expect(result.budgetTokens).toBe(200)
    expect(result.usedTokens).toBeLessThanOrEqual(200)
    expect(repoIds(result)).toEqual(['repo.budget-high'])
    expect(result.omitted.map((fact) => fact.id)).toContain('repo.budget-low')
    await expect(orchestrator.getContext({ topics: ['kl-budget'], budgetTokens: 199 })).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
})
