/**
 * `terminals:attach`: the one call that starts a chat's CLI. It goes through the sender guard, is a strict
 * `{ folder, chatId }`, checks the folder (tracked, not swapped) before any chat is looked up and that it is the
 * chat's own, and leaves everything else to the session manager: nothing is started and no grant is issued for a
 * refused attach, and for an accepted one the spawn is the one main builds from its own records.
 */
import { mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import { TERMINAL_ATTACH_CHANNEL, TERMINAL_PORT_CHANNEL, TERMINAL_SIGN_IN_CHANNEL } from '../../shared/agents/terminalApi'
import type { AgentView } from '../../shared/desktop/api'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { claudeSettingsPaths } from './claudeSettingsFile'
import type { PtySpawnSpec } from './ptyHost'
import { attachRunning, handlersRig, PAGE, type HandlersRig } from './__mocks__/terminalHandlersRig'
import { FakeFrame } from './__mocks__/terminalPorts'
import { cliFor, CUSTOM_AGENT, eventually, settle } from './__mocks__/terminalSessionsRig'
import { terminalFilePaths } from './terminalFiles'
import { terminalLaunchSpec } from './terminalLaunchSpec'

const REFUSED_SENDER = {
  ok: false,
  error: { code: 'unauthorized', message: 'Refused an IPC call that did not come from the Dark Mechanicus window.' }
}

let h: HandlersRig

beforeEach(() => {
  h = handlersRig()
})

afterEach(() => {
  h.cleanup()
})

/** Nothing was started for the chat: no sign-in check, no grant, no spawn, and no port went to any frame. */
function expectNothingStarted(...frames: FakeFrame[]): void {
  expect(h.rig.steps).toEqual([])
  expect(h.rig.host.spawns).toEqual([])
  for (const frame of [h.frame, ...frames]) {
    expect(frame.posted).toEqual([])
  }
}

/** Every listener the handlers attached has been detached again. */
function expectNoListenerLeft(): void {
  expect(h.detached).toEqual(h.attached)
}

describe('terminals:attach: the sender', () => {
  it('is registered with the sign-in terminal as the terminals channels, through the sender guard', () => {
    expect(h.ipc.channels()).toEqual([TERMINAL_SIGN_IN_CHANNEL, TERMINAL_ATTACH_CHANNEL].sort())
  })

  it('refuses a sender other than the app page in the top-level frame, and runs nothing for it', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const foreign = new FakeFrame('https://evil.example/')
    const subframe = new FakeFrame(PAGE, new FakeFrame(PAGE))
    const detachedFrame = new FakeFrame(PAGE, null, true)
    const payload = { folder: h.rig.repo, chatId: chat.id }

    const answers = [await h.attach(payload, foreign), await h.attach(payload, subframe), await h.attach(payload, detachedFrame), await h.attach(payload, null)]

    expect(answers).toEqual([REFUSED_SENDER, REFUSED_SENDER, REFUSED_SENDER, REFUSED_SENDER])
    expectNothingStarted(foreign, subframe, detachedFrame)
    expect(h.attached).toEqual([])
  })

  it('refuses an attach that names no frame to post a port to, even past the guard', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)

    const answer = await h.handlers.attach(null, { folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({ ok: false, error: { code: 'unauthorized', message: 'Refused a terminal attach that came from no window.' } })
    expectNothingStarted()
  })
})

describe('terminals:attach: the payload', () => {
  it('refuses any key besides folder and chatId, so no payload names a program, arguments, a folder to run in or an environment', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const ref = { folder: h.rig.repo, chatId: chat.id }
    const payloads = [
      { ...ref, file: '/bin/sh' },
      { ...ref, executable: '/bin/sh' },
      { ...ref, args: ['-c', 'touch /tmp/owned'] },
      { ...ref, cwd: '/' },
      { ...ref, env: { NODE_OPTIONS: '--require /tmp/owned.js' } },
      { ...ref, cols: 80, rows: 24 },
      { ...ref, agent: 'codex' }
    ]

    const answers = await Promise.all(payloads.map((payload) => h.attach(payload)))

    expect(answers.map((answer) => (answer.ok ? 'accepted' : answer.error.code))).toEqual(payloads.map(() => 'invalid_input'))
    expectNothingStarted()
    expect(h.attached).toEqual([])
  })

  it('refuses a payload that is not a folder and a chat id', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const payloads = [
      undefined,
      null,
      h.rig.repo,
      [h.rig.repo, chat.id],
      { folder: h.rig.repo },
      { chatId: chat.id },
      { folder: '', chatId: chat.id },
      { folder: h.rig.repo, chatId: '../other/chat' },
      { folder: h.rig.repo, chatId: 7 },
      { folder: 'x'.repeat(32_768), chatId: chat.id },
      { folder: h.rig.repo, chatId: chat.id, newSession: false },
      { folder: h.rig.repo, chatId: chat.id, newSession: 'yes' }
    ]

    const answers = await Promise.all(payloads.map((payload) => h.attach(payload)))

    expect(answers.map((answer) => (answer.ok ? 'accepted' : answer.error.code))).toEqual(payloads.map(() => 'invalid_input'))
    expectNothingStarted()
  })
})

describe('terminals:attach: the chat, before a grant is issued', () => {
  it('refuses a chat that is not in the folder', async () => {
    const answer = await h.attach({ folder: h.rig.repo, chatId: 'ch_missing' })

    expect(answer).toEqual({ ok: false, error: { code: 'not_found', message: `No chat ch_missing in ${h.rig.repo}.` } })
    expectNothingStarted()
  })

  it("refuses another tracked folder's chat, named under this folder", async () => {
    const other = join(h.rig.root, 'other')
    mkdirSync(other)
    h.rig.tracked.add(other)
    const chat = h.rig.newChat(CUSTOM_AGENT.id)

    const answer = await h.attach({ folder: other, chatId: chat.id })

    expect(answer).toEqual({ ok: false, error: { code: 'not_found', message: `No chat ${chat.id} in ${other}.` } })
    expectNothingStarted()
  })

  it('refuses a chat whose own record names another folder than the one asked for', async () => {
    h.cleanup()
    const other = '/repos/elsewhere'
    h = handlersRig({ store: (store) => ({ getChat: (ref) => { const chat = store.getChat(ref); return chat === null ? null : { ...chat, folder: other } } }) })
    const chat = h.rig.newChat(CUSTOM_AGENT.id)

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({
      ok: false,
      error: { code: 'not_found', message: `The chat ${chat.id} belongs to ${other}, not to ${h.rig.repo}.` }
    })
    expectNothingStarted()
  })

})

describe('terminals:attach: the folder, before a grant is issued', () => {
  it('refuses a folder that is not tracked', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    h.rig.tracked.delete(h.rig.repo)

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: `The folder ${h.rig.repo} is not tracked by Dark Mechanicus. Track the folder again to keep using this chat.` }
    })
    expectNothingStarted()
  })

  it('refuses a folder replaced by a symlink to another directory, before the chat is looked up', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const elsewhere = join(h.rig.root, 'elsewhere')
    mkdirSync(elsewhere)
    // Still tracked under its old path, which now leads somewhere else.
    rmSync(h.rig.repo, { recursive: true })
    symlinkSync(elsewhere, h.rig.repo)

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'not_found',
        message: `The folder ${h.rig.repo} now leads to ${elsewhere}, not to the folder this chat was created in. Track the folder again to keep using this chat.`
      }
    })
    expectNothingStarted()
    expect(h.attached).toEqual([])
  })

  it('answers refused for a chat whose folder was moved, with the launch check message', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    // Still tracked under the path it had: the registry answers for a folder that is gone.
    renameSync(h.rig.repo, join(h.rig.root, 'moved'))

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({
      ok: true,
      data: { state: 'refused', message: `The folder ${h.rig.repo} is gone: it was moved or deleted. Track the folder again to keep using this chat.` }
    })
    expectNothingStarted()
    expectNoListenerLeft()
  })

})

describe('terminals:attach: the agent, before a grant is issued', () => {
  it('answers refused for a chat whose agent is not connected', async () => {
    const chat = h.rig.newChat('codex')

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({ ok: true, data: { state: 'refused', message: 'No connected agent has the id codex. Connect it under Agents first.' } })
    expectNothingStarted()
    expectNoListenerLeft()
  })

  it('waits out the sign-in check and answers signed_out for a built-in whose CLI is signed out, posting no port', async () => {
    const held = h.rig.holdAuth()
    const chat = h.rig.newChat('claude')
    const payload = { folder: h.rig.repo, chatId: chat.id }

    const answers = Promise.all([h.attach(payload), h.attach(payload)])
    await eventually(() => h.rig.steps.includes('auth'), 'the sign-in check')
    held.open({ state: 'signed_out', reason: 'Claude Code is not signed in.' })

    const signedOut = { ok: true, data: { state: 'signed_out', message: 'Claude Code is not signed in.' } }
    expect(await answers).toEqual([signedOut, signedOut])
    expect(h.rig.steps).toEqual(['auth'])
    expect([h.rig.host.spawns, h.frame.posted]).toEqual([[], []])
    expectNoListenerLeft()
  })

  it('answers failed for an attach waiting on a sign-in check when the chat is deleted meanwhile', async () => {
    h.rig.holdAuth()
    const chat = h.rig.newChat('claude')

    const answer = h.attach({ folder: h.rig.repo, chatId: chat.id })
    await eventually(() => h.rig.steps.includes('auth'), 'the sign-in check')
    await h.rig.sessions.deleteChat(chat, async () => {})

    expect(await answer).toEqual({ ok: true, data: { state: 'failed', message: 'The chat was deleted, so its terminal was stopped.' } })
    expect([h.rig.steps, h.frame.posted]).toEqual([['auth'], []])
    expectNoListenerLeft()
  })
})

/** The spawn main builds for `chat` from its own records: the chat, its agent's row, the tracked folder, the grant, and for Claude its settings file. */
function specFromRecords(chat: ChatRecord, agent: AgentView, grantId: string): PtySpawnSpec {
  const { rig } = h
  const launch = cliFor(rig.repo)
  const files = terminalFilePaths(rig.userData, chat.id, 'darwin')
  const spec = terminalLaunchSpec({
    chat: { ...chat, sessionStarted: false, kickoffSent: false },
    kickoff: null,
    agent,
    folder: rig.repo,
    cli: { ...launch, env: { ...launch.env, DM_SESSION_TOKEN: `token-${grantId}` } },
    files: agent.kind === 'claude' ? { ...files, claudeSettings: claudeSettingsPaths(rig.userData, chat.id, 'darwin').settings } : files,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: rig.root },
    newSessionId: () => '00000000-0000-4000-8000-000000000001'
  })
  return { file: spec.file, args: spec.commandLine ?? spec.args, cwd: spec.cwd, env: spec.env, cols: 80, rows: 24 }
}

describe('terminals:attach: what an accepted attach starts', () => {
  it('spawns, for every accepted spelling of the folder, exactly what main builds from its own records', async () => {
    const alias = join(h.rig.root, 'alias')
    symlinkSync(h.rig.repo, alias)
    const claudeChat = h.rig.newChat('claude')
    const customChat = h.rig.newChat(CUSTOM_AGENT.id)

    // A symlink to the tracked folder and a trailing slash resolve to it; neither reaches the spawn.
    const claude = await attachRunning(h, { ...claudeChat, folder: alias })
    const custom = await attachRunning(h, { ...customChat, folder: `${h.rig.repo}/` })

    expect([claude.answer.state, custom.answer.state]).toEqual(['running', 'running'])
    expect(h.rig.host.spawns.map((pty) => pty.spec)).toEqual([
      specFromRecords(claudeChat, builtInAgent('claude'), 'gr_1'),
      specFromRecords(customChat, CUSTOM_AGENT, 'gr_2')
    ])
    expect(h.rig.host.spawns.map((pty) => pty.spec.cwd)).toEqual([h.rig.repo, h.rig.repo])
  })

  it('lets no port message start, change or add a process: input and sizes only, and the next start is again from the records', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const { port } = await attachRunning(h, chat)
    const pty = h.rig.host.last()

    for (const message of [
      { type: 'spawn', file: '/bin/sh', args: ['-c', 'id'] },
      { type: 'input', data: 'ls\r', file: '/bin/sh' },
      { type: 'input', data: 'ls\r', cwd: '/' },
      { type: 'resize', cols: 100, rows: 30, env: { PATH: '/tmp' } },
      { type: 'env', env: { NODE_OPTIONS: '--inspect' } },
      { type: 'cwd', cwd: '/' },
      { type: 'input', data: 'hello\r' },
      { type: 'resize', cols: 100, rows: 30 }
    ]) {
      port.postMessage(message)
    }
    await eventually(() => pty.sizes.length > 0, 'the resize to arrive')
    pty.exit()
    await settle()
    await attachRunning(h, chat)

    expect([pty.written, pty.sizes]).toEqual([['hello\r'], [[100, 30]]])
    expect(h.rig.host.spawns.map((spawned) => spawned.spec)).toEqual([specFromRecords(chat, CUSTOM_AGENT, 'gr_1'), specFromRecords(chat, CUSTOM_AGENT, 'gr_2')])
  })
})

describe('terminals:attach: the answer and the port', () => {
  it('answers running with the snapshot and posts one port to the attaching frame, named in the answer', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({ ok: true, data: { state: 'running', snapshot: expect.any(String), port: 'port-1' } })
    expect(h.frame.posted).toEqual([{ channel: TERMINAL_PORT_CHANNEL, message: { port: 'port-1' }, transfer: [h.ports.pairs[0]?.remote] }])
  })

  it('answers failed and detaches when the frame is gone before its port can be posted', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const disposed = new Error('Render frame was disposed before WebFrameMain could be accessed')
    h.frame.failNextPost = disposed

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({ ok: true, data: { state: 'failed', message: 'The window closed before its terminal could be attached.' } })
    expect([h.frame.posted, h.errors]).toEqual([[], [disposed]])
    expectNoListenerLeft()
  })

  it('answers failed when the spawn fails, with no port', async () => {
    h.rig.host.failNextSpawn(new Error('posix_spawnp failed.'))
    const chat = h.rig.newChat(CUSTOM_AGENT.id)

    const answer = await h.attach({ folder: h.rig.repo, chatId: chat.id })

    expect(answer).toEqual({ ok: true, data: { state: 'failed', message: 'posix_spawnp failed.' } })
    expect(h.frame.posted).toEqual([])
    expectNoListenerLeft()
  })

  it('answers an unexpected failure as internal and reports it, starting nothing', async () => {
    h.cleanup()
    const failure = new Error('The chat index could not be read.')
    h = handlersRig({
      store: () => ({
        getChat: () => {
          throw failure
        }
      })
    })

    const answer = await h.attach({ folder: h.rig.repo, chatId: 'ch_any' })

    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: 'The chat index could not be read.' } })
    expect(h.errors).toEqual([failure])
    expectNothingStarted()
  })
})
