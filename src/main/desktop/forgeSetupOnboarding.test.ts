import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { refreshForgeSetupWorkflow, saveForgeSetupWorkflow } from '../../core/repo/forgeSetupStorage'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ForgeSetupDetection } from '../../shared/desktop/forgeSetup'
import { scratchDir } from '../../test/gitScratch'
import { createChatStore } from '../agents/chatStore'
import type { TerminalStart } from '../terminals/terminalSessions'
import { createForgeSetupOnboarding, type ForgeSetupMember } from './forgeSetupOnboarding'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

function configureWorkflow(member: string, repository: string, detection: ForgeSetupDetection) {
  const value = refreshForgeSetupWorkflow(member, repository, detection)
  return saveForgeSetupWorkflow(member, { expectedSha256: value.sha256, workflow: { state: 'configured',
    steps: [{ id: 'dependencies', title: 'Install agreed dependencies', kind: 'command', cwd: '.', program: 'npm', args: ['ci'] }] } })
}

function fixture() {
  const scratch = scratchDir('forge-onboarding-')
  cleanup.push(scratch.cleanup)
  const member = join(scratch.path, 'tickets', 'Web')
  const checkout = join(scratch.path, 'code')
  mkdirSync(join(member, '.darkmechanicus'), { recursive: true })
  mkdirSync(checkout)
  const repository = 'https://github.com/example/web.git'
  const file = join(scratch.path, 'onboarding.json')
  const store = createChatStore({ root: join(scratch.path, 'chats') })
  const state = { agent: null as 'omp' | null, checkout, mapped: true, launchReady: true }
  const target: ForgeSetupMember = {
    member, root: join(scratch.path, 'tickets'), repository, identity: 'stable-ticket-project',
    assertCurrent() { if (!state.mapped) throw new Error('World member changed.') }
  }
  const detection: ForgeSetupDetection = { detectorVersion: 1, status: 'detected',
    source: { repository, commit: 'a'.repeat(40) }, facts: [{ kind: 'node', value: '22', source: '.node-version' }] }
  const discover = vi.fn(async () => detection)
  const pushed: string[] = []
  const starts = vi.fn<(chat: ChatRecord, authorization: symbol) => Promise<TerminalStart>>()
  const reopen = () => createForgeSetupOnboarding({
    file, scratch: join(scratch.path, 'managed'),
    resolveMember: () => target, discover, preferred: () => state.agent,
    agent: id => id === 'omp' && state.agent !== null ? 'omp:/programs/omp' : null,
    resolveCheckout: () => {
      const root = state.checkout
      return { root, assertCurrent() { if (state.checkout !== root) throw new Error('Code mapping changed.') } }
    },
    getStandards: async () => undefined,
    getChat: ref => store.getChat(ref),
    findChat: (_folder, tag) => store.listChats(member).find(chat => JSON.stringify(chat.forgeSetup) === JSON.stringify(tag)),
    createChat: async request => store.createChat({ ...request, model: request.model ?? null, allowSave: request.allowSave ?? true, firstPromptDelivery: 'pending' }),
    start: starts, hasInput: () => false, running: () => false,
    announce: chat => { pushed.push(chat.id) },
    mutate: async (_world, action) => action(),
    sync: () => undefined
  })
  const api = reopen()
  starts.mockImplementation(async (chat, authorization) => {
    if (!state.launchReady) state.mapped = false
    await api.assertLaunch(chat, authorization)
    store.updateChat(chat, { firstPromptDelivery: 'submitted' })
    return { state: 'running', pid: 400 }
  })
  const configure = () => configureWorkflow(member, repository, detection)
  return { state, api, target, discover, starts, store, reopen, configure, pushed, checkout }
}

it('uses one durable onboarding chat and preserves the existing standards approval in its first prompt', async () => {
  const f = fixture()
  await f.api.imported(f.target.member)
  expect(await f.api.project(f.target.member)).toMatchObject({ state: 'needs-discovery', onboarding: { state: 'needs-attention', chatId: null } })
  expect(f.starts).not.toHaveBeenCalled()
  f.state.agent = 'omp'
  const status = await f.api.prepare(f.target.member)
  expect(status).toMatchObject({ state: 'opened', chatId: expect.any(String) })
  const [chat] = f.store.listChats(f.target.member)
  expect(chat).toMatchObject({ role: 'planner', allowSave: true, firstPrompt: expect.stringContaining('set_delivery_standards') })
  expect(chat!.firstPrompt).toContain('Apply these standards to all existing project work now')
  expect(chat!.firstPrompt).toContain('Do not run installers or setup steps')
  expect(await f.reopen().prepare(f.target.member)).toMatchObject({ chatId: status.chatId, state: 'opened' })
  expect(f.starts).toHaveBeenCalledTimes(1)
  expect(new Set(f.pushed)).toEqual(new Set([status.chatId]))
})

it('rechecks the explicitly configured agent after it reconnects, without substituting another provider', async () => {
  const f = fixture()
  await f.api.imported(f.target.member, 'omp')
  expect(await f.api.project(f.target.member)).toMatchObject({ onboarding: { state: 'needs-attention', chatId: null } })
  f.state.agent = 'omp'
  const opened = await f.api.prepare(f.target.member)
  expect(opened).toMatchObject({ state: 'opened', chatId: expect.any(String) })
  expect(f.store.getChat({ folder: f.target.member, id: opened.chatId! })?.agent).toBe('omp')
  expect(f.starts).toHaveBeenCalledTimes(1)
})

it('binds explicit setup to reviewed YAML, canonical code and a separately guarded conversation', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  const onboarding = await f.api.prepare(f.target.member)
  const workflow = f.configure()
  await expect(f.api.run(f.target.member, '0'.repeat(64), f.checkout)).rejects.toThrow('workflow changed')
  await expect(f.api.run(f.target.member, workflow.sha256, f.checkout + '-replacement')).rejects.toThrow('checkout changed')
  const setup = await f.api.run(f.target.member, workflow.sha256, f.checkout)
  expect(setup).toMatchObject({ chatId: onboarding.chatId, run: { state: 'submitted', workflowSha256: workflow.sha256, chatId: expect.any(String) } })
  expect(setup.run!.chatId).not.toBe(onboarding.chatId)
  const execution = f.store.getChat({ folder: f.target.member, id: setup.run!.chatId! })!
  expect(execution).toMatchObject({ role: 'planner', allowSave: false, firstPrompt: expect.stringContaining(workflow.sha256) })
  expect(() => f.reopen().assertLaunch(execution)).toThrow('explicit setup')
  expect(await f.reopen().run(f.target.member, workflow.sha256, f.checkout)).toEqual(setup)
  f.state.checkout += '-moved'
  await expect(f.reopen().run(f.target.member, workflow.sha256, f.state.checkout)).rejects.toThrow('receipt for this workflow belongs to another checkout')
  expect(f.starts).toHaveBeenCalledTimes(2)
})

it('does not dispatch a second uncertain setup prompt after a lost reply and restart', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  await f.api.prepare(f.target.member)
  const workflow = f.configure()
  f.starts.mockRejectedValueOnce(new Error('Lost startup response'))
  const result = await f.api.run(f.target.member, workflow.sha256, f.checkout)
  expect(result).toMatchObject({ run: { state: 'uncertain', chatId: expect.any(String) } })
  const chat = f.store.getChat({ folder: f.target.member, id: result.run!.chatId! })!
  expect(() => f.reopen().assertLaunch(chat)).toThrow('explicit setup')
  expect(await f.reopen().run(f.target.member, workflow.sha256, f.checkout)).toMatchObject({ run: { state: 'uncertain', chatId: chat.id } })
  const revised = saveForgeSetupWorkflow(f.target.member, { expectedSha256: workflow.sha256, workflow: workflow.value.workflow, notes: 'New revision' })
  expect(await f.reopen().run(f.target.member, revised.sha256, f.checkout)).toMatchObject({
    message: expect.stringContaining('earlier setup execution'), run: { state: 'uncertain', workflowSha256: workflow.sha256 }
  })
  expect(f.starts).toHaveBeenCalledTimes(2)
})

it('rejects a prior conversation after the same project identity is mapped to another repository', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  const status = await f.api.prepare(f.target.member)
  const chat = f.store.getChat({ folder: f.target.member, id: status.chatId! })!
  f.target.repository = 'https://github.com/example/replacement.git'
  await expect(f.reopen().prepare(f.target.member)).rejects.toThrow('code repository changed')
  expect(() => f.reopen().assertLaunch(chat)).toThrow('code repository changed')
  expect(f.starts).toHaveBeenCalledTimes(1)
})

it('refuses to start a prepared chat after its member changes during asynchronous authority work', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  f.state.launchReady = false
  const result = await f.api.prepare(f.target.member)
  expect(result).toMatchObject({ state: 'uncertain', chatId: expect.any(String) })
  const chat = f.store.getChat({ folder: f.target.member, id: result.chatId! })!
  expect(chat.firstPromptDelivery).toBe('pending')
  expect(f.starts).toHaveBeenCalledTimes(1)
  expect(() => f.reopen().assertLaunch(chat)).toThrow()
})
