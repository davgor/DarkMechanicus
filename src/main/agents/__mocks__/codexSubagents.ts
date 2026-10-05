/**
 * What `codex app-server` says while a Codex agent works with subagents, built from the Codex source.
 * NOT captured from a running Codex: it is not installed where this was written, and no live Codex
 * check was made. Every shape below is read from https://github.com/openai/codex at tag `rust-v0.160.0`
 * (commit a956835d020762cb2b570053af06f643a11c0ecc, the latest release on 2026-10-05) at the paths
 * named; none of the exchanges here is a recording.
 *
 * - A subagent is a thread of its own. `codex-rs/app-server/src/lib.rs` (the `thread_created_rx` arm)
 *   attaches every thread Codex creates, subagent threads included, to every initialized connection
 *   (`message_processor.rs`, `thread_processor.rs`: `try_attach_thread_listener`), so the notifications
 *   and server requests of a subagent arrive on the same connection with the subagent's `threadId`.
 * - Multi-agent v1 (`codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`): the model's `spawn_agent`
 *   call is a `collabAgentToolCall` item (`app-server-protocol/schema/typescript/v2/ThreadItem.ts`, with
 *   `CollabAgentTool.ts`, `CollabAgentToolCallStatus.ts`, `CollabAgentStatus.ts`, `CollabAgentState.ts`)
 *   in the spawning thread. It starts `inProgress` with `receiverThreadIds: []` and completes with the
 *   new thread's id in `receiverThreadIds` and its first status in `agentsStates`. `wait`, `sendInput`,
 *   `closeAgent` and the other collab tools are the same item with their own `tool`; `agentsStates`
 *   carries the receivers' last known status (`pendingInit`, `running`, `interrupted`, `completed`,
 *   `errored`, `shutdown`, `notFound`).
 * - Multi-agent v2 (`multi_agents_v2/spawn.rs`, `core/src/agent/control.rs` `emit_sub_agent_activity`,
 *   `core/src/agent/control/completion.rs`): a spawn emits no collab item; the spawning thread gets a
 *   `subAgentActivity` item (`kind` `started`, later `completed` or `interrupted`; `agentThreadId`,
 *   `agentPath`), sent as `item/started` immediately followed by `item/completed`. Its id is the model's
 *   call id; a completion activity is `subagent-completed-<child turn id>`.
 * - The subagent's own turns are ordinary `turn/started`, `item/*` and `turn/completed` notifications.
 *   `Thread.ts` (`parentThreadId`, `source`) and `SubAgentSource.ts` (`thread_spawn`: `parent_thread_id`,
 *   `agent_path`, `agent_nickname`, `agent_role`) name the relation on the thread itself; the Codex TUI
 *   (`codex-rs/tui/src/app/app_server_events.rs`) is the client that reads it.
 *
 * Not shipped.
 */
import { REPO } from './fakeChatAdapter'
import { step, type Json, type Step } from './codexReplay'

export const PARENT = 'thr_1'
export const TURN = 'turn_1'
/** The subagent of the v1 exchange and its turn. */
export const CHILD = 'thr_child'
export const CHILD_TURN = 'turn_child'
/** The subagent of the v2 exchange and its turn. */
export const CHILD_V2 = 'thr_child_v2'
export const CHILD_V2_TURN = 'turn_child_v2'
/** A subagent the first subagent starts. */
export const GRANDCHILD = 'thr_grandchild'
export const GRANDCHILD_TURN = 'turn_grandchild'

export const SPAWN_PROMPT = 'Read notes.txt and report its first line.'
export const AGENT_PATH = '/root/read_notes'

const INITIALIZE: Step[] = [
  step.expect('initialize'),
  step.reply({ userAgent: 'codex/0.160.0', codexHome: '/home/me/.codex', platformFamily: 'unix', platformOs: 'linux' }),
  step.expect('initialized')
]

export const NEW_THREAD: Step[] = [
  ...INITIALIZE,
  step.expect('thread/start'),
  step.reply({ thread: { id: PARENT, turns: [] }, model: 'gpt-5-codex', approvalPolicy: 'untrusted' })
]

const turnObject = (id: string, status: string): Json => ({ id, items: [], status, error: null })

/** The parent's turn/start is accepted and `body` happens; the turn then ends with `finish`. */
export function parentTurn(body: Step[], finish: Step[] = [turnCompleted(PARENT, TURN, 'completed')]): Step[] {
  return [
    step.expect('turn/start', { threadId: PARENT }),
    step.reply({ turn: turnObject(TURN, 'inProgress') }),
    turnStarted(PARENT, TURN),
    ...body,
    ...finish
  ]
}

export function turnStarted(threadId: string, turnId: string): Step {
  return step.notify('turn/started', { threadId, turn: turnObject(turnId, 'inProgress') })
}

export function turnCompleted(threadId: string, turnId: string, status: string): Step {
  return step.notify('turn/completed', { threadId, turn: turnObject(turnId, status) })
}

export function started(threadId: string, turnId: string, item: Json): Step {
  return step.notify('item/started', { threadId, turnId, startedAtMs: 1, item })
}

export function completed(threadId: string, turnId: string, item: Json): Step {
  return step.notify('item/completed', { threadId, turnId, completedAtMs: 2, item })
}

function delta(threadId: string, turnId: string, itemId: string, text: string): Step {
  return step.notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: text })
}

export function message(id: string, text: string): Json {
  return { type: 'agentMessage', id, text, phase: null, memoryCitation: null }
}

export function command(id: string, text: string, fields: Record<string, Json> = {}): Json {
  return { type: 'commandExecution', id, command: text, cwd: REPO, status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, ...fields }
}

interface CollabFields {
  status: string
  senderThreadId: string
  receiverThreadIds: string[]
  prompt: string | null
  model: string | null
  agentsStates: Record<string, Json>
}

/** A `collabAgentToolCall` item (the multi-agent v1 tools). */
export function collab(id: string, tool: string, fields: Partial<CollabFields> = {}): Json {
  return {
    type: 'collabAgentToolCall',
    id,
    tool,
    status: 'inProgress',
    senderThreadId: PARENT,
    receiverThreadIds: [],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
    ...fields
  }
}

/** A `subAgentActivity` item (the multi-agent v2 tools). */
export function activity(id: string, kind: string, agentThreadId: string, agentPath = AGENT_PATH): Json {
  return { type: 'subAgentActivity', id, kind, agentThreadId, agentPath }
}

/** The server asks to run a command where `at` says, and the client answers `decision`. */
export function askCommand(requestId: number, at: { threadId: string; turnId: string; itemId: string }, text: string, decision: string): Step[] {
  return [
    step.ask(requestId, 'item/commandExecution/requestApproval', { ...at, command: text, cwd: REPO, reason: null }),
    step.expectResponse(requestId, { decision })
  ]
}

/**
 * Multi-agent v1, one turn: the parent spawns a subagent (`spawn_agent`), the subagent reads a file,
 * asks to write a summary and says what it found, and the parent waits for it.
 */
export const V1_EXCHANGE: Step[] = [
  ...NEW_THREAD,
  ...parentTurn([
    completed(PARENT, TURN, message('m1', 'I will ask a subagent to read the notes.')),
    started(PARENT, TURN, collab('s1', 'spawnAgent', { prompt: SPAWN_PROMPT })),
    completed(PARENT, TURN, collab('s1', 'spawnAgent', { status: 'completed', prompt: SPAWN_PROMPT, receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: 'pendingInit', message: null } } })),
    turnStarted(CHILD, CHILD_TURN),
    started(CHILD, CHILD_TURN, { type: 'userMessage', id: 'cu1', clientId: null, content: [{ type: 'text', text: SPAWN_PROMPT, text_elements: [] }] }),
    started(CHILD, CHILD_TURN, command('cc1', 'cat notes.txt')),
    completed(CHILD, CHILD_TURN, command('cc1', 'cat notes.txt', { status: 'completed', aggregatedOutput: 'alpha', exitCode: 0 })),
    started(CHILD, CHILD_TURN, command('cc2', 'echo alpha > summary.txt')),
    ...askCommand(200, { threadId: CHILD, turnId: CHILD_TURN, itemId: 'cc2' }, 'echo alpha > summary.txt', 'accept'),
    completed(CHILD, CHILD_TURN, command('cc2', 'echo alpha > summary.txt', { status: 'completed', exitCode: 0 })),
    delta(CHILD, CHILD_TURN, 'cm1', 'The first line is '),
    delta(CHILD, CHILD_TURN, 'cm1', 'alpha.'),
    completed(CHILD, CHILD_TURN, message('cm1', 'The first line is alpha.')),
    turnCompleted(CHILD, CHILD_TURN, 'completed'),
    started(PARENT, TURN, collab('w1', 'wait', { receiverThreadIds: [CHILD] })),
    completed(PARENT, TURN, collab('w1', 'wait', { status: 'completed', receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: 'completed', message: 'The first line is alpha.' } } })),
    completed(PARENT, TURN, message('m2', 'The subagent found alpha.'))
  ])
]

/**
 * Multi-agent v2, one turn: the parent's `spawn_agent` shows up only as `subAgentActivity` items
 * (`started`, then `completed` once the subagent's turn ended), and the subagent works in its own thread.
 */
export const V2_EXCHANGE: Step[] = [
  ...NEW_THREAD,
  ...parentTurn([
    started(PARENT, TURN, activity('call_2', 'started', CHILD_V2)),
    completed(PARENT, TURN, activity('call_2', 'started', CHILD_V2)),
    turnStarted(CHILD_V2, CHILD_V2_TURN),
    started(CHILD_V2, CHILD_V2_TURN, command('vc1', 'ls')),
    completed(CHILD_V2, CHILD_V2_TURN, command('vc1', 'ls', { status: 'completed', aggregatedOutput: 'notes.txt', exitCode: 0 })),
    completed(CHILD_V2, CHILD_V2_TURN, message('vm1', 'Only notes.txt is here.')),
    turnCompleted(CHILD_V2, CHILD_V2_TURN, 'completed'),
    started(PARENT, TURN, activity(`subagent-completed-${CHILD_V2_TURN}`, 'completed', CHILD_V2)),
    completed(PARENT, TURN, activity(`subagent-completed-${CHILD_V2_TURN}`, 'completed', CHILD_V2)),
    completed(PARENT, TURN, message('m1', 'Done.'))
  ])
]
