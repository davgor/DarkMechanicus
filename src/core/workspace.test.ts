import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { nodeFs } from './repo/nodeFs'
import type { Workspace } from './workspace'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

async function savedEpic(agent: Workspace): Promise<string> {
  await agent.initializeRepository({ name: 'branch-repo' })
  const epic = await agent.createEpic({ title: 'Branch epic' })
  const draft = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }]
  })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return epic.id
}

function trackedStatus(harness: Harness, epicId: string): string {
  const file = join(harness.root, '.darkmechanicus', 'epics', epicId, 'state.json')
  return (JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status
}

describe('Workspace branch guard', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('holds portable exports after the checkout moved until the repository is reconciled', async () => {
    const agent = harness.open('orchestrator')
    const epicId = await savedEpic(agent)
    harness.git.setHead({ branch: 'feature', commit: 'c'.repeat(40), detached: false })

    await agent.setEpicStatus({ epicId, status: 'in_progress' })
    expect(trackedStatus(harness, epicId)).toBe('backlog')
    expect(await codeOf(agent.flushPortableState())).toBe('branch_changed')
    const held = await agent.getStorageStatus()
    expect([held.branch.changed, held.outbox.pending]).toEqual([true, 1])

    const reconciled = await agent.reconcileRepository()
    expect(reconciled.branchChanged).toBe(true)
    expect(trackedStatus(harness, epicId)).toBe('in_progress')
    expect((await agent.getStorageStatus()).outbox.pending).toBe(0)
  })

  it('does not silently acknowledge a branch switch that happened while closed', async () => {
    const first = harness.open('orchestrator')
    const epicId = await savedEpic(first)
    first.close()
    harness.git.setHead({ branch: 'feature', commit: 'd'.repeat(40), detached: false })

    const reopened = harness.open('orchestrator')
    expect((await reopened.getStorageStatus()).branch.changed).toBe(true)
    expect(await codeOf(reopened.startRun({ epicId }))).toBe('branch_changed')
    await reopened.reconcileRepository()
    expect((await reopened.startRun({ epicId })).state).toBe('running')
  })
})

describe('Workspace save durability and pinning', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('reports a save as pending, keeping the draft, until the snapshot is durable', async () => {
    let failSnapshots = true
    const fs = {
      ...nodeFs,
      rename: (from: string, to: string) => {
        if (failSnapshots && to.includes(`${sep}snapshots${sep}`)) {
          throw new Error('disk full')
        }
        nodeFs.rename(from, to)
      }
    }
    const agent = harness.open('orchestrator', { fs })
    await agent.initializeRepository({ name: 'durable-repo' })
    const epic = await agent.createEpic({ title: 'Durable epic' })
    const draft = await agent.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'One' } }] })
    const pending = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    expect([pending.status, pending.error]).toEqual(['pending', 'disk full'])
    expect((await agent.getEpic({ epicId: epic.id })).hasDraft).toBe(true)
    expect(await codeOf(agent.getPlan({ epicId: epic.id, view: 'saved' }))).toBe('not_found')

    failSnapshots = false
    expect((await agent.flushPortableState()).failed).toBe(0)
    const saved = await agent.getPlan({ epicId: epic.id, view: 'saved' })
    expect([saved.revisionNumber, (await agent.getEpic({ epicId: epic.id })).hasDraft]).toEqual([1, false])
  })

  it('keeps a running run on its pinned revision after a newer save', async () => {
    const agent = harness.open('orchestrator')
    const epicId = await savedEpic(agent)
    const run = await agent.startRun({ epicId })
    const draft = await agent.updatePlanDraft({ epicId, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Later ticket' } }] })
    const second = await agent.savePlan({ epicId, expectedDraftRevision: draft.draftRevision })
    const current = await agent.getRun({ runId: run.id })
    expect([second.revisionNumber, current?.revisionNumber, current?.revisionId]).toEqual([2, 1, run.revisionId])
    expect(current?.tickets.map((ticket) => ticket.key)).toEqual(['BR-1'])
  })
})
