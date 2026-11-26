import { afterEach, expect, it } from 'vitest'
import { META_KEYS, setMeta } from '../../core/meta'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { reconcileOnLane, releaseLane, type LaneObserver, type LaneRequest, type LaneState } from './syncLaneCore'

const harnesses: Harness[] = []
const states: LaneState[] = []
afterEach(() => {
  for (const state of states.splice(0)) releaseLane(state)
  for (const used of harnesses.splice(0)) used.cleanup()
})

function fresh(): Harness {
  const created = createHarness()
  harnesses.push(created)
  return created
}

async function lanedProject(): Promise<LaneRequest> {
  const harness = fresh()
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'lane-repo' })
  const epic = await desktop.createEpic({ title: 'Lane epic' })
  await dropAcceptanceNodes(desktop, epic.id)
  const draft = await desktop.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Only ticket' } }] })
  await desktop.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const { session, machineId } = desktop.ctx()
  return { path: harness.root, home: harness.homeDir, ownerPid: process.pid, mode: 'explicit', authority: undefined, sessionId: session.id, machineId }
}

it('keeps an observed lane reading only what changed: its file-hash cache lives across reconciles', async () => {
  const request = await lanedProject()
  const rows: Parameters<LaneObserver['onReconcile']>[0][] = []
  const state: LaneState = { observer: { onTransaction: () => undefined, onReconcile: (row) => rows.push(row) } }
  states.push(state)
  reconcileOnLane(state, request)
  reconcileOnLane(state, request)
  reconcileOnLane(state, request)
  // The first reconcile reads every record body cold. The unchanged ones after it skip each body its cache vouches for,
  // as an unobserved lane's do; a counting wrapper made per reconcile emptied that cache and read every body again.
  const [cold, ...warm] = rows.map((row) => row.fileReads)
  expect(warm).toHaveLength(2)
  // Only files no cache covers (project.json and the like) are read again; every record body the cold read cached is not.
  for (const reads of warm) expect(reads).toEqual({ prepared: (cold?.prepared ?? 0) - 1, locked: 0 })
})

it('refuses a folder with no project database: the lane never creates one', () => {
  const state: LaneState = {}
  states.push(state)
  const harness = fresh()
  const request: LaneRequest = { path: harness.root, home: harness.homeDir, ownerPid: process.pid, mode: 'explicit', authority: undefined, sessionId: 'ss_1', machineId: 'mc_1' }
  expect(() => reconcileOnLane(state, request)).toThrow(expect.objectContaining({ code: 'not_initialized' }))
  expect(state.store).toBeUndefined()
})

it('skips a heartbeat after a branch change but runs a member reconcile, counting reads under the lock apart', async () => {
  const request = await lanedProject()
  const rows: Parameters<LaneObserver['onReconcile']>[0][] = []
  const state: LaneState = { observer: { onTransaction: () => undefined, onReconcile: (row) => rows.push(row) } }
  states.push(state)
  reconcileOnLane(state, request)
  setMeta(state.store!.db, META_KEYS.checkoutBranch, 'elsewhere')
  expect(reconcileOnLane(state, { ...request, mode: 'heartbeat' })).toEqual({ result: null, hasLocalCache: true })
  expect(rows.map((row) => row.mode)).toEqual(['explicit'])
  expect(reconcileOnLane(state, { ...request, mode: 'member' }).result).not.toBeNull()
  expect(rows.map((row) => row.mode)).toEqual(['explicit', 'member'])
})
