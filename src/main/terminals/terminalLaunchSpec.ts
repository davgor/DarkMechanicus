/**
 * What main starts in a chat's terminal, built from its own records only (`docs/design/chat-shells.md`, questions
 * 2 and 3). Pure: no process is started and no file is written here (`terminalFiles.ts` writes the files first).
 *
 * - **Program**: the agent row's executable. On Windows a Claude `.cmd` shim is followed to the program it runs;
 *   any other `.cmd` or `.bat` goes through the one cmd.exe parse of `planShimLaunch`.
 * - **Arguments**: per kind, from code (below), or a custom CLI's stored arguments with whole-argument
 *   `{folder}` and `{instructions}` replaced; the app adds no flags to a custom CLI. On Windows the app builds the
 *   command line itself (node-pty's pre-escaped form, which node-pty puts after the program).
 * - **cwd**: `folder`, the path `resolveLaunchFolder` returned, which is also `{folder}`, the folder Autonomous
 *   and Codex are given, and the `--repo` the `dm` invocation must be pinned to.
 * - **Environment**: `terminalEnv.ts`.
 *
 * A model that fails `isSafeModelId` (or is `default`) and a stored session id that is not a UUID are left out
 * and listed in `dropped`, so the pane can say so. What no `.cmd` line can carry (the instructions text and the
 * kickoff) is returned as `pasteFirst`, for main to paste once the CLI is ready; `kickoffIn` says
 * where the kickoff went, so main can record it as sent. The chat Start run opened (one with a `runId`) has the
 * orchestrator and worker guidance in its instructions, and a Linear transfer chat (one with a `transferEpicId`) the
 * transfer guidance, on every start.
 */
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { DomainError } from '../../core/errors'
import type { ChatRecord, DarkMechanicusCli } from '../../shared/agents/chat'
import { isSafeModelId } from '../../shared/agents/models'
import type { AgentView } from '../../shared/desktop/api'
import { windowsProgramKind } from '../desktop/agentProbe'
import { planShimLaunch } from '../agents/shimLaunch'
import { readShimFile, resolveClaudeExecutable } from './claudeExecutable'
import { pinnedCliScript } from './dmLauncher'
import { LOGIN_ARGS } from '../desktop/agentAuth'
import { terminalEnv, terminalLoginEnv } from './terminalEnv'
import { terminalInstructions, type TerminalFiles } from './terminalFiles'
import { windowsCommandLine } from './windowsCommandLine'

interface TerminalChat extends Pick<ChatRecord, 'agent' | 'role' | 'allowSave' | 'model' | 'sessionId' | 'runId' | 'transferEpicId'> {
  /** Whether the CLI has written the chat's session yet, so a start resumes it. */
  sessionStarted: boolean
  /** Whether the kickoff (an orchestrator's or a transfer chat's) went with an earlier start. */
  kickoffSent: boolean
}

/** How a Claude shim is read and followed on Windows. */
interface ShimFs {
  readFile: (path: string) => string
  isFile: (path: string) => boolean
}

export interface TerminalLaunchInput {
  chat: TerminalChat
  /** The kickoff, for a chat Start run or Transfer with agent opened; null for every other chat. */
  kickoff: string | null
  agent: Pick<AgentView, 'id' | 'kind' | 'executablePath' | 'args'>
  /** `resolveLaunchFolder`'s path. */
  folder: string
  /** The chat's `dm` invocation, pinned to `folder`, with its grant in `env` (`issueChatCli`). */
  cli: DarkMechanicusCli
  files: TerminalFiles
  platform: NodeJS.Platform
  /** main's `process.env`. */
  env: Readonly<Record<string, string | undefined>>
  /** A fresh Claude session id (a UUID), for a chat with no usable one yet. */
  newSessionId: () => string
  /** The disk, for following a Claude shim; the real one when omitted. */
  shimFs?: ShimFs
}

/** A value from the chat record the launch left out. */
interface DroppedValue {
  field: 'model' | 'sessionId'
  value: string
}

/** Where the kickoff goes with a start: on the command line (Claude's positional prompt), or in `pasteFirst`. */
type KickoffRoute = 'args' | 'paste'

interface LaunchBase {
  file: string
  cwd: string
  env: Record<string, string>
  dropped: DroppedValue[]
  /** Text main pastes as the CLI's first input once it is ready, or null. */
  pasteFirst: string | null
  /** Where the kickoff goes with this start; null when it does not (none was given, it was sent, or a resume). */
  kickoffIn: KickoffRoute | null
  /** The vendor session the CLI runs under, when known in advance: main stores it on the chat. */
  sessionId: string | null
  /** Whether the CLI is asked to resume an earlier session of the chat, which it may refuse (the pane then offers a new one). */
  resumed: boolean
}

/** The program, and its arguments as argv (macOS) or as one Windows command line the app built. */
type LaunchLine = { file: string } & ({ args: string[]; commandLine?: undefined } | { commandLine: string; args?: undefined })

export type TerminalLaunchSpec = LaunchBase & LaunchLine

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDERS = ['{folder}', '{instructions}'] as const
type Placeholder = (typeof PLACEHOLDERS)[number]
/** A drive-letter or UNC folder: never one Windows would read against the current folder. */
const ABSOLUTE_WINDOWS_FOLDER = /^(?:[A-Za-z]:\\|\\\\)/
const NO_NODE_HELP =
  "Claude Code's npm shim runs a script with node.exe, and none was found beside it or on Path. Connect claude.exe instead (the native installer puts it in %USERPROFILE%\\.local\\bin)."

const nodeShimFs: ShimFs = {
  readFile: readShimFile,
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
}

/** What the per-kind flags are built from, once every value in it has been checked. */
interface KindContext {
  folder: string
  instructionsPath: string
  instructionsText: string
  claudeSettings: string | undefined
  model: string | null
  /** A usable stored session id (a UUID), or null. */
  sessionId: string | null
  sessionStarted: boolean
  kickoff: string | null
  /** The program goes through cmd.exe, so nothing but constants, ids and paths may be on its line. */
  viaShim: boolean
  newSessionId: () => string
  customArgs: readonly string[]
}

interface KindLaunch {
  args: string[]
  pasteFirst: string | null
  kickoffIn: KickoffRoute | null
  sessionId: string | null
  resumed: boolean
}

/** The kickoff when it is due: on a chat's first start only. */
function kickoffFor(context: KindContext, resuming: boolean): string | null {
  return resuming ? null : context.kickoff
}

/** Where a kickoff that is due goes; none when it is not. */
function routeOf(kickoff: string | null, route: KickoffRoute): KickoffRoute | null {
  return kickoff === null ? null : route
}

/** The first input of a CLI that takes no instructions flag: the instructions, then the kickoff when it is due. */
function firstPrompt(context: KindContext, resuming: boolean): string | null {
  if (resuming) {
    return null
  }
  return context.kickoff === null ? context.instructionsText : `${context.instructionsText}\n\n${context.kickoff}`
}

function claudeLaunch(context: KindContext): KindLaunch {
  const resuming = context.sessionStarted && context.sessionId !== null
  const sessionId = context.sessionId ?? context.newSessionId()
  const kickoff = kickoffFor(context, resuming)
  return {
    args: [
      '--append-system-prompt-file',
      context.instructionsPath,
      ...(context.claudeSettings === undefined ? [] : ['--settings', context.claudeSettings]),
      ...(context.model === null ? [] : ['--model', context.model]),
      resuming ? '--resume' : '--session-id',
      sessionId,
      ...(kickoff === null ? [] : [kickoff])
    ],
    pasteFirst: null,
    kickoffIn: routeOf(kickoff, 'args'),
    sessionId,
    resumed: resuming
  }
}

function autonomousLaunch(context: KindContext): KindLaunch {
  const resuming = context.sessionStarted
  const kickoff = kickoffFor(context, resuming)
  return {
    args: [
      ...(resuming ? ['resume'] : ['start', context.folder]),
      ...(context.viaShim ? [] : ['--append-system-prompt', context.instructionsText]),
      '--approval-mode',
      'always-ask',
      ...(context.model === null ? [] : ['--model', context.model])
    ],
    pasteFirst: context.viaShim ? firstPrompt(context, resuming) : kickoff,
    kickoffIn: routeOf(kickoff, 'paste'),
    sessionId: null,
    resumed: resuming
  }
}

/** Codex and Cursor: flags inferred in the design (neither CLI is installed where it was written). */
function codexLaunch(context: KindContext): KindLaunch {
  const resumed = context.sessionStarted ? context.sessionId : null
  return {
    args: [...(resumed === null ? ['-C', context.folder] : ['resume', resumed]), ...(context.model === null ? [] : ['-m', context.model])],
    pasteFirst: firstPrompt(context, resumed !== null),
    kickoffIn: routeOf(kickoffFor(context, resumed !== null), 'paste'),
    sessionId: resumed,
    resumed: resumed !== null
  }
}

function cursorLaunch(context: KindContext): KindLaunch {
  const resumed = context.sessionStarted ? context.sessionId : null
  return {
    args: [...(resumed === null ? [] : ['--resume', resumed]), ...(context.model === null ? [] : ['-m', context.model])],
    pasteFirst: firstPrompt(context, resumed !== null),
    kickoffIn: routeOf(kickoffFor(context, resumed !== null), 'paste'),
    sessionId: resumed,
    resumed: resumed !== null
  }
}

/** `args` with each whole `{folder}` and `{instructions}` replaced; one inside a longer argument is refused. */
function withPlaceholders(args: readonly string[], values: Readonly<Record<Placeholder, string>>): string[] {
  return args.map((arg) => {
    const whole = PLACEHOLDERS.find((placeholder) => placeholder === arg)
    if (whole !== undefined) {
      return values[whole]
    }
    const inside = PLACEHOLDERS.find((placeholder) => arg.includes(placeholder))
    if (inside !== undefined) {
      throw new DomainError('invalid_input', `The argument ${JSON.stringify(arg)} holds ${inside} inside other text; ${inside} must be an argument of its own.`)
    }
    return arg
  })
}

function customLaunch(context: KindContext): KindLaunch {
  const values = { '{folder}': context.folder, '{instructions}': context.instructionsPath }
  const kickoff = kickoffFor(context, context.sessionStarted)
  return { args: withPlaceholders(context.customArgs, values), pasteFirst: kickoff, kickoffIn: routeOf(kickoff, 'paste'), sessionId: null, resumed: false }
}

const KIND_LAUNCHES: Record<AgentView['kind'], (context: KindContext) => KindLaunch> = {
  claude: claudeLaunch,
  autonomous: autonomousLaunch,
  codex: codexLaunch,
  cursor: cursorLaunch,
  custom: customLaunch
}

/** The program to start, the arguments that go before the kind's own, and whether it goes through cmd.exe. */
interface Program {
  file: string
  leading: string[]
  viaShim: boolean
}

/**
 * The node.exe an npm shim runs its script with: the one beside the shim, else the first in a folder of `Path`.
 * node-pty starts a program only by its exact file name, so it gets the full path; a relative `Path` folder would
 * be read against main's own folder, so only absolute ones are searched.
 */
function shimNode(shimPath: string, env: TerminalLaunchInput['env'], shimFs: ShimFs): string {
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const folders = path.split(';').map((folder) => folder.replaceAll('"', '')).filter((folder) => ABSOLUTE_WINDOWS_FOLDER.test(folder))
  const node = [win32.dirname(shimPath), ...folders].map((folder) => win32.join(folder, 'node.exe')).find((candidate) => shimFs.isFile(candidate))
  if (node === undefined) {
    throw new Error(NO_NODE_HELP)
  }
  return node
}

/** What choosing the program and building its line reads: the agent's program, main's environment, the platform. */
type ProgramInput = Pick<TerminalLaunchInput, 'env' | 'platform' | 'shimFs'> & { agent: Pick<AgentView, 'kind' | 'executablePath'> }

function windowsProgram(input: ProgramInput): Program {
  const shimFs = input.shimFs ?? nodeShimFs
  const { executablePath } = input.agent
  const path = input.agent.kind === 'claude' ? resolveClaudeExecutable(executablePath, 'win32', shimFs.readFile) : executablePath
  if (path !== executablePath && path.toLowerCase().endsWith('.js')) {
    return { file: shimNode(executablePath, input.env, shimFs), leading: [path], viaShim: false }
  }
  const kind = windowsProgramKind(path)
  if (kind === null) {
    throw new DomainError('invalid_input', 'That file is not a program Windows can run (.exe or .cmd).')
  }
  return { file: path, leading: [], viaShim: kind === 'shim' }
}

/** The chat's model as it may go on a command line: null when there is none, or when it fails the check. */
function checkedModel(input: TerminalLaunchInput, dropped: DroppedValue[]): string | null {
  const { model } = input.chat
  if (input.agent.kind === 'custom' || model === null) {
    return null
  }
  if (model === 'default' || !isSafeModelId(model)) {
    dropped.push({ field: 'model', value: model })
    return null
  }
  return model
}

/** The stored session id the launch would use, as it may go on a command line: a UUID, else null. */
function checkedSessionId(input: TerminalLaunchInput, dropped: DroppedValue[]): string | null {
  const { kind } = input.agent
  const { sessionId, sessionStarted } = input.chat
  const used = kind === 'claude' || ((kind === 'codex' || kind === 'cursor') && sessionStarted)
  if (!used || sessionId === null) {
    return null
  }
  if (!UUID.test(sessionId)) {
    dropped.push({ field: 'sessionId', value: sessionId })
    return null
  }
  return sessionId
}

function refuseMismatches(input: TerminalLaunchInput): void {
  if (input.chat.agent !== input.agent.id) {
    throw new DomainError('invalid_input', `The chat runs the agent ${input.chat.agent}, not ${input.agent.id}.`)
  }
  if (input.kickoff !== null && /^-|^\S*$/.test(input.kickoff)) {
    throw new DomainError('invalid_input', 'The kickoff is empty, one word or starts with "-", which a CLI would read as a subcommand or an option.')
  }
  pinnedCliScript(input.cli, input.folder)
}

function commandLineFor(input: ProgramInput, program: Program, args: string[]): LaunchLine {
  if (input.platform !== 'win32') {
    return { file: program.file, args: [...program.leading, ...args] }
  }
  if (!program.viaShim) {
    return { file: program.file, commandLine: windowsCommandLine([...program.leading, ...args]) }
  }
  const plan = planShimLaunch(program.file, args, { env: input.env })
  if (!plan.ok) {
    throw new DomainError('unsafe_path', plan.reason)
  }
  return { file: plan.launch.file, commandLine: plan.launch.args.join(' ') }
}

export function terminalLaunchSpec(input: TerminalLaunchInput): TerminalLaunchSpec {
  refuseMismatches(input)
  const { chat, agent, files, platform } = input
  const launcherDir = platform === 'win32' ? null : files.launcherDir
  const env = terminalEnv({ base: input.env, platform, kind: agent.kind, cli: input.cli, launcherDir })
  const program: Program = platform === 'win32' ? windowsProgram(input) : { file: agent.executablePath, leading: [], viaShim: false }
  const dropped: DroppedValue[] = []
  const model = checkedModel(input, dropped)
  const sessionId = checkedSessionId(input, dropped)
  const launch = KIND_LAUNCHES[agent.kind]({
    folder: input.folder,
    instructionsPath: files.instructions,
    instructionsText: terminalInstructions({
      cli: input.cli,
      role: chat.role,
      allowSave: chat.allowSave,
      launcherDir,
      orchestratesRun: chat.runId !== undefined,
      ...(chat.transferEpicId === undefined ? {} : { transferEpicId: chat.transferEpicId })
    }),
    claudeSettings: files.claudeSettings,
    model,
    sessionId,
    sessionStarted: chat.sessionStarted,
    kickoff: chat.kickoffSent ? null : input.kickoff,
    viaShim: program.viaShim,
    newSessionId: input.newSessionId,
    customArgs: agent.args
  })
  return {
    ...commandLineFor(input, program, launch.args),
    cwd: input.folder,
    env,
    dropped,
    pasteFirst: launch.pasteFirst,
    kickoffIn: launch.kickoffIn,
    sessionId: launch.sessionId,
    resumed: launch.resumed
  }
}

export interface TerminalLoginInput extends ProgramInput {
  agent: Pick<AgentView, 'id' | 'kind' | 'executablePath'>
  /** The person's home folder: where the sign-in runs. */
  home: string
}

/** An agent's sign-in terminal: its program and the CLI's own login command (`LOGIN_ARGS`). */
type TerminalLoginSpec = LaunchLine & { cwd: string; env: Record<string, string> }

/**
 * What main starts in a built-in agent's sign-in terminal: the registered executable (followed on Windows as for a
 * chat) with the kind's constant `LOGIN_ARGS` and nothing else, in the home folder, with the scrubbed environment and
 * no grant, no instructions and no session. A custom CLI has no login command the app knows, so it is refused.
 */
export function terminalLoginSpec(input: TerminalLoginInput): TerminalLoginSpec {
  const { kind } = input.agent
  if (kind === 'custom') {
    throw new DomainError('invalid_input', 'A custom CLI has no sign-in command the app knows. Sign it in from a terminal.')
  }
  const program: Program = input.platform === 'win32' ? windowsProgram(input) : { file: input.agent.executablePath, leading: [], viaShim: false }
  return { ...commandLineFor(input, program, [...LOGIN_ARGS[kind]]), cwd: input.home, env: terminalLoginEnv(input.env) }
}
