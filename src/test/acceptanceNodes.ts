/** Fixture helper for command-level tests that plan an epic through a Workspace. Not shipped. */
import type { Workspace } from '../core/workspace'

/**
 * Removes every acceptance node from an epic's draft and returns the new draft revision. A new epic
 * starts with its first sprint's node, and `add_sprint` adds one per sprint. Tests about ticket flow
 * (claims, runs, checkpoints) plan only work tickets, like a plan saved before acceptance nodes, because
 * how a run treats a node belongs to the tests that cover the node: the node's readiness and the
 * `acceptance_accepted` gate (`readinessAcceptance.test.ts`, `checkpointsAcceptance.test.ts` and
 * `src/integration/acceptanceGate.test.ts`). Call it right after `createEpic` so
 * that ticket keys start at 1, and again after any `add_sprint` before saving.
 */
export async function dropAcceptanceNodes(
  agent: Pick<Workspace, 'getPlan' | 'updatePlanDraft'>,
  epicId: string
): Promise<number> {
  const plan = await agent.getPlan({ epicId, view: 'draft' })
  const ops = plan.bundle.tickets
    .filter((ticket) => ticket.kind === 'acceptance')
    .map((ticket) => ({ op: 'remove_ticket' as const, ticket: ticket.id }))
  if (ops.length === 0) {
    return plan.draftRevision ?? 0
  }
  return (await agent.updatePlanDraft({ epicId, ops })).draftRevision
}
