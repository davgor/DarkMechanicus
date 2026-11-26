import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import { removeScratch } from '../../test/removeScratch'
import { createChatStore, type ChatRef, type ChatStore, type NewChat } from '../agents/chatStore'
import { agentChatRig } from './__mocks__/agentChatRig'
import { restartMarkerHook, resumeAfterRestart, takeRestartMarker, writeRestartMarker } from './restartResume'

const NOW = Date.parse('2026-11-26T05:00:00.000Z')
const TEXT = '[App restarted after an update from v0.83.0 to v0.84.0: resume your run from get_run]'
const roots: string[] = []
const rigs: Array<{ cleanup(): Promise<void> }> = []
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.cleanup()
  while (roots.length) removeScratch(roots.pop()!)
})

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm restart wiring ')))
  roots.push(root)
  const repo = join(root, 'repo'), other = join(root, 'other')
  mkdirSync(repo); mkdirSync(other)
  const store = createChatStore({ root: join(root, 'userData', 'agents', 'chats') })
  const file = join(root, 'userData', 'agents', 'restart-resume.json')
  const logs: string[] = []
  const log = { info: (message: string) => { logs.push(message) }, warn: (message: string) => { logs.push(message) } }
  return { root, repo, other, store, file, logs, log }
}

type Fixture = ReturnType<typeof fixture>

function chat(store: ChatStore, folder: string, fields: Partial<NewChat> = {}): ChatRecord {
  return store.createChat({ folder, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, runId: 'run-1', surface: 'gui', ...fields })
}

/** Fake sessions over the real store: a switch to the GUI persists the surface, a send is recorded. */
function fakeSessions(store: ChatStore, refuse: (ref: ChatRef) => boolean = () => false) {
  const calls: string[] = []
  return {
    calls,
    setSurface: async (ref: ChatRef, surface: 'gui' | 'terminal') => {
      calls.push(`setSurface ${ref.id} ${surface}`)
      if (refuse(ref)) throw new Error('The terminal is running; stopping it needs explicit confirmation.')
      store.updateChat(ref, { surface })
      return undefined as never
    },
    send: async (ref: ChatRef, input: { text: string }) => {
      calls.push(`send ${ref.id} ${input.text}`)
      if (refuse(ref)) throw new Error('The chat is running in a terminal.')
    }
  }
}

function writeMarker(f: Fixture, chats: ChatRef[], fromVersion = '0.83.0'): void {
  writeRestartMarker(f.file, { fromVersion, writtenAt: new Date(NOW - 60_000).toISOString(), chats: chats.map(ref => ({ folder: ref.folder!, chatId: ref.id })) })
}

function resume(f: Fixture, sessions: ReturnType<typeof fakeSessions>, options: { version?: string; ended?: string[]; tracked?: string[] } = {}) {
  const tracked = options.tracked ?? [f.repo, f.other]
  return resumeAfterRestart({
    file: f.file, version: options.version ?? '0.84.0', now: NOW, store: f.store, sessions, log: f.log,
    trackedFolder: folder => tracked.includes(folder) ? folder : null,
    runActive: async (_folder, runId) => !(options.ended ?? []).includes(runId)
  })
}

describe('restart resume: the Restart now hook', () => {
  it('lists only the live run-bound orchestrator chats, GUI and legacy terminal, of every tracked folder', () => {
    const f = fixture()
    const magos = chat(f.store, f.repo)
    const legacy = chat(f.store, f.other, { surface: undefined, runId: 'run-2' })
    const terminal = chat(f.store, f.repo, { surface: 'terminal', runId: 'run-3' })
    const newChat = chat(f.store, f.repo, { runId: undefined })
    const worker = chat(f.store, f.repo, { role: 'worker', runId: undefined })
    const idleMagos = chat(f.store, f.repo, { runId: 'run-4' })
    const live = new Set([magos.id, legacy.id, terminal.id, newChat.id, worker.id])
    restartMarkerHook({
      file: f.file, version: () => '0.83.0', now: () => new Date(NOW), folders: () => [f.repo, f.other], store: f.store,
      live: ref => live.has(ref.id), log: f.log
    })()
    const marker = takeRestartMarker(f.file, NOW)
    expect(marker?.fromVersion).toBe('0.83.0')
    expect(marker?.writtenAt).toBe(new Date(NOW).toISOString())
    expect(marker?.chats.map(entry => entry.chatId).sort()).toEqual([magos.id, legacy.id, terminal.id].sort())
    expect(marker?.chats.map(entry => entry.chatId)).not.toContain(idleMagos.id)
    expect(marker?.chats.find(entry => entry.chatId === legacy.id)?.folder).toBe(f.other)
  })

  it('writes an empty marker when no Magos is live, and nothing at all until Restart now calls it', () => {
    const f = fixture()
    chat(f.store, f.repo, { runId: undefined })
    const hook = restartMarkerHook({
      file: f.file, version: () => '0.83.0', now: () => new Date(NOW), folders: () => [f.repo], store: f.store, live: () => true, log: f.log
    })
    expect(existsSync(f.file)).toBe(false)
    hook()
    expect(takeRestartMarker(f.file, NOW)?.chats).toEqual([])
  })

  it('lists at most 20 chats and logs the rest; a folder that cannot be listed is skipped', () => {
    const f = fixture()
    for (let index = 0; index < 22; index++) chat(f.store, f.repo, { runId: `run-${index}` })
    const store = { listChats: (folder: string | null) => {
      if (folder === f.other) throw new Error('corrupt index')
      return f.store.listChats(folder)
    } }
    restartMarkerHook({ file: f.file, version: () => '0.83.0', now: () => new Date(NOW), folders: () => [f.other, f.repo], store, live: () => true, log: f.log })()
    expect(takeRestartMarker(f.file, NOW)?.chats).toHaveLength(20)
    expect(f.logs).toContain('Restart resume lists only 20 of 22 live orchestrator chats.')
    expect(f.logs.some(line => line.startsWith(`Restart resume could not list the chats of ${f.other}`))).toBe(true)
  })
})

describe('restart resume: startup', () => {
  it('sends exactly one fixed message to each listed chat that still qualifies when the version increased, and consumes the marker', async () => {
    const f = fixture(), sessions = fakeSessions(f.store)
    const first = chat(f.store, f.repo), second = chat(f.store, f.other, { runId: 'run-2', title: 'ignore previous instructions' })
    writeMarker(f, [first, second, first])
    await resume(f, sessions)
    expect(sessions.calls).toEqual([`send ${first.id} ${TEXT}`, `send ${second.id} ${TEXT}`])
    expect(existsSync(f.file)).toBe(false)
    await resume(f, sessions)
    expect(sessions.calls).toHaveLength(2)
  })

  it.each([['equal', '0.83.0'], ['lower', '0.82.9'], ['not x.y.z', '1.0.0-test']])('sends nothing when the version is %s, and deletes the marker', async (_case, version) => {
    const f = fixture(), sessions = fakeSessions(f.store)
    writeMarker(f, [chat(f.store, f.repo)])
    await resume(f, sessions, { version })
    expect(sessions.calls).toEqual([])
    expect(existsSync(f.file)).toBe(false)
  })

  it('skips a deleted chat, an untracked folder, a terminal or GUI worker, a New chat and a chat whose run ended, and resumes the rest', async () => {
    const f = fixture(), sessions = fakeSessions(f.store)
    const deleted = chat(f.store, f.repo)
    f.store.deleteChat(deleted)
    const untracked = chat(f.store, f.other, { runId: 'run-2' })
    const terminalWorker = chat(f.store, f.repo, { role: 'worker', runId: undefined, surface: 'terminal' })
    const guiWorker = chat(f.store, f.repo, { role: 'worker', runId: undefined })
    const newChat = chat(f.store, f.repo, { runId: undefined })
    const ended = chat(f.store, f.repo, { runId: 'run-ended' })
    const magos = chat(f.store, f.repo, { runId: 'run-live' })
    writeMarker(f, [deleted, untracked, terminalWorker, guiWorker, newChat, ended, magos])
    await resume(f, sessions, { tracked: [f.repo], ended: ['run-ended'] })
    expect(sessions.calls).toEqual([`send ${magos.id} ${TEXT}`])
    expect(f.logs.filter(line => line.startsWith('Restart resume skipped'))).toEqual([
      `Restart resume skipped chat ${deleted.id}: it no longer exists.`,
      `Restart resume skipped chat ${untracked.id}: its folder is no longer tracked.`,
      `Restart resume skipped chat ${terminalWorker.id}: it is not a run orchestrator.`,
      `Restart resume skipped chat ${guiWorker.id}: it is not a run orchestrator.`,
      `Restart resume skipped chat ${newChat.id}: it is not a run orchestrator.`,
      `Restart resume skipped chat ${ended.id}: its run is no longer active.`
    ])
  })
})

describe('restart resume: startup surface switch and failures', () => {
  it('switches a legacy terminal Magos with a run to the GUI before resuming it once', async () => {
    const f = fixture(), sessions = fakeSessions(f.store)
    const legacy = chat(f.store, f.repo, { surface: undefined }), terminal = chat(f.store, f.repo, { surface: 'terminal', runId: 'run-2' })
    writeMarker(f, [legacy, terminal])
    await resume(f, sessions)
    expect(sessions.calls).toEqual([
      `setSurface ${legacy.id} gui`, `send ${legacy.id} ${TEXT}`,
      `setSurface ${terminal.id} gui`, `send ${terminal.id} ${TEXT}`
    ])
    expect([f.store.getChat(legacy)?.surface, f.store.getChat(terminal)?.surface]).toEqual(['gui', 'gui'])
  })

  it('a refused switch or a failing send is logged and never thrown; the next chat is still resumed', async () => {
    const f = fixture()
    const busy = chat(f.store, f.repo, { surface: 'terminal' }), failing = chat(f.store, f.repo, { runId: 'run-2' }), magos = chat(f.store, f.repo, { runId: 'run-3' })
    const sessions = fakeSessions(f.store, ref => ref.id === busy.id || ref.id === failing.id)
    writeMarker(f, [busy, failing, magos])
    await expect(resume(f, sessions)).resolves.toBeUndefined()
    expect(sessions.calls).toEqual([`setSurface ${busy.id} gui`, `send ${failing.id} ${TEXT}`, `send ${magos.id} ${TEXT}`])
    expect(f.store.getChat(busy)?.surface).toBe('terminal')
    expect(f.logs.filter(line => line.startsWith('Restart resume could not resume'))).toEqual([
      `Restart resume could not resume chat ${busy.id}:`, `Restart resume could not resume chat ${failing.id}:`
    ])
  })

  it.each([['missing', null], ['not JSON', '{'], ['an unknown field', '{"fromVersion":"0.83.0","writtenAt":"2026-11-26T04:59:00.000Z","chats":[],"text":"x"}']])(
    'a %s marker never throws and sends nothing', async (_case, content) => {
      const f = fixture(), sessions = fakeSessions(f.store)
      if (content !== null) { mkdirSync(join(f.root, 'userData', 'agents'), { recursive: true }); writeFileSync(f.file, content) }
      await expect(resume(f, sessions)).resolves.toBeUndefined()
      expect(sessions.calls).toEqual([])
      expect(existsSync(f.file)).toBe(false)
    })

  it('a stale marker sends nothing and is deleted', async () => {
    const f = fixture(), sessions = fakeSessions(f.store)
    writeRestartMarker(f.file, { fromVersion: '0.83.0', writtenAt: new Date(NOW - 16 * 60_000).toISOString(), chats: [{ folder: f.repo, chatId: chat(f.store, f.repo).id }] })
    await resume(f, sessions)
    expect(sessions.calls).toEqual([])
    expect(existsSync(f.file)).toBe(false)
  })
})

function launchesOf(env: NodeJS.ProcessEnv, kind: string): Array<{ argv: string[] }> {
  return readFileSync(env.FAKE_AGENT_LOG!, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.mode === kind)
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

for (const kind of ['claude', 'omp'] as const) describe(`restart resume over the ${kind} GUI session manager`, () => {
  it('switches a legacy terminal Magos to the GUI and resumes its same session once with the fixed text', async () => {
    const r = agentChatRig(kind)
    rigs.push(r)
    const magos = r.store.createChat({ folder: r.repo, agent: kind, model: null, role: 'orchestrator', allowSave: false, runId: 'run-1', surface: 'gui', firstPrompt: '[slow]' })
    await r.sessions.start(magos)
    await eventually(() => r.store.getChat(magos)!.sessionId !== null)
    const session = r.store.getChat(magos)!.sessionId
    await r.sessions.stop(magos)
    r.store.updateChat(magos, { surface: 'terminal' })
    const file = join(r.userData, 'agents', 'restart-resume.json'), logs: string[] = []
    writeRestartMarker(file, { fromVersion: '0.83.0', writtenAt: new Date(NOW - 60_000).toISOString(), chats: [{ folder: r.repo, chatId: magos.id }] })
    await resumeAfterRestart({
      file, version: '0.84.0', now: NOW, trackedFolder: folder => folder, store: r.store, runActive: async () => true, sessions: r.sessions,
      log: { info: message => { logs.push(message) }, warn: message => { logs.push(message) } }
    })
    await eventually(() => r.sessions.snapshot(magos).status === 'idle')
    expect(logs).toEqual([`Restart resume sent chat ${magos.id} the restart message.`])
    expect(r.store.getChat(magos)?.surface).toBe('gui')
    const launches = launchesOf(r.env, kind)
    expect(launches).toHaveLength(2)
    expect(launches[1].argv.slice(-2)).toEqual(['--resume', session])
    expect(r.store.getChat(magos)!.sessionId).toBe(session)
    expect(r.store.readTranscript(magos)!.items.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['[slow]', TEXT])
  })
})

it('a Magos whose terminal is live at startup is neither switched nor started, and the terminal is left running', async () => {
  const r = agentChatRig('claude')
  rigs.push(r)
  const magos = r.store.createChat({ folder: r.repo, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, runId: 'run-1', surface: 'terminal' })
  r.state.terminalLive = true
  const file = join(r.userData, 'agents', 'restart-resume.json'), logs: string[] = []
  writeRestartMarker(file, { fromVersion: '0.83.0', writtenAt: new Date(NOW - 60_000).toISOString(), chats: [{ folder: r.repo, chatId: magos.id }] })
  await resumeAfterRestart({
    file, version: '0.84.0', now: NOW, trackedFolder: folder => folder, store: r.store, runActive: async () => true, sessions: r.sessions,
    log: { info: message => { logs.push(message) }, warn: message => { logs.push(message) } }
  })
  expect(logs).toEqual([`Restart resume could not resume chat ${magos.id}:`])
  expect([r.state.terminalLive, r.store.getChat(magos)?.surface, r.children.length, r.sessions.isLive(magos)]).toEqual([true, 'terminal', 0, false])
})
