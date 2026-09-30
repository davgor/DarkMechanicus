import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../test/workspaceHarness'
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
