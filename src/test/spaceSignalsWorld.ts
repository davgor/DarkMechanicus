/**
 * Fixture world for tests of the S, A and C signals (`getSpaceSignals`): one harness (its own temporary folders and
 * database), an orchestrator and a desktop session, an epic whose single sprint holds the given tickets, saved, with a
 * run started. The harness clock moves 60 s per lifecycle step. Not shipped.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { DraftOp, TicketInput } from '../shared/domain/api'
import type { SpaceComponentResult, SpaceGrade, SpaceGradeInput } from '../shared/domain/space'
import type { GetSpaceSignalsInput, SpaceSignalsView } from '../shared/domain/spaceSignals'
import type { SessionRole } from '../shared/domain/views'
import { getSpaceSignals } from '../core/services/spaceSignals'
import { gradeSpace } from '../core/space/rubric'
import type { Workspace } from '../core/workspace'
import { createMcpServer } from '../mcp/server'
import { dropAcceptanceNodes } from './acceptanceNodes'
import { createHarness, type Harness } from './workspaceHarness'

export interface Claimed {
  id: string
  token: string
}

/** The planned epic: sessions, ids and ticket ids by plan ref. */
interface Planned {
  harness: Harness
  orchestrator: Workspace
  desktop: Workspace
  epicId: string
  runId: string
  sprintId: string
  /** Ticket ids by plan ref (`acceptance` names the sprint's acceptance node when it was kept). */
  ticket: Record<string, string>
}

export interface SignalsWorld extends Planned {
  claim(ref: string): Promise<Claimed>
  /** Submits with full evidence (every criterion noted, one passed check, a summary, a commit on a branch) unless patched. */
  submit(ref: string, claimed: Claimed, patch?: Record<string, unknown>): Promise<void>
  accept(claimed: Claimed, criteria?: { criterionId: string; met: boolean; note: string }[]): Promise<void>
  reject(claimed: Claimed, reason: string): Promise<void>
  /** Pauses the run, applies the draft ops, saves and adopts the new revision, then resumes. */
  replan(ops: DraftOp[]): Promise<void>
  signals(input: Omit<GetSpaceSignalsInput, 'runId'> & { runId?: string }): SpaceSignalsView
  close(): void
}

async function plan(tickets: Record<string, TicketInput>, options: { acceptance?: boolean }): Promise<Planned> {
  const harness = createHarness()
  const orchestrator = harness.open('orchestrator')
  const desktop = harness.open('desktop')
  await orchestrator.initializeRepository({ name: 'signals-test' })
  const epic = await orchestrator.createEpic({ title: 'Signals' })
  if (options.acceptance !== true) {
    await dropAcceptanceNodes(orchestrator, epic.id)
  }
  const draft = await orchestrator.updatePlanDraft({
    epicId: epic.id,
    ops: Object.entries(tickets).map(([ref, ticket]) => ({ op: 'add_ticket' as const, ref, sprint: '1', ticket }))
  })
  await orchestrator.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const ticket: Record<string, string> = { ...draft.refMap }
  const saved = await orchestrator.getPlan({ epicId: epic.id, view: 'saved' })
  const node = saved.bundle.tickets.find((item) => item.kind === 'acceptance')
  if (node !== undefined) ticket.acceptance = node.id
  harness.clock.advanceSeconds(60)
  const run = await orchestrator.startRun({ epicId: epic.id })
  return { harness, orchestrator, desktop, epicId: epic.id, runId: run.id, sprintId: saved.bundle.sprints[0]?.id ?? '', ticket }
}

/** An epic whose one sprint holds `tickets` by ref; `acceptance` keeps the sprint's acceptance node. */
export async function signalsWorld(tickets: Record<string, TicketInput>, options: { acceptance?: boolean } = {}): Promise<SignalsWorld> {
  const planned = await plan(tickets, options)
  const { harness, orchestrator, epicId, runId, ticket } = planned
  const step = (): void => harness.clock.advanceSeconds(60)
  return {
    ...planned,
    async claim(ref) {
      step()
      const claimed = await orchestrator.claimTicket({ runId, ticketId: ticket[ref] ?? '', worker: { label: `worker-${ref}` } })
      return { id: claimed.attempt.id, token: claimed.packet.claimToken ?? '' }
    },
    async submit(ref, claimed, patch = {}) {
      step()
      const saved = await orchestrator.getPlan({ epicId, view: 'saved' })
      const criteria = (saved.bundle.tickets.find((item) => item.id === ticket[ref])?.acceptanceCriteria ?? []).map((item) => ({
        criterionId: item.id,
        met: true,
        note: `evidence for ${item.id}`
      }))
      await orchestrator.submitAttempt({
        attemptId: claimed.id,
        claimToken: claimed.token,
        outputs: { summary: `Delivered ${ref}`, commits: ['abc1234'], branch: `work-${ref}` },
        evidence: { checks: [{ name: 'npm run typecheck', status: 'passed', detail: 'exit 0' }], criteria, notes: '' },
        ...patch
      })
    },
    async accept(claimed, criteria) {
      step()
      await orchestrator.acceptAttempt({ attemptId: claimed.id, ...(criteria === undefined ? {} : { criteria }) })
    },
    async reject(claimed, reason) {
      step()
      await orchestrator.rejectAttempt({ attemptId: claimed.id, reasons: [reason] })
    },
    async replan(ops) {
      step()
      await orchestrator.pauseRun({ runId, reason: 'replan' })
      const edited = await orchestrator.updatePlanDraft({ epicId, ops })
      const saved = await orchestrator.savePlan({ epicId, expectedDraftRevision: edited.draftRevision })
      step()
      await orchestrator.adoptRevision({ runId, revisionId: saved.revisionId })
      await orchestrator.resumeRun({ runId })
      Object.assign(ticket, edited.refMap)
    },
    signals: (input) => getSpaceSignals(orchestrator.ctx(), { runId, ...input }),
    close: () => harness.cleanup()
  }
}

const COMPLETE_FIXTURE = join(import.meta.dirname, '..', 'core', 'space', 'fixtures', 'rubric', 'complete.json')

/**
 * Grades a signals read with the reference grader: the checked-in `complete.json` rubric input with its subject, cutoff
 * and dispatch time replaced by the read's and S, A and C taken from the read (P, E, T and K stay the fixture's).
 */
function gradeSignals(view: SpaceSignalsView): SpaceGrade {
  const { input } = JSON.parse(readFileSync(COMPLETE_FIXTURE, 'utf8')) as { input: SpaceGradeInput }
  return gradeSpace({
    ...input,
    subject: view.subject,
    cutoff: view.cutoff,
    dispatchedAt: view.A.dispatchedAt ?? view.cutoff,
    components: { ...input.components, S: view.S.input, A: view.A.input, C: view.C.input }
  })
}

/** One graded component of a signals read: `graded(view, 'A')`. */
export function graded(view: SpaceSignalsView, name: 'S' | 'A' | 'C'): SpaceComponentResult {
  const found = gradeSignals(view).components.find((item) => item.component === name)
  if (found === undefined) throw new Error(`no component ${name}`)
  return found
}

interface ToolAnswer {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

interface McpSession {
  tools: string[]
  call(name: string, args: Record<string, unknown>): Promise<ToolAnswer>
  close(): Promise<void>
}

/** A real MCP client of the full server for `api`, granted `role` the way the stdio entry point grants it. */
export async function mcpSession(api: Workspace, role: SessionRole): Promise<McpSession> {
  const server = createMcpServer(api, { name: 'darkmechanicus', version: 'test' }, { role, allowSave: false })
  const client = new Client({ name: `test-${role}`, version: '0.0.0' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    tools: (await client.listTools()).tools.map((tool) => tool.name),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args })
      return result.structuredContent as unknown as ToolAnswer
    },
    async close() {
      await client.close()
      await server.close()
    }
  }
}
