import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { claudeSessionExists } from '../terminals/claudeSession'

const fixtures = resolve('src/main/agentChat/__fixtures__')
const cli = join(fixtures, 'fakeAgentCli.mjs')
const protocols = ['claude', 'omp'] as const
type Protocol = typeof protocols[number]
const argsFor = (protocol: Protocol): string[] => protocol === 'claude' ? ['-p', '--output-format', 'stream-json'] : ['--mode', 'rpc-ui']
const arbiterArgs = (protocol: Protocol): string[] => protocol === 'claude' ? ['-p', '--output-format', 'json'] : ['-p', '--no-tools']
const golden = (protocol: Protocol, name: string, direction = 'out'): string => readFileSync(join(fixtures, protocol, `${name}.${direction}.jsonl`), 'utf8')
const lines = (text: string): string[] => text.trimEnd().split(/\r?\n/)
const grant = 'dmg_0123456789abcdef0123456789abcdef'
const claim = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
const sessionId = '00000000-0000-4000-8000-000000000001'
let scratch: string
let children: Harness[]

interface Harness {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  logPath: string
  loggedBeforeOutput: boolean
  closed: Promise<number | null>
  send: (value: unknown) => void
  until: (predicate: () => boolean) => Promise<void>
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dm-fake-cli-'))
  children = []
})

afterEach(async () => {
  for (const harness of children) {
    if (harness.child.exitCode === null && harness.child.signalCode === null) harness.child.kill('SIGKILL')
    await harness.closed
  }
  removeScratch(scratch)
})

function launch(argv: string[], env: NodeJS.ProcessEnv = {}, executable = cli): Harness {
  const logPath = join(scratch, `invocations-${children.length}.jsonl`)
  const child = spawn(process.execPath, [executable, ...argv], {
    cwd: scratch,
    stdio: 'pipe',
    env: { ...process.env, DM_SESSION_TOKEN: undefined, FAKE_AGENT_SIGNED_OUT: undefined, FAKE_ARBITER_VERDICT: undefined, CLAUDE_CONFIG_DIR: join(scratch, 'config'), FAKE_AGENT_LOG: logPath, ...env },
  })
  const events = new EventEmitter()
  let exited = false
  // The repository's ES library predates Promise.withResolvers.
  const closed = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code) => { exited = true; events.emit('output'); resolveExit(code) })
  })
  const harness: Harness = {
    child, stdout: '', stderr: '', logPath, loggedBeforeOutput: true, closed,
    send: (value) => { child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`) },
    until: (predicate) => new Promise<void>((resolveWait, reject) => {
      const check = (): void => {
        if (predicate()) { events.off('output', check); resolveWait() }
        else if (exited) { events.off('output', check); reject(new Error(`CLI exited before expected output: ${harness.stderr}\n${harness.stdout}`)) }
      }
      events.on('output', check)
      check()
    }),
  }
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].setEncoding('utf8')
    child[stream].on('data', (data: string) => {
      harness.loggedBeforeOutput &&= existsSync(logPath)
      harness[stream] += data
      events.emit('output')
    })
  }
  children.push(harness)
  return harness
}

async function initialize(protocol: Protocol, extra: string[] = [], executable = cli, env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const harness = launch([...argsFor(protocol), ...extra], env, executable)
  const name = protocol === 'omp' && (extra.includes('--resume') || extra.includes('--session')) ? 'init_resume' : 'init'
  for (const line of lines(golden(protocol, name, 'in'))) harness.send(line)
  await harness.until(() => harness.stdout.endsWith('\n') && lines(harness.stdout).length >= lines(golden(protocol, name)).length)
  expect(lines(harness.stdout)).toEqual(lines(golden(protocol, name)))
  harness.stdout = ''
  return harness
}

function prompt(protocol: Protocol, text: string, turn = 1): object {
  return protocol === 'claude'
    ? { type: 'user', session_id: `session_T${turn}`, message: { role: 'user', content: text } }
    : { type: 'prompt', id: `req_T${turn}_prompt`, message: text }
}

function completed(protocol: Protocol, stdout: string): boolean {
  return stdout.split('\n').slice(0, -1).some((line) => line && JSON.parse(line).type === (protocol === 'claude' ? 'result' : 'prompt_result'))
}

/** Ends stdin and answers the fake's exit code, for the test to assert. */
async function finish(harness: Harness): Promise<number | null> {
  harness.child.stdin.end()
  return harness.closed
}

function assertLog(harness: Harness, mode: string, present = false): void {
  const logText = readFileSync(harness.logPath, 'utf8')
  const records = lines(logText)
  expect(records).toHaveLength(1)
  expect(harness.child.spawnfile).toBe(process.execPath)
  expect(JSON.parse(records[0])).toMatchObject({ mode, pid: harness.child.pid, argv: harness.child.spawnargs.slice(2), cwd: scratch, env: { DM_SESSION_TOKEN: present ? 'present' : 'absent' } })
  expect(logText).not.toContain(grant)
  expect(logText).not.toContain('fixtureSecret')
  expect(harness.loggedBeforeOutput).toBe(true)
}

it('retains its Node-input shebang without requiring executable metadata and every golden file is LF-only', () => {
  expect(readFileSync(cli, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/)
  for (const protocol of protocols) {
    for (const file of readdirSync(join(fixtures, protocol))) {
      expect(readFileSync(join(fixtures, protocol, file), 'utf8'), `${protocol}/${file}`).not.toContain('\r')
    }
  }
})

async function sendGoldenCommands(harness: Harness, protocol: Protocol, scenario: string): Promise<void> {
  if (protocol !== 'omp') return
  const expected = lines(golden(protocol, scenario))
  const commands = lines(golden(protocol, scenario, 'in')).map((line) => JSON.parse(line))
  for (const command of commands.filter((frame) => ['get_subagent_messages', 'follow_up'].includes(frame.type))) {
    const responseIndex = expected.findIndex((line) => JSON.parse(line).id === command.id)
    await harness.until(() => harness.stdout.includes(`${expected[responseIndex - 1]}\n`))
    harness.send(command)
  }
}

const runTest = it
for (const protocol of protocols) {
  {
    const it = (name: string, body: () => Promise<void>): void => { runTest(`${protocol} protocol: ${name}`, body) }
    const scenarios = readdirSync(join(fixtures, protocol)).filter((file) => file.endsWith('.out.jsonl') && !file.startsWith('init')).map((file) => file.replace('.out.jsonl', ''))
    for (const scenario of scenarios) {
      it(`replays ${scenario} turn 1 byte-for-byte against the golden`, async () => {
        const harness = await initialize(protocol)
        harness.send(prompt(protocol, `[${scenario}]`))
        const expected = golden(protocol, scenario)
        const request = lines(expected).find((line) => {
          const frame = JSON.parse(line)
          return frame.type === 'control_request' || frame.type === 'extension_ui_request' && ['select', 'ask'].includes(frame.method)
        })
        if (request) {
          await harness.until(() => harness.stdout.includes(request))
          harness.send(lines(golden(protocol, scenario, 'in'))[1])
        }
        await sendGoldenCommands(harness, protocol, scenario)
        await harness.until(() => completed(protocol, harness.stdout))
        let remainder = ''
        if (protocol === 'omp' && scenario === 'queued') {
          remainder = '{"type":"queue_update","steering":[],"followUp":[]}\n'
            + lines(golden(protocol, 'text').replaceAll('T1', 'T2')).slice(1).join('\n').replaceAll('req_T2_prompt', 'req_T1_followup') + '\n'
          await harness.until(() => harness.stdout.length >= expected.length + remainder.length)
        }
        expect(await finish(harness)).toBe(0)
        expect(lines(harness.stdout.slice(0, expected.length))).toEqual(lines(expected))
        expect(harness.stdout).toBe(expected + remainder)
        assertLog(harness, protocol)
      })
    }

    it('two text turns have disjoint ids and exact T1 to T2 renumbering', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, 'Hello'))
      await harness.until(() => completed(protocol, harness.stdout))
      const first = harness.stdout
      harness.stdout = ''
      harness.send(prompt(protocol, 'Hello again', 2))
      await harness.until(() => completed(protocol, harness.stdout))
      expect(await finish(harness)).toBe(0)
      expect(first).toBe(golden(protocol, 'text'))
      expect(harness.stdout).toBe(first.replaceAll('T1', 'T2'))
      const ids = (text: string): Set<string> => new Set(text.match(/[a-z_]+T\d+[a-z_\d]*/g))
      expect([...ids(first)].filter((id) => ids(harness.stdout).has(id))).toEqual([])
    })

    for (const scenario of ['approval', 'approval_chat', 'question']) {
      it(`${scenario} blocks until its matching answer, not a different answer`, async () => {
        const harness = await initialize(protocol)
        harness.send(prompt(protocol, `[${scenario}]`))
        const expected = lines(golden(protocol, scenario))
        const requestIndex = expected.findIndex((line) => {
          const frame = JSON.parse(line)
          return frame.type === (protocol === 'claude' ? 'control_request' : 'extension_ui_request')
        })
        await harness.until(() => harness.stdout.includes(expected[requestIndex]))
        const answer = lines(golden(protocol, scenario, 'in'))[1]
        harness.send(answer.replaceAll('T1', 'WRONG'))
        // A correlated initialization round-trip is a deterministic input-processing barrier.
        const barrier = protocol === 'claude' ? { type: 'control_request', request_id: 'barrier', request: { subtype: 'initialize' } } : { type: 'get_state', id: 'barrier' }
        harness.send(barrier)
        const barrierOutput = protocol === 'claude'
          ? golden(protocol, 'init').replaceAll('req_T1_initialize', 'barrier')
          : `${JSON.stringify({ ...JSON.parse(lines(golden(protocol, 'init')).at(-1)!), id: 'barrier' })}\n`
        await harness.until(() => harness.stdout.includes(barrierOutput))
        const prefix = expected.slice(0, requestIndex + 1).join('\n') + '\n'
        expect(harness.stdout.startsWith(prefix)).toBe(true)
        expect(completed(protocol, harness.stdout)).toBe(false)
        harness.stdout = prefix
        harness.send(answer)
        await harness.until(() => completed(protocol, harness.stdout))
        expect(await finish(harness)).toBe(0)
        expect(harness.stdout).toBe(golden(protocol, scenario))
      })
    }

    it('interrupt during slow ends the turn with the golden interrupt tail', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, '[slow]'))
      await harness.until(() => harness.stdout.length > 0)
      const prefix = harness.stdout
      harness.send(lines(golden(protocol, 'interrupt', 'in'))[1])
      await harness.until(() => completed(protocol, harness.stdout))
      expect(await finish(harness)).toBe(0)
      const expected = lines(golden(protocol, 'interrupt'))
      const tail = expected.findIndex((line) => {
        const frame = JSON.parse(line)
        return protocol === 'claude' ? frame.type === 'control_response' : frame.command === 'abort'
      })
      expect(harness.stdout).toBe(prefix + expected.slice(tail).join('\n') + '\n')
    })

    it('queues input during slow, preserving complete turn order and fresh ids', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, '[slow]'))
      await harness.until(() => harness.stdout.length > 0)
      harness.send(prompt(protocol, 'Second turn', 2))
      const expected = golden(protocol, 'text') + golden(protocol, 'text').replaceAll('T1', 'T2')
      await harness.until(() => harness.stdout.length >= expected.length)
      expect(await finish(harness)).toBe(0)
      expect(harness.stdout).toBe(expected)
    })

    it('leaks its env token only in a tool result and stderr, never the invocation log', async () => {
      const harness = await initialize(protocol, [], cli, { DM_SESSION_TOKEN: grant })
      harness.send(prompt(protocol, '[leak]'))
      await harness.until(() => completed(protocol, harness.stdout))
      expect(await finish(harness)).toBe(0)
      expect(harness.stderr).toBe(`${grant}\n`)
      const frame = lines(harness.stdout).map((line) => JSON.parse(line)).find((value) => value.type === (protocol === 'claude' ? 'user' : 'tool_execution_end'))
      expect(JSON.stringify(frame)).toContain(grant)
      assertLog(harness, protocol, true)
    })

    it('crashes with exit 3 and exactly one stderr line', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, '[crash]'))
      expect(await harness.closed).toBe(3)
      expect(harness.stderr).toBe('fake-agent crash\n')
      assertLog(harness, protocol)
    })

    it('exits 0 on EOF while waiting for a question answer', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, '[question]'))
      await harness.until(() => harness.stdout.includes(protocol === 'claude' ? 'control_request' : 'extension_ui_request'))
      expect(await finish(harness)).toBe(0)
    })

    it('exits 0 on EOF during slow without finishing the pending turn', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, '[slow]'))
      await harness.until(() => harness.stdout.length > 0)
      expect(await finish(harness)).toBe(0)
      expect(completed(protocol, harness.stdout)).toBe(false)
    })

    it('replays a newly added worker_approval fixture generically and blocks for its answer', async () => {
      // The later approval ticket owns real worker golden data. This isolated alias proves extension support.
      const copied = join(scratch, 'fixtures')
      cpSync(fixtures, copied, { recursive: true })
      cpSync(join(fixtures, protocol, 'approval.out.jsonl'), join(copied, protocol, 'worker_approval.out.jsonl'))
      const harness = await initialize(protocol, [], join(copied, 'fakeAgentCli.mjs'))
      harness.send(prompt(protocol, '[worker_approval]'))
      await harness.until(() => harness.stdout.includes(protocol === 'claude' ? 'control_request' : 'extension_ui_request'))
      expect(completed(protocol, harness.stdout)).toBe(false)
      harness.send(lines(golden(protocol, 'approval', 'in'))[1])
      await harness.until(() => completed(protocol, harness.stdout))
      expect(await finish(harness)).toBe(0)
      expect(harness.stdout).toBe(golden(protocol, 'approval'))
    })
  }

  {
    const it = (name: string, body: () => Promise<void>): void => { runTest(`${protocol} arbiter: ${name}`, body) }
    for (const verdict of ['allow', 'deny', 'escalate', 'garbage', 'fenced']) {
      for (const source of ['keyword', 'env']) {
        it(`${source} selects ${verdict} with the correct envelope and log first`, async () => {
          const harness = launch(arbiterArgs(protocol), source === 'env' ? { FAKE_ARBITER_VERDICT: verdict } : {})
          harness.child.stdin.end(source === 'env' ? '[arbiter:crash]' : `[arbiter:${verdict}]`)
          expect(await harness.closed).toBe(0)
          const decision = verdict === 'allow' || verdict === 'fenced' ? 'allow_once' : verdict === 'deny' ? 'deny' : 'escalate'
          const json = JSON.stringify({ decision, reason: `fake ${decision}` })
          const text = verdict === 'garbage' ? 'I think it is fine.' : verdict === 'fenced' ? `\`\`\`json\n${json}\n\`\`\`` : json
          expect(harness.stdout).toBe(protocol === 'claude' ? `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: '00000000-0000-4000-8000-000000000000' })}\n` : `${text}\n`)
          assertLog(harness, 'arbiter')
          expect(JSON.parse(readFileSync(harness.logPath, 'utf8')).stdinHasSecret).toBe(false)
        })
      }
    }

    it('defaults to escalate/fake default without creating a session', async () => {
      const harness = launch([...arbiterArgs(protocol), '--session-id', sessionId])
      harness.child.stdin.end('ordinary arbiter prompt')
      expect(await harness.closed).toBe(0)
      const text = protocol === 'claude' ? JSON.parse(harness.stdout).result : harness.stdout
      expect(JSON.parse(text)).toEqual({ decision: 'escalate', reason: 'fake default' })
      expect(existsSync(join(scratch, 'config'))).toBe(false)
    })

    it('uses the first stdin verdict keyword', async () => {
      const harness = launch(arbiterArgs(protocol))
      harness.child.stdin.end('[arbiter:deny] [arbiter:allow]')
      expect(await harness.closed).toBe(0)
      const text = protocol === 'claude' ? JSON.parse(harness.stdout).result : harness.stdout
      expect(JSON.parse(text).decision).toBe('deny')
    })

    for (const token of [grant, claim]) {
      it(`records only stdinHasSecret for a planted ${token === grant ? 'grant' : 'claim'} token`, async () => {
        const harness = launch(arbiterArgs(protocol))
        harness.child.stdin.end(`Secret ${token} [arbiter:allow]`)
        expect(await harness.closed).toBe(0)
        const log = readFileSync(harness.logPath, 'utf8')
        expect(JSON.parse(log).stdinHasSecret).toBe(true)
        expect(log).not.toContain(token)
        expect(log).not.toContain('Secret ')
        assertLog(harness, 'arbiter')
      })
    }

    for (const source of ['env', 'keyword']) {
      it(`${source} hang stays alive after EOF until killed without output or a session`, async () => {
        const harness = launch([...arbiterArgs(protocol), '--session-id', sessionId], source === 'env' ? { FAKE_ARBITER_VERDICT: 'hang' } : {})
        harness.child.stdin.end(source === 'keyword' ? '[arbiter:hang]' : '[arbiter:allow]')
        await expect.poll(() => existsSync(harness.logPath)).toBe(true)
        expect(harness.child.exitCode).toBeNull()
        expect(harness.child.signalCode).toBeNull()
        expect(harness.stdout).toBe('')
        expect(harness.stderr).toBe('')
        expect(existsSync(join(scratch, 'config'))).toBe(false)
        assertLog(harness, 'arbiter')
        harness.child.kill('SIGKILL')
        await harness.closed
      })

      it(`${source} crash exits 3 after one stderr line`, async () => {
        const harness = launch(arbiterArgs(protocol), source === 'env' ? { FAKE_ARBITER_VERDICT: 'crash' } : {})
        harness.child.stdin.end(source === 'keyword' ? '[arbiter:crash]' : '[arbiter:allow]')
        expect(await harness.closed).toBe(3)
        expect(harness.stdout).toBe('')
        expect(harness.stderr).toBe('fake-agent crash\n')
        assertLog(harness, 'arbiter')
      })
    }
  }
}

for (const scenario of ['subagent', 'subagent_tree']) {
  it(`OMP ${scenario} gates each tail on the matching subagent and echoes non-golden request ids on two turns`, async () => {
    const harness = await initialize('omp')
    for (const turn of [1, 2]) {
      harness.stdout = ''
      harness.send(prompt('omp', `[${scenario}]`, turn))
      let expected = golden('omp', scenario).replaceAll('T1', `T${turn}`)
      const commands = lines(golden('omp', scenario, 'in').replaceAll('T1', `T${turn}`)).slice(1).map((line) => JSON.parse(line))
      for (const [index, command] of commands.entries()) {
        const frames = lines(expected)
        const responseIndex = frames.findIndex((line) => JSON.parse(line).id === command.id)
        await harness.until(() => harness.stdout.includes(`${frames[responseIndex - 1]}\n`))
        harness.send({ ...command, id: 'wrong-subagent-query', subagentId: 'absent-worker' })
        harness.send({ type: 'get_state', id: 'tail-barrier' })
        const barrier = `${JSON.stringify({ ...JSON.parse(lines(golden('omp', 'init')).at(-1)!), id: 'tail-barrier' })}\n`
        await harness.until(() => harness.stdout.includes(barrier))
        expect(harness.stdout.replace(barrier, '')).toBe(frames.slice(0, responseIndex).join('\n') + '\n')
        harness.stdout = harness.stdout.replace(barrier, '')
        const actualId = `consumer-${turn}-${index}`
        harness.send({ ...command, id: actualId })
        expected = expected.replaceAll(command.id, actualId)
        await harness.until(() => harness.stdout.includes(`"id":"${actualId}"`))
      }
      await harness.until(() => completed('omp', harness.stdout))
      expect(harness.stdout).toBe(expected)
    }
    expect(await finish(harness)).toBe(0)
  })
}

for (const type of ['follow_up', 'steer']) {
  it(`OMP acknowledges actual ${type} admission during slow and replays its queued turn without a false prompt acknowledgement`, async () => {
    const harness = await initialize('omp')
    harness.send(prompt('omp', '[slow]'))
    await harness.until(() => harness.stdout.includes('message_update'))
    const id = `consumer-${type}`
    harness.send({ type, id, message: 'Second turn' })
    const acknowledgement = `${JSON.stringify({ type: 'response', command: type, id, success: true })}\n`
    const queued = `${JSON.stringify({ type: 'queue_update', steering: type === 'steer' ? ['Second turn'] : [], followUp: type === 'follow_up' ? ['Second turn'] : [] })}\n`
    await harness.until(() => harness.stdout.includes(queued))
    expect(harness.stdout).toContain(acknowledgement + queued)
    expect(completed('omp', harness.stdout)).toBe(false)
    await harness.until(() => harness.stdout.split('\n').slice(0, -1).filter((line) => JSON.parse(line).type === 'prompt_result').length === 2)
    expect(await finish(harness)).toBe(0)
    const withoutAdmission = harness.stdout.replace(acknowledgement + queued, '')
    const secondTurn = lines(golden('omp', 'text').replaceAll('T1', 'T2')).slice(1).join('\n').replaceAll('req_T2_prompt', id) + '\n'
    expect(withoutAdmission).toBe(golden('omp', 'text') + '{"type":"queue_update","steering":[],"followUp":[]}\n' + secondTurn)
    const responses = lines(harness.stdout).map((line) => JSON.parse(line)).filter((frame) => frame.type === 'response' && frame.id === id)
    expect(responses).toEqual([{ type: 'response', command: type, id, success: true }])
  })
}

it('OMP --resume and --session answer get_state with nonempty todoPhases', async () => {
  for (const flag of ['--resume', '--session']) {
    const harness = await initialize('omp', [flag, 'saved-session.jsonl'])
    harness.send({ type: 'get_state', id: 'resumed-state' })
    await harness.until(() => harness.stdout.includes('resumed-state'))
    expect(JSON.parse(harness.stdout).data.todoPhases.length).toBeGreaterThan(0)
    expect(await finish(harness)).toBe(0)
  }
})

it('OMP rpc mode waits for subscription and correlates its response', async () => {
  const harness = launch(['--mode', 'rpc'])
  await harness.until(() => harness.stdout.length > 0)
  expect(harness.stdout).toBe(`${lines(golden('omp', 'init'))[0]}\n`)
  harness.stdout = ''
  harness.send({ type: 'set_subagent_subscription', id: 'custom-subscription', level: 'progress' })
  await harness.until(() => harness.stdout.includes('custom-subscription'))
  expect(await finish(harness)).toBe(0)
  expect(JSON.parse(harness.stdout)).toEqual({ type: 'response', command: 'set_subagent_subscription', id: 'custom-subscription', success: true })
})

for (const [protocol, keyword, target] of [['omp', 'tasks', 'todo'], ['claude', 'todo_clear', 'text'], ['claude', 'unknown_scenario', 'text']] as const) {
  it(`${protocol} maps ${keyword} to ${target}`, async () => {
    const harness = await initialize(protocol)
    harness.send(prompt(protocol, `[${keyword}]`))
    await harness.until(() => completed(protocol, harness.stdout))
    expect(await finish(harness)).toBe(0)
    expect(harness.stdout).toBe(golden(protocol, target))
  })
}

/**
 * Instructions with the app's `dm` line (a runtime prefix, a quoted program and script, a pinned repository) and
 * the first-message naming section; the "dm" is a Node script that records how it was called.
 */
function namingInstructions(): { file: string; record: string } {
  const record = join(scratch, 'name-chat.json')
  const recorder = join(scratch, 'dm-recorder.mjs')
  const body = 'JSON.stringify({ argv: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE })'
  // Written beside the record, then renamed onto it: the test reads the record as soon as it exists.
  writeFileSync(recorder, `import { renameSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(`${record}.part`)}, ${body})\nrenameSync(${JSON.stringify(`${record}.part`)}, ${JSON.stringify(record)})\n`)
  const line = `ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${recorder}' --repo ${scratch.replaceAll('\\', '/')}`
  const file = join(scratch, 'instructions.md')
  writeFileSync(file, ['```sh', `${line} --list`, `${line} call get_capabilities '{}'  # run a command`, '```', '', '## First-message chat naming', 'Name it.'].join('\n'))
  return { file, record }
}

for (const protocol of protocols) {
  it(`${protocol} names the chat on its first message through the instructions' dm line with FAKE_AGENT_NAME_CHATS`, async () => {
    const { file, record } = namingInstructions()
    const flag = protocol === 'claude' ? '--append-system-prompt-file' : '--append-system-prompt'
    const harness = await initialize(protocol, [flag, file], cli, { FAKE_AGENT_NAME_CHATS: '1' })
    harness.send(prompt(protocol, 'hello'))
    await harness.until(() => completed(protocol, harness.stdout))
    while (!existsSync(record)) await delay(20)
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
      argv: ['--repo', scratch.replaceAll('\\', '/'), 'call', 'name_chat', '{"title":"Fake agent conversation"}'],
      runAsNode: '1'
    })
    expect(await finish(harness)).toBe(0)
    expect(harness.stderr).toBe('')
  })
}

it('OMP accepts chunked input and renumbers decoded chunk ids on later turns', async () => {
  const harness = await initialize('omp')
  const wire = JSON.stringify(prompt('omp', '[chunked]'))
  const pieces = [wire.slice(0, 30), wire.slice(30)]
  pieces.forEach((part, index) => harness.send({ type: 'rpc_chunk', chunkId: 'host', index, count: 2, byteLength: Buffer.byteLength(wire), data: Buffer.from(part).toString('base64') }))
  await harness.until(() => completed('omp', harness.stdout))
  expect(harness.stdout).toBe(golden('omp', 'chunked'))
  harness.stdout = ''
  harness.send(prompt('omp', '[chunked]', 2))
  await harness.until(() => completed('omp', harness.stdout))
  expect(await finish(harness)).toBe(0)
  const chunks = lines(harness.stdout).map((line) => JSON.parse(line)).filter((frame) => frame.type === 'rpc_chunk')
  const bytes = Buffer.concat(chunks.map((frame) => Buffer.from(frame.data, 'base64')))
  expect(bytes.length).toBe(chunks[0].byteLength)
  expect(JSON.parse(bytes.toString('utf8')).toolCallId).toBe('call_T2_chunk')
  expect(chunks.every((frame) => frame.chunkId === 'chunk_T2_cli')).toBe(true)
})

for (const [argv, env, mode, stdout, code] of [
  [['--version'], {}, 'version', '2.1.329 (Claude Code)\n', 0],
  [['auth', 'status'], {}, 'auth', '{"loggedIn":true}\n', 0],
  [['auth', 'status'], { FAKE_AGENT_SIGNED_OUT: '1' }, 'auth', '{"loggedIn":false}\n', 1],
] as const) {
  it(`${argv.join(' ')} ${code === 1 ? 'signed out' : 'signed in'} prints exact output and logs first`, async () => {
    const harness = launch([...argv], { ...env, DM_SESSION_TOKEN: grant })
    expect(await harness.closed).toBe(code)
    expect(harness.stdout).toBe(stdout)
    expect(harness.stderr).toBe('')
    assertLog(harness, mode, true)
  })
}

it('TUI echoes each stdin line including final unterminated input and exits 0 on EOF', async () => {
  const harness = launch(['--session-id', sessionId], { DM_SESSION_TOKEN: grant })
  await harness.until(() => harness.stdout.includes('fake-tui ready'))
  harness.child.stdin.end('first\r\nsecond\nlast')
  expect(await harness.closed).toBe(0)
  expect(harness.stdout).toBe(`fake-tui ready ${sessionId}\nfirst\nsecond\nlast\n`)
  assertLog(harness, 'tui', true)
})

for (const argv of [[], argsFor('claude'), argsFor('omp')]) {
  it(`${argv.join(' ') || 'TUI'} exits 0 on immediate stdin EOF`, async () => {
    const harness = launch(argv)
    expect(await finish(harness)).toBe(0)
  })
  if (process.platform !== 'win32') {
    it(`${argv.join(' ') || 'TUI'} exits 0 on delivered SIGTERM`, async () => {
      const harness = launch(argv)
      if (argv.includes('stream-json')) harness.send(lines(golden('claude', 'init', 'in'))[0])
      await harness.until(() => harness.stdout.length > 0)
      harness.child.kill('SIGTERM')
      expect(await harness.closed).toBe(0)
    })
  }
}

for (const argv of [[], argsFor('claude'), argsFor('omp')]) {
  it(`${argv.join(' ') || 'TUI'} writes a resumable session under the isolated CLAUDE_CONFIG_DIR`, async () => {
    const harness = launch([...argv, '--session-id', sessionId])
    expect(await finish(harness)).toBe(0)
    expect(claudeSessionExists({ env: { CLAUDE_CONFIG_DIR: join(scratch, 'config') }, platform: process.platform, folder: scratch, sessionId })).toBe(true)
  })
}
