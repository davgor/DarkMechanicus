import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import { hostCatalog, hostModel } from '../../test/execution'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

const OPS: DraftOp[] = [
  { op: 'set_epic', successCriteria: ['Both tickets are done'] },
  {
    op: 'add_ticket',
    ref: 'tiny',
    sprint: '1',
    ticket: {
      title: 'Rename the flag',
      acceptanceCriteria: ['Flag renamed'],
      size: 'micro',
      capability: { reasoning: { level: 'routine', effort: 'low' } }
    }
  },
  {
    op: 'add_ticket',
    ref: 'big',
    sprint: '1',
    ticket: { title: 'Rewrite the planner', acceptanceCriteria: ['Planner rewritten'], size: 'large' }
  },
  { op: 'add_dependency', from: 'tiny', to: 'big' }
]

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

interface Planned {
  epicId: string
  ticket(ref: string): string
}

async function plannedEpic(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'sizing-repo', keyPrefix: 'DM' })
  const epic = await agent.createEpic({ title: 'Sizing' })
  const draft = await agent.updatePlanDraft({ epicId: epic.id, ops: OPS })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return { epicId: epic.id, ticket: (ref) => draft.refMap[ref] ?? '' }
}

describe('ticket size and reasoning effort through the planning commands', () => {
  it('returns the size and effort from get_ticket and list_tickets', async () => {
    const agent = harness.open('orchestrator')
    const plan = await plannedEpic(agent)
    const detail = await agent.getTicket({ epicId: plan.epicId, ticketId: plan.ticket('tiny'), view: 'saved' })
    expect(detail.ticket.size).toBe('micro')
    expect(detail.ticket.capability.reasoning).toEqual({ level: 'routine', rationale: '', effort: 'low' })
    const rows = await agent.listTickets({ epicId: plan.epicId, view: 'saved' })
    expect(rows.map((row) => [row.title, row.size, row.effort])).toEqual([
      ['Rename the flag', 'micro', 'low'],
      ['Rewrite the planner', 'large', undefined],
      // The sprint acceptance node a new epic starts with stays last in its sprint.
      ['Sprint 1 acceptance', undefined, undefined]
    ])
  })

  it('shows a changed size or effort in the draft changes', async () => {
    const agent = harness.open('orchestrator')
    const plan = await plannedEpic(agent)
    await agent.updatePlanDraft({
      epicId: plan.epicId,
      ops: [
        { op: 'update_ticket', ticket: plan.ticket('tiny'), patch: { size: 'small', capability: { reasoning: { effort: 'medium' } } } }
      ]
    })
    const { changes } = await agent.getPlan({ epicId: plan.epicId, view: 'draft' })
    expect(changes.map((change) => change.detail)).toEqual(['size micro → small; reasoning effort low → medium'])
  })

  it('warns, without erroring, about a large ticket', async () => {
    const agent = harness.open('orchestrator')
    const plan = await plannedEpic(agent)
    const report = await agent.validatePlan({ epicId: plan.epicId, view: 'saved' })
    expect(report.valid).toBe(true)
    expect(report.warnings.filter((warning) => warning.code === 'large_ticket')).toEqual([
      {
        code: 'large_ticket',
        message: 'DM-3 is sized large; consider splitting it into smaller tickets.',
        ticketIds: [plan.ticket('big')]
      }
    ])
  })
})

describe('ticket effort through the execution commands', () => {
  async function started(agent: Workspace): Promise<{ plan: Planned; runId: string }> {
    const plan = await plannedEpic(agent)
    const catalog = await agent.registerHost(hostCatalog([hostModel('small', { efforts: ['low', 'medium'] })]))
    const run = await agent.startRun({ epicId: plan.epicId, hostCatalogId: catalog.id })
    return { plan, runId: run.id }
  }

  it('records the effort on the attempt, hands it over in the packet, and exports it in run history', async () => {
    const agent = harness.open('orchestrator')
    const { plan, runId } = await started(agent)
    const claim = await agent.claimTicket({
      runId,
      ticketId: plan.ticket('tiny'),
      worker: { label: 'worker-1', modelId: 'small', effort: 'low' }
    })
    expect(claim.attempt.worker.effort).toBe('low')
    expect(claim.packet.effort).toBe('low')
    expect(claim.packet.ticket.size).toBe('micro')
    const run = await agent.getRun({ runId })
    expect(run?.attempts.map((attempt) => attempt.worker.effort)).toEqual(['low'])
    await agent.flushPortableState()
    const history = JSON.parse(readFileSync(join(harness.root, '.darkmechanicus', 'history', runId, 'run.json'), 'utf8')) as {
      attempts: { worker: { effort?: string | null } }[]
    }
    expect(history.attempts.map((attempt) => attempt.worker.effort)).toEqual(['low'])
  })

  it('refuses an effort the model does not declare', async () => {
    const agent = harness.open('orchestrator')
    const { plan, runId } = await started(agent)
    await expect(
      agent.claimTicket({ runId, ticketId: plan.ticket('tiny'), worker: { label: 'w', modelId: 'small', effort: 'high' } })
    ).rejects.toMatchObject({ code: 'unsupported_capability' })
    await expect(
      agent.claimTicket({ runId, ticketId: plan.ticket('tiny'), worker: { label: 'w', modelId: 'small', effort: 'extreme' as never } })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
