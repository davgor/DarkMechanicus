/**
 * Whether a command a chat wants to run is one of its own `dm` calls.
 *
 * This is the only thing between a hosted chat and arbitrary shell execution, because a recognized
 * call is allowed without asking. So it recognizes exactly one shape and nothing else, and anything
 * it does not recognize is not refused — it becomes an ordinary command approval, which is what
 * every command used to be.
 *
 * The grammar is deliberately tiny. A command is a sequence of tokens separated by spaces, where a
 * token is either bare (letters, digits and `/._:=-`) or wrapped in single quotes, which in POSIX
 * quote everything including the characters that would otherwise start a substitution. Nothing
 * else parses: no `;`, `|`, `&`, `>`, `<`, backtick, `$`, backslash, double quote, newline,
 * parenthesis or brace can appear anywhere, inside a quoted argument or out of it. A command
 * substitution, a second command, a redirect and a pipeline are therefore all unrepresentable
 * rather than filtered, and `dm call x; curl …` simply does not match.
 *
 * The first two tokens must equal, character for character, the executable and script the app
 * itself launches. A `dm` earlier on the agent's `PATH`, a relative path, a copy of the script
 * elsewhere and `sh -c '…'` all fail on that comparison.
 */
import type { CliLaunch } from '../desktop/cliConfig'

/** A bare token: no character that means anything to a shell. */
const BARE = /^[A-Za-z0-9/._:=-]+$/

/**
 * Refused even inside single quotes, where POSIX would already make them literal. Relying on that
 * would make this correct only for as long as every agent's shell tool quotes exactly the way we
 * expect, and a recognized command is run without asking. A JSON argument holding one of these
 * falls back to an ordinary approval, which costs a click and assumes nothing.
 */
const NEVER_QUOTED = new Set(['$', '`', '\\'])

/** True for a character that must never reach a shell from us, quoted or not. */
function forbidden(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return NEVER_QUOTED.has(character) || code < 0x20 || code === 0x7f
}

function hasForbidden(text: string): boolean {
  return [...text].some(forbidden)
}

/** The modes the CLI offers. Anything else is not one of ours, whatever it looks like. */
const MODES = ['--list', '--describe', 'call'] as const

export interface OwnCliCall {
  mode: (typeof MODES)[number]
  /** The command named after `--describe` or `call`; null for `--list`. */
  command: string | null
}

/**
 * Splits on single spaces into bare or single-quoted tokens, or null when the text contains
 * anything the grammar does not cover. Never throws, and never interprets: an unmatched quote,
 * a tab, a newline or a backslash all return null.
 */
/** One token read from `index`, or null when the text does not continue with one we recognize. */
function readToken(text: string, index: number): { token: string; next: number } | null {
  if (text[index] === "'") {
    const end = text.indexOf("'", index + 1)
    const quoted = end === -1 ? null : text.slice(index + 1, end)
    // A quoted token must end the token: `'a'b` is not something we recognize.
    if (quoted === null || hasForbidden(quoted) || (end + 1 < text.length && text[end + 1] !== ' ')) {
      return null
    }
    return { token: quoted, next: end + 1 }
  }
  const space = text.indexOf(' ', index)
  const end = space === -1 ? text.length : space
  const bare = text.slice(index, end)
  return BARE.test(bare) ? { token: bare, next: end } : null
}

export function tokenize(text: string): string[] | null {
  const tokens: string[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] === ' ') {
      index += 1
      continue
    }
    const read = readToken(text, index)
    if (read === null) {
      return null
    }
    tokens.push(read.token)
    index = read.next
  }
  return tokens
}

/** `call <command> [json]`: the JSON is opaque here, since the command's own schema validates it. */
function callOf(rest: readonly string[]): OwnCliCall | null {
  const [, command, json] = rest
  if (command === undefined || rest.length > 3) {
    return null
  }
  return json === undefined || json.startsWith('{') ? { mode: 'call', command } : null
}

function modeOf(rest: readonly string[]): OwnCliCall | null {
  const [first, second] = rest
  if (first === '--list') {
    return rest.length === 1 ? { mode: '--list', command: null } : null
  }
  if (first === '--describe') {
    return rest.length === 2 && second !== undefined ? { mode: '--describe', command: second } : null
  }
  return first === 'call' ? callOf(rest) : null
}

/**
 * The call this command makes, or null when it is not one of the chat's own. `launch` is the
 * invocation the app built for this chat; the command must begin with exactly that executable and
 * script, and may pin only the same repository.
 */
export function ownCliCall(launch: CliLaunch, text: string): OwnCliCall | null {
  const tokens = tokenize(text)
  const script = launch.args[0]
  const repo = launch.args[2]
  if (tokens === null || script === undefined || tokens[0] !== launch.command || tokens[1] !== script) {
    return null
  }
  let rest = tokens.slice(2)
  if (rest[0] === '--repo') {
    // Pinning another folder would run this chat's grant against another project.
    if (rest[1] !== repo) {
      return null
    }
    rest = rest.slice(2)
  }
  // The token comes from the environment the app set; a chat never names a file to read it from.
  return rest.includes('--token-file') ? null : modeOf(rest)
}

export function isOwnCliCall(launch: CliLaunch, text: string): boolean {
  return ownCliCall(launch, text) !== null
}
