/**
 * Entry point of the `dm` CLI (`out/main/cli.js`).
 *
 * One invocation runs one command and prints JSON on stdout: `{ "ok": true, "data": … }` or
 * `{ "ok": false, "error": { "code", "message" } }`. Everything human-readable goes to stderr, so
 * the output is safe to pipe into `jq` or read back by an agent.
 *
 * The CLI is a transport, not an authority. It exposes the same command table the desktop app and
 * the MCP server use, and the session's role comes from a grant a person issued — never from a
 * flag, because a local process chooses its own flags. Without a grant it is a reader.
 */
import { readFileSync } from 'node:fs'
import { COMMAND_CAPABILITIES } from '../core/commands/capabilities'
import { COMMANDS } from '../core/commands/index'
import { DomainError, toErrorShape } from '../core/errors'
import type { CommandName } from '../shared/domain/api'
import { openWorkspace, type OpenWorkspaceOptions, type Workspace } from '../core/workspace'
import { CLI_USAGE, type CliOptions, parseCliArgs, TOKEN_ENV } from './args'

/** Exit codes: 0 fine, 1 the command failed, 2 the arguments were wrong. */
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

export interface CliHost {
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
  open: (options: OpenWorkspaceOptions) => Workspace
  readFile: (path: string) => string
  writeStdout: (text: string) => void
  writeStderr: (text: string) => void
  exit: (code: number) => void
}

function commandNames(): CommandName[] {
  return (Object.keys(COMMANDS) as CommandName[]).sort()
}

/** `claimTicket` → `claim_ticket`: the spelling the skills, the docs and the MCP tools all use. */
export function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/** Both spellings of every command, so either works and neither has to be remembered. */
const BY_NAME: ReadonlyMap<string, CommandName> = new Map(
  commandNames().flatMap((name) => [
    [name, name],
    [snakeCase(name), name]
  ])
)

/** The command `name` asks for in either spelling, or null when it names none. */
export function resolveCommand(name: string): CommandName | null {
  return BY_NAME.get(name) ?? null
}

/** Every command with the capability it needs and whether it changes anything. */
function listing(): unknown {
  return commandNames().map((name) => ({
    command: snakeCase(name),
    alias: name,
    capability: COMMAND_CAPABILITIES[name],
    mutates: COMMANDS[name].mutates,
    beforeInitialize: COMMANDS[name].beforeInit === true
  }))
}

function describing(name: CommandName): unknown {
  const spec = COMMANDS[name]
  return {
    command: snakeCase(name),
    alias: name,
    capability: COMMAND_CAPABILITIES[name],
    mutates: spec.mutates,
    beforeInitialize: spec.beforeInit === true,
    input: spec.schema === undefined ? null : describeSchema(spec.schema)
  }
}

/** The input shape, as far as zod will describe it without a JSON Schema dependency. */
function describeSchema(schema: { safeParse: (value: unknown) => unknown }): unknown {
  const candidate = schema as { _zod?: { def?: { shape?: Record<string, unknown> } } }
  const shape = candidate._zod?.def?.shape
  if (shape === undefined) {
    return { fields: null, note: 'Pass a JSON object; the command validates it and says what is wrong.' }
  }
  return { fields: Object.keys(shape).sort() }
}

function parseInputJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new DomainError('invalid_input', 'The arguments must be one JSON object.')
  }
}

/** The grant token, from the named file or the environment; null when neither has one. */
function readToken(host: CliHost, options: CliOptions): string | null {
  if (options.tokenFile !== null) {
    return host.readFile(options.tokenFile).trim() || null
  }
  const fromEnv = host.env[TOKEN_ENV]?.trim()
  return fromEnv === undefined || fromEnv === '' ? null : fromEnv
}

function ok(host: CliHost, data: unknown): void {
  host.writeStdout(`${JSON.stringify({ ok: true, data }, null, 2)}\n`)
}

function failed(host: CliHost, error: unknown): void {
  host.writeStdout(`${JSON.stringify({ ok: false, error: toErrorShape(error) }, null, 2)}\n`)
}

/**
 * The first thing anyone meets is `unauthorized`, because a session reads until it is granted a
 * role. Say where a role comes from, on stderr so the JSON on stdout stays clean — but only when
 * no grant was presented, since a session that has one is being told something else.
 */
function hintAboutGrants(host: CliHost, error: unknown, presentedToken: boolean): void {
  if (presentedToken || toErrorShape(error).code !== 'unauthorized') {
    return
  }
  host.writeStderr(
    `dm: this session presented no grant, so it may only read. Issue one in the desktop app (the folder's Agent access card) and pass it as $${TOKEN_ENV} or --token-file.\n`
  )
}

async function runCommand(host: CliHost, options: CliOptions, requested: string, input: string): Promise<number> {
  const name = resolveCommand(requested)
  if (name === null) {
    host.writeStderr(`dm: unknown command "${requested}". Use --list to see them all.\n`)
    return EXIT_USAGE
  }
  const token = readToken(host, options)
  let workspace: Workspace | null = null
  try {
    // Opening is part of the attempt: an unusable grant fails here, and must be reported the same
    // way a refused command is rather than escaping as a crash.
    workspace = host.open({
      repoRoot: options.repo,
      role: 'reader',
      label: 'dm CLI',
      transport: 'cli',
      pid: process.pid,
      ...(token === null ? {} : { grantToken: token })
    })
    ok(host, await workspace.execute(name, parseInputJson(input)))
    return EXIT_OK
  } catch (error) {
    failed(host, error)
    hintAboutGrants(host, error, token !== null)
    return EXIT_FAILED
  } finally {
    workspace?.close()
  }
}

/** Opening can fail too (an unusable grant, an uninitialized folder); that is a command failure. */
async function dispatch(host: CliHost, options: CliOptions): Promise<number> {
  switch (options.mode.kind) {
    case 'help':
      host.writeStdout(`${CLI_USAGE}\n`)
      return EXIT_OK
    case 'list':
      ok(host, listing())
      return EXIT_OK
    case 'describe': {
      const name = resolveCommand(options.mode.command)
      if (name === null) {
        host.writeStderr(`dm: unknown command "${options.mode.command}". Use --list to see them all.\n`)
        return EXIT_USAGE
      }
      ok(host, describing(name))
      return EXIT_OK
    }
    default:
      return runCommand(host, options, options.mode.command, options.mode.input)
  }
}

export async function runCli(host: CliHost): Promise<void> {
  let options: CliOptions
  try {
    options = parseCliArgs(host.argv, host.env, host.cwd)
  } catch (error) {
    host.writeStderr(`dm: ${error instanceof Error ? error.message : String(error)}\n`)
    host.exit(EXIT_USAGE)
    return
  }
  try {
    host.exit(await dispatch(host, options))
  } catch (error) {
    failed(host, error)
    host.exit(EXIT_FAILED)
  }
}

const ENTRY = /(?:^|[\\/])cli\.js$/

function runIfEntry(entry: string | undefined, run: () => void): boolean {
  if (entry === undefined || !ENTRY.test(entry)) {
    return false
  }
  run()
  return true
}

function nodeHost(): CliHost {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    open: (options) => openWorkspace(options),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeStdout: (text) => {
      process.stdout.write(text)
    },
    writeStderr: (text) => {
      process.stderr.write(text)
    },
    exit: (code) => process.exit(code)
  }
}

runIfEntry(process.argv[1], () => {
  void runCli(nodeHost())
})
