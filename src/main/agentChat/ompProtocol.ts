import type { AgentChatAnswer, AgentChatEvent } from '../../shared/agents/agentChat'
import { fail } from '../../core/errors'
import type { ChatItem } from '../../shared/agents/chat'
import { ompReadFrame, ompWriteFrame, type OmpFraming } from './ompFraming'
import type { OmpHeldPrompt } from './ompPrompts'
import { OmpReducer } from './ompReducer'
import type { ToolResultBlob, TurnImage } from './toolResultImages'
import type { ThreadClaimEvent } from './translatorEvents'

type Payload<T> = T extends unknown ? Omit<T, 'folder' | 'chatId'> : never
export type OmpEvent = Payload<AgentChatEvent>
type ObjectValue = Record<string, unknown>
type ToolItem = Extract<ChatItem, { kind: 'tool_call' }>
type ThreadItem = Extract<ChatItem, { kind: 'thread' }>
type Block = { kind: 'text' | 'thinking'; text: string; held: string }
type Message = { id: string; at: string; blocks: Map<number, Block>; tools: Map<number, ObjectValue>; arguments: Map<number, string>; committed: Set<number> }
export interface OmpState extends OmpFraming {
  /** Main supplies a fresh process-generation namespace; wire/provider ids remain unchanged. */
  idNamespace: string
  skipped: number
  initialized: boolean
  inFlight: boolean
  sequence: number
  messageSequence: number
  message: Message | null
  tools: Map<string, ToolItem>
  threads: Map<string, ThreadItem>
  /** Threads whose first raw task has been inspected; ids only, never claim credentials. */
  claimTasksSeen: Set<string>
  pending: OmpHeldPrompt[]
  commands: Map<string, { type: string; threadId?: string; fromByte?: number }>
  tailOffsets: Map<string, number>
  terminalErrors: Map<string | null, Set<string>>
  sessionId: string | null
  sessionFile: string | null
}
export type OmpCommand =
  | { type: 'send'; id: string; text: string; images?: TurnImage[] }
  | { type: 'interrupt'; id: string }
  | ({ type: 'answer'; id: string } & AgentChatAnswer)
  | { type: 'get_subagent_messages'; id: string; subagentId: string; fromByte: number }
type Result = { events: OmpEvent[]; state: OmpState }
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

/** State is main-private, including exact wire option values and in-progress chunks. */
export function createOmpState(idNamespace = ''): OmpState {
  return { maxFrameBytes: 1_048_576, maxReassembledFrameBytes: 67_108_864, protocolVersion: 1, chunk: null, rejectedChunks: [], recoveringChunks: false,
    idNamespace, skipped: 0, initialized: false, inFlight: false, sequence: 0, messageSequence: 0, message: null,
    tools: new Map(), threads: new Map(), claimTasksSeen: new Set(), pending: [], commands: new Map(), tailOffsets: new Map(), terminalErrors: new Map(), sessionId: null, sessionFile: null }
}

/**
 * No I/O, clocks or raw-line events. Only `events` are safe for storage/IPC, never `internalEvents`. `blobs` are
 * tool-result image bytes for the named items: never in an event, and the caller stores them as bytes.
 */
export function translateOmpLine(line: string, previous: OmpState, at: string): Result & { internalEvents: ThreadClaimEvent[]; blobs: ToolResultBlob[] } {
  const state = structuredClone(previous)
  const reducer = new OmpReducer(state, at)
  const result = ompReadFrame(line, state)
  if (result.skipped) state.skipped++
  if (result.error) reducer.error(result.error)
  if (result.frame) {
    try { reducer.consume(object(result.frame)) }
    catch {
      // Oversized/deep or malformed vendor values are not host exceptions or raw error messages.
      return { events: [], internalEvents: [], blobs: [], state: { ...previous, skipped: previous.skipped + 1 } }
    }
  }
  return { events: reducer.events, internalEvents: reducer.internalEvents, blobs: reducer.blobs, state }
}

/** Call once after ready and before send; IDs are supplied by the owning session. */
export function initLines(ready: unknown, previous: OmpState, ids: () => string): { lines: string[]; state: OmpState } {
  if (previous.initialized) return { lines: [], state: previous }
  const state = structuredClone(previous)
  const frame = object(ready)
  if (frame.type !== 'ready') return { lines: [], state: previous }
  const commands: ObjectValue[] = []
  if (array(frame.supportedProtocolVersions).includes(2)) commands.push({ type: 'negotiate_protocol', protocolVersion: 2 })
  commands.push({ type: 'set_ask_dialog', enabled: true }, { type: 'set_subagent_subscription', level: 'progress' }, { type: 'set_event_filter', events: null, messageUpdates: 'delta' }, { type: 'get_state' })
  const lines = commands.map(command => {
    const id = ids()
    if (!id) throw new Error('OMP command requires an id')
    state.commands.set(id, { type: string(command.type) })
    return JSON.stringify({ ...command, id })
  })
  state.initialized = true
  return { lines, state }
}

/**
 * OMP refuses host → CLI `rpc_chunk` (agent-chat-images.md §3), so a turn goes out as one line whatever
 * `maxFrameBytes` says; only a line OMP could not reassemble is refused.
 */
function turnLine(frame: ObjectValue, state: OmpState): string {
  const line = JSON.stringify(frame)
  const size = Buffer.byteLength(line)
  if (size > state.maxReassembledFrameBytes) fail('image_too_large', `The turn's images make a ${size} byte line, over the agent's ${state.maxReassembledFrameBytes} byte limit.`)
  return line
}

/** With `framing`, a command keeps `ompWriteFrame`'s chunking (the `chunked` golden pair); a turn without it is never chunked. */
export function encodeOmpCommand(command: OmpCommand, previous: OmpState, at: string, framing?: { chunkId: string; chunkBytes?: number }): Result & { lines: string[] } {
  const state = structuredClone(previous)
  const reducer = new OmpReducer(state, at)
  if (!command.id) throw new Error('OMP command requires an id')
  const frame = reducer.command(command)
  if (!frame) return { events: reducer.events, state, lines: [] }
  const lines = command.type === 'send' && !framing ? [turnLine(frame, state)] : ompWriteFrame(frame, state, framing?.chunkId ?? command.id, framing?.chunkBytes)
  if (command.type !== 'answer') state.commands.set(command.id, { type: string(frame.type), ...(command.type === 'get_subagent_messages' ? { threadId: command.subagentId, fromByte: command.fromByte } : {}) })
  return { events: reducer.events, state, lines }
}
