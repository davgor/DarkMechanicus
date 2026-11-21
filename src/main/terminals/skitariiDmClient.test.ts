/**
 * The Skitarii extension's mail client (`resources/skitarii/extension/dmClient.ts`) over descriptors main writes
 * (`writeDmClientDescriptor`). The spawn is checked with a fake child where the exact call matters, and with a real
 * Node child running a fixture `cli.js` for what only a process shows: literal argv and stdin, the environment it
 * gets, and that no child outlives a timeout, an overflow, an abort or the session's end.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  DM_CLIENT_DESCRIPTOR_ENV,
  DM_CLIENT_LIMITS,
  createDmClient,
  parseDmClientDescriptor,
  type DmClientDeps,
  type DmMailAcceptance,
  type DmMailAcknowledged,
  type DmMailCalls,
  type DmMailIdentity,
  type DmMailInboxPage,
  type DmMailPeersPage,
  type DmMailStatusPage
} from '../../../resources/skitarii/extension/dmClient'
import { attachDmClient, type OmpApi } from '../../../resources/skitarii/extension/index'
import type * as Shared from '../../shared/domain/agentMail'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { removeScratch } from '../../test/removeScratch'
import { dmClientDescriptorPath, writeDmClientDescriptor } from './terminalFiles'

const TOKEN = 'grant-token-7f3a'
const CHAT = 'ch_mail'
const GENERATION = '0c6f1d3e-2b7a-4c55-9a51-1f0e9d2c7b44'
/** Every character a shell would read as something else, in names Windows allows too. */
const AWKWARD = "it's a $HOME & (ü 漢) %PATH% ^!; `x`"

/** The fixture `dm`: echoes what it was given, or misbehaves as the input's `mode` says. */
const FIXTURE_CLI = `
const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const token = process.env.DM_SESSION_TOKEN
switch (input.mode) {
  case 'error':
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'mailbox_full', message: 'full for ' + token } }))
    process.exit(1)
  case 'garbage':
    process.stdout.write('{"ok": tru')
    process.exit(0)
  case 'crash':
    process.stderr.write('boom\\u0007\\u001b[31m token=' + token + '\\n' + 'x'.repeat(10000))
    process.exit(3)
  case 'hang':
    setInterval(() => {}, 1000)
    break
  case 'flood': {
    const chunk = 'x'.repeat(65536)
    const write = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', write) }
    write()
    break
  }
  default:
    process.stdout.write(JSON.stringify({ ok: true, data: { argv: process.argv.slice(1), cwd: process.cwd(), env: process.env, input } }))
}
`

interface Echo {
  argv: string[]
  cwd: string
  env: Record<string, string>
  input: unknown
}

let root: string
let folder: string
let script: string
let home: string
let descriptor: string

function cli(overrides: Partial<DarkMechanicusCli> = {}): DarkMechanicusCli {
  return {
    command: process.execPath,
    args: [script, '--repo', folder],
    env: { ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: home, DM_SESSION_TOKEN: TOKEN, DM_DESKTOP_PIPE: '\\\\.\\pipe\\naming' },
    ...overrides
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dm-client-'))
  folder = join(root, `repo ${AWKWARD}`)
  home = join(root, 'dm home')
  const bin = join(root, `app ${AWKWARD}`, 'out', 'main')
  mkdirSync(folder, { recursive: true })
  mkdirSync(bin, { recursive: true })
  script = join(bin, 'cli.js')
  writeFileSync(script, FIXTURE_CLI)
  descriptor = await writeDmClientDescriptor({ userData: join(root, 'userData'), chatId: CHAT, generation: GENERATION, folder, cli: cli(), platform: process.platform })
})

afterEach(() => {
  removeScratch(root)
})

/** The chat's process environment: its grant and descriptor, with what must never reach the child laid over it. */
function chatEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    [DM_CLIENT_DESCRIPTOR_ENV]: descriptor,
    DM_SESSION_TOKEN: TOKEN,
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-openai-secret',
    NODE_OPTIONS: '--require ./evil.js',
    BUN_INSPECT: '1',
    LD_PRELOAD: '/tmp/evil.so',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    DM_DESKTOP_PIPE: 'naming-address',
    ELECTRON_RUN_AS_NODE: '0',
    PI_CODING_AGENT_DIR: '/elsewhere',
    ...extra
  }
}

/** Real spawns, each child kept so a test can check it is gone. */
function realDeps(env = chatEnv(), limits = DM_CLIENT_LIMITS): DmClientDeps & { children: ChildProcess[] } {
  const children: ChildProcess[] = []
  return {
    env,
    platform: process.platform,
    readFile: (path) => Promise.resolve(readFileSync(path, 'utf8')),
    spawn: (command, args, options) => {
      const child = nodeSpawn(command, [...args], options)
      children.push(child)
      return child
    },
    limits,
    children
  }
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function expectAllGone(children: ChildProcess[]): void {
  expect(children.length).toBeGreaterThan(0)
  for (const child of children) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(alive(child.pid)).toBe(false)
  }
}

/** A child that answers `stdout` and exits `code` once its stdin has ended, for checking the exact spawn. */
function fakeChild(stdout: string, code = 0): ChildProcess & { stdinText: () => string } {
  const child = new EventEmitter() as ChildProcess & { stdinText: () => string }
  const stdin = new PassThrough()
  let written = ''
  stdin.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8')
  })
  stdin.on('end', () => {
    setImmediate(() => {
      out.end(stdout)
      err.end()
      child.emit('exit', code, null)
      child.emit('close', code, null)
    })
  })
  const out = new PassThrough()
  const err = new PassThrough()
  Object.assign(child, { stdin, stdout: out, stderr: err, pid: 4242, kill: vi.fn(() => true), stdinText: () => written })
  return child
}

describe('the DM client spawn', () => {
  it('runs the pinned runtime and script, call <command> -, in the folder, with the input on stdin and nothing else on the line', async () => {
    const child = fakeChild(JSON.stringify({ ok: true, data: { messageId: 'mm_1' } }))
    const spawn = vi.fn(() => child)
    const client = createDmClient({ ...realDeps(), spawn })
    const input = { to: 'me_peer', clientMessageId: 'c-1', body: `hi ${AWKWARD} "quoted" \n ${TOKEN.length}` }

    const result = await client.call('send', input)

    expect(result).toEqual({ ok: true, data: { messageId: 'mm_1' } })
    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(command).toBe(process.execPath)
    expect(args).toEqual([script, '--repo', folder, 'call', 'send_agent_message', '-'])
    expect(options).toMatchObject({ cwd: folder, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(JSON.parse(child.stdinText())).toEqual(input)
    expect(args.join(' ')).not.toContain(TOKEN)
  })

  it.each([
    ['identity', 'get_agent_identity'],
    ['peers', 'list_agent_peers'],
    ['send', 'send_agent_message'],
    ['read', 'read_agent_inbox'],
    ['ack', 'acknowledge_agent_messages'],
    ['status', 'get_agent_mail_status']
  ] as const)('maps %s to the CLI command %s', async (command, cliName) => {
    const spawn = vi.fn(() => fakeChild('{"ok":true,"data":{}}'))
    await createDmClient({ ...realDeps(), spawn }).call(command, {} as never)
    expect((spawn.mock.calls[0] as unknown as [string, string[]])[1].slice(-3)).toEqual(['call', cliName, '-'])
  })

  it('refuses any other command, and input that is not one JSON object, without spawning', async () => {
    const spawn = vi.fn(() => fakeChild('{}'))
    const client = createDmClient({ ...realDeps(), spawn })

    for (const command of ['save_plan', 'get_agent_identity', 'constructor', '__proto__']) {
      expect(await client.call(command as 'identity', {})).toMatchObject({ ok: false, error: { source: 'client', code: 'command_not_allowed' } })
    }
    for (const input of [null, [], 'text', 5]) {
      expect(await client.call('identity', input as never)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('needs the grant in the chat’s process and spawns nothing without it', async () => {
    const spawn = vi.fn(() => fakeChild('{}'))
    const result = await createDmClient({ ...realDeps(chatEnv({ DM_SESSION_TOKEN: '  ' })), spawn }).call('identity', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'no_grant' } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses the stated limits: 5 s, 2 MiB of stdout, 4 KiB of stderr', () => {
    expect(DM_CLIENT_LIMITS).toEqual({ timeoutMs: 5_000, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 4 * 1024 })
  })
})

const refusingSpawn = vi.fn(() => fakeChild('{}'))

/** What the client answers with the chat environment changed by `env`, after checking it spawned nothing. */
async function refusal(env: Record<string, string | undefined>): Promise<unknown> {
  refusingSpawn.mockClear()
  const result = await createDmClient({ ...realDeps(chatEnv(env)), spawn: refusingSpawn }).call('identity', {})
  expect(refusingSpawn).not.toHaveBeenCalled()
  return result.ok ? null : result.error
}

/** Main's descriptor, changed by `change`, written at `path`. */
function written(change: (d: Record<string, unknown>) => void, path = descriptor): string {
  const d = JSON.parse(readFileSync(descriptor, 'utf8')) as Record<string, unknown>
  change(d)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(d))
  return path
}

describe('the DM client descriptor', () => {
  it('holds the pinned runtime, script, folder and inherited names, and never the grant or the naming address', () => {
    const text = readFileSync(descriptor, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ version: 1, chatId: CHAT, generation: GENERATION, folder, command: process.execPath, args: [script, '--repo', folder], cwd: folder, env: { ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: home } })
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('DM_SESSION_TOKEN')
    expect(text).not.toContain('pipe')
    expect(parseDmClientDescriptor(descriptor, text).ok).toBe(true)
  })

  it('is missing when the variable is unset or the file is gone', async () => {
    expect(await refusal({ [DM_CLIENT_DESCRIPTOR_ENV]: undefined })).toMatchObject({ code: 'descriptor_missing' })
    rmSync(descriptor)
    expect(await refusal({})).toMatchObject({ code: 'descriptor_missing' })
  })

  it('is stale when it is another version', async () => {
    written((d) => (d['version'] = 2))
    expect(await refusal({})).toMatchObject({ code: 'descriptor_stale' })
  })

  it('is refused when it was written for another chat or launch, rather than used for this one', async () => {
    const otherChat = written(() => {}, dmClientDescriptorPath(join(root, 'userData'), 'ch_other', GENERATION))
    expect(await refusal({ [DM_CLIENT_DESCRIPTOR_ENV]: otherChat })).toMatchObject({ code: 'descriptor_invalid' })
    const otherLaunch = written(() => {}, dmClientDescriptorPath(join(root, 'userData'), CHAT, 'another-generation'))
    expect(await refusal({ [DM_CLIENT_DESCRIPTOR_ENV]: otherLaunch })).toMatchObject({ code: 'descriptor_invalid' })
    expect(await refusal({ [DM_CLIENT_DESCRIPTOR_ENV]: 'relative/descriptor.json' })).toMatchObject({ code: 'descriptor_invalid' })
  })
})

describe('the DM client descriptor: shapes main never writes', () => {
  it.each<[string, (d: Record<string, unknown>) => void]>([
    ['not JSON', () => {}],
    ['an extra key', (d) => (d['shell'] = 'cmd.exe')],
    ['a relative runtime', (d) => (d['command'] = 'node')],
    ['a runtime found through ..', (d) => (d['command'] = `${root}${sep}..${sep}node`)],
    ['a script that is not cli.js', (d) => (d['args'] = [join(root, 'evil.js'), '--repo', folder])],
    ['a CLI pinned to another folder', (d) => (d['args'] = [script, '--repo', root])],
    ['extra CLI arguments', (d) => (d['args'] = [script, '--repo', folder, '--token-file', 'x'])],
    ['another working folder', (d) => (d['cwd'] = root)],
    ['the grant in its environment', (d) => (d['env'] = { ELECTRON_RUN_AS_NODE: '1', DM_SESSION_TOKEN: TOKEN })],
    ['another runtime switch', (d) => (d['env'] = { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' })],
    ['a provider key to inherit', (d) => (d['inherit'] = ['PATH', 'ANTHROPIC_API_KEY'])],
    ['runtime injection to inherit', (d) => (d['inherit'] = ['NODE_OPTIONS'])],
    ['the grant to inherit', (d) => (d['inherit'] = ['dm_session_token'])]
  ])('is refused with %s', async (what, change) => {
    if (what === 'not JSON') writeFileSync(descriptor, '{"version":1,')
    else written(change)
    expect(await refusal({})).toMatchObject({ source: 'client', code: 'descriptor_invalid' })
  })
})

describe('the DM client child', () => {
  it('gets argv and stdin literally, the folder as cwd, and only the inherited names, its runtime switches and the grant', async () => {
    const deps = realDeps()
    const input = { to: 'me_peer', clientMessageId: 'c-1', body: `${AWKWARD} "q" \\ \n ${'€'.repeat(3)} $(whoami) | rm -rf ~` }

    const result = await createDmClient(deps).call('send', input)

    expect(result.ok).toBe(true)
    const echo = (result as { data: unknown }).data as Echo
    expect(echo.argv).toEqual([script, '--repo', folder, 'call', 'send_agent_message', '-'])
    expect(echo.cwd).toBe(folder)
    expect(echo.input).toEqual(input)
    expect(echo.env['DM_SESSION_TOKEN']).toBe(TOKEN)
    expect(echo.env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(echo.env['DARKMECHANICUS_HOME']).toBe(home)
    const names = Object.keys(echo.env).map((name) => name.toUpperCase())
    for (const hidden of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'BUN_INSPECT', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DM_DESKTOP_PIPE', DM_CLIENT_DESCRIPTOR_ENV, 'PI_CODING_AGENT_DIR']) {
      expect(names).not.toContain(hidden)
    }
    // libuv fills these in on Windows from the system when an environment lacks them; the client passes none of them on.
    const libuvRequired = process.platform === 'win32' ? ['LOGONSERVER', 'USERDOMAIN'] : []
    const allowed = new Set([...JSON.parse(readFileSync(descriptor, 'utf8')).inherit.map((name: string) => name.toUpperCase()), ...libuvRequired, 'DM_SESSION_TOKEN', 'ELECTRON_RUN_AS_NODE', 'DARKMECHANICUS_HOME'])
    expect(names.filter((name) => !allowed.has(name))).toEqual([])
    expectAllGone(deps.children)
  })

  it('passes the CLI’s own refusal through with its code, the grant redacted', async () => {
    const result = await createDmClient(realDeps()).call('read', { mode: 'error' } as never)
    expect(result).toEqual({ ok: false, error: { source: 'dm', code: 'mailbox_full', message: 'full for [redacted]' } })
  })
})

describe('the DM client child: failures', () => {
  it('reports a CLI that exits 0 without a JSON result as malformed', async () => {
    expect(await createDmClient(realDeps()).call('read', { mode: 'garbage' } as never)).toMatchObject({ ok: false, error: { source: 'client', code: 'malformed_output' } })
  })

  it('reports a failed exit with at most 4 KiB of sanitized stderr, and never the grant', async () => {
    const result = await createDmClient(realDeps()).call('read', { mode: 'crash' } as never)

    expect(result).toMatchObject({ ok: false, error: { source: 'client', code: 'process_failed' } })
    const message = result.ok ? '' : result.error.message
    expect(message).toMatch(/^The dm CLI exited with code 3: boom \[31m token=\[redacted\] x+$/)
    expect(message).not.toContain(TOKEN)
    expect(message.length).toBeLessThan(4 * 1024 + 100)
  })
})

describe('the DM client child: stopping it', () => {
  it('kills a child that runs past the time limit and settles once it is gone', async () => {
    const deps = realDeps(chatEnv(), { ...DM_CLIENT_LIMITS, timeoutMs: 300 })
    expect(await createDmClient(deps).call('read', { mode: 'hang' } as never)).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expectAllGone(deps.children)
  })

  it('kills a child that prints more than 2 MiB', async () => {
    const deps = realDeps()
    expect(await createDmClient(deps).call('read', { mode: 'flood' } as never)).toMatchObject({ ok: false, error: { code: 'output_too_large' } })
    expectAllGone(deps.children)
  })

  it('kills the child when the caller aborts, and spawns none for a signal already aborted', async () => {
    const deps = realDeps()
    const client = createDmClient(deps)
    const controller = new AbortController()
    const call = client.call('read', { mode: 'hang' } as never, controller.signal)
    await vi.waitFor(() => expect(deps.children[0]?.pid).toBeDefined())
    controller.abort()
    expect(await call).toMatchObject({ ok: false, error: { code: 'aborted' } })
    expectAllGone(deps.children)

    expect(await client.call('identity', {}, AbortSignal.abort())).toMatchObject({ ok: false, error: { code: 'aborted' } })
    expect(deps.children).toHaveLength(1)
  })

  it('kills every running child when the session shuts down, and resolves once they have exited', async () => {
    const deps = realDeps()
    const handlers = new Map<string, () => void>()
    const pi: OmpApi = { on: (event, handler) => handlers.set(event, () => handler({}, { ui: {} as never, hasUI: false, cwd: folder })) }
    const client = attachDmClient(pi, createDmClient(deps))
    const calls = [client.call('read', { mode: 'hang' } as never), client.call('status', { mode: 'hang' } as never)]
    await vi.waitFor(() => expect(deps.children.filter((child) => child.pid !== undefined)).toHaveLength(2))

    handlers.get('session_shutdown')?.()
    const settled = await Promise.all(calls)
    await client.cancelAll()

    expect(settled.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['cancelled', 'cancelled'])
    expectAllGone(deps.children)
  })

  it('reports a runtime that cannot be started', async () => {
    const missing = join(root, 'no such runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    const path = await writeDmClientDescriptor({ userData: join(root, 'userData'), chatId: CHAT, generation: 'g2', folder, cli: cli({ command: missing }), platform: process.platform })
    expect(await createDmClient(realDeps(chatEnv({ [DM_CLIENT_DESCRIPTOR_ENV]: path }))).call('identity', {})).toMatchObject({ ok: false, error: { code: 'spawn_failed' } })
  })
})

// The DM client contract: the extension cannot import src/shared, so its mailbox views must equal
// the shared domain types. These are compile-time checks (no runtime effect): `npm run typecheck`
// covers this file and fails when the two drift.
expectTypeOf<DmMailIdentity>().toEqualTypeOf<Shared.AgentIdentityView>()
expectTypeOf<DmMailPeersPage>().toEqualTypeOf<Shared.AgentPeersPage>()
expectTypeOf<DmMailAcceptance>().toEqualTypeOf<Shared.AgentMessageAcceptanceView>()
expectTypeOf<DmMailInboxPage>().toEqualTypeOf<Shared.AgentInboxPage>()
expectTypeOf<DmMailStatusPage>().toEqualTypeOf<Shared.AgentMailStatusPage>()
expectTypeOf<DmMailAcknowledged>().toEqualTypeOf<Shared.AcknowledgeAgentMessagesResult>()
expectTypeOf<DmMailCalls['send']['input']>().toEqualTypeOf<Shared.SendAgentMessageInput>()
expectTypeOf<DmMailCalls['read']['input']>().toEqualTypeOf<Shared.ReadAgentInboxInput>()
expectTypeOf<DmMailCalls['status']['input']>().toEqualTypeOf<Shared.AgentMailWindow>()

describe('authenticated person-board host outbox', () => {
  it('reads only the descriptor-bound recipient and rechecks its current mailbox grant before returning person bodies', async () => {
    const messages = [{ id: 'board_one', text: '[Board message from the person]\nFull body\nincluding its tail.' }]
    writeFileSync(join(root, 'userData', 'agents', 'omp', CHAT, 'context-outbox.json'),
      JSON.stringify({ version: 1, chatId: CHAT, endpointId: 'me_recipient_a', messages }))
    const spawn = vi.fn(() => fakeChild('{"ok":true,"data":{"endpointId":"me_recipient_a","name":"A","role":"worker","boundAt":"2026-11-20T00:00:00Z"}}'))
    const result = await createDmClient({ ...realDeps(), spawn }).readBoard()
    expect(result).toEqual({ ok: true, data: messages })
    expect((spawn.mock.calls[0] as unknown as [string, string[]])[1].slice(-3)).toEqual(['call', 'get_agent_identity', '-'])
  })

  it('never returns pending person bodies under a revoked grant or a foreign recipient outbox', async () => {
    const file = join(root, 'userData', 'agents', 'omp', CHAT, 'context-outbox.json')
    const messages = [{ id: 'board_one', text: 'Private person body.' }]
    writeFileSync(file, JSON.stringify({ version: 1, chatId: CHAT, endpointId: 'me_recipient_a', messages }))
    const spawn = vi.fn(() => fakeChild('{"ok":false,"error":{"code":"unauthorized","message":"Grant revoked"}}', 1))
    expect(await createDmClient({ ...realDeps(), spawn }).readBoard()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    writeFileSync(file, JSON.stringify({ version: 1, chatId: 'chat_other', endpointId: 'me_other', messages }))
    expect(await createDmClient({ ...realDeps(), spawn }).readBoard()).toMatchObject({ ok: false, error: { code: 'context_unavailable' } })
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

it('does not expose recipient A person bodies through a valid A descriptor when the current grant authenticates mailbox B', async () => {
  const messages = [{ id: 'board_a', text: 'Person body for recipient A only.' }]
  writeFileSync(join(root, 'userData', 'agents', 'omp', CHAT, 'context-outbox.json'),
    JSON.stringify({ version: 1, chatId: CHAT, endpointId: 'me_recipient_a', messages }))
  const spawn = vi.fn(() => fakeChild('{"ok":true,"data":{"endpointId":"me_recipient_b","name":"B","role":"worker","boundAt":"2026-11-20T00:00:00Z"}}'))
  const result = await createDmClient({ ...realDeps(chatEnv({ DM_SESSION_TOKEN: 'valid-grant-for-b' })), spawn }).readBoard()
  expect(result).toMatchObject({ ok: false, error: { code: 'recipient_mismatch' } })
  expect(JSON.stringify(result)).not.toContain(messages[0]!.text)
})
