import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AGENT_MAIL_LIMITS, getBinding, getEndpoint, provisionEndpoint } from '../../core/services/agentMailStore'
import { createHarness } from '../../test/workspaceHarness'
import { createChatStore } from '../agents/chatStore'
import { testWorkspace } from './__mocks__/projectWorkspaceFixture'

const fixtures: ReturnType<typeof createHarness>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function fixture() {
  const h = createHarness()
  fixtures.push(h)
  const store = createChatStore({ root: join(h.homeDir, 'chats') })
  const workspace = testWorkspace(h.open('desktop'), h.homeDir)
  await workspace.initializeRepository({ name: 'Mailbox project' })
  return { workspace, ctx: workspace.ctx(), store }
}

it('retires a later-page orphan without touching the same chat identity on another machine', async () => {
  const { workspace, ctx } = await fixture()
  const chats = Array.from({ length: AGENT_MAIL_LIMITS.endpointPageSize + 1 }, (_, index) => ({
    id: 'chat-sweep-' + index, agent: 'omp' as const, title: 'Mailbox ' + index
  }))
  const orphan = chats.at(-1)!
  const { endpoints } = await workspace.call('provisionMailboxes', [], chats)
  const local = endpoints.get(orphan.id)!
  const foreign = provisionEndpoint(ctx, { machineId: 'foreign-machine', chatId: orphan.id, name: 'Remote mailbox' })
  await workspace.call('deleteOrphanMailboxes', [orphan.id])
  expect(getEndpoint(ctx, local)?.state).toBe('deleted')
  expect(getEndpoint(ctx, foreign.id)?.state).toBe('open')
  expect(getEndpoint(ctx, endpoints.get(chats[0]!.id)!)?.state).toBe('open')
  expect(await workspace.call('listMailboxRoutes', [chats[0]!.id, orphan.id])).toEqual([
    { chatId: chats[0]!.id, endpointId: endpoints.get(chats[0]!.id) }
  ])
})

it('does not serve a foreign or retired mailbox even when the chat ID still matches', async () => {
  const { workspace, ctx, store } = await fixture()
  const chat = store.createChat({ folder: workspace.repoRoot, agent: 'omp', model: null, role: 'worker', allowSave: false })
  const foreign = provisionEndpoint(ctx, { machineId: 'foreign-machine', chatId: chat.id, name: 'Remote mailbox' })
  const { endpoints } = await workspace.call('provisionMailboxes', [], [chat])
  const local = { ...chat, endpointId: endpoints.get(chat.id) }
  await expect(workspace.call('mailState', { ...chat, endpointId: foreign.id })).rejects.toMatchObject({ code: 'not_found' })
  await expect(workspace.call('mailState', local)).resolves.toMatchObject({ endpointId: local.endpointId })
  await workspace.call('deleteMailbox', chat)
  await expect(workspace.call('mailState', local)).rejects.toMatchObject({ code: 'not_found' })
})

it('revokes the durable grant even if its mailbox binding cannot be closed', async () => {
  const { workspace, ctx, store } = await fixture()
  const chat = store.createChat({ folder: workspace.repoRoot, agent: 'omp', model: null, role: 'worker', allowSave: false })
  const { grant } = await workspace.call('issueChatGrant', { role: 'worker', label: 'Lost terminal' })
  await workspace.call('bindMailbox', chat, grant.id)
  ctx.db.exec(`CREATE TRIGGER refuse_mailbox_close BEFORE UPDATE OF closed_at ON agent_mail_bindings
    BEGIN SELECT RAISE(ABORT, 'fixture mailbox write failure'); END;`)
  try {
    await expect(workspace.call('revokeChatGrant', grant.id, true)).resolves.toBe(true)
    await expect(workspace.call('verifyChatGrant', grant.id, '', null)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(getBinding(ctx, grant.id)?.closedAt).toBeNull()
  } finally {
    ctx.db.exec('DROP TRIGGER refuse_mailbox_close')
  }
  await expect(workspace.call('revokeChatGrant', grant.id, true)).resolves.toBe(false)
  expect(getBinding(ctx, grant.id)?.closedAt).not.toBeNull()
})
