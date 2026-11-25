/**
 * The terminal session manager's starts: one PTY per chat however many attaches race for it, and the order of
 * what comes before a spawn (sign-in check, start files, grant, grant id on the record), with the grant revoked
 * on every way out: the PTY exits, is killed, fails to spawn, or its start is cancelled after the grant was issued.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CUSTOM_AGENT, eventually, gate, recorder, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

function grantsIssued(): string[] {
  return rig.steps.filter((step) => step.startsWith('grant:'))
}

describe('terminal sessions: one PTY per chat', () => {
  it('starts one PTY for concurrent attaches of one chat, and another for another chat', async () => {
    const one = rig.newChat(CUSTOM_AGENT.id)
    const two = rig.newChat(CUSTOM_AGENT.id)

    const answers = await Promise.all([rig.sessions.attach(one), rig.sessions.attach(one), rig.sessions.attach(one)])
    const other = await rig.sessions.attach(two)

    expect(rig.host.spawns).toHaveLength(2)
    const [first, second] = rig.host.spawns
    expect(answers.map((answer) => (answer.state === 'running' ? answer.pid : answer.state))).toEqual([first?.pid, first?.pid, first?.pid])
    expect(other).toMatchObject({ state: 'running', pid: second?.pid })
    expect(first?.pid).not.toBe(second?.pid)
    expect(grantsIssued()).toEqual(['grant:gr_1', 'grant:gr_2'])
  })

  it('runs one sign-in check for attaches that arrive while it runs, each answering checking', async () => {
    const held = rig.holdAuth()
    const chat = rig.newChat('autonomous')
    const heard = recorder()

    const answers = await Promise.all([rig.sessions.attach(chat, heard.listener), rig.sessions.attach(chat)])

    expect(answers).toEqual([{ state: 'checking' }, { state: 'checking' }])
    expect([rig.steps, rig.host.spawns]).toEqual([['auth'], []])
    held.open({ state: 'signed_in', reason: 'Signed in.' })
    await eventually(() => heard.events.length > 0, 'the start to be heard')
    expect(heard.events).toEqual([{ kind: 'started', pid: rig.host.last().pid }])
    expect(rig.steps).toEqual(['auth', 'grant:gr_1', 'spawn'])
  })

  it('answers a later attach with the running PTY and starts nothing more', async () => {
    const chat = rig.newChat()
    const { pid } = await startTerminal(rig, chat)

    const again = await rig.sessions.attach(chat)

    expect(again).toMatchObject({ state: 'running', pid })
    expect([rig.host.spawns.length, grantsIssued()]).toEqual([1, ['grant:gr_1']])
  })

  it('starts a new PTY with a new grant once the last one has exited', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const { pty } = await startTerminal(rig, chat)
    pty.exit()
    await settle()

    const { pid } = await startTerminal(rig, chat)

    expect([rig.host.spawns.length, pid === pty.pid, grantsIssued()]).toEqual([2, false, ['grant:gr_1', 'grant:gr_2']])
  })

  it('background start waits for an exiting PTY and starts one fresh terminal for concurrent callers', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const { pty } = await startTerminal(rig, chat)
    pty.exit()
    const results = await Promise.all([rig.sessions.start(chat, { kickoff: 'Resolve merge' }), rig.sessions.start(chat, { kickoff: 'Resolve merge' })])
    expect(rig.host.spawns).toHaveLength(2)
    expect(results).toEqual([{ state: 'running', pid: rig.host.last().pid }, { state: 'running', pid: rig.host.last().pid }])
    expect(rig.revoked).toEqual(['gr_1'])
  })
})

describe('terminal sessions: surface ownership', () => {
  it('refuses GUI-owned starts and attaches before authentication, persistence or spawning', async () => {
    rig.cleanup()
    rig = terminalRig({ deps: () => ({ agentChatLive: () => true }) })
    const chat = rig.newChat()
    await expect(rig.sessions.start(chat, { kickoff: 'Do not start' })).rejects.toMatchObject({ code: 'busy_elsewhere' })
    await expect(rig.sessions.attach(chat, undefined, { newSession: true })).rejects.toMatchObject({ code: 'busy_elsewhere' })
    expect(rig.steps).toEqual([])
    expect(rig.host.spawns).toEqual([])
    expect(rig.store.getChat(chat)).toEqual(chat)
    expect(rig.sessions.isLive(chat)).toBe(false)
  })

  it('reserves ownership during authentication, offers no owner to stop, and releases it after cancellation', async () => {
    const auth = rig.holdAuth(), chat = rig.newChat()
    expect(await rig.sessions.attach(chat)).toEqual({ state: 'checking' })
    expect(rig.sessions.isLive(chat)).toBe(true)
    expect(rig.sessions.owner(chat)).toBeNull()
    await expect(rig.sessions.stop(chat, 'unconfirmed')).rejects.toMatchObject({ code: 'busy' })
    await rig.sessions.endAgent(chat.agent)
    expect(rig.sessions.isLive(chat)).toBe(false)
    auth.open({ state: 'signed_in', reason: 'Fixture auth.' })
    expect(rig.host.spawns).toHaveLength(0)
  })

  it('refuses an approval for an exited or replaced owner without touching the current one', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id), first = await startTerminal(rig, chat)
    const approved = rig.sessions.owner(chat)!
    first.pty.exit()
    await settle()
    await expect(rig.sessions.stop(chat, approved)).rejects.toMatchObject({ code: 'busy' })
    const second = await startTerminal(rig, chat), current = rig.sessions.owner(chat)
    expect(current).not.toBeNull()
    expect(current).not.toBe(approved)
    await expect(rig.sessions.stop(chat, approved)).rejects.toMatchObject({ code: 'busy' })
    expect(rig.sessions.owner(chat)).toBe(current)
    expect(rig.killed.map(tree => tree.pid)).not.toContain(second.pid)
    expect(rig.revoked).not.toContain('gr_2')
    rig.sessions.write(chat.id, 'still live')
    expect(second.pty.written).toContain('still live')
  })
})

describe('terminal sessions: confirmed surface handoff', () => {
  it('freezes the named owner and retains ownership until close, tree cleanup and revocation settle', async () => {
    rig.cleanup()
    const kill = gate<boolean>(), revoke = gate<void>()
    rig = terminalRig({ deps: () => ({ killTree: tree => { tree.kill(); return kill.promise },
      revokeChatGrant: () => revoke.promise }) })
    const chat = rig.newChat(CUSTOM_AGENT.id), { pty } = await startTerminal(rig, chat)
    const sessionId = rig.store.getChat(chat)!.sessionId
    let stopped = false
    const stopping = rig.sessions.stop(chat, rig.sessions.owner(chat)!).then(() => { stopped = true })
    expect([rig.sessions.owner(chat), pty.kills]).toEqual([null, 1])
    rig.sessions.write(chat.id, 'late input')
    expect(pty.written).not.toContain('late input')
    pty.exit()
    await settle()
    await expect(rig.sessions.start(chat, { kickoff: 'Do not start' })).rejects.toMatchObject({ code: 'busy' })
    await expect(rig.sessions.attach(chat)).rejects.toMatchObject({ code: 'busy' })
    expect([rig.sessions.isLive(chat), stopped]).toEqual([true, false])
    kill.open(true)
    await settle()
    expect([rig.sessions.isLive(chat), stopped]).toEqual([true, false])
    revoke.open()
    await stopping
    expect(rig.sessions.isLive(chat)).toBe(false)
    expect(rig.host.spawns).toHaveLength(1)
    expect(rig.store.getChat(chat)!.sessionId).toBe(sessionId)
  })
})

describe('terminal sessions: failed surface handoff', () => {
  for (const failure of ['kill', 'revoke'] as const) it(`keeps a confirmed handoff fenced when ${failure} cleanup fails`, async () => {
    rig.cleanup()
    rig = terminalRig({ deps: () => failure === 'kill'
      ? { killTree: async tree => { tree.kill(); return false } }
      : { revokeChatGrant: async () => { throw new Error('revocation failed') } } })
    const chat = rig.newChat(CUSTOM_AGENT.id), { pty } = await startTerminal(rig, chat)
    const stopping = rig.sessions.stop(chat, rig.sessions.owner(chat)!)
    pty.exit()
    await expect(stopping).rejects.toThrow(failure === 'kill' ? 'process tree did not stop' : 'revocation failed')
    expect([rig.sessions.isLive(chat), rig.sessions.owner(chat)]).toEqual([true, null])
    await expect(rig.sessions.start(chat, { kickoff: 'Do not start' })).rejects.toMatchObject({ code: 'busy' })
    expect(rig.host.spawns).toHaveLength(1)
  })
})

describe('terminal sessions: what may start', () => {

  it('starts nothing for a signed-out built-in, and says so to the attach that is waiting', async () => {
    rig.auth.status = { state: 'signed_out', reason: 'Claude Code is not signed in.' }
    const chat = rig.newChat()
    const heard = recorder()

    expect(await rig.sessions.attach(chat, heard.listener)).toEqual({ state: 'checking' })
    await eventually(() => heard.events.length > 0, 'the start to end')

    expect(heard.events).toEqual([{ kind: 'not_started', state: 'signed_out', message: 'Claude Code is not signed in.' }])
    expect([rig.steps, rig.host.spawns]).toEqual([['auth'], []])
  })

  it('starts a custom CLI without a sign-in check', async () => {
    await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id))

    expect(rig.steps).toEqual(['grant:gr_1', 'spawn'])
    expect(rig.host.last().spec.args).toEqual(['--in', rig.repo])
  })

  it('refuses a custom CLI marked for review, saying how to review it, and starts nothing: no grant, no file, no spawn', async () => {
    rig.cleanup()
    rig = terminalRig({ agents: [{ ...CUSTOM_AGENT, needsReview: true }] })
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const heard = recorder()

    const answer = await rig.sessions.attach(chat, heard.listener)
    const kickoff = await rig.sessions.start(chat, { kickoff: 'Run the sprint.' })

    const message =
      'My CLI was saved with arguments for a chat protocol the app no longer speaks, so it does not start until you review them. Open it under Agents and choose Review arguments.'
    expect(answer).toEqual({ state: 'refused', message })
    expect(kickoff).toEqual({ state: 'refused', message })
    await settle()
    expect([rig.steps, rig.host.spawns, heard.events]).toEqual([[], [], []])
    expect(existsSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`))).toBe(false)
    expect(rig.reopenedStore().getChat(chat)?.grantIds ?? []).toEqual([])
  })

  it('starts the same custom CLI once it needs no review', async () => {
    rig.cleanup()
    rig = terminalRig({ agents: [{ ...CUSTOM_AGENT, needsReview: false }] })

    await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id))

    expect(rig.steps).toEqual(['grant:gr_1', 'spawn'])
  })

  it('refuses a chat that is not in the store, and a chat whose agent is not connected', async () => {
    const gone = await rig.sessions.attach({ folder: rig.repo, id: 'ch_missing' })
    const orphan = await rig.sessions.attach(rig.newChat('codex'))

    expect(gone).toEqual({ state: 'refused', message: `No chat ch_missing in ${rig.repo}.` })
    expect(orphan).toEqual({ state: 'refused', message: 'No connected agent has the id codex. Connect it under Agents first.' })
    expect(rig.steps).toEqual([])
  })
})

describe('terminal sessions: the grant', () => {
  it('writes the start files, issues the grant, stores its id on the chat record, then spawns with it', async () => {
    const chat = rig.newChat()

    await startTerminal(rig, chat)

    expect(rig.steps).toEqual(['auth', 'grant:gr_1', 'spawn'])
    expect(rig.host.grantStoredAtSpawn).toEqual([true])
    expect(rig.reopenedStore().getChat(chat)?.grantIds).toEqual(['gr_1'])
    const { spec } = rig.host.last()
    expect([spec.cwd, spec.env['DM_SESSION_TOKEN']]).toEqual([rig.repo, 'token-gr_1'])
    const instructions = join(rig.userData, 'agents', 'instructions', `${chat.id}.md`)
    expect([existsSync(instructions), spec.args.includes(instructions)]).toEqual([true, true])
  })

  it("writes a Claude chat's settings file before its start and passes it with --settings, never as inline JSON", async () => {
    const chat = rig.newChat()

    await startTerminal(rig, chat)

    const settings = join(rig.userData, 'agents', 'settings', `${chat.id}.json`)
    const { args } = rig.host.last().spec
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2)).toEqual(['--settings', settings])
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toMatchObject({
      autoMemoryDirectory: expect.stringContaining('dark-mechanicus-unused-memory'),
      hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command' }] }] }
    })
    expect(args).not.toContainEqual(expect.stringMatching(/^\s*\{/))
    expect(rig.host.last().spec.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
  })

  it('writes no Claude settings for another agent', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)

    await startTerminal(rig, chat)

    expect(rig.host.last().spec.args).not.toContain('--settings')
    expect(existsSync(join(rig.userData, 'agents', 'settings'))).toBe(false)
  })

  it('keeps every grant id issued to the chat, oldest first', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const { pty } = await startTerminal(rig, chat)
    pty.exit()
    await settle()

    await startTerminal(rig, chat)

    expect(rig.reopenedStore().getChat(chat)?.grantIds).toEqual(['gr_1', 'gr_2'])
  })

  it('issues no grant when the start files cannot be written', async () => {
    // A file where the app's userData folder should be: nothing can be written under it.
    writeFileSync(rig.userData, 'not a folder')

    const answer = await rig.sessions.attach(rig.newChat(CUSTOM_AGENT.id))

    expect(answer.state).toBe('failed')
    expect([rig.steps, rig.host.spawns]).toEqual([[], []])
  })
})

describe('terminal sessions: the grant is revoked on every way out', () => {
  it('revokes the grant when the PTY exits, ends what it left running, and tells the exit after its output', async () => {
    const chat = rig.newChat()
    const heard = recorder()
    const { pty } = await startTerminal(rig, chat, heard.listener)
    await settle()
    pty.emitData('bye\r\n')

    pty.exit({ exitCode: 3, signal: null })
    await eventually(() => heard.events.some((event) => event.kind === 'exited'), 'the exit to be told')

    expect([rig.revoked, rig.killed.map((tree) => tree.pid), pty.kills]).toEqual([['gr_1'], [pty.pid], 0])
    expect(heard.events.map((event) => event.kind)).toEqual(['started', 'output', 'exited'])
    expect(heard.events.at(-1)).toEqual({ kind: 'exited', exitCode: 3, signal: null, message: null, resumed: false })
    expect(rig.sessions.busy()).toBe(false)
  })

  it('revokes the grant when the PTY is killed, once, however it then exits', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)

    const ending = rig.sessions.deleteChat(chat, async () => {})
    expect(rig.revoked).toEqual(['gr_1'])
    pty.exit({ exitCode: 0, signal: 9 })
    await ending

    expect(rig.killed.map((tree) => tree.pid)).toEqual([pty.pid])
    expect(rig.revoked).toEqual(['gr_1'])
  })

  it('revokes the grant when the spawn fails, keeping its id on the record', async () => {
    rig.host.failNextSpawn(new Error('posix_spawnp failed.'))
    const chat = rig.newChat(CUSTOM_AGENT.id)

    const answer = await rig.sessions.attach(chat)
    await settle()

    expect(answer).toEqual({ state: 'failed', message: 'posix_spawnp failed.' })
    expect(rig.steps).toEqual(['grant:gr_1', 'spawn', 'revoke:gr_1'])
    expect(rig.reopenedStore().getChat(chat)?.grantIds).toEqual(['gr_1'])
    expect(rig.sessions.busy()).toBe(false)
  })

  it('revokes a grant that arrives after its start was cancelled, and spawns nothing', async () => {
    const held = rig.holdGrant()
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const attaching = rig.sessions.attach(chat)
    await eventually(() => rig.grantsAsked > 0, 'the grant to be asked for')

    await rig.sessions.deleteChat(chat, async () => {})
    held.open()
    await eventually(() => rig.revoked.length > 0, 'the late grant to be revoked')

    expect(await attaching).toEqual({ state: 'failed', message: 'The chat was deleted, so its terminal was stopped.' })
    expect(rig.steps).toEqual(['grant:gr_1', 'revoke:gr_1'])
    expect(rig.host.spawns).toEqual([])
  })
})

describe('terminal sessions: grant labels', () => {
  const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/

  it('starts a chat whose label would pass 120 characters, cutting the title and never splitting a surrogate pair', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id, `${'a'.repeat(110)}😀${'b'.repeat(80)}`)

    const answer = await rig.sessions.attach(chat)

    expect(answer.state).toBe('running')
    expect(rig.grantLabels).toEqual([`My CLI · ${'a'.repeat(110)}`])
    expect(LONE_HIGH_SURROGATE.test(rig.grantLabels[0] ?? '')).toBe(false)
  })

  it('keeps a label that fits exactly as display name, separator and title', async () => {
    const title = 'c'.repeat(111)
    const chat = rig.newChat(CUSTOM_AGENT.id, title)

    await rig.sessions.attach(chat)

    expect(rig.grantLabels).toEqual([`My CLI · ${title}`])
    expect(rig.grantLabels[0]).toHaveLength(120)
  })
})
