/**
 * What a hosted chat is told about reaching Dark Mechanicus.
 *
 * The app used to hand the vendor an MCP server, so the tools simply appeared and needed no
 * explanation. A chat now runs the `dm` CLI instead, and nothing about the environment announces
 * that: an agent that goes looking for `mcp__darkmechanicus__*` finds nothing and reasonably
 * concludes it has no access at all. So the exact command, and the fact that its grant is already
 * in place, are stated up front.
 */
import type { ChatRole, DarkMechanicusCli } from '../../shared/agents/chat'

/** A shell word, quoted only when it needs it, so the agent can copy the line as written. */
function word(part: string): string {
  return /^[A-Za-z0-9/._:=-]+$/.test(part) ? part : `'${part}'`
}

export function cliCommandLine(cli: DarkMechanicusCli): string {
  return [cli.command, ...cli.args].map(word).join(' ')
}

interface InstructionOptions {
  cli: DarkMechanicusCli
  role: ChatRole
  /** Whether the chat's grant lets it save a plan without a person pressing Save. */
  allowSave: boolean
}

/**
 * The instructions every chat is given: appended to Claude's system prompt, sent as Codex's
 * `developerInstructions` of each thread, and leading the first prompt of each ACP process.
 * Written as fact rather than suggestion:
 * the grant exists already, so an agent that asks a person to set one up has misread its own
 * situation, which is the failure this text exists to prevent.
 */
export function cliInstructions(options: InstructionOptions): string {
  const line = cliCommandLine(options.cli)
  const saving = options.allowSave
    ? 'This chat may save plans itself.'
    : 'This chat may not save plans: prepare the draft and ask the person to press Save in the app.'
  return [
    '## Dark Mechanicus',
    '',
    `You reach Dark Mechanicus by running the \`dm\` CLI. There is no MCP server in this chat, and no`,
    '`mcp__darkmechanicus__*` tool: do not look for one, and do not report that you have no access.',
    '',
    'Run it exactly like this, from this folder:',
    '',
    '```sh',
    `${line} --list                      # every command, with the capability it needs`,
    `${line} --describe claim_ticket     # one command and its input`,
    `${line} call get_capabilities '{}'  # run a command; the argument is a JSON object`,
    '```',
    '',
    `You already hold a **${options.role}** grant for this folder: it is in \`DM_SESSION_TOKEN\` in your`,
    'environment, and the CLI reads it for itself. Do not pass a role, a token or a repository on the',
    'command line — there are no such flags, and asking a person to issue you a grant is wrong, because',
    'one was issued when this chat started.',
    '',
    saving,
    '',
    'Commands take either spelling, `claim_ticket` or `claimTicket`. Output is JSON on stdout:',
    '`{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message"}}`. Start with `get_capabilities`.'
  ].join('\n')
}
