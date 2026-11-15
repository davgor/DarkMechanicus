import { expect, it } from 'vitest'
import { connectedAgents, memoryChatStore } from './__mocks__/chatFixtures'
import { createChatRecords } from './chatRecords'

it.each([{ runId: 'run' }, { transferEpicId: 'transfer' }, { cardId: 'card' }])('does not enable inferred naming for a system-bound first prompt: %j', (binding) => {
  const store = memoryChatStore()
  const records = createChatRecords({ store, agentFor: connectedAgents() })
  const firstPrompt = '  Investigate the refresh flow without changing this system identity.  '
  const chat = records.createChat({ folder: '/repo', agent: 'codex', role: 'orchestrator', firstPrompt, ...binding })
  expect(chat.titleStatus).not.toBe('pending')
  expect(store.getChat(chat)).toMatchObject({ firstPrompt, firstPromptDelivery: 'pending', ...binding })
})
