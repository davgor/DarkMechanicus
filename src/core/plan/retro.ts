/**
 * The retro of a sprint report: turning what a reporter wrote into what is stored (tickets resolved to stable
 * ids, every list present, experiments resolved by `./experiments`), telling an empty retro from a real one, and the
 * text search indexes. Pure.
 */
import type { PlanBundle } from '../../shared/domain/bundle'
import type {
  RetroDelivered,
  RetroDiscovery,
  RetroLeftover,
  RetroTierFit,
  SprintRetro,
  SprintRetroInput
} from '../../shared/domain/retro'
import { fail } from '../errors'
import { type ExperimentContext, normalizeExperiments } from './experiments'

type Resolve = (ref: string, path: string) => string

/** Finds a ticket of the run's plan by stable id or display key (exact), or refuses it and says where it was written. */
function ticketResolver(bundle: PlanBundle): Resolve {
  const ids = new Set(bundle.tickets.map((ticket) => ticket.id))
  const byKey = new Map(bundle.tickets.map((ticket) => [ticket.key, ticket.id]))
  return (ref, path) => {
    if (ids.has(ref)) {
      return ref
    }
    return (
      byKey.get(ref) ??
      fail('invalid_input', `Unknown ticket "${ref}" at ${path}: the run's plan has no ticket with that id or display key.`, {
        path,
        ticket: ref
      })
    )
  }
}

function delivered(input: SprintRetroInput, resolve: Resolve): RetroDelivered[] {
  return (input.delivered ?? []).map((item, index) => ({
    ticket: resolve(item.ticket, `retro.delivered[${index}].ticket`),
    demo: item.demo,
    evidence: item.evidence
  }))
}

function discoveries(input: SprintRetroInput, resolve: Resolve): RetroDiscovery[] {
  return (input.discoveries ?? []).map((item, index) => ({
    title: item.title,
    body: item.body ?? '',
    ticket: item.ticket == null ? null : resolve(item.ticket, `retro.discoveries[${index}].ticket`)
  }))
}

function leftovers(input: SprintRetroInput, resolve: Resolve): RetroLeftover[] {
  return (input.leftovers ?? []).map((item, index) => ({
    ticket: resolve(item.ticket, `retro.leftovers[${index}].ticket`),
    reason: item.reason
  }))
}

function tierFit(input: SprintRetroInput, resolve: Resolve): RetroTierFit[] {
  return (input.tierFit ?? []).map((item, index) => ({
    ticket: resolve(item.ticket, `retro.tierFit[${index}].ticket`),
    verdict: item.verdict,
    note: item.note ?? ''
  }))
}

/**
 * The stored form of a written retro: each ticket resolved to its stable id, each unwritten list empty, each
 * unwritten body or note an empty string, and a discovery without a ticket kept with `ticket: null`. A ticket
 * the plan does not have fails the whole report with `invalid_input`, naming the field.
 *
 * Experiments are resolved against `experiments` (the report's run, sprint and the epic's frozen scorecards). The
 * `experiments` key is written only when there is at least one, so a prose-only retro (and an empty experiments list)
 * stores exactly what it stored before experiments existed, with the same content hash. Prose `actions` and
 * structured experiments are independent lists: a retro may carry both, each kept as written.
 */
export function normalizeRetro(input: SprintRetroInput, bundle: PlanBundle, experiments?: ExperimentContext): SprintRetro {
  const resolve = ticketResolver(bundle)
  const written = input.experiments ?? []
  const structured =
    written.length === 0
      ? []
      : normalizeExperiments(
          written,
          experiments ?? fail('invalid_input', 'Experiments are written into a submitted sprint report, which resolves their sources.')
        )
  return {
    delivered: delivered(input, resolve),
    wentWell: input.wentWell ?? [],
    wentPoorly: input.wentPoorly ?? [],
    actions: input.actions ?? [],
    discoveries: discoveries(input, resolve),
    leftovers: leftovers(input, resolve),
    tierFit: tierFit(input, resolve),
    ...(structured.length === 0 ? {} : { experiments: structured })
  }
}

/**
 * A retro with no entry in any list says nothing about the sprint, so it does not count as one. Experiments count only
 * when there is one: an empty experiments list is never stored (normalizing drops it, an import refuses it).
 */
export function retroIsEmpty(retro: SprintRetro): boolean {
  const lists: unknown[][] = [
    retro.delivered,
    retro.wentWell,
    retro.wentPoorly,
    retro.actions,
    retro.discoveries,
    retro.leftovers,
    retro.tierFit,
    retro.experiments ?? []
  ]
  return lists.every((entries) => entries.length === 0)
}

/** The retro's text for the search index, in section order, with display keys for tickets. Empty parts are left out. */
export function retroSearchParts(retro: SprintRetro, keyOf: (ticketId: string) => string): string[] {
  const parts = [
    ...retro.delivered.flatMap((item) => [keyOf(item.ticket), item.demo, item.evidence]),
    ...retro.wentWell,
    ...retro.wentPoorly,
    ...retro.actions,
    ...retro.discoveries.flatMap((item) => [item.title, item.body, ...(item.ticket === null ? [] : [keyOf(item.ticket)])]),
    ...retro.leftovers.flatMap((item) => [keyOf(item.ticket), item.reason]),
    ...retro.tierFit.flatMap((item) => [keyOf(item.ticket), item.verdict, item.note]),
    ...(retro.experiments ?? []).flatMap((item) => [
      item.issue.summary,
      item.hypothesis,
      ...item.proposedWork.flatMap((work) => [work.title, work.body])
    ])
  ]
  return parts.filter((part) => part !== '')
}
