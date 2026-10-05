/**
 * What `agent acp` says when Cursor hands work to a subagent, built from Cursor's documentation. NOT
 * captured from a running Cursor: the Cursor CLI is not installed where this was written and no live
 * Cursor check was made. The shapes are read from, as of 2026-10-05:
 *
 * - https://cursor.com/docs/cli/acp, "cursor/task": "Notify the client about a subagent task. Sent as
 *   a notification; no response required." Its fields are `toolCallId`, `description`, `prompt`,
 *   `subagentType` (`explore`, `shell`, `browser_use`, ... or `{ custom }`), and optionally `model`,
 *   `agentId` (to resume a subagent) and `durationMs`; the page also lists a response,
 *   `{ outcome: "completed" | "rejected" | "cancelled" }`, so the page does not say whether Cursor
 *   sends it as a notification or as a request. Both forms are recorded here. The page has no word
 *   on the subagent's own messages or tool calls reaching the client, and no field names a subagent
 *   session or a parent call besides the `toolCallId` of the call that started the task.
 * - https://agentclientprotocol.com/protocol (tool calls, `session/update`): a tool call is
 *   `tool_call` and `tool_call_update` updates under one `toolCallId`; the stable protocol has no
 *   relation between sessions or between calls.
 * - The Agent Client Protocol's own proposal for subagents, an unstable draft that an agent may send
 *   only to a client that advertises a `subagents` capability (this client does not):
 *   https://github.com/agentclientprotocol/agent-client-protocol, `docs/rfds/subagents.mdx`, merged
 *   in commit d2631c6f092cb2105a235c9cf295b5a3b51fa0e5 on 2026-09-30. Nothing read from Cursor says it
 *   sends those updates.
 *
 * Not shipped.
 */
import { agent, client, type Frame } from './replayAcpAgent'
import { handshake, newSession, prompt, say, turnEnd, update } from './cursorRecordings'

export const SESSION = 'sess_1'
export const TASK_CALL = 'call_126'
const TASK_PROMPT = 'Find where authentication is handled and report the file paths.'
export const TASK_RESULT = 'Authentication is handled in src/auth/session.ts.'

const TASK_PARAMS = { toolCallId: TASK_CALL, description: 'Explore codebase', prompt: TASK_PROMPT, subagentType: 'explore' }

/** The tool call that starts the task, and the update that finishes it with the subagent's report. */
const TASK_CALL_UPDATE = update(SESSION, {
  sessionUpdate: 'tool_call',
  toolCallId: TASK_CALL,
  title: 'Explore codebase',
  kind: 'other',
  status: 'pending',
  rawInput: { description: 'Explore codebase', prompt: TASK_PROMPT, subagentType: 'explore' }
})

const TASK_DONE_UPDATE = update(SESSION, {
  sessionUpdate: 'tool_call_update',
  toolCallId: TASK_CALL,
  status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text: TASK_RESULT } }]
})

function exchange(taskMessage: Frame[]): Frame[] {
  return [
    ...handshake(),
    ...newSession(3, SESSION),
    prompt(4, SESSION, 'Where is authentication handled?'),
    say(SESSION, 'I will have a subagent look.'),
    TASK_CALL_UPDATE,
    ...taskMessage,
    TASK_DONE_UPDATE,
    say(SESSION, TASK_RESULT),
    turnEnd(4)
  ]
}

/** One turn in which Cursor sends `cursor/task` as a request, which the client answers `completed`. */
export const TASK_AS_REQUEST: Frame[] = exchange([
  agent({ id: 31, method: 'cursor/task', params: TASK_PARAMS }),
  client({ id: 31, result: { outcome: { outcome: 'completed' } } })
])

/** The same turn with `cursor/task` sent as a notification, as the page says: nothing goes back. */
export const TASK_AS_NOTIFICATION: Frame[] = exchange([agent({ method: 'cursor/task', params: TASK_PARAMS })])
