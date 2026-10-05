/**
 * Test doubles for the Claude adapter: a fake Agent SDK query that replays recorded message
 * sequences, builders for the messages the SDK sends, and a rig that starts an adapter on them. Not shipped.
 */
import { resolve } from 'node:path'
import type { CanUseTool, HookInput, ModelInfo, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, vi } from 'vitest'
import type {
  ApprovalDecision,
  ApprovalRequestItem,
  ChatAdapter,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ChatItem
} from '../../../../shared/agents/chat'
import { createClaudeAdapter, type ClaudeAdapterDeps, type ClaudeQuery, type ClaudeQueryFactory } from '../claude'
import type { ClaudeProcesses } from '../claudeProcess'

export const FOLDER = resolve('/work/repo')
export const NOW = '2026-01-01T00:00:00.000Z'
export const SESSION = '11111111-1111-4111-8111-111111111111'
export const OTHER_SESSION = '22222222-2222-4222-8222-222222222222'
export const EXECUTABLE = resolve('/bin/claude')

// ---- A fake SDK: a query that replays recorded message sequences ----

export const message = (value: object): SDKMessage => value as unknown as SDKMessage

let counter = 0
export const uuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

export const init = (session = SESSION): SDKMessage =>
  message({ type: 'system', subtype: 'init', session_id: session, uuid: uuid(), model: 'claude-sonnet-5', cwd: FOLDER, tools: [] })

export const assistant = (messageId: string, content: object[], extra: object = {}): SDKMessage =>
  message({
    type: 'assistant',
    uuid: uuid(),
    session_id: SESSION,
    parent_tool_use_id: null,
    message: { id: messageId, role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: null },
    ...extra
  })

export const text = (value: string): object => ({ type: 'text', text: value })
export const toolUse = (id: string, name: string, input: object): object => ({ type: 'tool_use', id, name, input })

export const toolResult = (toolUseId: string, content: unknown, isError = false, extra: object = {}): SDKMessage =>
  message({
    type: 'user',
    uuid: uuid(),
    session_id: SESSION,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    ...extra
  })

export const streamEvent = (event: object, parent: string | null = null): SDKMessage =>
  message({ type: 'stream_event', event, parent_tool_use_id: parent, uuid: uuid(), session_id: SESSION })

export const messageStart = (id: string): SDKMessage => streamEvent({ type: 'message_start', message: { id, role: 'assistant', content: [] } })
export const textDelta = (index: number, value: string): SDKMessage =>
  streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } })

export const success = (result: string, extra: object = {}): SDKMessage =>
  message({ type: 'result', subtype: 'success', is_error: false, result, session_id: SESSION, uuid: uuid(), ...extra })

export const failure = (subtype: string, errors: string[], extra: object = {}): SDKMessage =>
  message({ type: 'result', subtype, is_error: true, errors, session_id: SESSION, uuid: uuid(), ...extra })

/** What the CLI adds to a permission request besides the tool call itself. */
interface AskExtras {
  /** The subagent the tool call runs in, when it runs in one. */
  agentID?: string
}

interface TurnContext {
  index: number
  text: string
  options: Options
  emit: (...messages: SDKMessage[]) => void
  ask: (tool: string, input: Record<string, unknown>, toolUseID?: string, extras?: AskExtras) => Promise<PermissionResult>
}

type Script = (turn: TurnContext) => Promise<void> | void

/** One query the adapter starts: how its turns go, and how it dies before saying anything. */
export interface Plan {
  script?: Script
  models?: ModelInfo[]
  /** The message stream throws (or, for `'end'`, just ends) before the first message. */
  dieEarly?: Error | 'end'
  modelsError?: Error
}

export class FakeQuery implements ClaudeQuery {
  readonly received: SDKUserMessage[] = []
  readonly modelCalls: (string | undefined)[] = []
  interrupts = 0
  closed = false
  private readonly outbox: SDKMessage[] = []
  private waiting: { resolve: (result: IteratorResult<SDKMessage>) => void; reject: (error: Error) => void } | null = null
  private failure: Error | null = null
  private ended = false

  constructor(
    readonly options: Options,
    private readonly plan: Plan,
    input: AsyncIterable<SDKUserMessage>,
    private readonly log: string[]
  ) {
    if (plan.dieEarly === 'end') {
      this.finish(null)
    } else if (plan.dieEarly !== undefined) {
      this.finish(plan.dieEarly)
    }
    void this.consume(input)
  }

  emit(...messages: SDKMessage[]): void {
    for (const item of messages) {
      if (this.waiting === null) {
        this.outbox.push(item)
      } else {
        const { resolve } = this.waiting
        this.waiting = null
        resolve({ value: item, done: false })
      }
    }
  }

  finish(error: Error | null): void {
    this.ended = true
    this.failure = error
    const waiting = this.waiting
    this.waiting = null
    if (error === null) {
      waiting?.resolve({ value: undefined, done: true })
    } else {
      waiting?.reject(error)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const next = this.outbox.shift()
        if (next !== undefined) {
          return Promise.resolve({ value: next, done: false })
        }
        if (this.failure !== null && this.ended) {
          return Promise.reject(this.failure)
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject }
        })
      }
    }
  }

  interrupt(): Promise<undefined> {
    this.interrupts += 1
    return Promise.resolve(undefined)
  }

  setModel(model?: string): Promise<void> {
    this.log.push(`setModel:${model}`)
    this.modelCalls.push(model)
    return Promise.resolve()
  }

  supportedModels(): Promise<ModelInfo[]> {
    return this.plan.modelsError === undefined ? Promise.resolve(this.plan.models ?? []) : Promise.reject(this.plan.modelsError)
  }

  close(): void {
    this.log.push('close')
    this.closed = true
    this.finish(null)
  }

  private async consume(input: AsyncIterable<SDKUserMessage>): Promise<void> {
    let index = 0
    for await (const item of input) {
      this.received.push(item)
      const content = item.message.content
      const body = typeof content === 'string' ? content : ''
      this.log.push(`user:${body}`)
      await this.plan.script?.({
        index,
        text: body,
        options: this.options,
        emit: (...messages) => this.emit(...messages),
        ask: (tool, toolInput, toolUseID = `tool_${tool}_${index}`, extras = {}) => this.ask(tool, toolInput, toolUseID, extras)
      })
      index += 1
    }
  }

  private async ask(tool: string, input: Record<string, unknown>, toolUseID: string, extras: AskExtras): Promise<PermissionResult> {
    const canUseTool = this.options.canUseTool as CanUseTool
    const result = await canUseTool(tool, input, {
      signal: new AbortController().signal,
      toolUseID,
      requestId: `req_${toolUseID}`,
      ...extras
    } as Parameters<CanUseTool>[2])
    if (result === null) {
      throw new Error('canUseTool returned null')
    }
    return result
  }
}

interface FakeSdk {
  query: ClaudeQueryFactory
  launches: FakeQuery[]
  log: string[]
}

export function fakeSdk(plans: Plan[] = []): FakeSdk {
  const sdk: FakeSdk = { launches: [], log: [], query: () => undefined as never }
  sdk.query = ({ prompt, options }) => {
    const plan = plans[sdk.launches.length] ?? plans.at(-1) ?? {}
    const query = new FakeQuery(options, plan, prompt, sdk.log)
    sdk.launches.push(query)
    return query
  }
  return sdk
}

// ---- The rig ----

interface Approval {
  request: ApprovalRequestItem
  respond: (decision: ApprovalDecision) => void
}

type FakeProcesses = ClaudeProcesses & { killed: number }

export interface Rig {
  adapter: ChatAdapter
  sdk: FakeSdk
  events: ChatAdapterEvent[]
  items: () => ChatItem[]
  approvals: Approval[]
  /** The process trackers created, in order: the chat's own first, then one per helper process. */
  created: FakeProcesses[]
  /** The chat's own tracker. */
  processes: FakeProcesses
}

export const START: ChatAdapterStartOptions = {
  chatId: 'chat_1',
  folder: FOLDER,
  model: null,
  role: 'orchestrator',
  allowSave: true,
  sessionId: null,
  darkMechanicus: { command: 'node', args: ['mcp.js', '--role', 'orchestrator', '--allow-save', '--label', 'Claude · Chat'], env: { DM_HOME: '/state' } }
}

export function fakeProcesses(log: string[], stderr = ''): FakeProcesses {
  const processes = {
    killed: 0,
    spawn: vi.fn(),
    killAll: () => {
      processes.killed += 1
      log.push('killAll')
      return Promise.resolve()
    },
    stderrTail: () => stderr
  }
  return processes as unknown as FakeProcesses
}

interface RigOptions {
  plans?: Plan[]
  start?: Partial<ChatAdapterStartOptions>
  deps?: Partial<ClaudeAdapterDeps>
  /** What the CLI process printed on stderr. */
  stderr?: string
}

export async function startRig({ plans = [], start = {}, deps = {}, stderr = '' }: RigOptions = {}): Promise<Rig> {
  const sdk = fakeSdk(plans)
  const events: ChatAdapterEvent[] = []
  const approvals: Approval[] = []
  const created: FakeProcesses[] = []
  const createProcesses = (): FakeProcesses => {
    const processes = fakeProcesses(sdk.log, stderr)
    created.push(processes)
    return processes
  }
  const adapter = createClaudeAdapter(EXECUTABLE, { query: sdk.query, now: () => NOW, createProcesses, platform: 'linux', ...deps })
  await adapter.start({ ...START, ...start }, (event) => {
    events.push(event)
    if (event.type === 'approval_request') {
      approvals.push({ request: event.request, respond: event.respond })
    }
  })
  const items = (): ChatItem[] => events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
  return { adapter, sdk, events, items, approvals, created, processes: created[0] as FakeProcesses }
}

export const pendingApproval = async (rig: Rig, count = 1): Promise<Approval> => {
  await vi.waitFor(() => expect(rig.approvals.length).toBeGreaterThanOrEqual(count))
  return rig.approvals[count - 1] as Approval
}

export const replay = (...messages: SDKMessage[]): Plan => ({ script: ({ emit }) => emit(...messages) })

/** What the CLI's `PreToolUse` hooks answer for one tool call: the first answer that decides anything, or `{}` when none does. */
export async function preToolUse(options: Options, tool: string, toolInput: unknown, cwd: string = FOLDER): Promise<unknown> {
  const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: 'toolu_hook', session_id: SESSION, transcript_path: '', cwd }
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of new RegExp(matcher.matcher ?? '').test(tool) ? matcher.hooks : []) {
      const answer = await hook(input as unknown as HookInput, 'toolu_hook', { signal: new AbortController().signal })
      if (Object.keys(answer).length > 0) {
        return answer
      }
    }
  }
  return {}
}
