import { describe, expect, it } from 'vitest'
import { defaultCapabilityProfile, type ReasoningLevel, type TicketContent } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, tid } from '../../test/bundles'
import { claim, errorCode, hostCatalog, hostModel, lastEventPayload, startedRun, submitClaim } from '../../test/execution'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { failAttempt, rejectAttempt } from './attempts'
import { matchCapabilities, registerHost } from './hosts'

describe('registerHost', () => {
  it('stores the host catalog and returns it with its registration', () => {
    const ctx = createTestCtx()
    const catalog = hostCatalog([hostModel('m1'), hostModel('m2', { costTier: 'low' })])
    ctx.clock.advanceSeconds(7)
    const view = registerHost(ctx, catalog)
    expect(view).toEqual({
      ...catalog,
      id: view.id,
      registeredAt: '2026-01-01T00:00:07.000Z',
      registeredBy: 'test orchestrator'
    })
    expect(view.id).toMatch(/^hc_/)
    expect(ctx.db.get('SELECT host_id, host_type, catalog_revision FROM host_catalogs WHERE id = ?', view.id)).toEqual({
      host_id: 'host-a',
      host_type: 'cli-agent',
      catalog_revision: 'cat-1'
    })
    expect(lastEventPayload(ctx, 'host.registered')).toEqual({
      catalogId: view.id,
      hostId: 'host-a',
      catalogRevision: 'cat-1',
      models: ['m1', 'm2']
    })
  })

  it('is refused to the desktop and to reviewers', () => {
    const ctx = createTestCtx()
    expect(errorCode(() => registerHost(withRole(ctx, 'desktop'), hostCatalog([])))).toBe('unauthorized')
    expect(errorCode(() => registerHost(withRole(ctx, 'reviewer'), hostCatalog([])))).toBe('unauthorized')
  })
})

describe('matchCapabilities', () => {
  it('matches a pinned ticket against the run’s catalog', () => {
    const ctx = createTestCtx()
    const bundle = makeBundle([[1]])
    bundle.tickets = [makeTicket(1, { capability: { ...defaultCapabilityProfile(), skills: ['SQL'] } })]
    const { runId } = startedRun(ctx, { bundle })
    const catalog = registerHost(ctx, hostCatalog([hostModel('plain'), hostModel('sql', { skills: ['sql'] })]))
    registerHost(ctx, hostCatalog([hostModel('other')]))
    ctx.db.run('UPDATE runs SET host_catalog_id = ? WHERE id = ?', catalog.id, runId)
    const match = matchCapabilities(withRole(ctx, 'reviewer'), { runId, ticketId: tid(1) })
    expect(match).toMatchObject({
      ticketId: tid(1),
      catalogId: catalog.id,
      rejected: [],
      hostFailures: [],
      unknownRequirements: []
    })
    expect(match.eligible.map((item) => [item.modelId, item.score])).toEqual([
      ['sql', 35],
      ['plain', 30]
    ])
    expect(match.eligible[0]?.reasons).toContain('Lists skill "SQL" (+5).')
    expect(match.recommended).toMatchObject({ modelId: 'sql', effort: 'medium' })
  })

  it('falls back to the most recently registered catalog', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    registerHost(ctx, hostCatalog([hostModel('old')]))
    const latest = registerHost(ctx, hostCatalog([hostModel('new')], { tools: [] }))
    const match = matchCapabilities(ctx, { runId, ticketId: tid(1) })
    expect(match.catalogId).toBe(latest.id)
    expect(match.hostFailures).toEqual(['Host lacks required tool "repo_read".', 'Host lacks required tool "repo_write".'])
    expect(match.rejected.map((item) => item.modelId)).toEqual(['new'])
  })

  it('asks for a catalog when none is registered and rejects unknown runs or tickets', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(errorCode(() => matchCapabilities(ctx, { runId, ticketId: tid(1) }))).toBe('not_found')
    registerHost(ctx, hostCatalog([hostModel('m1')]))
    expect(errorCode(() => matchCapabilities(ctx, { runId, ticketId: tid(9) }))).toBe('not_found')
    expect(errorCode(() => matchCapabilities(ctx, { runId: 'rn_missing', ticketId: tid(1) }))).toBe('not_found')
    expect(errorCode(() => matchCapabilities(withRole(ctx, 'worker', { capabilities: [] }), { runId, ticketId: tid(1) }))).toBe(
      'unauthorized'
    )
  })
})

describe('registerHost efforts', () => {
  it('stores the efforts each model declares and returns them with the registration', () => {
    const ctx = createTestCtx()
    const view = registerHost(ctx, hostCatalog([hostModel('tiered', { efforts: ['low', 'medium'] }), hostModel('open')]))
    expect(view.models[0]?.efforts).toEqual(['low', 'medium'])
    expect(Object.keys(view.models[1] ?? {})).not.toContain('efforts')
    const row = ctx.db.get<{ catalog_json: string }>('SELECT catalog_json FROM host_catalogs WHERE id = ?', view.id)
    const stored = JSON.parse(row?.catalog_json ?? '{}') as { models: { id: string; efforts?: string[] }[] }
    expect(stored.models.map((model) => [model.id, model.efforts])).toEqual([
      ['tiered', ['low', 'medium']],
      ['open', undefined]
    ])
  })
})

const MODELS = [
  hostModel('deep-model', { costTier: 'high' }),
  hostModel('mid-model', { reasoningLevels: ['routine', 'multi_step'], costTier: 'normal' }),
  hostModel('routine-model', { reasoningLevels: ['routine'], costTier: 'low' })
]

function boundRun(overrides: Partial<TicketContent> = {}, level: ReasoningLevel = 'routine'): { ctx: TestCtx; runId: string } {
  const ctx = createTestCtx()
  const bundle = makeBundle([[1]])
  const capability = { ...defaultCapabilityProfile(), reasoning: { level, rationale: '' } }
  bundle.tickets = [makeTicket(1, { capability, ...overrides })]
  const { runId } = startedRun(ctx, { bundle })
  const catalog = registerHost(ctx, hostCatalog(MODELS))
  ctx.db.run('UPDATE runs SET host_catalog_id = ? WHERE id = ?', catalog.id, runId)
  return { ctx, runId }
}

const recommendedFor = (ctx: TestCtx, runId: string) => matchCapabilities(ctx, { runId, ticketId: tid(1) }).recommended

describe('matchCapabilities recommendation', () => {
  it('recommends the right-sized model at an effort taken from the ticket’s size', () => {
    const { ctx, runId } = boundRun({ size: 'small' })
    expect(recommendedFor(ctx, runId)).toMatchObject({ modelId: 'routine-model', effort: 'low' })
    const sized = boundRun({ size: 'large' }, 'multi_step')
    expect(recommendedFor(sized.ctx, sized.runId)).toMatchObject({ modelId: 'mid-model', effort: 'high' })
  })

  it('recommends a deep ticket only the deep model', () => {
    const { ctx, runId } = boundRun({}, 'deep')
    const match = matchCapabilities(ctx, { runId, ticketId: tid(1) })
    expect(match.eligible.map((item) => item.modelId)).toEqual(['deep-model'])
    expect(match.recommended?.modelId).toBe('deep-model')
  })

  it('does not escalate while the first attempt is still open', () => {
    const { ctx, runId } = boundRun()
    claim(ctx, runId, 1, { worker: { label: 'w1', modelId: 'routine-model' } })
    expect(recommendedFor(ctx, runId)?.modelId).toBe('routine-model')
  })
})

describe('matchCapabilities escalation', () => {
  it('recommends one tier up after a rejected attempt, and again after a failed one', () => {
    const { ctx, runId } = boundRun()
    const first = claim(ctx, runId, 1, { worker: { label: 'w1', modelId: 'routine-model', effort: 'low' } })
    expect(recommendedFor(ctx, runId)?.modelId).toBe('routine-model')
    submitClaim(ctx, first)
    rejectAttempt(ctx, { attemptId: first.attempt.id, reasons: ['No tests'] })
    const afterReject = recommendedFor(ctx, runId)
    expect(afterReject?.modelId).toBe('mid-model')
    expect(afterReject?.reasons).toContain(
      'Last attempt on "routine-model" was rejected; escalating to the cheapest eligible model one tier above it.'
    )
    const second = claim(ctx, runId, 1, { worker: { label: 'w2', modelId: 'mid-model' } })
    failAttempt(ctx, { attemptId: second.attempt.id, failure: { reason: 'stuck' } })
    expect(recommendedFor(ctx, runId)?.modelId).toBe('deep-model')
  })

  it('recommends the same model at a higher effort when nothing sits above the last attempt’s model', () => {
    const { ctx, runId } = boundRun({}, 'deep')
    const first = claim(ctx, runId, 1, { worker: { label: 'w1', modelId: 'deep-model', effort: 'medium' } })
    failAttempt(ctx, { attemptId: first.attempt.id, failure: { reason: 'stuck' } })
    expect(recommendedFor(ctx, runId)).toMatchObject({ modelId: 'deep-model', effort: 'high' })
  })

  it('looks only at the attempts of the ticket asked about, in this run', () => {
    const ctx = createTestCtx()
    const bundle = makeBundle([[1, 2]])
    bundle.tickets = bundle.tickets.map((ticket) => ({
      ...ticket,
      capability: { ...defaultCapabilityProfile(), reasoning: { level: 'routine' as const, rationale: '' } }
    }))
    const { runId } = startedRun(ctx, { bundle })
    const catalog = registerHost(ctx, hostCatalog(MODELS))
    ctx.db.run('UPDATE runs SET host_catalog_id = ? WHERE id = ?', catalog.id, runId)
    const other = claim(ctx, runId, 2, { worker: { label: 'w1', modelId: 'routine-model' } })
    failAttempt(ctx, { attemptId: other.attempt.id, failure: { reason: 'stuck' } })
    expect(recommendedFor(ctx, runId)?.modelId).toBe('routine-model')
    expect(matchCapabilities(ctx, { runId, ticketId: tid(2) }).recommended?.modelId).toBe('mid-model')
  })
})
