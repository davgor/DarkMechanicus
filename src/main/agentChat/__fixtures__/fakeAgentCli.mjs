#!/usr/bin/env node
/** Offline CLI for protocol, process, session and packaged-app tests. Golden JSONL is authoritative. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

const argv = process.argv.slice(2)
const option = (name) => argv[argv.indexOf(name) + 1]
const outputFormat = argv.includes('--output-format') ? option('--output-format') : ''
const arbiter = argv.includes('-p') && (outputFormat === 'json' || argv.includes('--no-tools'))
const protocol = outputFormat === 'json' || outputFormat === 'stream-json' ? 'claude' : 'omp'
const mode = argv.includes('--version') ? 'version'
  : argv[0] === 'auth' && argv[1] === 'status' ? 'auth'
    : arbiter ? 'arbiter'
      : argv.includes('--mode') && ['rpc-ui', 'rpc'].includes(option('--mode')) ? 'omp'
        : argv.includes('-p') && outputFormat === 'stream-json' ? 'claude' : 'tui'
const root = dirname(fileURLToPath(import.meta.url))
const log = (extra = {}) => {
  if (process.env.FAKE_AGENT_LOG) {
    appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({
      mode, pid: process.pid, argv, cwd: process.cwd(),
      env: { DM_SESSION_TOKEN: process.env.DM_SESSION_TOKEN === undefined ? 'absent' : 'present' }, ...extra,
    })}\n`)
  }
}
const emit = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
const crash = () => {
  process.stderr.write('fake-agent crash\n')
  process.exitCode = 3
}


function runInteractive() {
  const sessionId = argv.includes('--session-id') ? option('--session-id') : argv.includes('--resume') ? option('--resume') : 'session_T1'
  if (argv.includes('--session-id')) {
    const config = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
    const project = join(resolve(config), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(project, { recursive: true })
    appendFileSync(join(project, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'system', sessionId })}\n`)
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const stop = () => { input.close(); process.stdin.destroy() }
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
  if (mode === 'tui') {
    emit(`fake-tui ready ${sessionId}`)
    input.on('line', emit)
  } else {
    new ProtocolReplay(input, stop)
  }
}

function fixture(name) {
  return readFileSync(join(root, mode, `${name}.out.jsonl`), 'utf8').trimEnd().split('\n')
}

function renumber(lines, number) {
  if (number === 1) return lines
  const result = []
  for (let index = 0; index < lines.length; index++) {
    const frame = JSON.parse(lines[index])
    if (frame.type !== 'rpc_chunk') {
      result.push(lines[index].replaceAll('T1', `T${number}`))
      continue
    }
    const frames = lines.slice(index, index + frame.count).map((line) => JSON.parse(line))
    const bytes = Buffer.from(Buffer.concat(frames.map((part) => Buffer.from(part.data, 'base64'))).toString('utf8').replaceAll('T1', `T${number}`))
    const size = Math.ceil(bytes.length / frames.length)
    for (let part = 0; part < frames.length; part++) {
      result.push(JSON.stringify({ ...frames[part], chunkId: frame.chunkId.replaceAll('T1', `T${number}`), byteLength: bytes.length, data: bytes.subarray(part * size, (part + 1) * size).toString('base64') }))
    }
    index += frame.count - 1
  }
  return result
}

function requestId(frame) {
  if (frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool') return frame.request_id
  if (frame.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'ask', 'form'].includes(frame.method)) return frame.id
  return null
}

function scenario(prompt) {
  const keywords = [...(prompt ?? '').matchAll(/\[([a-z_]+)\]/g)].map((match) => match[1])
  if (mode === 'omp' && keywords.includes('tasks')) return 'todo'
  if (mode === 'claude' && keywords.includes('todo_clear')) return 'text'
  return keywords.find((key) => ['slow', 'leak'].includes(key) || existsSync(join(root, mode, `${key}.out.jsonl`))) ?? 'text'
}

function leakToken(lines) {
  const secret = process.env.DM_SESSION_TOKEN ?? ''
  process.stderr.write(`${secret}\n`)
  return lines.map((line) => {
    const frame = JSON.parse(line)
    if (mode === 'omp' && frame.type === 'tool_execution_end') frame.result.content = [{ type: 'text', text: secret }]
    if (mode === 'claude' && frame.type === 'user') {
      for (const block of frame.message.content) if (block.type === 'tool_result') block.content = secret
    }
    return JSON.stringify(frame)
  })
}

function tailBindings(name, turn) {
  const path = join(root, mode, `${name}.in.jsonl`)
  if (!existsSync(path)) return new Map()
  const inputs = renumber(readFileSync(path, 'utf8').trimEnd().split('\n'), turn).map((line) => JSON.parse(line))
  return new Map(inputs.filter((frame) => frame.type === 'get_subagent_messages').map((frame) => [frame.id, frame.subagentId]))
}

class ProtocolReplay {
  turn = 0
  active = null
  timer = undefined
  queue = []
  chunks = []
  tailQueries = new Map()

  constructor(input, stop) {
    this.stop = stop
    this.startup = fixture(mode === 'omp' && (argv.includes('--resume') || argv.includes('--session')) ? 'init_resume' : 'init')
    if (mode === 'omp') emit(this.startup[0])
    input.on('close', () => { clearTimeout(this.timer) })
    input.on('line', (line) => { if (line.trim()) this.receive(JSON.parse(line)) })
  }

  pump() {
    while (this.active && !this.active.waiting) {
      if (this.active.index === this.active.lines.length) {
        this.active = null
        this.next()
        return
      }
      if (!this.emitFrame(this.active.lines[this.active.index])) return
      this.active.index++
      if (this.active.slow && this.active.index < this.active.lines.length) {
        this.timer = setTimeout(() => this.pump(), 200)
        return
      }
    }
  }

  emitFrame(line) {
    const frame = JSON.parse(line)
    if (frame.command === 'get_subagent_messages') {
      const subagentId = this.active.tails.get(frame.id)
      const query = this.tailQueries.get(subagentId)
      if (!query) { this.active.waitingForTail = true; return false }
      this.tailQueries.delete(subagentId)
      emit({ ...frame, id: query.id })
      return true
    }
    if (frame.command === 'follow_up') {
      this.active.waitingForAdmission = true
      return false
    }
    this.active.waiting = requestId(frame)
    emit(line)
    return true
  }

  next() {
    if (!this.queue.length) return
    const message = this.queue.shift()
    if (message.admitted) this.queueUpdate()
    this.start(message)
  }

  queueUpdate() {
    emit({
      type: 'queue_update',
      steering: this.queue.filter((message) => message.type === 'steer').map((message) => message.message),
      followUp: this.queue.filter((message) => message.type === 'follow_up').map((message) => message.message),
    })
  }

  admit(message) {
    emit({ type: 'response', command: message.type, id: message.id, success: true })
    this.queue.push({ ...message, admitted: true })
    this.queueUpdate()
    if (!this.active) { this.next(); return }
    if (this.active.waitingForAdmission) {
      // The golden queued pair pins the admission response and its following queue snapshot.
      this.active.index += 2
      this.active.waitingForAdmission = false
      this.pump()
    }
  }

  tail(message) {
    this.tailQueries.set(message.subagentId, message)
    if (this.active?.waitingForTail) {
      this.active.waitingForTail = false
      this.pump()
    }
  }

  start(message) {
    const content = mode === 'claude' ? message.message?.content : message.message
    const prompt = typeof content === 'string' ? content : JSON.stringify(content)
    if (prompt?.includes('[crash]')) { crash(); this.stop(); return }
    const name = scenario(prompt)
    const replay = { slow: 'text', leak: 'tool' }[name] ?? name
    let lines = this.turnLines(replay, message)
    if (name === 'leak') lines = leakToken(lines)
    this.tailQueries.clear()
    this.active = { lines, index: 0, waiting: null, slow: name === 'slow', promptId: message.id, tails: tailBindings(replay, this.turn) }
    this.pump()
  }

  turnLines(replay, message) {
    let lines = renumber(fixture(replay), ++this.turn)
    if (mode === 'omp' && message.id) lines = lines.map((line) => line.replaceAll(`req_T${this.turn}_prompt`, message.id))
    if (message.admitted) lines = lines.filter((line) => JSON.parse(line).command !== 'prompt')
    return lines
  }

  initialize(message) {
    if (mode === 'claude' && message.type === 'control_request' && message.request?.subtype === 'initialize') {
      if (process.env.FAKE_AGENT_INITIALIZE_ERROR === '1') {
        emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Fake initialization rejected.' } })
        return true
      }
      for (const line of this.startup) emit(line.replaceAll('req_T1_initialize', message.request_id))
      return true
    }
    if (mode === 'omp') {
      const response = this.startup.slice(1).find((line) => JSON.parse(line).command === message.type)
      if (response) { emit({ ...JSON.parse(response), id: message.id }); return true }
    }
    return false
  }

  interrupt(message) {
    if (!this.active) return
    clearTimeout(this.timer)
    const lines = renumber(fixture('interrupt'), this.turn)
    const tail = lines.findIndex((line) => {
      const frame = JSON.parse(line)
      return mode === 'claude' ? frame.type === 'control_response' : frame.command === 'abort'
    })
    for (let line of lines.slice(tail)) {
      line = line.replaceAll(`req_T${this.turn}_${mode === 'claude' ? 'interrupt' : 'abort'}`, message.request_id ?? message.id)
      if (this.active.promptId) line = line.replaceAll(`req_T${this.turn}_prompt`, this.active.promptId)
      emit(line)
    }
    this.active = null
    this.next()
  }

  answer(message) {
    const id = mode === 'claude' && message.type === 'control_response' ? message.response?.request_id : message.type === 'extension_ui_response' ? message.id : null
    if (id && this.active?.waiting === id) {
      this.active.waiting = null
      this.pump()
    }
  }

  command(message) {
    if (this.initialize(message)) return true
    if (message.type === 'abort' || message.request?.subtype === 'interrupt') { this.interrupt(message); return true }
    if (mode === 'omp' && message.type === 'get_subagent_messages') { this.tail(message); return true }
    if (mode === 'omp' && ['follow_up', 'steer'].includes(message.type)) { this.admit(message); return true }
    this.answer(message)
    return false
  }

  receive(message) {
    if (message.type === 'rpc_chunk') {
      this.chunks.push(Buffer.from(message.data, 'base64'))
      if (message.index + 1 === message.count) {
        const decoded = JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
        this.chunks = []
        this.receive(decoded)
      }
      return
    }
    if (this.command(message)) return
    const user = message.type === (mode === 'claude' ? 'user' : 'prompt')
    if (user) {
      if (this.active) this.queue.push(message)
      else this.start(message)
    }
  }
}
if (mode === 'arbiter') {
  let stdin = ''
  process.stdin.setEncoding('utf8')
  for await (const part of process.stdin) stdin += part
  log({ stdinHasSecret: /dmg_[0-9a-f]{16,}|at_[0-9a-hjkmnp-tv-z]{26}\.[A-Za-z0-9_-]{6,}/i.test(stdin) })
  const keyword = stdin.match(/\[arbiter:(allow|deny|escalate|garbage|fenced|hang|crash)\]/)?.[1]
  const verdict = process.env.FAKE_ARBITER_VERDICT ?? keyword ?? 'escalate'
  if (verdict === 'hang') {
    // An open message port keeps the process alive without a timer or network listener.
    const { port1, port2 } = new MessageChannel()
    port1.on('message', () => {})
    process.on('exit', () => { port1.close(); port2.close() })
  } else if (verdict === 'crash') {
    crash()
  } else {
    const decision = verdict === 'allow' || verdict === 'fenced' ? 'allow_once' : verdict === 'deny' ? 'deny' : 'escalate'
    const json = JSON.stringify({ decision, reason: !keyword && !process.env.FAKE_ARBITER_VERDICT ? 'fake default' : `fake ${decision}` })
    const text = verdict === 'garbage' ? 'I think it is fine.' : verdict === 'fenced' ? `\`\`\`json\n${json}\n\`\`\`` : json
    emit(protocol === 'claude' ? { type: 'result', subtype: 'success', is_error: false, result: text, session_id: '00000000-0000-4000-8000-000000000000' } : text)
  }
} else {
  log()
  if (mode === 'version') {
    emit('2.1.329 (Claude Code)')
  } else if (mode === 'auth') {
    const loggedIn = process.env.FAKE_AGENT_SIGNED_OUT !== '1'
    emit({ loggedIn })
    process.exitCode = loggedIn ? 0 : 1
  } else {
    runInteractive()
  }
}
