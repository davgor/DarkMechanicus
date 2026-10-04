/** The acceptance node's execution packet carries the project's Definition of Done, so its worker knows what to run. */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { ClaimResultView, DefinitionOfDoneCheck } from '../../shared/domain/views'
import { makeBundle, tid } from '../../test/bundles'
import { claim, startedRun, submitClaim } from '../../test/execution'
import { createTestCtx } from '../../test/testContext'
import { acceptAttempt } from './attempts'

const DEFINITION: DefinitionOfDoneCheck[] = [
  { name: 'lint', command: 'npm run lint', description: 'oxlint over src and scripts' },
  { name: 'fireguard', command: 'npm run fireguard', description: 'Graded from the sprint Fireguard ticket' },
  { name: 'build', command: 'npm run build', description: '' }
]

/** Sprint = {DM-1, DM-2}; DM-2 is the acceptance node, which requires DM-1. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2]])
  bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(2) ? { ...ticket, kind: 'acceptance' as const } : ticket))
  return bundle
}

/** The packets of the work ticket and, once that is accepted, of the acceptance node. */
function packets(definition: DefinitionOfDoneCheck[]): { work: ClaimResultView['packet']; node: ClaimResultView['packet'] } {
  const ctx = createTestCtx({ definitionOfDone: definition })
  const { runId } = startedRun(ctx, { bundle: plan() })
  const work = claim(ctx, runId, 1)
  submitClaim(ctx, work)
  acceptAttempt(ctx, { attemptId: work.attempt.id })
  return { work: work.packet, node: claim(ctx, runId, 2).packet }
}

describe('the execution packet of a sprint acceptance node', () => {
  it('lists every Definition of Done check with its name, command and description, in order', () => {
    expect(packets(DEFINITION).node.definitionOfDone).toEqual(DEFINITION)
  })

  it('tells the worker to report each check by name, and what the checkpoint does with them', () => {
    const { instructions } = packets(DEFINITION).node.reporting
    expect(instructions).toContain('evidence.checks')
    expect(instructions).toContain('definition_of_done')
    expect(instructions).toContain('submit_attempt')
  })

  it('names no Definition of Done when the project has none, and says nothing more than for a work ticket', () => {
    const { work, node } = packets([])
    expect(Object.keys(node)).not.toContain('definitionOfDone')
    expect(node.reporting).toEqual(work.reporting)
  })
})

describe('the execution packet of a work ticket', () => {
  it('does not carry the Definition of Done: that belongs to the acceptance node', () => {
    const { work } = packets(DEFINITION)
    expect(Object.keys(work)).not.toContain('definitionOfDone')
    expect(work.reporting.instructions).not.toContain('definition_of_done')
  })
})
