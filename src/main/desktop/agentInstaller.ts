/**
 * Downloads an agent: asks the person, fetches the vendor's official installer, checks it, runs it,
 * then finds, probes and stores the CLI it installed. A pure orchestration over injected dependencies
 * (no Electron, no network, no process of its own), so tests drive it with fake downloads and runners.
 *
 * Order, which is the contract:
 * 1. The confirmation (source URL, command, location) is shown first. Nothing is fetched, written or
 *    spawned until it answers yes; a no leaves everything as it was.
 * 2. The installer script is downloaded to a temp file this process owns and, where the vendor
 *    publishes a checksum for it, verified; a mismatch refuses the script before it runs.
 * 3. The script runs without a shell string and without any renderer text (see `installerLaunch`).
 * 4. The executable is looked for where the vendor installs it (see each recipe's `layout`), probed
 *    with the same check as "Find", and only then stored. Any failure on the way stores nothing and
 *    reports why, with the installer's last output lines.
 *
 * A vendor installer that is run again updates the CLI in place, so running Download on an installed
 * agent re-probes it and stores the new version.
 */
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import { AGENT_DEFINITIONS } from '../../shared/desktop/agentKinds'
import type {
  AgentDownloadFailureCode,
  AgentDownloadPhase,
  AgentDownloadProgress,
  AgentDownloadResult,
  AgentKind
} from '../../shared/desktop/api'
import {
  installerLaunch,
  resolveRecipe,
  type InstallEnvironment,
  type InstallLaunch,
  type InstallRecipe,
  type ScriptIntegrity
} from './agentInstallRecipes'
import type { AgentProbeResult, FileCheck } from './agentProbe'
import type { AgentRegistry } from './agentRegistry'

/** Installers download a package and unpack it; generous, but not forever. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
const LAST_OUTPUT_LINES = 12
const MAX_LINE_CHARS = 400
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/i
/** Terminal colour codes installers print even when piped. */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

/** How the installer process ended; `output` is the end of stdout and stderr together. */
export type InstallOutcome =
  | { kind: 'exited'; exitCode: number; output: string }
  | { kind: 'timed_out'; output: string }
  | { kind: 'spawn_failed'; code: string | null; message: string }

export type InstallRunner = (launch: InstallLaunch, timeoutMs: number) => Promise<InstallOutcome>

export interface InstallerHttp {
  /** GETs an HTTPS URL and parses the JSON body. */
  getJson(url: string): Promise<unknown>
  /** Streams an HTTPS URL to `destination` and returns its SHA-256 (lower-case hex); `onPercent` is null when the size is unknown. */
  download(url: string, destination: string, onPercent: (percent: number | null) => void): Promise<{ sha256: string }>
}

export interface InstallerFiles {
  /** A fresh folder only this process can use, for the downloaded script. */
  makeTempDir(): string
  removeDir(path: string): void
}

/** What the person is asked to approve, taken from the recipe so the question and the action cannot differ. */
export interface InstallConfirmation {
  kind: AgentKind
  displayName: string
  /** Where the installer script is fetched from. */
  sourceUrl: string
  /** What will run (the downloaded script appears as a placeholder). */
  command: string
  /** The folders the installer writes to. */
  location: string
  /** How the download is checked, and what else the installer does. */
  notes: readonly string[]
  docsUrl: string
}

export interface InstallerDeps {
  environment: InstallEnvironment
  /** Asks the person; resolves true only for an explicit yes. */
  confirm: (confirmation: InstallConfirmation) => Promise<boolean>
  http: InstallerHttp
  run: InstallRunner
  files: InstallerFiles
  inspect: (path: string) => FileCheck
  /** The Find probe (`probeAgent`, wired in main). */
  probeAgent: (kind: AgentKind, executablePath: string) => Promise<AgentProbeResult>
  agents: Pick<AgentRegistry, 'list' | 'upsert'>
  report: (progress: AgentDownloadProgress) => void
  /** How long the installer may run; defaults to ten minutes. */
  timeoutMs?: number
}

export interface AgentInstaller {
  download(kind: AgentKind): Promise<AgentDownloadResult>
}

/** A step that failed for a reason worth telling the person; carries the installer output when it ran. */
class InstallFailure extends Error {
  constructor(
    readonly code: AgentDownloadFailureCode,
    message: string,
    readonly output: string[] = []
  ) {
    super(message)
  }
}

interface InstallContext {
  deps: InstallerDeps
  recipe: InstallRecipe
  report: (phase: AgentDownloadPhase, percent?: number | null) => void
}

interface ScriptSource {
  url: string
  /** The published SHA-256 (lower-case hex), or null when the vendor publishes none for the script. */
  sha256: string | null
}

const scriptName = (recipe: InstallRecipe): string => (recipe.interpreter === 'powershell' ? 'install.ps1' : 'install.sh')

/** The end of the output, one trimmed line each, so a failure shows what the installer last said. */
function lastOutputLines(output: string): string[] {
  return output
    .replace(ANSI_ESCAPE, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-LAST_OUTPUT_LINES)
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line))
}

function describeInstall(recipe: InstallRecipe, environment: InstallEnvironment): InstallConfirmation {
  const launch = installerLaunch(recipe, `<downloaded ${scriptName(recipe)}>`, environment)
  const assignments = Object.entries(launch.env).map(([name, value]) => `${name}=${value}`)
  return {
    kind: recipe.kind,
    displayName: AGENT_DEFINITIONS[recipe.kind].displayName,
    sourceUrl: recipe.scriptUrl,
    command: [...assignments, launch.file, ...launch.args].join(' '),
    location: recipe.layout(environment).folders.join('; '),
    notes: recipe.notes,
    docsUrl: recipe.docsUrl
  }
}

/** The shape of the native confirmation (assignable to Electron's message box options). */
interface InstallDialogOptions {
  type: 'question'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: true
}

/** Cancel is the default and the escape answer: only an explicit click on the first button installs. */
export function installDialogOptions(confirmation: InstallConfirmation): InstallDialogOptions {
  const detail = [
    `Source: ${confirmation.sourceUrl}`,
    `Runs: ${confirmation.command}`,
    `Installs to: ${confirmation.location}`,
    ...confirmation.notes,
    `Documentation: ${confirmation.docsUrl}`,
    'Nothing is downloaded until you choose Download and install.'
  ].join('\n\n')
  return {
    type: 'question',
    title: `Download ${confirmation.displayName}`,
    message: `Download and install ${confirmation.displayName} from its official source?`,
    detail,
    buttons: ['Download and install', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
}

const releaseSchema = z.object({
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), digest: z.string().nullish() }))
})

type DigestIntegrity = Extract<ScriptIntegrity, { type: 'github-release-digest' }>

/** The installer asset of a GitHub release, only if it is an official address and has a published SHA-256. */
function pickReleaseAsset(json: unknown, integrity: DigestIntegrity): ScriptSource {
  const release = releaseSchema.safeParse(json)
  const asset = release.success ? release.data.assets.find((candidate) => candidate.name === integrity.asset) : undefined
  if (asset === undefined) {
    throw new InstallFailure('download_failed', `The latest release lists no ${integrity.asset}.`)
  }
  if (!asset.browser_download_url.startsWith(integrity.downloadPrefix)) {
    throw new InstallFailure('download_failed', `${integrity.asset} is not at an official release address, so it was not downloaded.`)
  }
  const digest = SHA256_DIGEST.exec(asset.digest ?? '')?.[1]
  if (digest === undefined) {
    throw new InstallFailure('checksum_unavailable', `GitHub publishes no SHA-256 for ${integrity.asset}, so it was not downloaded.`)
  }
  return { url: asset.browser_download_url, sha256: digest.toLowerCase() }
}

async function attempt<T>(code: AgentDownloadFailureCode, what: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new InstallFailure(code, `${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function resolveSource({ deps, recipe }: InstallContext): Promise<ScriptSource> {
  const { integrity } = recipe
  if (integrity.type === 'vendor-installer') {
    return { url: recipe.scriptUrl, sha256: null }
  }
  const release = await attempt('download_failed', 'Could not read the latest release', () =>
    deps.http.getJson(integrity.releaseApi)
  )
  return pickReleaseAsset(release, integrity)
}

/** Downloads the script to `scriptPath` and refuses it unless it matches the checksum the vendor published. */
async function fetchInstaller(context: InstallContext, scriptPath: string): Promise<void> {
  const { deps, report } = context
  report('downloading')
  const source = await resolveSource(context)
  const downloaded = await attempt('download_failed', `Could not download ${source.url}`, () =>
    deps.http.download(source.url, scriptPath, (percent) => report('downloading', percent))
  )
  report('verifying')
  const actual = downloaded.sha256.toLowerCase()
  if (source.sha256 !== null && actual !== source.sha256) {
    throw new InstallFailure(
      'checksum_mismatch',
      `The installer does not match its published checksum (expected ${source.sha256}, got ${actual}), so it was not run.`
    )
  }
}

function interpretInstall(outcome: InstallOutcome): string[] {
  if (outcome.kind === 'spawn_failed') {
    throw new InstallFailure('installer_failed', `The installer could not be started (${outcome.code ?? outcome.message}).`)
  }
  const lines = lastOutputLines(outcome.output)
  if (outcome.kind === 'timed_out') {
    throw new InstallFailure('installer_failed', 'The installer did not finish in time and was stopped.', lines)
  }
  if (outcome.exitCode !== 0) {
    throw new InstallFailure('installer_failed', `The installer failed (exit code ${outcome.exitCode}).`, lines)
  }
  return lines
}

/** Runs the downloaded script and returns the last lines it printed. */
async function runInstaller({ deps, recipe, report }: InstallContext, scriptPath: string): Promise<string[]> {
  report('installing')
  const launch = installerLaunch(recipe, scriptPath, deps.environment)
  return interpretInstall(await deps.run(launch, deps.timeoutMs ?? INSTALL_TIMEOUT_MS))
}

/** The first of the vendor's documented executable locations that holds a program. */
function locateExecutable({ deps, recipe }: InstallContext, installerOutput: string[]): string {
  const { executables } = recipe.layout(deps.environment)
  const found = executables.find((path) => deps.inspect(path) === 'ok')
  if (found === undefined) {
    const name = AGENT_DEFINITIONS[recipe.kind].displayName
    throw new InstallFailure(
      'executable_not_found',
      `The installer finished, but no ${name} program was found where it installs (${executables[0] ?? 'unknown'}).`,
      installerOutput
    )
  }
  return found
}

/** Probes the installed executable and, only if it is that CLI, stores it as downloaded. */
async function probeAndStore({ deps, recipe, report }: InstallContext, executablePath: string): Promise<AgentDownloadResult> {
  report('checking')
  const { kind } = recipe
  const probe = await deps.probeAgent(kind, executablePath)
  if (!probe.ok) {
    throw new InstallFailure('verify_failed', `The installed program did not pass the check: ${probe.reason}`)
  }
  const updated = deps.agents.list().some((agent) => agent.kind === kind)
  const agent = deps.agents.upsert({ kind, executablePath, version: probe.version, connectedVia: 'downloaded' })
  return { outcome: 'installed', agent, updated }
}

async function install(context: InstallContext, folder: string): Promise<AgentDownloadResult> {
  const join = context.recipe.platform === 'win32' ? win32.join : posix.join
  const scriptPath = join(folder, scriptName(context.recipe))
  await fetchInstaller(context, scriptPath)
  const installerOutput = await runInstaller(context, scriptPath)
  return probeAndStore(context, locateExecutable(context, installerOutput))
}

function toFailure(error: unknown): AgentDownloadResult {
  if (error instanceof InstallFailure) {
    return { outcome: 'failed', code: error.code, reason: error.message, output: error.output }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { outcome: 'failed', code: 'unexpected', reason: `Something went wrong while installing: ${message}`, output: [] }
}

/** Runs a confirmed install in its own temp folder, which is removed whatever happens. */
async function installConfirmed(context: InstallContext): Promise<AgentDownloadResult> {
  let folder: string | null = null
  try {
    folder = context.deps.files.makeTempDir()
    const result = await install(context, folder)
    context.report('done', 100)
    return result
  } catch (error) {
    context.report('failed')
    return toFailure(error)
  } finally {
    if (folder !== null) {
      context.deps.files.removeDir(folder)
    }
  }
}

function failed(code: AgentDownloadFailureCode, reason: string): AgentDownloadResult {
  return { outcome: 'failed', code, reason, output: [] }
}

async function confirmAndInstall(deps: InstallerDeps, kind: AgentKind): Promise<AgentDownloadResult> {
  const recipe = resolveRecipe(kind, deps.environment)
  if (recipe === null) {
    const { platform, arch } = deps.environment
    return failed('unsupported_platform', `There is no installer for ${AGENT_DEFINITIONS[kind].displayName} on ${platform} (${arch}).`)
  }
  const report = (phase: AgentDownloadPhase, percent: number | null = null): void => {
    deps.report({ kind, phase, percent })
  }
  report('confirming')
  if (!(await deps.confirm(describeInstall(recipe, deps.environment)))) {
    report('cancelled')
    return { outcome: 'cancelled' }
  }
  return installConfirmed({ deps, recipe, report })
}

export function createAgentInstaller(deps: InstallerDeps): AgentInstaller {
  const running = new Set<AgentKind>()
  return {
    async download(kind) {
      if (running.has(kind)) {
        return failed('busy', `A download of ${AGENT_DEFINITIONS[kind].displayName} is already running.`)
      }
      running.add(kind)
      try {
        return await confirmAndInstall(deps, kind)
      } finally {
        running.delete(kind)
      }
    }
  }
}
