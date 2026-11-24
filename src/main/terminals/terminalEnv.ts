/**
 * The environment a chat's terminal starts with, in layers:
 *
 * 1. main's own environment, without the Electron and Node switches (`ELECTRON_RUN_AS_NODE`, every `ELECTRON_*`,
 *    `NODE_OPTIONS`) and without any name the layers below set, in any letter case, since Windows reads names
 *    without case;
 * 2. the terminal's constants, `TERM` and `COLORTERM`, for OMP its hyperlink and synchronized-output switches, and for Claude the switch that
 *    turns off its own memory;
 * 3. the chat's `dm` environment: its grant (`DM_SESSION_TOKEN`) and `DARKMECHANICUS_HOME`, nothing else from
 *    the invocation; on Windows a packaged app's `ELECTRON_RUN_AS_NODE=1` stays, as today, because there is no
 *    launcher to hold it (a known limitation); for an OMP chat with a mailbox, the path of its launch's mail client
 *    descriptor (`DM_SKITARII_CLIENT_DESCRIPTOR`, `terminalFiles.ts`), and for no other chat;
 * 4. on macOS, the chat's launcher folder first on `PATH`.
 *
 * An agent's sign-in terminal (`terminalLoginEnv`) gets layers 1 and 2 only, the Claude switch aside, and no
 * `DM_SESSION_TOKEN` or descriptor in any letter case: it runs with no grant.
 */
import { DM_CLIENT_DESCRIPTOR_ENV } from '../../../resources/skitarii/extension/dmClient'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import type { AgentView } from '../../shared/desktop/api'

/** Names main's own environment never passes on, in any letter case, even when the layers above set none. */
const NEVER_PASSED = ['DM_SESSION_TOKEN', 'DM_DESKTOP_PIPE', DM_CLIENT_DESCRIPTOR_ENV]

const SCRUBBED = /^(?:ELECTRON_.*|NODE_OPTIONS)$/i

const TERMINAL_CONSTANTS: Readonly<Record<string, string>> = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }

/**
 * What OMP's terminal detection cannot learn from `TERM` and `COLORTERM` (`docs/reports/omp-cli.md`, 7): the pane
 * draws OSC 8 hyperlinks and opens them, but OMP writes them only for terminals it knows or when forced; and xterm 6
 * supports synchronized output (DEC 2026), but under ConPTY OMP's DECRQM probe for it gets no reply (section 7), so
 * it is switched on rather than probed.
 */
const OMP_CONSTANTS: Readonly<Record<string, string>> = { PI_FORCE_HYPERLINKS: '1', PI_FORCE_SYNC_OUTPUT: '1' }

interface TerminalEnvOptions {
  /** main's `process.env`. */
  base: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  kind: AgentView['kind']
  cli: DarkMechanicusCli
  /** The chat's launcher folder; needed on macOS, ignored on Windows. */
  launcherDir: string | null
  /** The launch's mail client descriptor (`writeDmClientDescriptor`): an OMP chat with a mailbox only. */
  dmClient?: string
  /** Set only for a project-less chat that reaches no folder: it starts with no grant, so none is required. */
  grantless?: true
  /** Structured stdio has no terminal, including any inherited terminal variables. */
  headless?: true
}

/** The descriptor's variable, for an OMP launch that has one; any other kind given one is refused. */
function dmClientEnv(kind: AgentView['kind'], dmClient: string | undefined): Record<string, string> {
  if (dmClient === undefined) {
    return {}
  }
  if (kind !== 'omp') {
    throw new Error('Only an OMP chat is started with a mail client descriptor.')
  }
  return { [DM_CLIENT_DESCRIPTOR_ENV]: dmClient }
}

function dmEnv(cli: DarkMechanicusCli, platform: NodeJS.Platform, grantless: boolean): Record<string, string> {
  const token = cli.env['DM_SESSION_TOKEN']
  const granted = token !== undefined && token !== ''
  if (!granted && !grantless) {
    throw new Error('The chat has no grant: its dm environment holds no DM_SESSION_TOKEN.')
  }
  const home = cli.env['DARKMECHANICUS_HOME']
  return {
    ...(granted ? { DM_SESSION_TOKEN: token } : {}),
    ...(cli.env['DM_DESKTOP_PIPE'] === undefined ? {} : { DM_DESKTOP_PIPE: cli.env['DM_DESKTOP_PIPE'] }),
    ...(home === undefined ? {} : { DARKMECHANICUS_HOME: home }),
    ...(platform === 'win32' && cli.env['ELECTRON_RUN_AS_NODE'] === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {})
  }
}

/** `PATH` with the launcher folder first; unchanged when the folder holds a `:`, which would split it. */
function pathWithLauncher(path: string | undefined, launcherDir: string | null): string | undefined {
  if (launcherDir === null) {
    throw new Error("A macOS terminal needs the chat's dm launcher folder.")
  }
  if (launcherDir.includes(':')) {
    return path
  }
  return path === undefined || path === '' ? launcherDir : `${launcherDir}:${path}`
}

/** `base` without the Electron and Node switches and without `own`'s names (in any letter case), then `own`. */
function layered(base: TerminalEnvOptions['base'], own: Readonly<Record<string, string>>, removed: readonly string[] = []): Record<string, string> {
  // Windows reads names without case, so main's `term` and the terminal's `TERM` would be one variable set twice.
  const ownNames = new Set([...Object.keys(own), ...removed])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !SCRUBBED.test(key) && !ownNames.has(key.toUpperCase())) {
      env[key] = value
    }
  }
  return Object.assign(env, own)
}

export function terminalEnv(options: TerminalEnvOptions): Record<string, string> {
  const own: Record<string, string> = {
    ...(options.headless ? {} : TERMINAL_CONSTANTS),
    ...(options.kind === 'omp' ? OMP_CONSTANTS : {}),
    ...(options.kind === 'claude' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
    ...dmEnv(options.cli, options.platform, options.grantless === true),
    ...dmClientEnv(options.kind, options.dmClient)
  }
  const env = layered(options.base, own, options.headless ? [...NEVER_PASSED, 'TERM', 'COLORTERM'] : NEVER_PASSED)
  if (options.platform !== 'win32') {
    const path = pathWithLauncher(env['PATH'], options.launcherDir)
    if (path !== undefined) {
      env['PATH'] = path
    }
  }
  return env
}

/** The environment of an agent's sign-in terminal: main's own, scrubbed, with the terminal's constants and no grant, naming address or descriptor. */
export function terminalLoginEnv(base: TerminalEnvOptions['base']): Record<string, string> {
  return layered(base, TERMINAL_CONSTANTS, NEVER_PASSED)
}

/** A headless arbiter inherits sign-in environment, never a chat grant, pipe, descriptor or terminal. */
export function arbiterEnv(base: TerminalEnvOptions['base'], kind: 'claude' | 'omp'): Record<string, string> {
  const own = kind === 'claude' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : OMP_CONSTANTS
  return layered(base, own, [...NEVER_PASSED, 'TERM', 'COLORTERM'])
}
