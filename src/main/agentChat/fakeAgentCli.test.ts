import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { contextReceipts } from '../../../resources/skitarii/extension/contextDelivery'
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
    env: { ...process.env, DM_SESSION_TOKEN: undefined, FAKE_AGENT_SIGNED_OUT: undefined, FAKE_ARBITER_VERDICT: undefined, FAKE_AGENT_PERSONA: undefined, CLAUDE_CONFIG_DIR: join(scratch, 'config'), FAKE_AGENT_LOG: logPath, ...env },
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

function prompt(protocol: Protocol, text: string, turn = 1, id = `req_T${turn}_prompt`): object {
  return protocol === 'claude'
    ? { type: 'user', session_id: `session_T${turn}`, message: { role: 'user', content: text } }
    : { type: 'prompt', id, message: text }
}

/** The prompt id a scenario's OMP golden answers, which the replay echoes back as the id it was sent. */
function goldenPromptId(scenario: string): string {
  return lines(golden('omp', scenario, 'in')).map((line) => JSON.parse(line)).find((frame) => frame.type === 'prompt')?.id ?? 'req_T1_prompt'
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
        harness.send(prompt(protocol, `[${scenario}]`, 1, protocol === 'omp' ? goldenPromptId(scenario) : undefined))
        const expected = golden(protocol, scenario)
        const requests = lines(expected).filter((line) => {
          const frame = JSON.parse(line)
          return frame.type === 'control_request' || frame.type === 'extension_ui_request' && ['select', 'ask', 'input', 'editor'].includes(frame.method)
        })
        // An OMP ask tool form (`ask_multi_q*`) asks one request at a time; each gets the golden response with its id.
        const responses = lines(golden(protocol, scenario, 'in')).slice(1)
        for (const [index, request] of requests.entries()) {
          await harness.until(() => harness.stdout.includes(request))
          const id = JSON.parse(request).id
          harness.send(protocol === 'omp' ? responses.find((line) => JSON.parse(line).id === id)! : responses[index])
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

    it('multiselect asks the multi then the single question and echoes the answers it received', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, '[multiselect]'))
      const expected = golden(protocol, 'question_multi')
      const request = lines(expected).find((line) => ['control_request', 'extension_ui_request'].includes(JSON.parse(line).type))!
      const questions = protocol === 'claude' ? JSON.parse(request).request.input.questions : JSON.parse(request).questions
      expect(questions.map((question: Record<string, unknown>) => question.multiSelect ?? question.multi)).toEqual([true, false])
      expect(questions[0].options).toHaveLength(4)
      await harness.until(() => harness.stdout.includes(request))
      // Not the golden's answers: the echo must report what reached the CLI.
      const answer = JSON.parse(lines(golden(protocol, 'question_multi', 'in'))[1])
      const holder = protocol === 'claude' ? answer.response.response.updatedInput : answer
      const echo = (value: unknown): string => JSON.stringify(`answers: ${JSON.stringify(value)}`)
      const goldenEcho = echo(holder.answers)
      holder.answers = protocol === 'claude' ? { 'Which letters?': 'B, D', 'Which database?': 'Postgres' }
        : [{ id: 'q_T1_databases', selectedOptions: ['MySQL', 'DuckDB'] }, { id: 'q_T1_region', selectedOptions: ['US'] }]
      harness.send(answer)
      await harness.until(() => completed(protocol, harness.stdout))
      expect(await finish(harness)).toBe(0)
      expect(expected).toContain(goldenEcho)
      expect(harness.stdout).toBe(expected.replaceAll(goldenEcho, echo(holder.answers)))
    })

    if (protocol === 'omp') it('[ask-multi-q] replays the recorded OMP 18.20.2 ask form one request at a time and echoes every response it received', async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, '[ask-multi-q]'))
      const expected = golden(protocol, 'ask_multi_q')
      const requests = lines(expected).filter((line) => JSON.parse(line).type === 'extension_ui_request')
      expect(requests.map((line) => JSON.parse(line).method)).toEqual(['select', 'select', 'input'])
      // Not the golden's answers: the echo must report what reached the CLI, in arrival order.
      const sent = lines(golden(protocol, 'ask_multi_q', 'in')).slice(1).map((line) => JSON.parse(line))
      sent[2].value = 'Something else'
      for (const [index, request] of requests.entries()) {
        await harness.until(() => harness.stdout.includes(request))
        expect(completed(protocol, harness.stdout)).toBe(false)
        harness.send(sent[index])
      }
      await harness.until(() => completed(protocol, harness.stdout))
      expect(await finish(harness)).toBe(0)
      const echo = (value: unknown): string => JSON.stringify(`answers: ${JSON.stringify(value)}`)
      const original = lines(golden(protocol, 'ask_multi_q', 'in')).slice(1).map((line) => JSON.parse(line))
      expect(expected).toContain(echo(original))
      expect(harness.stdout).toBe(expected.replaceAll(echo(original), echo(sent)))
    })

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

it('OMP starts on FAKE_AGENT_OMP_START_MODEL and _THINKING without --model, and logs each session control to FAKE_AGENT_CONTROL_LOG', async () => {
  const controls = join(scratch, 'controls.jsonl')
  const harness = launch(argsFor('omp'), { FAKE_AGENT_OMP_START_MODEL: 'anthropic/claude-opus-5-5', FAKE_AGENT_OMP_START_THINKING: 'high', FAKE_AGENT_CONTROL_LOG: controls })
  const reply = async (message: Record<string, string>): Promise<{ success: boolean; data?: object }> => {
    harness.send(message)
    await harness.until(() => lines(harness.stdout).some((line) => line.includes(`"id":"${message.id}"`)))
    return JSON.parse(lines(harness.stdout).find((line) => line.includes(`"id":"${message.id}"`)) ?? '')
  }
  expect((await reply({ type: 'get_state', id: 'start-state' })).data).toMatchObject({ model: { provider: 'anthropic', id: 'claude-opus-5-5' }, thinkingLevel: 'high' })
  expect(existsSync(controls)).toBe(false)
  expect((await reply({ type: 'set_model', id: 'switch-model', provider: 'openai-codex', modelId: 'gpt-6.1-sol' })).success).toBe(true)
  expect((await reply({ type: 'set_thinking_level', id: 'switch-effort', level: 'medium' })).success).toBe(true)
  expect((await reply({ type: 'get_state', id: 'switched-state' })).data).toMatchObject({ model: { provider: 'openai-codex', id: 'gpt-6.1-sol' }, thinkingLevel: 'medium' })
  expect(await finish(harness)).toBe(0)
  expect(lines(readFileSync(controls, 'utf8')).map((line) => JSON.parse(line))).toEqual([
    { pid: harness.child.pid, at: expect.any(Number), type: 'set_model', provider: 'openai-codex', modelId: 'gpt-6.1-sol', busy: false },
    { pid: harness.child.pid, at: expect.any(Number), type: 'set_thinking_level', level: 'medium', busy: false }
  ])
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

const swatch = readFileSync(join(fixtures, 'images', 'swatch.png'))
/** A second image, distinct in type, length and hash from the swatch; the fake echoes bytes without decoding them. */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])
const echoLine = (mimeType: string, bytes: Buffer): string => `received image ${mimeType} ${bytes.length} ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`

function imagePrompt(protocol: Protocol, text: string, images: Array<[string, Buffer]>, turn: number): object {
  return protocol === 'claude'
    ? { type: 'user', session_id: `session_T${turn}`, message: { role: 'user', content: [...images.map(([mimeType, bytes]) => ({ type: 'image', source: { type: 'base64', media_type: mimeType, data: bytes.toString('base64') } })), { type: 'text', text }] } }
    : { type: 'prompt', id: `req_T${turn}_prompt`, message: text, images: images.map(([mimeType, bytes]) => ({ type: 'image', mimeType, data: bytes.toString('base64') })) }
}

/** A turn's reply text: Claude's result, or OMP's first ended assistant message text. */
function replyText(protocol: Protocol, stdout: string): string {
  const frames = lines(stdout).map((line) => JSON.parse(line))
  if (protocol === 'claude') return frames.find((frame) => frame.type === 'result').result
  return frames.find((frame) => frame.type === 'message_end' && frame.message.role === 'assistant' && frame.message.content.some((block: { type: string }) => block.type === 'text'))
    .message.content.find((block: { type: string }) => block.type === 'text').text
}

for (const protocol of protocols) {
  it(`${protocol} echoes received image for swatch.png and turn 1 of the image_in input equals the golden`, async () => {
    const harness = await initialize(protocol)
    for (const line of lines(golden(protocol, 'image_in', 'in'))) harness.send(line)
    await harness.until(() => completed(protocol, harness.stdout))
    expect(await finish(harness)).toBe(0)
    expect(echoLine('image/png', swatch)).toBe('received image image/png 132 6f7ffeeb8892')
    expect(replyText(protocol, harness.stdout)).toBe(echoLine('image/png', swatch))
    expect(harness.stdout).toBe(golden(protocol, 'image_in'))
  })

  it(`${protocol} [image] replays image_result: turn 1 equals the golden and turn 2 renumbers T1 to T2`, async () => {
    const harness = await initialize(protocol)
    harness.send(prompt(protocol, 'Read swatch.png [image]', 1, goldenPromptId('image_result')))
    await harness.until(() => completed(protocol, harness.stdout))
    const first = harness.stdout
    harness.stdout = ''
    harness.send(prompt(protocol, 'Read swatch.png again [image]', 2, goldenPromptId('image_result').replace('T1', 'T2')))
    await harness.until(() => completed(protocol, harness.stdout))
    expect(await finish(harness)).toBe(0)
    expect(first).toBe(golden(protocol, 'image_result'))
    expect(harness.stdout).toBe(golden(protocol, 'image_result').replaceAll('T1', 'T2'))
  })

  it(`${protocol} a turn with two images echoes two lines in order, before the chosen scenario's reply`, async () => {
    const harness = await initialize(protocol)
    harness.send(imagePrompt(protocol, 'what colour', [['image/png', swatch], ['image/jpeg', jpeg]], 1))
    await harness.until(() => completed(protocol, harness.stdout))
    const first = harness.stdout
    harness.stdout = ''
    harness.send(imagePrompt(protocol, 'Read swatch.png [image]', [['image/jpeg', jpeg], ['image/png', swatch]], 2))
    await harness.until(() => completed(protocol, harness.stdout))
    expect(await finish(harness)).toBe(0)
    expect(replyText(protocol, first)).toBe(`${echoLine('image/png', swatch)}\n${echoLine('image/jpeg', jpeg)}`)
    expect(replyText(protocol, harness.stdout)).toBe(`${echoLine('image/jpeg', jpeg)}\n${echoLine('image/png', swatch)}\nRed`)
    if (protocol === 'claude') return
    const frames = lines(first).map((line) => JSON.parse(line))
    expect(frames.find((frame) => frame.type === 'message_start' && frame.message.role === 'user').message.content).toEqual([
      { type: 'text', text: 'what colour' },
      { type: 'image', mimeType: 'image/png', data: swatch.toString('base64') },
      { type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') },
    ])
    expect(frames.at(-1)).toEqual({ type: 'prompt_result', id: 'req_T1_prompt', agentInvoked: true, status: 'completed' })
    expect(JSON.parse(lines(harness.stdout).at(-1) ?? '')).toMatchObject({ type: 'prompt_result', id: 'req_T2_prompt' })
  })

  for (const [keyword, text, reply] of [
    ['echo', '[echo] first line\nsecond line', 'first line\nsecond line'],
    ['markdown', 'Show the fix [markdown]', 'Here is the **fix**:\n\n```js\nconst answer = 42\nconsole.log(answer)\n```']
  ] as const) {
    it(`${protocol} [${keyword}] streams and stores the same scripted reply on the text golden`, async () => {
      const harness = await initialize(protocol)
      harness.send(prompt(protocol, text))
      await harness.until(() => completed(protocol, harness.stdout))
      expect(await finish(harness)).toBe(0)
      expect(replyText(protocol, harness.stdout)).toBe(reply)
      const deltas = lines(harness.stdout).map((line) => JSON.parse(line)).map((frame) => protocol === 'claude'
        ? frame.event?.delta?.type === 'text_delta' ? frame.event.delta.text : null
        : frame.assistantMessageEvent?.type === 'text_delta' ? frame.assistantMessageEvent.delta : null).filter((delta) => delta !== null)
      expect(deltas).toEqual([reply])
      expect(lines(harness.stdout)).toHaveLength(lines(golden(protocol, 'text')).length - 1)
    })
  }
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

/**
 * Instructions whose `dm` line runs a Node stand-in for the dm CLI: it appends each call (command, arguments and
 * whether the run's grant reached it) to `calls` and answers `list_agent_peers` (an orchestrator peer only),
 * `send_agent_message` and `read_agent_inbox` (one message) as the CLI does.
 */
function mailInstructions(): { file: string; calls: string } {
  const calls = join(scratch, 'dm-calls.jsonl')
  const stub = join(scratch, 'dm-stub.mjs')
  writeFileSync(stub, [
    "import { appendFileSync } from 'node:fs'",
    "const args = process.argv.slice(2), at = args.indexOf('call'), command = args[at + 1], input = JSON.parse(args[at + 2])",
    `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, input, grant: process.env.DM_SESSION_TOKEN !== undefined }) + '\\n')`,
    'const answers = {',
    "  list_agent_peers: () => ({ peers: input.role === 'orchestrator' ? [{ endpointId: 'ae_magos', name: 'Run', epicId: input.epicId, role: 'orchestrator' }] : [], nextAfterId: null, hasMore: false }),",
    "  send_agent_message: () => ({ messageId: 'am_1', to: input.to, clientMessageId: input.clientMessageId, inReplyTo: null, acceptedAt: 't', duplicate: false }),",
    "  read_agent_inbox: () => ({ messages: [{ id: 'am_7', seq: 3, body: 'Revision 2 saved.', from: { endpointId: 'ae_lex', name: 'Plan', deleted: false } }], nextCursor: 3, snapshotHighWater: 3, hasMore: false })",
    '}',
    'process.stdout.write(JSON.stringify({ ok: true, data: answers[command]() }))',
    ''
  ].join('\n'))
  const line = `ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${stub}' --repo ${scratch.replaceAll('\\', '/')}`
  const file = join(scratch, 'instructions.md')
  writeFileSync(file, ['```sh', `${line} call get_capabilities '{}'  # run a command`, '```'].join('\n'))
  return { file, calls }
}

const dmCalls = (file: string): { command: string; input: Record<string, unknown>; grant: boolean }[] =>
  existsSync(file) ? lines(readFileSync(file, 'utf8')).map((line) => JSON.parse(line)) : []

it('OMP [mail] acknowledges the prompt, finds the role\'s peer in the epic and mails it with its own grant, then replies', async () => {
  const { file, calls } = mailInstructions()
  const harness = await initialize('omp', ['--append-system-prompt', file], cli, { DM_SESSION_TOKEN: grant })
  harness.send(prompt('omp', '[mail] orchestrator ep_1'))
  await harness.until(() => completed('omp', harness.stdout))
  expect(JSON.parse(lines(harness.stdout)[0])).toEqual({ type: 'response', command: 'prompt', id: 'req_T1_prompt', success: true })
  expect(replyText('omp', harness.stdout)).toBe('mailed the orchestrator at ae_magos')
  const [list, send, ...rest] = dmCalls(calls)
  expect(list).toEqual({ command: 'list_agent_peers', input: { epicId: 'ep_1', role: 'orchestrator' }, grant: true })
  expect(send).toMatchObject({ command: 'send_agent_message', input: { to: 'ae_magos', body: 'Fake coordination mail for the orchestrator.' }, grant: true })
  expect(rest).toEqual([])
  harness.stdout = ''
  harness.send(prompt('omp', '[mail] planner ep_1', 2))
  await harness.until(() => completed('omp', harness.stdout))
  expect(replyText('omp', harness.stdout)).toBe('mail failed: no planner peer in ep_1')
  expect(dmCalls(calls)).toHaveLength(3)
  expect(await finish(harness)).toBe(0)
  expect(harness.stderr).toBe('')
})

const browserPipe = '\\\\.\\pipe\\dm-browser-fixture'
const treeContent = '[e1] heading "Fixture"\n  [e7] button "Change text"\n  [e9] textbox "Name"\n  [e8] link "Other page"'

/**
 * Instructions whose `dm` line runs a Node stand-in for the dm CLI in `dir`: it appends each call (its argv from
 * `call` on, whether the grant reached it, its browser pipe and cwd) to `calls` and answers canned JSON per op.
 * `browser_read` fails with `stopped` from the `STUB_FAIL_READ`th read on, `browser_screenshot` with `view_hidden`
 * when STUB_HIDDEN is set, and `browser_status` plants the grant token in its reply, which the fake must never show.
 */
function browserInstructions(dir: string): { file: string; calls: string } {
  mkdirSync(dir, { recursive: true })
  const calls = join(dir, 'browser-calls.jsonl')
  const stub = join(dir, 'cli.mjs')
  writeFileSync(stub, [
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs'",
    "const all = process.argv.slice(2), argv = all.slice(all.indexOf('call')), op = argv[1], input = JSON.parse(argv[2])",
    `const log = ${JSON.stringify(calls)}`,
    "const reads = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter((line) => line.includes('\"browser_read\"')).length : 0",
    "appendFileSync(log, JSON.stringify({ argv, grant: process.env.DM_SESSION_TOKEN !== undefined, pipe: process.env.DM_BROWSER_PIPE, cwd: process.cwd() }) + '\\n')",
    "const tab = { url: 'http://127.0.0.1:4100/', title: 'Fixture', loading: false }",
    'const failAt = Number(process.env.STUB_FAIL_READ) || Infinity',
    'const answers = {',
    '  browser_navigate: () => ({ tab: { ...tab, url: input.url } }),',
    `  browser_read: () => ({ url: tab.url, title: tab.title, untrusted: true, content: input.mode === 'tree' ? ${JSON.stringify(treeContent)} : 'Clicked\\nAda', truncated: false }),`,
    '  browser_click: () => ({ tab }),',
    '  browser_type: () => ({ tab }),',
    "  browser_screenshot: () => ({ image: { id: 'img_1', mimeType: 'image/png' }, url: tab.url, path: 'C:\\\\shots\\\\fixture.png' }),",
    "  browser_status: () => ({ enabled: true, owner: 'agent', tab, pendingOrigin: null, planted: process.env.DM_SESSION_TOKEN })",
    '}',
    "const refusal = (code, message) => { process.stdout.write(JSON.stringify({ ok: false, error: { code, message } })); process.exitCode = 1 }",
    "if (op === 'browser_read' && reads + 1 >= failAt) refusal('stopped', 'The person stopped the agent.')",
    "else if (op === 'browser_screenshot' && process.env.STUB_HIDDEN === '1') refusal('view_hidden', 'The browser view is not visible.')",
    'else process.stdout.write(JSON.stringify({ ok: true, data: answers[op]() }))',
    ''
  ].join('\n'))
  const line = `ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${stub}' --repo ${scratch.replaceAll('\\', '/')}`
  const file = join(dir, 'instructions.md')
  writeFileSync(file, ['```sh', `${line} call get_capabilities '{}'  # run a command`, '```'].join('\n'))
  return { file, calls }
}

const browserCalls = (file: string): { argv: string[]; grant: boolean; pipe: string; cwd: string }[] =>
  existsSync(file) ? lines(readFileSync(file, 'utf8')).map((line) => JSON.parse(line)) : []

/** The run's `Bash` tool calls, in order: their id, command, result text and whether they failed. */
function bashCalls(protocol: Protocol, stdout: string): { id: string; command: string; result: string; isError: boolean }[] {
  const frames = lines(stdout).map((line) => JSON.parse(line))
  if (protocol === 'omp') {
    return frames.filter((frame) => frame.type === 'tool_execution_end' && frame.toolName === 'Bash')
      .map((frame) => ({ id: frame.toolCallId, command: frame.args.command, result: frame.result.content[0].text, isError: frame.isError }))
  }
  const uses = frames.filter((frame) => frame.type === 'assistant').flatMap((frame) => frame.message.content)
    .filter((block: { type: string; name?: string }) => block.type === 'tool_use' && block.name === 'Bash')
  const results = frames.filter((frame) => frame.type === 'user').flatMap((frame) => frame.message.content)
    .filter((block: { type: string }) => block.type === 'tool_result')
  return uses.map((use: { id: string; input: { command: string } }) => {
    const result = results.find((block: { tool_use_id: string }) => block.tool_use_id === use.id)
    return { id: use.id, command: use.input.command, result: result.content, isError: result.is_error }
  })
}

/** Runs one `text` turn with `instructions` (none when null) given as the protocol's instructions flag. */
async function browserRun(protocol: Protocol, text: string, instructions: string | null, env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const flag = protocol === 'claude' ? '--append-system-prompt-file' : '--append-system-prompt'
  const harness = await initialize(protocol, instructions === null ? [] : [flag, instructions], cli, { DM_SESSION_TOKEN: grant, DM_BROWSER_PIPE: browserPipe, ...env })
  harness.send(prompt(protocol, text))
  await harness.until(() => completed(protocol, harness.stdout))
  expect(await finish(harness)).toBe(0)
  expect(harness.stdout).not.toContain(grant)
  expect(harness.stderr).toBe('')
  return harness
}

for (const protocol of protocols) {
  it(`${protocol} [browser] navigates, reads, clicks, types Ada, reads and screenshots through the instructions' dm line, with its own env and cwd, as Bash tool calls`, async () => {
    const { file, calls } = browserInstructions(join(scratch, 'dm cli with spaces'))
    const harness = await browserRun(protocol, 'Drive it [browser url="http://127.0.0.1:4100/"]', file)
    const recorded = browserCalls(calls)
    expect(recorded.map((call) => call.argv)).toEqual([
      ['call', 'browser_navigate', '{"url":"http://127.0.0.1:4100/","as":"Acolyte:DM-442"}'],
      ['call', 'browser_read', '{"mode":"tree"}'],
      ['call', 'browser_click', '{"ref":"e7"}'],
      ['call', 'browser_type', '{"ref":"e9","text":"Ada"}'],
      ['call', 'browser_read', '{"mode":"text"}'],
      ['call', 'browser_screenshot', '{"label":"fixture"}']
    ])
    for (const call of recorded) expect(call).toMatchObject({ grant: true, pipe: browserPipe })
    for (const call of recorded) expect(call.cwd.toLowerCase()).toBe(scratch.toLowerCase())
    const tools = bashCalls(protocol, harness.stdout)
    expect(tools.map((tool) => tool.command)).toEqual(recorded.map((call) => `dm ${call.argv[0]} ${call.argv[1]} ${call.argv[2]}`))
    expect(tools.map((tool) => tool.id)).toEqual([1, 2, 3, 4, 5, 6].map((step) => `${protocol === 'claude' ? 'toolu' : 'call'}_T1_browser${step}`))
    expect(tools.every((tool) => !tool.isError)).toBe(true)
    expect(JSON.parse(tools[1].result)).toEqual({ ok: true, data: { url: 'http://127.0.0.1:4100/', title: 'Fixture', untrusted: true, content: treeContent, truncated: false } })
    expect(JSON.parse(tools[5].result)).toMatchObject({ ok: true, data: { path: 'C:\\shots\\fixture.png' } })
    expect(replyText(protocol, harness.stdout)).toBe('browser done')
  })

  it(`${protocol} [browser] without a dm line in its instructions calls nothing and says so`, async () => {
    const harness = await browserRun(protocol, '[browser url=http://127.0.0.1:4100/]', null)
    expect(bashCalls(protocol, harness.stdout)).toEqual([])
    expect(replyText(protocol, harness.stdout)).toBe('browser failed: the instructions give no dm command line')
  })
}

it('OMP [browser-origin] navigates to the second origin, then reads the status', async () => {
  const { file, calls } = browserInstructions(join(scratch, 'stub'))
  const harness = await browserRun('omp', '[browser-origin url=http://localhost:4101/]', file)
  expect(browserCalls(calls).map((call) => call.argv)).toEqual([
    ['call', 'browser_navigate', '{"url":"http://localhost:4101/","as":"Acolyte:DM-442"}'],
    ['call', 'browser_status', '{}']
  ])
  expect(bashCalls('omp', harness.stdout).map((tool) => tool.command)).toEqual(['dm call browser_navigate {"url":"http://localhost:4101/","as":"Acolyte:DM-442"}', 'dm call browser_status {}'])
  expect(replyText('omp', harness.stdout)).toBe('browser done')
})

it('[browser-read] navigates to the page and reads it as text, and nothing else', async () => {
  const { file, calls } = browserInstructions(join(scratch, 'stub'))
  const harness = await browserRun('claude', '[browser-read url=http://127.0.0.1:4100/inject]', file)
  expect(browserCalls(calls).map((call) => call.argv)).toEqual([
    ['call', 'browser_navigate', '{"url":"http://127.0.0.1:4100/inject","as":"Acolyte:DM-442"}'],
    ['call', 'browser_read', '{"mode":"text"}']
  ])
  expect(JSON.parse(bashCalls('claude', harness.stdout)[1].result).data.untrusted).toBe(true)
  expect(replyText('claude', harness.stdout)).toBe('browser done')
})

it('[browser-hidden] reads and clicks the current page, then replies with the screenshot\'s view_hidden refusal', async () => {
  const { file, calls } = browserInstructions(join(scratch, 'stub'))
  const harness = await browserRun('claude', '[browser-hidden]', file, { STUB_HIDDEN: '1' })
  expect(browserCalls(calls).map((call) => call.argv)).toEqual([
    ['call', 'browser_read', '{"mode":"tree"}'],
    ['call', 'browser_click', '{"ref":"e7"}'],
    ['call', 'browser_screenshot', '{"label":"hidden"}']
  ])
  expect(bashCalls('claude', harness.stdout).map((tool) => tool.isError)).toEqual([false, false, true])
  expect(replyText('claude', harness.stdout)).toBe('browser failed: browser_screenshot view_hidden: The browser view is not visible.')
})

it('OMP [browser-status] makes one status call and never shows the grant token its reply carried', async () => {
  const { file, calls } = browserInstructions(join(scratch, 'stub'))
  const harness = await browserRun('omp', '[browser-status]', file)
  expect(browserCalls(calls)).toEqual([expect.objectContaining({ argv: ['call', 'browser_status', '{}'], grant: true, pipe: browserPipe })])
  const [status] = bashCalls('omp', harness.stdout)
  expect(JSON.parse(status.result).data.planted).toBe('[redacted]')
  expect(replyText('omp', harness.stdout)).toBe('browser done')
})

it('OMP [browser-loop] navigates first, then reads every 300 ms until the first failing read, reports its code and calls nothing after it', async () => {
  const { file, calls } = browserInstructions(join(scratch, 'stub'))
  const started = Date.now()
  const harness = await browserRun('omp', '[browser-loop url=http://127.0.0.1:4100/slow]', file, { STUB_FAIL_READ: '3' })
  expect(Date.now() - started).toBeGreaterThanOrEqual(600)
  expect(browserCalls(calls).map((call) => call.argv)).toEqual([
    ['call', 'browser_navigate', '{"url":"http://127.0.0.1:4100/slow","as":"Acolyte:DM-442"}'],
    ...Array.from({ length: 3 }, () => ['call', 'browser_read', '{"mode":"text"}'])
  ])
  const tools = bashCalls('omp', harness.stdout)
  expect(tools.map((tool) => tool.isError)).toEqual([false, false, false, true])
  expect(JSON.parse(tools[3].result)).toEqual({ ok: false, error: { code: 'stopped', message: 'The person stopped the agent.' } })
  expect(replyText('omp', harness.stdout)).toBe('browser loop stopped: browser_read stopped\nbrowser done')
})

it('OMP [browser] stops at the first refused step and replies with its code', async () => {
  const { file, calls } = browserInstructions(join(scratch, 'stub'))
  const harness = await browserRun('omp', '[browser url=http://127.0.0.1:4100/]', file, { STUB_FAIL_READ: '1' })
  expect(browserCalls(calls).map((call) => call.argv[1])).toEqual(['browser_navigate', 'browser_read'])
  expect(replyText('omp', harness.stdout)).toBe('browser failed: browser_read stopped: The person stopped the agent.')
})

it('OMP with FAKE_AGENT_DELIVER_MAIL delivers its inbox into its session file at startup, as the app\'s receipts read it', async () => {
  const { file, calls } = mailInstructions()
  const sessions = join(scratch, 'sessions')
  const harness = launch(['--mode', 'rpc-ui', '--append-system-prompt', file, '--session-dir', sessions, '--session-id', sessionId], {
    DM_SESSION_TOKEN: grant, FAKE_AGENT_SESSION_FILES: '1', FAKE_AGENT_DELIVER_MAIL: '1'
  })
  const session = join(sessions, `2026-01-01T00-00-00Z_${sessionId}.jsonl`)
  while (!existsSync(session) || !readFileSync(session, 'utf8').includes('dm-inbox-delivery')) await delay(20)
  expect(dmCalls(calls)).toEqual([{ command: 'read_agent_inbox', input: {}, grant: true }])
  const receipts = contextReceipts(readFileSync(session, 'utf8'))
  expect([...receipts.peers.values()]).toEqual([expect.objectContaining({ id: 'am_7', seq: 3, body: 'Revision 2 saved.' })])
  expect(await finish(harness)).toBe(0)
  expect(harness.stderr).toBe('')
})

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

const OMP_SIGNED_IN = '{"reports":[{"provider":"fixture","accounts":1}],"accountsWithoutUsage":[],"disabledCredentials":[]}\n'
const OMP_SIGNED_OUT = '{"reports":[],"accountsWithoutUsage":[],"disabledCredentials":[]}\n'
for (const [argv, env, mode, persona, stdout, code] of [
  [['--version'], {}, 'version', 'claude', '2.1.329 (Claude Code)\n', 0],
  [['auth', 'status'], {}, 'auth', 'claude', '{"loggedIn":true}\n', 0],
  [['auth', 'status'], { FAKE_AGENT_SIGNED_OUT: '1' }, 'auth', 'claude', '{"loggedIn":false}\n', 1],
  [['--version'], { FAKE_AGENT_PERSONA: 'omp' }, 'version', 'omp', 'omp/18.16.0\n', 0],
  [['usage', '--json'], {}, 'auth', 'omp', OMP_SIGNED_IN, 0],
  [['usage', '--json'], { FAKE_AGENT_SIGNED_OUT: '1' }, 'auth', 'omp', OMP_SIGNED_OUT, 0],
] as const) {
  it(`${persona} ${argv.join(' ')} ${stdout === OMP_SIGNED_OUT || code === 1 ? 'signed out' : 'signed in'} prints exact output and logs first`, async () => {
    const harness = launch([...argv], { ...env, DM_SESSION_TOKEN: grant })
    expect(await harness.closed).toBe(code)
    expect(harness.stdout).toBe(stdout)
    expect(harness.stderr).toBe('')
    assertLog(harness, mode, true)
    expect(JSON.parse(readFileSync(harness.logPath, 'utf8')).persona).toBe(persona)
  })
}

it('the OMP persona prints its redacted catalog for `models --json` as OMP does without a session, and logs first', async () => {
  const harness = launch(['models', '--json'], { DM_SESSION_TOKEN: grant })
  expect(await harness.closed).toBe(0)
  expect(harness.stderr).toBe('')
  assertLog(harness, 'models', true)
  const stored = JSON.parse(readFileSync(join(fixtures, 'omp', 'models.json'), 'utf8')) as { models: { provider: string; id: string; identity: unknown; thinking: { efforts: string[] } }[] }
  const printed = JSON.parse(harness.stdout) as { models: Record<string, unknown>[] }
  expect(printed.models).toHaveLength(29)
  expect(printed.models).toEqual(stored.models.map(({ identity: _identity, thinking, ...model }) => ({ ...model, selector: `${model.provider}/${model.id}`, thinking: thinking.efforts })))
  expect(JSON.parse(readFileSync(harness.logPath, 'utf8')).persona).toBe('omp')
})

it('the OMP persona records the GUI launch arguments without running them, streams one turn and logs its pid', async () => {
  const extra = ['--cwd', scratch, '--append-system-prompt', join(scratch, 'missing-instructions.md'), '--config', join(scratch, 'missing.yml'), '-e', join(scratch, 'missing.ts'), '--session-dir', join(scratch, 'sessions')]
  const harness = await initialize('omp', extra, cli, { DM_SESSION_TOKEN: grant, FAKE_AGENT_PERSONA: 'omp' })
  harness.send(prompt('omp', 'hello first'))
  await harness.until(() => completed('omp', harness.stdout))
  expect(await finish(harness)).toBe(0)
  expect(harness.stdout).toBe(golden('omp', 'text'))
  expect(harness.stderr).toBe('')
  assertLog(harness, 'omp', true)
  expect(JSON.parse(readFileSync(harness.logPath, 'utf8'))).toMatchObject({ persona: 'omp', pid: harness.child.pid, argv: ['--mode', 'rpc-ui', ...extra] })
  expect(existsSync(join(scratch, 'sessions'))).toBe(false)
})

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
