import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../core/errors'
import type { Workspace } from '../core/workspace'
import type { LinearTransferPacket } from '../shared/domain/transfer'
import { callLinear, createFakeLinear, type FakeIssue, type FakeLinear } from '../test/fakeLinearMcp'
import {
  completeTicket,
  type DriverStep,
  type PlanApi,
  planOneSprintEpic,
  planTwoSprintEpic,
  TransferDriver,
  TransferInterrupted
} from '../test/linearTransferDriver'
import { createHarness, type Harness } from '../test/workspaceHarness'

let harness: Harness
let fake: FakeLinear

beforeEach(() => {
  harness = createHarness()
  fake = createFakeLinear()
})

afterEach(async () => {
  await fake.close()
  harness.cleanup()
})

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return error instanceof DomainError ? error.code : String(error)
  }
}

interface Queued {
  desktop: Workspace
  agent: Workspace
  linear: Client
  epicId: string
}

/**
 * A saved fixture epic whose transfer the person queued in the desktop app, and an orchestrator with Linear's
 * tools. `before` runs as that orchestrator ahead of the queue, as work done in Dark Mechanicus first.
 */
async function queued(plan: (api: PlanApi) => Promise<string>, before?: (agent: Workspace, epicId: string) => Promise<unknown>): Promise<Queued> {
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'linear-transfer-repo' })
  const epicId = await plan(desktop)
  const agent = harness.open('orchestrator')
  await before?.(agent, epicId)
  expect(await desktop.queueTransfer({ epicId })).toMatchObject({ status: 'queued' })
  return { desktop, agent, linear: await fake.connect(), epicId }
}

function driver(setup: Queued, session: string, interrupt?: (step: DriverStep) => boolean, leaveCompletedOpen?: boolean): TransferDriver {
  return new TransferDriver({
    dm: setup.agent,
    linear: setup.linear,
    epicId: setup.epicId,
    teamKey: 'ENG',
    session,
    ...(interrupt ? { interrupt } : {}),
    ...(leaveCompletedOpen ? { leaveCompletedOpen } : {})
  })
}

/** Stops right after creating the fourth issue, before recording it: three issues are recorded then. */
function crashBeforeFourthRecord(step: DriverStep): boolean {
  return step.phase === 'created' && step.kind === 'issue' && step.recordedIssues === 3
}

interface Transferred extends Queued {
  packet: LinearTransferPacket
  /** The ref of the issue created but not recorded before the crash. */
  orphan: string
}

/** The two-sprint fixture, interrupted between a create and its record, then resumed by a fresh session. */
async function transferWithCrash(): Promise<Transferred> {
  const setup = await queued(planTwoSprintEpic)
  const { agent, epicId } = setup
  await expect(driver(setup, 'first', crashBeforeFourthRecord).transfer()).rejects.toBeInstanceOf(TransferInterrupted)

  const stopped = await agent.getTransfer({ epicId })
  const packet = stopped.packet ?? expect.fail('the queued transfer has a packet')
  const orphan = packet.issues[3]?.ref ?? ''
  expect(stopped.recorded.filter((item) => item.kind === 'issue').map((item) => item.ref)).toEqual(packet.issues.slice(0, 3).map((issue) => issue.ref))
  expect(stopped.next[0]).toBe(orphan)
  expect(fake.dump().issues).toHaveLength(4)

  const resumed = await driver(setup, 'resumed').transfer()
  expect(resumed).toMatchObject({ resumed: true, alreadyRecorded: 1 + packet.milestones.length + 3 })
  expect(resumed.adopted).toEqual([orphan])
  expect(resumed.created).toEqual(stopped.next.slice(1))
  return { ...setup, packet, orphan }
}

describe('a Linear transfer interrupted between a create and its record', () => {
  it('creates nothing twice after a crash between a create and its record', async () => {
    const { agent, epicId, packet, orphan } = await transferWithCrash()
    const { issues, projects, milestones, relations } = fake.dump()
    expect(issues).toHaveLength(packet.issues.length)
    expect(new Set(issues.map((issue) => issue.description)).size).toBe(packet.issues.length)
    expect([projects.length, milestones.length, relations.length]).toEqual([1, packet.milestones.length, packet.relations.length])
    expect(fake.calls.filter((name) => name === 'create_issue')).toHaveLength(packet.issues.length)
    const view = await agent.getTransfer({ epicId })
    expect([view.status, view.next]).toEqual(['in_progress', []])
    expect(view.recorded.find((item) => item.ref === orphan)?.identifier).toBe('ENG-4')
  })

  it('lays the epic out in execution order: rising identifiers, a milestone per sprint, acceptance issues last and blocked, the related link', async () => {
    const { desktop, agent, epicId, packet } = await transferWithCrash()
    const { issues, milestones, relations } = fake.dump()
    const recorded = new Map((await agent.getTransfer({ epicId })).recorded.map((item) => [item.ref, item.linearId]))
    const issueOf = (ref: string) => issues.find((issue) => issue.id === recorded.get(ref)) ?? expect.fail(`issue ${ref} is in the fake`)

    expect(packet.issues.map((item) => issueOf(item.ref).identifier)).toEqual(packet.issues.map((item) => `ENG-${item.position}`))
    expect(milestones.map((item) => [item.name, item.id])).toEqual(packet.milestones.map((item) => [item.name, recorded.get(item.ref)]))
    for (const item of packet.issues) {
      expect([issueOf(item.ref).milestoneId, issueOf(item.ref).title]).toEqual([recorded.get(item.milestoneRef), item.title])
    }

    const { bundle } = await desktop.getPlan({ epicId, view: 'saved' })
    for (const sprint of bundle.sprints) {
      const inSprint = packet.issues.filter((item) => item.milestoneRef === sprint.id)
      const node = bundle.tickets.find((ticket) => ticket.kind === 'acceptance' && sprint.ticketIds.includes(ticket.id))
      expect(inSprint[inSprint.length - 1]?.ref).toBe(node?.id)
      const blockers = relations.filter((item) => item.type === 'blocks' && item.relatedIssueId === recorded.get(node?.id ?? '')).map((item) => item.issueId)
      expect(blockers.sort()).toEqual(inSprint.slice(0, -1).map((item) => recorded.get(item.ref)).sort())
    }

    const [guide, api] = ['Write the guide', 'Define the API'].map((title) => packet.issues.find((item) => item.title === title)?.ref ?? '')
    const related = relations.filter((item) => item.type === 'related')
    expect(related.map((item) => [item.issueId, item.relatedIssueId])).toEqual([[recorded.get(guide ?? ''), recorded.get(api ?? '')]])
  })
})

describe('a Linear transfer whose read-back differs', () => {
  it('reports an injected wrong milestone and unexpected issue, fixes them without deleting, and only then completes the epic', async () => {
    const setup = await transferWithCrash()
    const { desktop, agent, linear, epicId, packet } = setup
    const wire = packet.issues.find((item) => item.title === 'Wire the screen to the API') ?? expect.fail('the fixture has Wire')
    const recorded = new Map((await agent.getTransfer({ epicId })).recorded.map((item) => [item.ref, item.linearId]))
    const [sprint1, sprint2] = packet.milestones.map((item) => recorded.get(item.ref) ?? '')
    await callLinear(linear, 'update_issue', { id: recorded.get(wire.ref), milestoneId: sprint2 })
    const stray = await callLinear<FakeIssue>(linear, 'create_issue', { teamId: 'team-eng', projectId: recorded.get('project'), title: 'Stray note', description: 'Added by hand.' })

    const first = await driver(setup, 'verifier').verify(1)
    expect(first.results.map((result) => result.status)).toEqual(['rejected'])
    expect(first.results[0]?.mismatches).toEqual([
      { ref: wire.ref, key: wire.key, field: 'milestone', expected: sprint1, actual: sprint2 },
      { ref: stray.id, field: 'unexpected', expected: null, actual: 'ENG-8' }
    ])
    expect(first.fixes).toEqual([`updated the milestone of ${wire.key}`, 'moved ENG-8 out of the project'])
    expect(await desktop.getEpic({ epicId })).toMatchObject({ status: 'backlog', outcome: null })
    expect((await agent.getTransfer({ epicId })).lastMismatches).toHaveLength(2)

    const second = await driver(setup, 'verifier-2').verify()
    expect(second.results.map((result) => [result.status, result.mismatches])).toEqual([['verified', []]])
    const { issues } = fake.dump()
    expect(issues).toHaveLength(packet.issues.length + 1)
    expect(issues.find((issue) => issue.id === stray.id)).toMatchObject({ projectId: null, milestoneId: null })
    expect(issues).toHaveLength(fake.calls.filter((name) => name === 'create_issue').length)
    expect(await desktop.getEpic({ epicId })).toMatchObject({ status: 'completed', outcome: { transfer: { target: 'linear' } } })
    expect(await codeOf(agent.startRun({ epicId, host: { label: 'test', type: 'test' } }))).toBe('completed_epic')
    expect(await codeOf(desktop.queueTransfer({ epicId }))).toBe('completed_epic')
  })
})

describe('a Linear transfer canceled and queued again', () => {
  it('adopts every existing item by its marker after the person cancels and queues the transfer again', async () => {
    const setup = await queued(planOneSprintEpic)
    const { desktop, agent, epicId } = setup
    const first = await driver(setup, 'first').transfer()
    const before = (await agent.getTransfer({ epicId })).recorded.map((item) => [item.ref, item.linearId, item.identifier])
    const creates = fake.calls.filter((name) => name.startsWith('create_')).length

    expect(await desktop.cancelTransfer({ epicId })).toMatchObject({ status: 'canceled', recorded: [] })
    expect(await codeOf(agent.startTransfer({ epicId }))).toBe('approval_required')
    expect(await desktop.queueTransfer({ epicId })).toMatchObject({ status: 'queued', recorded: [] })

    const again = await driver(setup, 'requeued').transfer()
    expect(again).toMatchObject({ resumed: false, alreadyRecorded: 0, created: [] })
    expect(again.adopted).toEqual(first.created)
    expect(fake.calls.filter((name) => name.startsWith('create_')).length).toBe(creates)
    expect((await agent.getTransfer({ epicId })).recorded.map((item) => [item.ref, item.linearId, item.identifier])).toEqual(before)

    const verified = await driver(setup, 'verifier').verify()
    expect(verified.results.map((result) => result.status)).toEqual(['verified'])
    expect(fake.layout()).toContain('Project Cancel path fixture')
  })
})

describe('a Linear transfer of an epic with a ticket completed in Dark Mechanicus', () => {
  interface WithCompleted extends Queued {
    packet: LinearTransferPacket
    completed: LinearTransferPacket['issues'][number]
    stateOf: (ref: string) => Promise<string | undefined>
  }

  /** The one-sprint fixture with Prepare accepted in a run that was then canceled, queued for transfer. */
  async function withCompleted(): Promise<WithCompleted> {
    const setup = await queued(planOneSprintEpic, (agent, epicId) => completeTicket(agent, epicId, 'Prepare'))
    const packet = (await setup.agent.getTransfer({ epicId: setup.epicId })).packet ?? expect.fail('the queued transfer has a packet')
    expect(packet.issues.map((issue) => [issue.title, issue.state])).toEqual([
      ['Prepare', 'completed'],
      ['Deliver', 'default'],
      [expect.any(String), 'default']
    ])
    const completed = packet.issues[0] ?? expect.fail('the packet has Prepare')
    const stateOf = async (ref: string) => {
      const recorded = (await setup.agent.getTransfer({ epicId: setup.epicId })).recorded.find((item) => item.ref === ref)
      return fake.dump().issues.find((issue) => issue.id === recorded?.linearId)?.stateType
    }
    return { ...setup, packet, completed, stateOf }
  }

  it('creates its issue in a completed state, and the read-back verifies and completes the epic', async () => {
    const setup = await withCompleted()
    const { desktop, epicId, packet, completed, stateOf } = setup
    await driver(setup, 'first').transfer()
    expect(await Promise.all(packet.issues.map((issue) => stateOf(issue.ref)))).toEqual(['completed', 'unstarted', 'unstarted'])

    const verified = await driver(setup, 'verifier').verify()
    expect(verified.results.map((result) => [result.status, result.mismatches])).toEqual([['verified', []]])
    expect(await stateOf(completed.ref)).toBe('completed')
    expect(await desktop.getEpic({ epicId })).toMatchObject({ status: 'completed', outcome: { transfer: { target: 'linear' } } })
  })

  it('rejects its issue left open with a state mismatch naming its key, and verifies once the driver sets the state', async () => {
    const setup = await withCompleted()
    const { desktop, agent, epicId, completed, stateOf } = setup
    await driver(setup, 'first', undefined, true).transfer()
    expect(await stateOf(completed.ref)).toBe('unstarted')

    const first = await driver(setup, 'verifier').verify(1)
    expect(first.results.map((result) => [result.status, result.mismatches])).toEqual([
      ['rejected', [{ ref: completed.ref, key: completed.key, field: 'state', expected: 'completed', actual: 'unstarted' }]]
    ])
    expect(first.fixes).toEqual([`updated the state of ${completed.key}`])
    expect(await stateOf(completed.ref)).toBe('completed')
    expect(await desktop.getEpic({ epicId })).toMatchObject({ outcome: null })
    expect((await agent.getTransfer({ epicId })).lastMismatches).toHaveLength(1)

    const second = await driver(setup, 'verifier-2').verify()
    expect(second.results.map((result) => [result.status, result.mismatches])).toEqual([['verified', []]])
    expect(await desktop.getEpic({ epicId })).toMatchObject({ status: 'completed', outcome: { transfer: { target: 'linear' } } })
  })
})
