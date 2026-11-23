import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createForge } from '../desktop/forgeManifest'
import { builtInAgent, connectedAgents } from './__mocks__/chatFixtures'
import { createChatMailboxes } from './chatMailboxes'
import { createChatRecords } from './chatRecords'
import { createChatStore, nodeChatStoreFs } from './chatStore'

let root: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-world-chats-')))
  createForge(root, 'example')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each(['valid', 'conflicted'] as const)('manages root Skitarii chats with a %s manifest without opening a root project database', async manifest => {
  if (manifest === 'conflicted') writeFileSync(join(root, 'forge-world.json'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> remote\n')
  const store = createChatStore({ root: join(root, 'private-chats'), fs: nodeChatStoreFs })
  const opened: string[] = []
  const removed: string[] = []
  const mailboxes = createChatMailboxes({
    store, ledger: { file: join(root, 'private-mailboxes.jsonl'), fs: nodeChatStoreFs }, log: () => {},
    workspaceFor: folder => { opened.push(folder); throw new Error('A Forge World has no project database') }
  })
  const records = createChatRecords({ store, mailboxes, agentFor: connectedAgents([builtInAgent('omp')]), removeScratch: async id => { removed.push(id) } })
  const chat = await records.createChat({ folder: root, agent: 'omp', role: 'worker', title: 'World task' })
  expect(await records.listChats(root)).toEqual([chat])
  await records.recoverFolder(root)
  await records.renameChat(chat, 'World work')
  await mailboxes.suspendFolder(root, [chat])
  await records.deleteChat(chat)
  expect(await records.listChats(root)).toEqual([])
  expect(opened).toEqual([])
  expect(removed).toEqual([chat.id])
  expect(existsSync(join(root, '.darkmechanicus'))).toBe(false)
})
