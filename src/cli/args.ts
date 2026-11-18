/**
 * Launch options of the `dm` CLI.
 *
 * There is deliberately no `--role`. A local process can pass any flag it likes, so a role asked
 * for on the command line would be a role granted to whoever ran the command. The role comes from
 * a grant a person issued at the desktop (`$DM_SESSION_TOKEN`, or `--token-file`), and a session
 * that presents none is a reader.
 */
import { resolve } from 'node:path'
import { USAGE_BILLINGS, type UsageBilling } from '../shared/domain/hostUsage'

/** Where a call's arguments come from: one inline JSON object, a file, or stdin. */
export type CallInput =
  | { source: 'inline'; text: string }
  | { source: 'file'; path: string }
  | { source: 'stdin' }

type CliMode =
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'describe'; command: string }
  | { kind: 'call'; command: string; input: CallInput }
  | { kind: 'transfer'; target: 'linear'; epicId: string; json: boolean }
  | UsageMode

/** `usage --run <id>`: reads the host's own session files and reports their usage to the run (`cli/usage.ts`). */
export interface UsageMode {
  kind: 'usage'
  runId: string
  /** The host session file to read (default `$PI_SESSION_FILE`); null with `unavailable`. */
  sessionFile: string | null
  billing: UsageBilling
  dryRun: boolean
  /** `--unavailable <host>`: the host cannot report usage; its buckets are recorded as unavailable instead. */
  unavailable: string | null
}

export interface CliOptions {
  repo: string
  mode: CliMode
  /** Path of a file holding the grant token, preferred over the environment. */
  tokenFile: string | null
}

const REPO_ENV = 'DARKMECHANICUS_REPO'
/** The token is read from here unless `--token-file` names a file. */
export const TOKEN_ENV = 'DM_SESSION_TOKEN'
/** OMP tells the tools it runs which session file they belong to. */
const SESSION_FILE_ENV = 'PI_SESSION_FILE'

export const CLI_USAGE = [
  'Usage: dm [--repo <path>] [--token-file <path>] <command> [arguments]',
  '',
  'Runs one Dark Mechanicus command against a repository and prints JSON.',
  '',
  'Commands:',
  '  --list                   Every command, with the capability it needs',
  '  --describe <command>     One command: what it needs and its input schema',
  '  call <command> [json|-]  Run <command> with a JSON object of arguments (default {}); - reads stdin',
  '  call <command> --args-file <path>',
  '                           Run <command> with the JSON object read from a file (a BOM is ignored)',
  '  transfer linear --epic <id> [--json]',
  '                           The Linear transfer kickoff for an epic, as text; --json prints its packet',
  '  usage --run <id> [--session-file <path>] [--billing api_key|subscription|unknown] [--dry-run]',
  '                           Reads your host session (default $PI_SESSION_FILE) and records its token and',
  '                           active-time usage to the run: each subagent to the attempt whose claim it held,',
  '                           the main thread as orchestration, the rest as unattributed (orchestrator grant)',
  '  usage --run <id> --unavailable <host>',
  '                           Records that your host cannot report usage (never an estimate)',
  '  --help                   Show this help',
  '',
  'Options:',
  '  --repo <path>            Repository root (default: $DARKMECHANICUS_REPO, else the current directory)',
  '  --token-file <path>      File holding a grant token, instead of $DM_SESSION_TOKEN',
  '',
  'Authority:',
  `  A session runs as a reader — it may only read — until it presents a grant. Issue one in the`,
  '  desktop app (Storage → Authorize an agent), then pass it through $DM_SESSION_TOKEN or',
  '  --token-file. A grant expires, can be revoked, and never carries a capability reserved to a',
  '  person, so approving a checkpoint or deleting an epic stays in the app.'
].join('\n')

function usageError(message: string): Error {
  return new Error(`${message}\n\n${CLI_USAGE}`)
}

interface Parsed {
  repo?: string
  tokenFile?: string
  epic?: string
  argsFile?: string
  run?: string
  sessionFile?: string
  billing?: string
  unavailable?: string
  json: boolean
  dryRun: boolean
  rest: string[]
  help: boolean
}

type ValueFlag = 'repo' | 'tokenFile' | 'epic' | 'argsFile' | 'run' | 'sessionFile' | 'billing' | 'unavailable'

/** Flags that take a value, and where that value is kept. */
const VALUE_FLAGS: Readonly<Record<string, ValueFlag>> = {
  '--repo': 'repo',
  '--token-file': 'tokenFile',
  '--epic': 'epic',
  '--args-file': 'argsFile',
  '--run': 'run',
  '--session-file': 'sessionFile',
  '--billing': 'billing',
  '--unavailable': 'unavailable'
}

/** The flags only `usage` takes. */
const USAGE_FLAGS: readonly ValueFlag[] = ['run', 'sessionFile', 'billing', 'unavailable']

/** Flags that are modes rather than options, so they travel with the positional words. */
const MODE_FLAGS: readonly string[] = ['--list', '--describe']

/** Flags that take no value, and where they are kept. */
const SWITCH_FLAGS: Readonly<Record<string, 'json' | 'dryRun'>> = { '--json': 'json', '--dry-run': 'dryRun' }

function takeValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1]
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw usageError(`${name} requires a value.`)
  }
  return value
}

function readFlags(argv: readonly string[]): Parsed {
  const parsed: Parsed = { rest: [], help: false, json: false, dryRun: false }
  let index = 0
  while (index < argv.length) {
    const token = argv[index] ?? ''
    if (token === '--help' || token === '-h') {
      parsed.help = true
      return parsed
    }
    const key = VALUE_FLAGS[token]
    if (key !== undefined) {
      parsed[key] = takeValue(argv, index, token)
      index += 2
      continue
    }
    const flag = SWITCH_FLAGS[token]
    if (flag !== undefined) {
      parsed[flag] = true
      index += 1
      continue
    }
    // An unrecognized flag is a mistake, not a positional: `--role` must never be read as data.
    if (token.startsWith('--') && !MODE_FLAGS.includes(token)) {
      throw usageError(`Unknown option "${token}".`)
    }
    parsed.rest.push(token)
    index += 1
  }
  return parsed
}

/** `transfer linear --epic <id> [--json]`: the only mode that takes `--epic` and `--json`. */
function transferMode(flags: Parsed): CliMode {
  const [, target, extra] = flags.rest
  if (target !== 'linear' || extra !== undefined) {
    throw usageError('transfer takes one target: linear.')
  }
  if (flags.epic === undefined) {
    throw usageError('transfer linear requires --epic <id>.')
  }
  return { kind: 'transfer', target: 'linear', epicId: flags.epic, json: flags.json }
}

/** `--billing`, defaulting to `unknown`: how the account pays for tokens. */
function billingOf(flags: Parsed): UsageBilling {
  const billing = flags.billing ?? 'unknown'
  const known = USAGE_BILLINGS.find((item) => item === billing)
  if (known === undefined) {
    throw usageError(`--billing is one of ${USAGE_BILLINGS.join(', ')}.`)
  }
  return known
}

/** The session file to read: `--session-file`, else `$PI_SESSION_FILE`; none with `--unavailable`. */
function sessionFileOf(flags: Parsed, env: Record<string, string | undefined>, cwd: string): string | null {
  if (flags.unavailable !== undefined) {
    if (flags.sessionFile !== undefined) {
      throw usageError('Give --session-file or --unavailable, not both.')
    }
    return null
  }
  const path = flags.sessionFile ?? nonBlank(env[SESSION_FILE_ENV])
  return path === undefined ? null : resolve(cwd, path)
}

/** `usage --run <id> …`: the only mode that takes the usage flags. */
function usageMode(flags: Parsed, env: Record<string, string | undefined>, cwd: string): UsageMode {
  if (flags.rest.length > 1 || flags.argsFile !== undefined) {
    throw usageError('usage takes only its flags.')
  }
  if (flags.run === undefined) {
    throw usageError('usage requires --run <id>.')
  }
  return {
    kind: 'usage',
    runId: flags.run,
    sessionFile: sessionFileOf(flags, env, cwd),
    billing: billingOf(flags),
    dryRun: flags.dryRun,
    unavailable: flags.unavailable ?? null
  }
}

function modeOf(flags: Parsed, env: Record<string, string | undefined>, cwd: string): CliMode {
  if (flags.rest[0] === 'usage') {
    if (flags.epic !== undefined || flags.json) {
      throw usageError('--epic and --json belong to transfer linear only.')
    }
    return usageMode(flags, env, cwd)
  }
  if (USAGE_FLAGS.some((flag) => flags[flag] !== undefined) || flags.dryRun) {
    throw usageError('--run, --session-file, --billing, --unavailable and --dry-run belong to usage only.')
  }
  if (flags.rest[0] === 'transfer') {
    if (flags.argsFile !== undefined) {
      throw usageError('--args-file belongs to call only.')
    }
    return transferMode(flags)
  }
  if (flags.epic !== undefined || flags.json) {
    throw usageError('--epic and --json belong to transfer linear only.')
  }
  return commandMode(flags, cwd)
}

/**
 * The arguments of `call`: the third word is inline JSON, or `-` for stdin; `--args-file` names a
 * file instead. Two sources at once are refused, so a reader never wonders which one won.
 */
function callInput(third: string | undefined, argsFile: string | undefined, cwd: string): CallInput {
  if (third !== undefined && argsFile !== undefined) {
    throw usageError('Give the arguments once: inline JSON, - (stdin) or --args-file, not two of them.')
  }
  if (third === '-') {
    return { source: 'stdin' }
  }
  if (third !== undefined) {
    return { source: 'inline', text: third }
  }
  if (argsFile !== undefined) {
    return { source: 'file', path: resolve(cwd, argsFile) }
  }
  return { source: 'inline', text: '{}' }
}

function commandMode(flags: Parsed, cwd: string): CliMode {
  const rest = flags.rest
  const [first, second, third] = rest
  if (flags.argsFile !== undefined && first !== 'call') {
    throw usageError('--args-file belongs to call only.')
  }
  if (first === undefined) {
    throw usageError('Give a command.')
  }
  if (first === '--list') {
    return { kind: 'list' }
  }
  if (first === '--describe') {
    if (second === undefined) {
      throw usageError('--describe requires a command name.')
    }
    return { kind: 'describe', command: second }
  }
  if (first === 'call') {
    if (second === undefined) {
      throw usageError('call requires a command name.')
    }
    if (rest.length > 3) {
      throw usageError('call takes a command name and at most one JSON argument.')
    }
    return { kind: 'call', command: second, input: callInput(third, flags.argsFile, cwd) }
  }
  throw usageError(`Unknown command "${first}".`)
}

export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string
): CliOptions {
  const flags = readFlags(argv)
  const repo = resolve(cwd, flags.repo ?? nonBlank(env[REPO_ENV]) ?? cwd)
  const tokenFile = flags.tokenFile === undefined ? null : resolve(cwd, flags.tokenFile)
  if (flags.help) {
    return { repo, tokenFile, mode: { kind: 'help' } }
  }
  return { repo, tokenFile, mode: modeOf(flags, env, cwd) }
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}
