/** DM-956: the `dm:approveLearningCard` channel forwards only folder and input, and answers a `CommandResult`. */
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { KanbanCardView } from '../../shared/domain/kanban'
import { createLearningApprovalHandlers, registerLearningApprovalIpc } from './learningApprovalIpc'

type Listener = (event: unknown, ...args: unknown[]) => unknown

function registered(approve: (folder: unknown, input: unknown) => Promise<KanbanCardView>): Map<string, Listener> {
  const channels = new Map<string, Listener>()
  registerLearningApprovalIpc({ handle: (channel, listener) => void channels.set(channel, listener as Listener) }, createLearningApprovalHandlers({ approve }))
  return channels
}

const input = { cardId: 'kc_x', attemptId: 'ka_x', draftsHash: `sha256:${'a'.repeat(64)}` }

describe('dm:approveLearningCard', () => {
  it('passes exactly the folder and the reviewed input, and returns the Done card', async () => {
    const seen: unknown[][] = []
    const card = { id: 'kc_x', lane: 'done' } as KanbanCardView
    const channels = registered(async (...args) => (seen.push(args), card))
    expect([...channels.keys()]).toEqual(['dm:approveLearningCard'])
    expect(await channels.get('dm:approveLearningCard')?.({ sender: 'renderer' }, '/repo', input, 'ignored')).toEqual({ ok: true, data: card })
    expect(seen).toEqual([['/repo', input]])
  })

  it('answers a refusal as a structured domain error', async () => {
    const channels = registered(async () => {
      throw new DomainError('conflict', 'The guardrails conflict.', { integrationId: 'li_x' })
    })
    expect(await channels.get('dm:approveLearningCard')?.({}, '/repo', input)).toEqual({
      ok: false,
      error: { code: 'conflict', message: 'The guardrails conflict.', details: { integrationId: 'li_x' } }
    })
  })
})
