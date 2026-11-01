/**
 * The Cursor chat adapter: runs `agent acp` (Agent Client Protocol over stdio) in the chat's folder, as
 * the Cursor flavor of the generic ACP adapter (`acp/acpAdapter.ts`). What is Cursor's own is here: the
 * `cursor_login` auth method, the `cursor/*` extension methods, `agent models`, switching models by
 * starting `agent --model <id> acp`, and the sign-in sentence of a stale process.
 *
 * Session. `initialize`, `authenticate` (Cursor's stored login), then `session/new` with the folder
 * and no MCP servers (`mcpServers: []`), or `session/load` with the stored session
 * id to resume. A session that cannot be loaded becomes a `context_reset` item and a new session.
 * A process that dies between turns is started again and resumes the same way on the next message.
 *
 * Models. The list comes from `agent models` (`agent --list-models` when that lists nothing).
 * `setModel` only records the choice; the next turn restarts the process as `agent --model <id> acp`
 * and loads the same session. In-process switching (`session/set_config_option`) is not used:
 * Cursor staff said in July 2026 that switching models at runtime through ACP "isn't something we
 * support today" and recommended `--model`, and forum reports show it changing what the session
 * says it runs without changing the model that answers.
 *
 * Sign-in. A login Cursor rejects is reported as one `auth_required` item and the turn ends
 * cleanly, with the process killed so none runs on the old login: an error answer for `authenticate`,
 * `session/new`, `session/load` or `session/prompt`, or a turn whose whole answer is the sign-in
 * sentence a stale process gives instead of an error (see `cursorAuth.ts`; the shapes are from Cursor's
 * forum and the ACP specification, not from a real CLI). A refusal while the chat is being started is
 * held until the first message, which starts a new process and tries again.
 *
 * Subagents. Everything stays in the chat's own thread. Cursor's ACP page (https://cursor.com/docs/cli/acp,
 * read 2026-10-05) tells the client only that a subagent task exists: the `cursor/task` extension carries
 * the task's `toolCallId`, description, prompt, subagent type and (once known) agent id and duration, and
 * nothing in it, in the stable Agent Client Protocol (https://agentclientprotocol.com/protocol) or on
 * Cursor's page names a session of the subagent or relates its messages and tool calls to the task that
 * started it. So the task shows as the tool call it is, the `cursor/task` message is answered (see
 * `cursorFlavor`) and no `thread` item is written: a thread would hold nothing. The ACP draft for
 * subagent sessions (`subagent_update`, agentclientprotocol/agent-client-protocol `docs/rfds/subagents.mdx`,
 * 2026-09-30) is sent only to a client that advertises the `subagents` capability, which this one does
 * not, and nothing read from Cursor says it sends them. Not verified against a real CLI (none is
 * installed here); `__mocks__/cursorSubagents.ts` is built from the documents, not recorded.
 *
 * Stop. `session/cancel`; if the agent has not ended the turn within a grace period the process is
 * killed (the next message resumes the session in a new one). `dispose` kills the whole tree and resolves
 * once it is gone.
 *
 * Dark Mechanicus. No MCP server is passed to Cursor and nothing is written to Cursor's config: the
 * agent runs the `dm` CLI, authorized by the chat's grant in `DM_SESSION_TOKEN` in the process
 * environment (the context's `server`, a `DarkMechanicusCli`, supplies only that environment), and
 * is told the exact command at the head of its first prompt (`cliInstructions.ts`).
 */
import type { ChatAdapter, ChatItem, ModelOption } from '../../../shared/agents/chat'
import type { ProcessOutcome } from '../../desktop/agentProbe'
import { createAcpAdapter, type AcpDeps, type AcpFlavor } from './acp/acpAdapter'
import { clip, objectOf } from './acp/acpJson'
import { CANCELLED, type ExtensionContext } from './acp/acpSession'
import { isSignInPrompt } from './cursorAuth'
import { cursorArguments, cursorLaunch } from './cursorLaunch'
import { CURSOR_NAME, parseModelList } from './cursorProtocol'

/** Long enough for a cold start and a network round trip for the account's models. */
const LIST_MODELS_TIMEOUT_MS = 30_000

function describeListFailure(outcome: ProcessOutcome): string {
  if (outcome.kind === 'timed_out') {
    return 'Cursor did not answer when asked for its models.'
  }
  if (outcome.kind === 'spawn_failed') {
    return `Cursor could not be started to list its models${outcome.code === null ? '' : ` (${outcome.code})`}.`
  }
  const firstLine = outcome.output.split(/\r?\n/).find((line) => line.trim() !== '')
  if (outcome.exitCode !== 0) {
    return firstLine === undefined
      ? `Cursor exited with code ${outcome.exitCode} when asked for its models.`
      : clip(firstLine.trim(), 300)
  }
  return 'Cursor printed no models.'
}

/** The models the signed-in account can use, from `agent models` (or `agent --list-models`). */
export async function listCursorModels(executablePath: string, deps: AcpDeps): Promise<ModelOption[]> {
  const failures: string[] = []
  for (const command of ['models', '--list-models'] as const) {
    const outcome = await deps.run(cursorLaunch(executablePath, { command, model: null }, deps), LIST_MODELS_TIMEOUT_MS)
    const models = outcome.kind === 'exited' && outcome.exitCode === 0 ? parseModelList(outcome.output) : []
    if (models.length > 0) {
      return models
    }
    failures.push(describeListFailure(outcome))
  }
  throw new Error(failures[0])
}

// ---- Cursor's extension methods (https://cursor.com/docs/cli/acp, read 2026-10-04) ----

/** The questions Cursor asked, for the notice that says they were declined. */
function questionsOf(params: unknown): string {
  const questions = objectOf(params)?.questions
  const prompts = Array.isArray(questions)
    ? questions.flatMap((question: unknown) => {
        const prompt = objectOf(question)?.prompt
        return typeof prompt === 'string' ? [prompt] : []
      })
    : []
  return prompts.length === 0 ? 'a question' : prompts.join(' / ')
}

/** A blocking Cursor extension this chat has no way to put to the person: noted in the transcript, answered cancelled. */
function decline(chat: ExtensionContext, code: string, message: string): unknown {
  const item: ChatItem = { id: chat.newId(), at: chat.now(), kind: 'error', message, code }
  chat.emit({ type: 'item', item })
  return { outcome: CANCELLED }
}

function taskResult(params: unknown): Record<string, unknown> {
  const body = objectOf(params)
  return {
    ...(typeof body?.agentId === 'string' ? { agentId: body.agentId } : {}),
    ...(typeof body?.durationMs === 'number' ? { durationMs: body.durationMs } : {})
  }
}

/** Cursor as an ACP flavor: `agent [--model <id>] acp`, signed in with `cursor_login`. */
export const cursorFlavor: AcpFlavor = {
  kind: 'cursor',
  displayName: CURSOR_NAME,
  authMethodId: 'cursor_login',
  extensions: {
    'cursor/ask_question': (params, chat) =>
      decline(
        chat,
        'cursor_question',
        `Cursor asked "${questionsOf(params)}", but this chat cannot show Cursor's questions yet, so it was declined. Answer in a message instead.`
      ),
    'cursor/create_plan': (_params, chat) =>
      decline(
        chat,
        'cursor_plan',
        'Cursor proposed a plan for approval, but this chat cannot show plans yet, so it was declined. Ask for the plan in a message instead.'
      ),
    'cursor/update_todos': (params) => ({ outcome: { outcome: 'accepted', todos: objectOf(params)?.todos ?? [] } }),
    'cursor/task': (params) => ({ outcome: { outcome: 'completed', ...taskResult(params) } })
  },
  launchArgs: (model) => cursorArguments({ command: 'acp', model }),
  listModels: listCursorModels,
  switchModel: 'relaunch',
  isSignInPrompt
}

export function createCursorAdapter(executablePath: string, deps: AcpDeps): ChatAdapter {
  return createAcpAdapter(cursorFlavor, executablePath, deps)
}
