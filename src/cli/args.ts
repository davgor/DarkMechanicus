/**
 * Launch options of the `dm` CLI.
 *
 * There is deliberately no `--role`. A local process can pass any flag it likes, so a role asked
 * for on the command line would be a role granted to whoever ran the command. The role comes from
 * a grant a person issued at the desktop (`$DM_SESSION_TOKEN`, or `--token-file`), and a session
 * that presents none is a reader.
 */
import { resolve } from 'node:path'

type CliMode =
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'describe'; command: string }
  | { kind: 'call'; command: string; input: string }

export interface CliOptions {
  repo: string
  mode: CliMode
  /** Path of a file holding the grant token, preferred over the environment. */
  tokenFile: string | null
}

const REPO_ENV = 'DARKMECHANICUS_REPO'
/** The token is read from here unless `--token-file` names a file. */
export const TOKEN_ENV = 'DM_SESSION_TOKEN'

export const CLI_USAGE = [
  'Usage: dm [--repo <path>] [--token-file <path>] <command> [arguments]',
  '',
  'Runs one Dark Mechanicus command against a repository and prints JSON.',
  '',
  'Commands:',
  '  --list                   Every command, with the capability it needs',
  '  --describe <command>     One command: what it needs and its input schema',
  '  call <command> [json]    Run <command> with a JSON object of arguments (default {})',
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
  rest: string[]
  help: boolean
}

/** Flags that take a value, and where that value is kept. */
const VALUE_FLAGS: Readonly<Record<string, 'repo' | 'tokenFile'>> = {
  '--repo': 'repo',
  '--token-file': 'tokenFile'
}

/** Flags that are modes rather than options, so they travel with the positional words. */
const MODE_FLAGS: readonly string[] = ['--list', '--describe']

function takeValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1]
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw usageError(`${name} requires a value.`)
  }
  return value
}

function readFlags(argv: readonly string[]): Parsed {
  const parsed: Parsed = { rest: [], help: false }
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
    // An unrecognized flag is a mistake, not a positional: `--role` must never be read as data.
    if (token.startsWith('--') && !MODE_FLAGS.includes(token)) {
      throw usageError(`Unknown option "${token}".`)
    }
    parsed.rest.push(token)
    index += 1
  }
  return parsed
}

function modeOf(rest: readonly string[]): CliMode {
  const [first, second, third] = rest
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
    return { kind: 'call', command: second, input: third ?? '{}' }
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
  return { repo, tokenFile, mode: modeOf(flags.rest) }
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}
