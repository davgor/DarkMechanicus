import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import type { FakePty } from './__mocks__/fakePtyHost'
import type { TerminalEvent } from './terminalSessions'
import { CUSTOM_AGENT, eventually, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

let rig: TerminalRig
const prompt = '  Diagnose expired-session refresh without losing this message.  '
beforeEach(() => { rig = terminalRig({ agents: [CUSTOM_AGENT, builtInAgent('claude')] }) })
afterEach(() => { rig.cleanup() })
function popup(agent = CUSTOM_AGENT.id) {
  return rig.store.createChat({ folder: rig.repo, agent, model: null, role: 'worker', allowSave: false, firstPrompt: prompt, firstPromptDelivery: 'pending', titleStatus: 'pending' })
}
async function ready(pty: FakePty) {
  pty.emitData('\x1b[?2004hready')
  await settle()
  rig.clock.advance(1_000)
  rig.clock.advance(500)
  await settle()
}

it('restores an undelivered native startup prompt after spawn fails and retries it only once', async () => {
  const chat = popup('claude')
  rig.host.failNextSpawn(new Error('Native executable could not start'))
  const events: TerminalEvent[] = []
  await rig.sessions.attach(chat, event => events.push(event))
  await eventually(() => events.some(event => event.kind === 'not_started'), 'native spawn failure reaches the chat')
  expect(events).toContainEqual({ kind: 'not_started', state: 'failed', message: 'Native executable could not start' })
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'pending', kickoffSent: false })
  const recovered = await startTerminal(rig, chat)
  expect(recovered.pty.spec.args).toContain(prompt)
  expect(rig.store.getChat(chat)?.firstPromptDelivery).toBe('submitted')
  await rig.sessions.attach(chat)
  expect(rig.host.spawns).toHaveLength(1)
})

it('refuses a saved prompt paste after shutdown without starting another terminal', async () => {
  const chat = popup()
  await rig.sessions.dispose()
  expect(await rig.sessions.paste(chat, prompt)).toMatchObject({ state: 'failed' })
  expect(rig.host.spawns).toEqual([])
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'pending' })
})

it('refuses an untracked folder before a queued prompt can start its agent', async () => {
  const chat = popup()
  rig.tracked.delete(rig.repo)
  expect(await rig.sessions.paste(chat, prompt)).toMatchObject({ state: 'refused' })
  expect(rig.host.spawns).toEqual([])
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'pending' })
})

it('sends no input if saving the pre-write claim fails and retains the full prompt for a safe retry', async () => {
  const chat = popup()
  const started = await startTerminal(rig, chat)
  const update = rig.store.updateChat
  const failure = new Error('The pre-write claim could not be saved')
  rig.store.updateChat = (ref, patch) => {
    if (patch.firstPromptDelivery === 'uncertain') throw failure
    return update(ref, patch)
  }
  await ready(started.pty)
  expect(started.pty.written).toEqual([])
  expect(rig.killed).toHaveLength(1)
  expect(rig.errors).toContain(failure)
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'pending' })
  rig.store.updateChat = update
  started.pty.exit()
  await settle()
  const recovered = await startTerminal(rig, chat)
  await ready(recovered.pty)
  expect(recovered.pty.written).toEqual([`\x1b[200~${prompt}\x1b[201~`, '\r'])
})

it('does not replay an already written prompt when recording submission fails', async () => {
  const chat = popup()
  const started = await startTerminal(rig, chat)
  const update = rig.store.updateChat
  const failure = new Error('Submission record could not be saved')
  rig.store.updateChat = (ref, patch) => {
    if (patch.firstPromptDelivery === 'submitted') throw failure
    return update(ref, patch)
  }
  await ready(started.pty)
  expect(started.pty.written).toEqual([`\x1b[200~${prompt}\x1b[201~`, '\r'])
  expect(rig.errors).toContain(failure)
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'uncertain' })
  rig.store.updateChat = update
  started.pty.exit()
  await settle()
  const restarted = await startTerminal(rig, chat)
  await ready(restarted.pty)
  expect(restarted.pty.written).toEqual([])
})

it('keeps native argument delivery uncertain if its final persistence fails and never replays it', async () => {
  const chat = popup('claude')
  const update = rig.store.updateChat
  const failure = new Error('Native delivery record could not be saved')
  rig.store.updateChat = (ref, patch) => {
    if (patch.firstPromptDelivery === 'submitted') throw failure
    return update(ref, patch)
  }
  const attaching = rig.sessions.attach(chat)
  await eventually(() => rig.killed.length === 1, 'native delivery failure stops its owned PTY')
  rig.host.last().exit()
  await attaching
  expect(rig.host.last().spec.args).toContain(prompt)
  expect(rig.killed).toHaveLength(1)
  expect(rig.errors).toContain(failure)
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'uncertain', kickoffSent: true })
  rig.store.updateChat = update
  await settle()
  expect((await startTerminal(rig, chat)).pty.spec.args).not.toContain(prompt)
})

it('settles shutdown after a CLI has already exited without losing its undelivered prompt', async () => {
  const chat = popup()
  const started = await startTerminal(rig, chat)
  started.pty.exit()
  await rig.sessions.dispose()
  expect(rig.awake).toBe(0)
  expect(rig.revoked).toEqual(['gr_1'])
  expect(rig.host.spawns).toHaveLength(1)
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'pending' })
})

it.skipIf(process.platform !== 'win32')('delivers a Windows Skitarii first prompt without writing to the real vendor home', async () => {
  rig.cleanup()
  rig = terminalRig({
    agents: [builtInAgent('omp', { executablePath: 'C:\\fixture\\omp.exe' })],
    deps: current => ({
      platform: 'win32',
      env: { PI_CODING_AGENT_DIR: join(current.root, 'omp'), USERPROFILE: current.root, HOME: current.root }
    })
  })
  const chat = popup('omp')
  const started = await startTerminal(rig, chat)
  expect(started.pty.spec.args).toContain(prompt)
  expect(started.pty.spec.env['PI_CODING_AGENT_DIR']).toBe(join(rig.root, 'omp'))
  expect(started.pty.written).toEqual([])
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt: prompt, firstPromptDelivery: 'submitted' })
})
