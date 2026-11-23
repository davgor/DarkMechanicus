import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { refreshForgeSetupWorkflow, saveForgeSetupWorkflow } from '../../core/repo/forgeSetupStorage'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ForgeSetupDetection } from '../../shared/desktop/forgeSetup'
import { scratchDir } from '../../test/gitScratch'
import { createChatStore } from '../agents/chatStore'
import type { TerminalStart } from '../terminals/terminalSessions'
import { ForgeSetupJournal } from './forgeSetupJournal'
import { createForgeSetupOnboarding, type ForgeSetupMember, type ForgeSetupOnboardingOptions } from './forgeSetupOnboarding'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

function configureWorkflow(member: string, repository: string, detection: ForgeSetupDetection) {
  const value = refreshForgeSetupWorkflow(member, repository, detection)
  return saveForgeSetupWorkflow(member, { expectedSha256: value.sha256, workflow: { state: 'configured',
    steps: [{ id: 'dependencies', title: 'Install agreed dependencies', kind: 'command', cwd: '.', program: 'npm', args: ['ci'] }] } })
}

function chatStorage(store: ReturnType<typeof createChatStore>) {
  const create = (request: Parameters<ForgeSetupOnboardingOptions['createChat']>[0]) =>
    store.createChat({ ...request, model: request.model ?? null, allowSave: request.allowSave ?? true, firstPromptDelivery: 'pending' })
  const createChat = vi.fn<ForgeSetupOnboardingOptions['createChat']>(async request => create(request))
  const runningChats = new Set<string>()
  const inputReceipts = new Map<string, string>()
  const deps: Pick<ForgeSetupOnboardingOptions, 'getChat' | 'findChat' | 'createChat' | 'running' | 'hasInput'> = {
    getChat: ref => store.getChat(ref),
    findChat: (folder, tag) => store.listChats(folder).find(chat =>
      chat.forgeSetup?.intentId === tag.intentId && chat.forgeSetup.stepId === tag.stepId && chat.forgeSetup.mode === tag.mode),
    createChat,
    running: id => runningChats.has(id),
    hasInput: (chat, text) => inputReceipts.get(chat.id) === text
  }
  return { deps, create, createChat, runningChats, inputReceipts }
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
  const chatRoot = join(scratch.path, 'chats')
  const store = createChatStore({ root: chatRoot })
  const state = { agent: null as 'omp' | null, checkout, mapped: true, launchReady: true, signature: 'omp:/programs/omp' }
  const target: ForgeSetupMember = {
    member, root: join(scratch.path, 'tickets'), repository, identity: 'stable-ticket-project',
    assertCurrent() { if (!state.mapped) throw new Error('World member changed.') }
  }
  const detection: ForgeSetupDetection = { detectorVersion: 1, status: 'detected',
    source: { repository, commit: 'a'.repeat(40) }, facts: [{ kind: 'node', value: '22', source: '.node-version' }] }
  const discover = vi.fn(async () => detection)
  const pushed: string[] = []
  const chat = chatStorage(store)
  const starts = vi.fn<(chat: ChatRecord, authorization: symbol) => Promise<TerminalStart>>()
  const reopen = () => createForgeSetupOnboarding({
    file, scratch: join(scratch.path, 'managed'),
    resolveMember: () => target, discover, preferred: () => state.agent,
    agent: id => id === 'omp' && state.agent !== null ? state.signature : null,
    resolveCheckout: () => {
      const root = state.checkout
      return { root, assertCurrent() { if (state.checkout !== root) throw new Error('Code mapping changed.') } }
    },
    getStandards: async () => undefined,
    ...chat.deps, start: starts,
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
  const persistedChats = () => createChatStore({ root: chatRoot }).listChats(member)
  return { state, api, target, discover, starts, store, reopen, configure, pushed, checkout, file, chat, persistedChats }
}

it('uses one durable onboarding chat and preserves the existing standards approval in its first prompt', async () => {
  const f = fixture()
  await f.api.imported(f.target.member)
  expect(await f.api.project(f.target.member)).toMatchObject({ state: 'needs-discovery', onboarding: { state: 'needs-attention', chatId: null } })
  expect(f.persistedChats()).toEqual([])
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
  expect(f.persistedChats()).toMatchObject([{ id: opened.chatId, agent: 'omp', firstPromptDelivery: 'submitted' }])
  expect(new ForgeSetupJournal(f.file).get(f.target.identity)?.onboarding).toMatchObject({
    agent: 'omp', agentSignature: f.state.signature, chatId: opened.chatId, delivery: 'submitted'
  })
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
  const receipt = readFileSync(f.file, 'utf8')
  f.target.repository = 'https://github.com/example/replacement.git'
  await expect(f.reopen().prepare(f.target.member)).rejects.toThrow('code repository changed')
  expect(() => f.reopen().assertLaunch(chat)).toThrow('code repository changed')
  expect(readFileSync(f.file, 'utf8')).toBe(receipt)
})

it('reads without discovery, saves by revision, and preserves authored steps when refreshed prerequisites become stale', async () => {
  const f = fixture()
  const initial = f.configure()
  expect(await f.api.project(f.target.member)).toMatchObject({
    state: 'configured',
    value: { sha256: initial.sha256, value: {
      repository: initial.value.repository, revision: initial.value.revision, workflow: initial.value.workflow
    } }
  })
  const { state, steps } = initial.value.workflow
  const updated = { workflow: { state, steps }, notes: 'Retain this setup decision.' }
  await expect(f.api.saveWorkflow(f.target.member, { ...updated, expectedSha256: '0'.repeat(64) })).rejects.toThrow('changed')
  const saved = await f.api.saveWorkflow(f.target.member, { ...updated, expectedSha256: initial.sha256 })
  expect(saved.value?.sha256).not.toEqual(initial.sha256)
  f.discover.mockResolvedValue({
    detectorVersion: 1, status: 'detected', source: { repository: f.target.repository, commit: '2'.repeat(40) },
    facts: [{ kind: 'node', value: '24', source: '.node-version' }]
  })
  const refreshed = await f.api.refresh(f.target.member)
  expect(refreshed).toMatchObject({ state: 'stale', value: { value: {
    notes: updated.notes, workflow: initial.value.workflow, detection: { facts: [{ kind: 'node', value: '24' }] }
  } } })
  expect(f.discover).toHaveBeenCalledExactlyOnceWith(f.target.repository)
  await expect(f.api.run(f.target.member, refreshed.value!.sha256, f.checkout)).rejects.toThrow('Configure the workflow against the current detected facts')
  expect(f.persistedChats()).toEqual([])
})

it('refuses to start a prepared chat after its member changes during asynchronous authority work', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  f.state.launchReady = false
  const result = await f.api.prepare(f.target.member)
  expect(result).toMatchObject({ state: 'uncertain', chatId: expect.any(String) })
  const chat = f.store.getChat({ folder: f.target.member, id: result.chatId! })!
  expect(chat.firstPromptDelivery).toBe('pending')
  expect(new ForgeSetupJournal(f.file).get(f.target.identity)?.onboarding).toMatchObject({ chatId: chat.id, delivery: 'attempted' })
  expect(() => f.reopen().assertLaunch(chat)).toThrow()
})

it('recovers the chat already stored when its first-create response was lost', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  f.chat.createChat.mockImplementationOnce(async request => {
    f.chat.create(request)
    throw new Error('Mailbox confirmation was interrupted')
  })
  expect(await f.api.prepare(f.target.member)).toMatchObject({ state: 'needs-attention', message: 'Mailbox confirmation was interrupted' })
  const [original] = f.persistedChats()
  expect(original?.firstPromptDelivery).toBe('pending')
  const fresh = f.reopen()
  f.starts.mockImplementationOnce(async (chat, authorization) => {
    fresh.assertLaunch(chat, authorization)
    f.store.updateChat(chat, { firstPromptDelivery: 'submitted' })
    return { state: 'running', pid: 400 }
  })
  expect(await fresh.prepare(f.target.member)).toMatchObject({ state: 'opened', chatId: original!.id })
  expect(f.persistedChats()).toMatchObject([{ id: original!.id, firstPromptDelivery: 'submitted' }])
})

it('reports an unconfirmed live launch and later recognizes the exact input receipt without another startup', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  f.starts.mockImplementationOnce(async (chat, authorization) => {
    f.api.assertLaunch(chat, authorization)
    f.chat.runningChats.add(chat.id)
    return { state: 'running', pid: 400 }
  })
  const pending = await f.api.prepare(f.target.member)
  expect(pending).toMatchObject({ state: 'preparing', chatId: expect.any(String) })
  const chat = f.store.getChat({ folder: f.target.member, id: pending.chatId! })!
  f.chat.runningChats.clear()
  expect(await f.reopen().prepare(f.target.member)).toMatchObject({ state: 'uncertain', chatId: chat.id })
  f.chat.inputReceipts.set(chat.id, 'some unrelated input')
  expect(await f.reopen().prepare(f.target.member)).toMatchObject({ state: 'uncertain' })
  f.chat.inputReceipts.set(chat.id, chat.firstPrompt!)
  const fresh = f.reopen()
  expect(await fresh.prepare(f.target.member)).toMatchObject({ state: 'opened', chatId: chat.id })
  expect(fresh.assertLaunch(chat)).toContain('managed')
  expect(f.starts).toHaveBeenCalledTimes(1)
})

it('retains known sign-out and retries only the original explicitly selected conversation', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  f.starts.mockResolvedValueOnce({ state: 'signed_out', message: 'Sign in to the configured host' })
  const refused = await f.api.prepare(f.target.member, 'omp')
  expect(refused).toMatchObject({ state: 'needs-attention', message: 'Sign in to the configured host', chatId: expect.any(String) })
  const chat = f.store.getChat({ folder: f.target.member, id: refused.chatId! })!
  expect(() => f.api.assertLaunch(chat)).toThrow('prompt was not replayed')
  expect(await f.api.prepare(f.target.member)).toMatchObject({ state: 'opened', chatId: refused.chatId })
  expect(f.persistedChats()).toMatchObject([{ id: chat.id, firstPromptDelivery: 'submitted' }])
  expect(f.starts).toHaveBeenCalledTimes(2)
  f.state.signature = 'omp:/other-programs/omp'
  expect(() => f.api.assertLaunch(chat)).toThrow('configured agent or conversation authority changed')
})

it('refuses setup when onboarding has not opened and leaves corrupted local proof unchanged', async () => {
  const f = fixture()
  const yaml = f.configure()
  expect(await f.api.run(f.target.member, yaml.sha256, f.checkout)).toMatchObject({
    state: 'needs-attention', run: null, message: expect.stringContaining('Finish opening')
  })
  const journal = JSON.parse(readFileSync(f.file, 'utf8'))
  journal.records.push(journal.records[0])
  const duplicate = JSON.stringify(journal)
  writeFileSync(f.file, duplicate)
  await expect(f.reopen().prepare(f.target.member)).rejects.toThrow('setup journal cannot be read')
  expect(readFileSync(f.file, 'utf8')).toBe(duplicate)
  expect(f.persistedChats()).toEqual([])
})

it('admits only the recorded setup chat for the current ticket project', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  const prepared = await f.api.prepare(f.target.member)
  const original = f.store.getChat({ folder: f.target.member, id: prepared.chatId! })!
  expect(f.api.assertLaunch(original)).toContain('managed')

  const request = { folder: f.target.member, agent: 'omp' as const, role: 'planner' as const, allowSave: true }
  const ordinary = f.chat.create(request)
  expect(() => f.api.assertLaunch(ordinary)).toThrow('launch authority is unavailable')
  const copied = f.chat.create({ ...request, forgeSetup: original.forgeSetup })
  expect(() => f.api.assertLaunch(copied)).toThrow('conversation changed')

  f.target.identity = 'replacement-ticket-project'
  expect(() => f.api.assertLaunch(original)).toThrow('no longer belongs to this ticket project')
  expect(f.starts).toHaveBeenCalledTimes(1)
})

it('shares an in-flight onboarding request and keeps setup closed until the prompt is delivered', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  const yaml = f.configure()
  const entered = deferred<ChatRecord>()
  const release = deferred<void>()
  f.starts.mockImplementationOnce(async (chat, authorization) => {
    entered.resolve(chat)
    await release.promise
    f.api.assertLaunch(chat, authorization)
    f.store.updateChat(chat, { firstPromptDelivery: 'submitted' })
    return { state: 'running', pid: 400 }
  })
  const first = f.api.prepare(f.target.member)
  const current = await Promise.race([entered.promise, first.then(() => { throw new Error('Onboarding did not reach terminal admission.') })])
  const joined = f.api.prepare(f.target.member)
  try {
    expect(await f.api.run(f.target.member, yaml.sha256, f.checkout)).toMatchObject({
      state: 'preparing', chatId: current.id, run: null, message: expect.stringContaining('Wait for the existing Forge setup request')
    })
  } finally {
    release.resolve()
    await Promise.all([first, joined])
  }
  expect(await first).toMatchObject({ state: 'opened', chatId: current.id })
  expect(await joined).toEqual(await first)
  expect(f.starts).toHaveBeenCalledTimes(1)
  expect(f.persistedChats().map(chat => chat.id)).toEqual([current.id])
})

it('keeps a live setup execution visible and blocks a newer workflow until it stops', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  const authoring = await f.api.prepare(f.target.member)
  const workflow = f.configure()
  f.starts.mockImplementationOnce(async (chat, authorization) => {
    expect(f.api.assertLaunch(chat, authorization)).toBe(f.checkout)
    f.chat.runningChats.add(chat.id)
    return { state: 'running', pid: 400 }
  })
  const started = await f.api.run(f.target.member, workflow.sha256, f.checkout)
  expect(started).toMatchObject({ run: { state: 'pending', chatId: expect.any(String), workflowSha256: workflow.sha256 } })

  const revised = saveForgeSetupWorkflow(f.target.member, {
    expectedSha256: workflow.sha256, workflow: workflow.value.workflow, notes: 'Reviewed a new revision.'
  })
  expect(revised.sha256).not.toBe(workflow.sha256)
  const result = await f.reopen().run(f.target.member, revised.sha256, f.checkout)
  expect(result).toMatchObject({ run: started.run, message: expect.stringContaining('earlier setup execution is still active') })
  expect(f.starts).toHaveBeenCalledTimes(2)
  expect(f.persistedChats().map(chat => chat.id).sort()).toEqual([authoring.chatId!, started.run!.chatId!].sort())
})

it('keeps the original onboarding receipt and refuses to replace an archived conversation', async () => {
  const f = fixture()
  f.state.agent = 'omp'
  f.starts.mockResolvedValueOnce({ state: 'refused', message: 'Agent permission was declined.' })
  const original = await f.api.prepare(f.target.member)
  expect(original).toMatchObject({ state: 'needs-attention', chatId: expect.any(String) })
  const ref = { folder: f.target.member, id: original.chatId! }
  f.store.updateChat(ref, { archived: true })
  expect(await f.reopen().prepare(f.target.member)).toMatchObject({
    state: 'needs-attention', chatId: original.chatId, message: expect.stringContaining('original conversation is unavailable')
  })
  expect(f.persistedChats()).toMatchObject([{ id: original.chatId, archived: true }])
  expect(f.starts).toHaveBeenCalledTimes(1)
})
