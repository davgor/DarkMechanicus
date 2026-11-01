/**
 * The command line a terminal's Windows program is started with. node-pty takes a "pre-escaped" command line
 * and would otherwise apply its own quoting, which treats an argument that already starts and ends with `"` as
 * quoted; the app does not rely on that and builds the line itself, with exactly the quoting Node's
 * `child_process` uses (libuv's `quote_cmd_arg`), so a program that splits its command line by the Microsoft C
 * runtime's rules reads back the arguments the app meant. This is for `.exe` programs only: a `.cmd` goes
 * through cmd.exe, which has rules of its own (`planShimLaunch`).
 */

/** Characters that make an argument need quotes. */
const NEEDS_QUOTES = /[ \t"]/
/** Characters that need escaping inside quotes. */
const NEEDS_ESCAPES = /["\\]/

function quoteArgument(arg: string): string {
  if (arg.includes('\0')) {
    throw new Error('An argument holds a NUL character, which a Windows command line cannot carry.')
  }
  if (arg === '') {
    return '""'
  }
  if (!NEEDS_QUOTES.test(arg)) {
    return arg
  }
  if (!NEEDS_ESCAPES.test(arg)) {
    return `"${arg}"`
  }
  // Each quote gets a backslash, and the backslashes right before a quote, or before the closing quote, are doubled.
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** `args` as one Windows command line, each quoted as Node quotes it. */
export function windowsCommandLine(args: readonly string[]): string {
  return args.map(quoteArgument).join(' ')
}
