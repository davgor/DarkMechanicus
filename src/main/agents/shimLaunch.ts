/**
 * The one launcher for a Windows program that has to go through cmd.exe: an npm `.cmd` shim (Node
 * will not start those without a shell), and the console window a sign-in runs in.
 *
 * The rule (DM-49): the command goes through exactly one cmd.exe parse, `cmd.exe /d /v:off /s /c
 * ""<path>" <args>"` (`/k` to keep the window open). `/s` makes cmd strip exactly the outer pair of
 * quotes, so the path stays inside its own pair, where `&`, `^`, `(`, `)`, `|`, `<`, `>` and spaces are
 * literal; `/v:off` rules out `!` expansion and `/d` skips AutoRun commands. There is no `start`, no
 * nested cmd.exe and no shell option: either would parse the line a second time with the path outside
 * its quotes, and an `&` in the path would end the command.
 *
 * Inside quotes cmd.exe still acts on `%` (variable expansion), and a `"` ends the quoted text, so
 * neither can be made literal. Windows file names cannot hold a quote or a control character, so a
 * path with one did not come from a real file. Arguments follow the same rule, and an argument ending in
 * a backslash is refused as well (the program would read `\\"` as an escaped quote). Anything like that
 * is refused, never escaped.
 *
 * Arguments are constants or validated ids, never free text. Plain ones (letters, digits, `. _ -`) go
 * as they are; any other is wrapped in its own pair of quotes, so a model id such as
 * `claude-opus-4-7[thinking=true,effort=high]` stays one argument. Callers pass arguments unquoted.
 */

/** The process to start: cmd.exe with a command line that is already quoted, so Node must not quote it again. */
interface ShimLaunch {
  file: string
  args: readonly string[]
  verbatimArguments: true
}

type ShimPlan =
  | { ok: true; launch: ShimLaunch }
  | { ok: false; unsafe: 'path' | 'argument'; reason: string }

interface ShimOptions {
  /** The command interpreter; `cmd.exe` is looked up on the path when absent. */
  comspec?: string
  /** Leave the window open after the program ends (`/k`), for a sign-in console. */
  keepOpen?: boolean
}

const UNSAFE_PATH = 'The path has a character (a quote, "%", or a control character) that cannot be launched safely.'
const UNSAFE_ARGUMENT =
  'An argument has a character (a quote, "%", a control character, or a final backslash) that cannot be launched safely.'

/** Letters, digits and `. _ -` mean the same to cmd.exe and to the program, so they need no quotes. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9._-]+$/

function isControl(code: number): boolean {
  return code < 32 || code === 127
}

/** Whether cmd.exe reads this text literally inside one pair of quotes. */
function isLiteralInQuotes(text: string): boolean {
  return [...text].every((char) => char !== '"' && char !== '%' && !isControl(char.charCodeAt(0)))
}

function isSafeArgument(argument: string): boolean {
  return isLiteralInQuotes(argument) && !argument.endsWith('\\')
}

function wordFor(argument: string): string {
  return PLAIN_ARGUMENT.test(argument) ? argument : `"${argument}"`
}

/**
 * The launch that runs `path` with `args` through one cmd.exe parse, or the reason it must not be run.
 * `args` are given as the program should read them, without quotes of their own.
 */
export function planShimLaunch(path: string, args: readonly string[], options: ShimOptions = {}): ShimPlan {
  if (!isLiteralInQuotes(path)) {
    return { ok: false, unsafe: 'path', reason: UNSAFE_PATH }
  }
  if (!args.every(isSafeArgument)) {
    return { ok: false, unsafe: 'argument', reason: UNSAFE_ARGUMENT }
  }
  const command = `"${[`"${path}"`, ...args.map(wordFor)].join(' ')}"`
  return {
    ok: true,
    launch: {
      file: options.comspec ?? 'cmd.exe',
      args: ['/d', '/v:off', '/s', options.keepOpen === true ? '/k' : '/c', command],
      verbatimArguments: true
    }
  }
}
