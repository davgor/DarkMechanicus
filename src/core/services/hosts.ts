/**
 * Host capability catalogs: the orchestrator registers the models and tools its host actually
 * offers, and tickets' provider-neutral capability profiles are matched against them.
 */
import type { CapabilityMatchView, HostCatalog, HostCatalogView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { toJson } from '../db/database'
import { fail } from '../errors'
import { matchProfile } from '../plan/capabilities'
import { appendEvent } from './events'
import { loadBundle, loadHostCatalog, requireRun, ticketOf } from './execution'

export function registerHost(ctx: Ctx, catalog: HostCatalog): HostCatalogView {
  requireCapability(ctx.session, 'host.register')
  const stored: HostCatalog = {
    hostId: catalog.hostId,
    hostType: catalog.hostType,
    catalogRevision: catalog.catalogRevision,
    tools: catalog.tools,
    canSelectWorkerModel: catalog.canSelectWorkerModel,
    models: catalog.models
  }
  return ctx.db.tx(() => {
    const id = ctx.ids.next('hostCatalog')
    const now = ctx.clock.nowIso()
    ctx.db.run(
      `INSERT INTO host_catalogs (id, host_id, host_type, catalog_revision, catalog_json, registered_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      stored.hostId,
      stored.hostType,
      stored.catalogRevision,
      toJson(stored),
      ctx.session.label,
      now
    )
    appendEvent(ctx, {
      kind: 'host.registered',
      payload: {
        catalogId: id,
        hostId: stored.hostId,
        catalogRevision: stored.catalogRevision,
        models: stored.models.map((model) => model.id)
      }
    })
    return { ...stored, id, registeredAt: now, registeredBy: ctx.session.label }
  })
}

/** Matches a pinned ticket against the run's host catalog (else the most recently registered one). */
export function matchCapabilities(ctx: Ctx, input: { ticketId: string; runId: string }): CapabilityMatchView {
  requireCapability(ctx.session, 'read')
  const run = requireRun(ctx, input.runId)
  const catalog =
    loadHostCatalog(ctx, run.host_catalog_id) ??
    fail('not_found', 'Register the host catalog with register_host first.', { runId: run.id })
  const ticket = ticketOf(loadBundle(ctx, run.revision_id), input.ticketId)
  return { ticketId: ticket.id, catalogId: catalog.id, ...matchProfile(ticket.capability, catalog.catalog) }
}
