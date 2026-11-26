/**
 * DM-956: the approval coordinator's own refusals and scoping, over a scripted workspace (no Git runs): a folder that
 * is not a path, untrack scoped to its folders, and recovery that does nothing once the app is quitting or the
 * folder is being released.
 */
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { LearningApprovalState } from '../../core/services/learningApproval'
import type { KanbanCardView } from '../../shared/domain/kanban'
import { createLearningIntegrationLocks } from '../git/learningIntegration'
import { createOperationLocks } from '../git/operationLock'
import type { GitRunner } from '../git/runner'
import { createLearningApprovals, type LearningApprovalController } from './approveLearningCard'

const CARD = 'kc_01m877ym5kj3nydv11sna2t15f'
const ATTEMPT = 'ka_01m877ym5kj3nydv11sna2t15f'
const INPUT = { cardId: CARD, attemptId: ATTEMPT, draftsHash: `sha256:${'d'.repeat(64)}` }
/** Only the lane of the Done card is read back here. */
const DONE = { id: CARD, lane: 'done' } as KanbanCardView

/** No Git may run: every approval here is already published, so the coordinator only reads the Done card. */
const NO_GIT: GitRunner = { run: () => Promise.reject(new Error('Unexpected Git process')) }

/** A workspace whose preparation waits until `release()`, then answers with an already published operation. */
function scriptedWorkspace() {
  const calls: string[] = []
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (open = resolve))
  const published = { state: 'published', cardId: CARD, attemptId: ATTEMPT } as unknown as LearningApprovalState
  return {
    calls,
    release: () => open(),
    workspace: {
      repoRoot: '/a',
      getStorageStatus: () => Promise.reject(new Error('Unexpected storage read')),
      getKanbanCard: () => Promise.resolve(DONE),
      call: async (name: string) => {
        calls.push(name)
        if (name === 'pendingLearningApprovals') return []
        await gate
        return published
      }
    }
  }
}

function coordinator(scripted: ReturnType<typeof scriptedWorkspace>): LearningApprovalController {
  return createLearningApprovals({
    resolve: (folder) => (folder === '/a' || folder === '/b' ? folder : null),
    workspace: () => scripted.workspace as never,
    git: { runner: NO_GIT, operations: createOperationLocks(NO_GIT), cards: createLearningIntegrationLocks() }
  })
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  if (!(error instanceof DomainError)) throw new Error(`expected a domain error, got ${String(error)}`)
  return error
}

describe('approval coordinator scoping', () => {
  it('refuses a folder that is not a path as untracked without asking any workspace', async () => {
    const scripted = scriptedWorkspace()
    const error = await refusal(coordinator(scripted).approve(42, INPUT))
    expect([error.code, error.message]).toEqual(['unauthorized', 'That folder is not tracked by Dark Mechanicus.'])
    expect(scripted.calls).toEqual([])
  })

  it('untracking another folder neither aborts nor waits for this folder’s approval', async () => {
    const scripted = scriptedWorkspace()
    const approvals = coordinator(scripted)
    const running = approvals.approve('/a', INPUT)
    await approvals.release(['/b'])
    expect(approvals.busy()).toBe(true)
    scripted.release()
    expect((await running).lane).toBe('done')
    expect(approvals.busy()).toBe(false)
  })

  it('recovers nothing in a folder being released or after quit, and refuses approvals while it closes', async () => {
    const scripted = scriptedWorkspace()
    const approvals = coordinator(scripted)
    const running = approvals.approve('/a', INPUT)
    const releasing = approvals.release(['/a'])
    await approvals.recover('/a')
    expect((await refusal(approvals.approve('/a', INPUT))).message).toBe('This project is closing; approve the card after it reopens.')
    scripted.release()
    await releasing
    expect((await running).lane).toBe('done')
    await approvals.dispose()
    await approvals.recover('/b')
    expect(scripted.calls).toEqual(['prepareLearningApproval'])
  })
})
