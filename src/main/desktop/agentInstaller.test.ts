import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentDownloadProgress, AgentKind } from '../../shared/desktop/api'
import type { InstallEnvironment } from './agentInstallRecipes'
import {
  createAgentInstaller,
  installDialogOptions,
  type InstallConfirmation,
  type InstallOutcome,
  type InstallerDeps
} from './agentInstaller'
import type { AgentProbeResult, FileCheck } from './agentProbe'
import { createAgentRegistry, type AgentRegistry, type RegistryFs } from './agentRegistry'

const WINDOWS: InstallEnvironment = {
  platform: 'win32',
  arch: 'x64',
  homeDir: 'C:\\Users\\Ada',
  localAppData: 'C:\\Users\\Ada\\AppData\\Local',
  systemRoot: 'C:\\Windows'
}
const MAC: InstallEnvironment = { ...WINDOWS, platform: 'darwin', arch: 'arm64', homeDir: '/Users/ada' }

const CLAUDE_EXE = 'C:\\Users\\Ada\\.local\\bin\\claude.exe'
const CODEX_EXE = 'C:\\Users\\Ada\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
const TEMP = 'C:\\Temp\\dm-agent-1'
const SCRIPT = win32.join(TEMP, 'install.ps1')
const DIGEST = 'a1'.repeat(32)

const OK: InstallOutcome = { kind: 'exited', exitCode: 0, output: 'installed' }

function memoryFs(): RegistryFs {
  const files = new Map<string, string>()
  return {
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return data
    },
    writeFile: (path, data) => files.set(path, data),
    rename(from, to) {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    mkdirp() {}
  }
}

/** A GitHub release as the releases API describes it, with the installer asset under test. */
function release(options: { asset?: string; digest?: string | null; url?: string } = {}): unknown {
  const asset = options.asset ?? 'install.ps1'
  const digest = options.digest === undefined ? `sha256:${DIGEST}` : options.digest
  return {
    tag_name: 'rust-v0.160.0',
    assets: [
      { name: 'codex-x86_64-pc-windows-msvc.exe', browser_download_url: 'https://github.com/x/y', digest: 'sha256:00' },
      {
        name: asset,
        browser_download_url: options.url ?? `https://github.com/openai/codex/releases/download/rust-v0.160.0/${asset}`,
        ...(digest === null ? {} : { digest })
      }
    ]
  }
}

interface WorldOptions {
  environment?: InstallEnvironment
  /** Answers to the confirmation; a promise lets a test hold the question open. */
  confirm?: Promise<boolean>
  /** Paths that exist once the installer has run. */
  installed?: string[]
  installer?: InstallerStep
  /** What the releases API says; a function can throw. */
  release?: () => unknown
  /** The SHA-256 of the downloaded script. */
  sha256?: string
  timeoutMs?: number
  /** Successive probe results. */
  probes?: AgentProbeResult[]
  downloadFails?: boolean
  probeThrows?: boolean
}

type InstallerStep = InstallOutcome | (() => InstallOutcome)

interface World {
  installer: ReturnType<typeof createAgentInstaller>
  registry: AgentRegistry
  /** Every side effect in the order it happened. */
  log: string[]
  progress: AgentDownloadProgress[]
  confirmations: InstallConfirmation[]
  launches: { file: string; args: readonly string[]; env: Readonly<Record<string, string>> }[]
  /** The time limit each installer run was given. */
  timeouts: number[]
}

function fakeHttp(options: WorldOptions, log: string[]): InstallerDeps['http'] {
  return {
    getJson: (url) => {
      log.push(`getJson ${url}`)
      return options.release ? Promise.resolve(options.release()) : Promise.reject(new Error('no release'))
    },
    download: (url, destination, onPercent) => {
      log.push(`download ${url} -> ${destination}`)
      if (options.downloadFails) {
        return Promise.reject(new Error('connection reset'))
      }
      onPercent(50)
      onPercent(100)
      return Promise.resolve({ sha256: options.sha256 ?? DIGEST })
    }
  }
}

function createWorld(options: WorldOptions = {}): World {
  const log: string[] = []
  const installed = new Set(options.installed ?? [])
  const probes = [...(options.probes ?? [])]
  const registry = createAgentRegistry({ file: '/state/agents.json', fs: memoryFs(), now: () => '2026-01-01T00:00:00.000Z' })
  const world: World = { installer: undefined as never, registry, log, progress: [], confirmations: [], launches: [], timeouts: [] }
  const deps: InstallerDeps = {
    environment: options.environment ?? WINDOWS,
    confirm: (confirmation) => {
      log.push('confirm')
      world.confirmations.push(confirmation)
      return options.confirm ?? Promise.resolve(true)
    },
    http: fakeHttp(options, log),
    run: (launch, timeoutMs) => {
      log.push(`run ${launch.file}`)
      world.launches.push(launch)
      world.timeouts.push(timeoutMs)
      const step = options.installer ?? OK
      return Promise.resolve(typeof step === 'function' ? step() : step)
    },
    files: {
      makeTempDir: () => {
        log.push('mkdtemp')
        return options.environment?.platform === 'darwin' ? '/tmp/dm-agent-1' : TEMP
      },
      removeDir: (path) => log.push(`rmdir ${path}`)
    },
    inspect: (path): FileCheck => (installed.has(path) ? 'ok' : 'not_a_file'),
    probeAgent: (kind, path) => {
      log.push(`probe ${kind} ${path}`)
      if (options.probeThrows) {
        return Promise.reject(new Error('probe blew up'))
      }
      return Promise.resolve(probes.shift() ?? { ok: true, version: '2.1.281' })
    },
    agents: registry,
    report: (progress) => world.progress.push(progress),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  }
  world.installer = createAgentInstaller(deps)
  return world
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred(): { promise: Promise<boolean>; resolve: (answer: boolean) => void } {
  let resolve: (answer: boolean) => void = () => undefined
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const phases = (world: World): string[] => world.progress.map((p) => `${p.phase}:${String(p.percent)}`)

const claudeWorld = (options: WorldOptions = {}): World => createWorld({ installed: [CLAUDE_EXE], ...options })

describe('nothing is fetched or run before the person confirms', () => {
  it('asks first, with the source, the command and the location, and does nothing while the question is open', async () => {
    const answer = deferred()
    const world = claudeWorld({ confirm: answer.promise })

    const running = world.installer.download('claude')
    await settle()

    expect(world.log).toEqual(['confirm'])
    const [confirmation] = world.confirmations
    expect(confirmation?.sourceUrl).toBe('https://claude.ai/install.ps1')
    expect(confirmation?.command).toContain('-File')
    expect(confirmation?.command).toContain('powershell.exe')
    expect(confirmation?.location).toContain('C:\\Users\\Ada\\.local\\bin')
    expect(confirmation?.docsUrl).toBe('https://code.claude.com/docs/en/setup')

    answer.resolve(true)
    expect((await running).outcome).toBe('installed')
    expect(world.log[0]).toBe('confirm')
    expect(world.log.indexOf('mkdtemp')).toBeGreaterThan(0)
  })

  it('does not fetch, run, probe or store anything when the person declines', async () => {
    const world = claudeWorld({ confirm: Promise.resolve(false) })

    expect(await world.installer.download('claude')).toEqual({ outcome: 'cancelled' })

    expect(world.log).toEqual(['confirm'])
    expect(world.registry.list()).toEqual([])
    expect(phases(world)).toEqual(['confirming:null', 'cancelled:null'])
  })

  it('asks again before updating an agent that is already installed', async () => {
    const world = claudeWorld()
    await world.installer.download('claude')

    await world.installer.download('claude')

    expect(world.log.filter((entry) => entry === 'confirm')).toHaveLength(2)
  })

  it('asks nothing and fetches nothing where there is no recipe', async () => {
    const world = createWorld({ environment: { ...WINDOWS, platform: 'linux' } })

    expect(await world.installer.download('claude')).toMatchObject({ outcome: 'failed', code: 'unsupported_platform' })

    expect(world.log).toEqual([])
  })
})

describe('a confirmed install of a vendor installer', () => {
  it('downloads the script to a temp file, runs it with PowerShell -File, then probes and stores the CLI', async () => {
    const world = claudeWorld({ probes: [{ ok: true, version: '2.1.281' }] })

    const result = await world.installer.download('claude')

    expect(result).toEqual({
      outcome: 'installed',
      updated: false,
      agent: {
        kind: 'claude',
        executablePath: CLAUDE_EXE,
        version: '2.1.281',
        connectedVia: 'downloaded',
        connectedAt: '2026-01-01T00:00:00.000Z',
        lastProbed: '2026-01-01T00:00:00.000Z'
      }
    })
    expect(world.log).toEqual([
      'confirm',
      'mkdtemp',
      `download https://claude.ai/install.ps1 -> ${SCRIPT}`,
      'run C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      `probe claude ${CLAUDE_EXE}`,
      `rmdir ${TEMP}`
    ])
    expect(world.launches[0]?.args.at(-1)).toBe(SCRIPT)
    expect(world.registry.list()).toEqual([result.outcome === 'installed' ? result.agent : null])
  })

  it('takes the first location the vendor documents where an executable exists', async () => {
    const world = createWorld({
      environment: MAC,
      installed: ['/Users/ada/.local/bin/cursor-agent'],
      probes: [{ ok: true, version: '2025.09.18-7ae6800' }]
    })

    const result = await world.installer.download('cursor')

    expect(result).toMatchObject({ outcome: 'installed', agent: { executablePath: '/Users/ada/.local/bin/cursor-agent' } })
    expect(world.launches[0]).toMatchObject({ file: '/bin/bash', args: ['/tmp/dm-agent-1/install.sh'] })
  })

})

describe('the installer is bounded and told what it is given', () => {
  it('stops an installer after ten minutes unless told otherwise', async () => {
    const world = claudeWorld()
    const quick = claudeWorld({ timeoutMs: 5_000 })

    await world.installer.download('claude')
    await quick.installer.download('claude')

    expect(world.timeouts).toEqual([600_000])
    expect(quick.timeouts).toEqual([5_000])
  })

  it('shows the variables the installer is run with in the command the person approves', async () => {
    const world = createWorld({ installed: [CODEX_EXE], release: () => release() })

    await world.installer.download('codex')

    expect(world.confirmations[0]?.command).toMatch(/^CODEX_NON_INTERACTIVE=1 .*powershell\.exe .*-File <downloaded install\.ps1>$/)
    expect(world.confirmations[0]?.location).toBe(`${win32.dirname(CODEX_EXE)}; C:\\Users\\Ada\\.codex`)
    expect(world.confirmations[0]?.sourceUrl).toBe('https://github.com/openai/codex/releases/latest/download/install.ps1')
  })
})

describe('progress is streamed while it runs', () => {
  it('streams the phase and the download percentage, and ends on done', async () => {
    const world = claudeWorld()

    await world.installer.download('claude')

    expect(phases(world)).toEqual([
      'confirming:null',
      'downloading:null',
      'downloading:50',
      'downloading:100',
      'verifying:null',
      'installing:null',
      'checking:null',
      'done:100'
    ])
    expect(world.progress.every((p) => p.kind === 'claude')).toBe(true)
  })
})

describe('Codex is checked against the digest GitHub publishes for its installer', () => {
  const codexWorld = (options: WorldOptions = {}): World =>
    createWorld({ installed: [CODEX_EXE], release: () => release(), ...options })

  it('fetches the tag-pinned release asset and runs it once the SHA-256 matches', async () => {
    const world = codexWorld()

    const result = await world.installer.download('codex')

    expect(result.outcome).toBe('installed')
    expect(world.log).toContain('getJson https://api.github.com/repos/openai/codex/releases/latest')
    expect(world.log).toContain(
      `download https://github.com/openai/codex/releases/download/rust-v0.160.0/install.ps1 -> ${SCRIPT}`
    )
    expect(world.launches[0]?.env).toEqual({ CODEX_NON_INTERACTIVE: '1' })
  })

  it('refuses a mismatch without running the script, and says what did not match', async () => {
    const world = codexWorld({ sha256: 'b2'.repeat(32) })

    const result = await world.installer.download('codex')

    expect(result).toMatchObject({ outcome: 'failed', code: 'checksum_mismatch', output: [] })
    expect(result.outcome === 'failed' && result.reason).toContain(DIGEST)
    expect(result.outcome === 'failed' && result.reason).toContain('b2'.repeat(32))
    expect(world.launches).toEqual([])
    expect(world.registry.list()).toEqual([])
    expect(world.log.at(-1)).toBe(`rmdir ${TEMP}`)
    expect(world.progress.at(-1)?.phase).toBe('failed')
  })

  it('compares digests regardless of letter case', async () => {
    const world = codexWorld({ release: () => release({ digest: `sha256:${DIGEST.toUpperCase()}` }) })

    expect((await world.installer.download('codex')).outcome).toBe('installed')
  })

  it.each([
    ['has no digest', () => release({ digest: null })],
    ['has a digest that is not SHA-256', () => release({ digest: 'md5:abc' })]
  ])('downloads nothing when the release asset %s', async (_label, source) => {
    const world = codexWorld({ release: source })

    const result = await world.installer.download('codex')

    expect(result).toMatchObject({ outcome: 'failed', code: 'checksum_unavailable' })
    expect(world.log.some((entry) => entry.startsWith('download'))).toBe(false)
  })
})

describe('Codex releases that are not the official ones are refused before any download', () => {
  const refused = async (source: () => unknown, code: string): Promise<World> => {
    const world = createWorld({ installed: [CODEX_EXE], release: source })
    expect(await world.installer.download('codex')).toMatchObject({ outcome: 'failed', code })
    expect(world.log.some((entry) => entry.startsWith('download') || entry.startsWith('run'))).toBe(false)
    expect(world.registry.list()).toEqual([])
    return world
  }

  it('refuses an asset address outside openai/codex releases', async () => {
    const elsewhere = await refused(() => release({ url: 'https://evil.example/openai/codex/releases/download/x/install.ps1' }), 'download_failed')
    const plainHttp = await refused(() => release({ url: 'http://github.com/openai/codex/releases/download/x/install.ps1' }), 'download_failed')

    expect(elsewhere.log.filter((entry) => entry.startsWith('download'))).toEqual([])
    expect(plainHttp.log.filter((entry) => entry.startsWith('download'))).toEqual([])
  })

  it('refuses a release without the installer asset, or one the API cannot read', async () => {
    const worlds = [
      await refused(() => release({ asset: 'install.sh' }), 'download_failed'),
      await refused(() => ({ nonsense: true }), 'download_failed'),
      await refused(() => {
        throw new Error('rate limited')
      }, 'download_failed')
    ]

    expect(worlds.map((world) => world.log.filter((entry) => entry.startsWith('run')))).toEqual([[], [], []])
  })
})

describe('a failing installer leaves the registry unchanged and reports its last output', () => {
  const noise = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\r\n')

  it('reports the exit code and only the last lines of output', async () => {
    const world = claudeWorld({ installer: { kind: 'exited', exitCode: 1, output: `${noise}\r\n\x1b[31mboom\x1b[0m\r\n\r\n` } })

    const result = await world.installer.download('claude')

    expect(result).toMatchObject({ outcome: 'failed', code: 'installer_failed' })
    expect(result.outcome === 'failed' && result.reason).toContain('code 1')
    expect(result.outcome === 'failed' && result.output).toEqual([...Array.from({ length: 11 }, (_, i) => `line ${i + 20}`), 'boom'])
    expect(world.registry.list()).toEqual([])
    expect(world.log.some((entry) => entry.startsWith('probe'))).toBe(false)
  })

  it('cuts a very long line of output short', async () => {
    const world = claudeWorld({ installer: { kind: 'exited', exitCode: 1, output: `${'y'.repeat(1000)}
` } })

    const result = await world.installer.download('claude')

    expect(result.outcome === 'failed' && result.output).toEqual([`${'y'.repeat(400)}...`])
  })

  it('keeps the agent already stored exactly as it was', async () => {
    const world = claudeWorld({ installer: { kind: 'exited', exitCode: 2, output: 'nope' } })
    world.registry.upsert({ kind: 'claude', executablePath: CLAUDE_EXE, version: '2.0.0', connectedVia: 'downloaded' })
    const before = world.registry.list()

    expect(await world.installer.download('claude')).toMatchObject({ outcome: 'failed' })

    expect(world.registry.list()).toEqual(before)
  })

})

describe('an installer that cannot finish leaves nothing behind', () => {
  it.each<[string, InstallOutcome, string]>([
    ['times out', { kind: 'timed_out', output: 'still working' }, 'stopped'],
    ['cannot start', { kind: 'spawn_failed', code: 'ENOENT', message: 'spawn failed' }, 'ENOENT']
  ])('reports an installer that %s', async (_label, outcome, reason) => {
    const world = claudeWorld({ installer: outcome })

    const result = await world.installer.download('claude')

    expect(result).toMatchObject({ outcome: 'failed', code: 'installer_failed' })
    expect(result.outcome === 'failed' && result.reason).toContain(reason)
    expect(world.registry.list()).toEqual([])
    expect(world.log.at(-1)).toBe(`rmdir ${TEMP}`)
  })
})

describe('an install that does not end in a working CLI stores nothing', () => {
  it('reports a finished installer whose executable is not where the vendor puts it', async () => {
    const world = createWorld({ installed: [], installer: { kind: 'exited', exitCode: 0, output: 'all done\nbut where' } })

    const result = await world.installer.download('claude')

    expect(result).toMatchObject({ outcome: 'failed', code: 'executable_not_found', output: ['all done', 'but where'] })
    expect(result.outcome === 'failed' && result.reason).toContain(CLAUDE_EXE)
    expect(world.registry.list()).toEqual([])
  })

  it('reports an executable the probe refuses, with the probe reason', async () => {
    const world = claudeWorld({ probes: [{ ok: false, code: 'wrong_program', reason: 'This is not the Claude Code CLI.' }] })

    const result = await world.installer.download('claude')

    expect(result).toMatchObject({ outcome: 'failed', code: 'verify_failed' })
    expect(result.outcome === 'failed' && result.reason).toContain('This is not the Claude Code CLI.')
    expect(world.registry.list()).toEqual([])
  })

  it('reports a download that fails, before anything runs', async () => {
    const world = claudeWorld({ downloadFails: true })

    const result = await world.installer.download('claude')

    expect(result).toMatchObject({ outcome: 'failed', code: 'download_failed' })
    expect(result.outcome === 'failed' && result.reason).toContain('connection reset')
    expect(world.launches).toEqual([])
    expect(world.log.at(-1)).toBe(`rmdir ${TEMP}`)
  })

  it('turns an unexpected error into a failure and still cleans up', async () => {
    const world = claudeWorld({ probeThrows: true })

    const result = await world.installer.download('claude')

    expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected' })
    expect(result.outcome === 'failed' && result.reason).toContain('probe blew up')
    expect(world.registry.list()).toEqual([])
    expect(world.log.at(-1)).toBe(`rmdir ${TEMP}`)
    expect(world.progress.at(-1)?.phase).toBe('failed')
  })
})

describe('running Download again on an installed agent updates it', () => {
  it('stores the newly probed version and keeps when it was first connected', async () => {
    const world = claudeWorld({ probes: [{ ok: true, version: '2.1.0' }, { ok: true, version: '2.2.0' }] })
    const first = await world.installer.download('claude')

    const second = await world.installer.download('claude')

    expect(first).toMatchObject({ outcome: 'installed', updated: false, agent: { version: '2.1.0' } })
    expect(second).toMatchObject({ outcome: 'installed', updated: true, agent: { version: '2.2.0', connectedVia: 'downloaded' } })
    expect(world.registry.list()).toHaveLength(1)
    expect(world.registry.list()[0]).toMatchObject({ kind: 'claude', version: '2.2.0' })
  })

  it('replaces an agent that was found by hand with the downloaded one', async () => {
    const world = claudeWorld({ probes: [{ ok: true, version: '3.0.0' }] })
    world.registry.upsert({ kind: 'claude', executablePath: 'C:\\npm\\claude.cmd', version: '1.0.0', connectedVia: 'found' })

    const result = await world.installer.download('claude')

    expect(result).toMatchObject({ outcome: 'installed', updated: true })
    expect(world.registry.list()).toMatchObject([{ executablePath: CLAUDE_EXE, version: '3.0.0', connectedVia: 'downloaded' }])
  })
})

describe('only one download of a kind runs at a time', () => {
  it('turns away a second request for the same kind and allows other kinds and later requests', async () => {
    const answer = deferred()
    const world = createWorld({ installed: [CLAUDE_EXE], confirm: answer.promise })

    const first = world.installer.download('claude')
    const second = await world.installer.download('claude')
    answer.resolve(true)
    await first
    const third = await world.installer.download('claude')

    expect(second).toMatchObject({ outcome: 'failed', code: 'busy', output: [] })
    expect(world.log.filter((entry) => entry === 'confirm')).toHaveLength(2)
    expect(third.outcome).toBe('installed')
  })
})

describe('the confirmation dialog', () => {
  const confirmation: InstallConfirmation = {
    kind: 'cursor' satisfies AgentKind,
    displayName: 'Cursor',
    sourceUrl: 'https://cursor.com/install',
    command: '/bin/bash <downloaded installer>',
    location: '/Users/ada/.local/bin; /Users/ada/.local/share/cursor-agent',
    notes: ['Cursor publishes no checksum for this installer.'],
    docsUrl: 'https://cursor.com/docs/cli/installation'
  }

  it('shows the source, what will run and where it installs, and defaults to cancelling', () => {
    const options = installDialogOptions(confirmation)

    expect(options.message).toContain('Cursor')
    for (const text of [confirmation.sourceUrl, confirmation.command, confirmation.location, confirmation.docsUrl]) {
      expect(options.detail).toContain(text)
    }
    expect(options.detail).toContain('Cursor publishes no checksum')
    expect(options.buttons).toEqual(['Download and install', 'Cancel'])
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
  })
})
