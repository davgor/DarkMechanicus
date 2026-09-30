import { describe, expect, it } from 'vitest'
import { defaultCapabilityProfile } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, tid } from '../../test/bundles'
import { errorCode, hostCatalog, hostModel, lastEventPayload, startedRun } from '../../test/execution'
import { createTestCtx, withRole } from '../../test/testContext'
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
    expect(matchCapabilities(withRole(ctx, 'reviewer'), { runId, ticketId: tid(1) })).toEqual({
      ticketId: tid(1),
      catalogId: catalog.id,
      eligible: [
        { modelId: 'sql', score: 60, reasons: ['Lists skill "SQL" (+10).'] },
        { modelId: 'plain', score: 50, reasons: [] }
      ],
      rejected: [],
      hostFailures: [],
      unknownRequirements: []
    })
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
