import { describe, expect, it } from 'vitest'
import { AGENT_KINDS, expectedExecutableNames } from '../../shared/desktop/agentKinds'
import type { AgentKind } from '../../shared/desktop/api'
import {
  installerLaunch,
  resolveRecipe,
  type InstallEnvironment,
  type InstallPlatform
} from './agentInstallRecipes'

const WINDOWS: InstallEnvironment = {
  platform: 'win32',
  arch: 'x64',
  homeDir: 'C:\\Users\\Ada',
  localAppData: 'C:\\Users\\Ada\\AppData\\Local',
  systemRoot: 'C:\\Windows'
}
const MAC: InstallEnvironment = { ...WINDOWS, platform: 'darwin', arch: 'arm64', homeDir: '/Users/ada' }

/** The four targets the ticket names: Windows x64 and arm64, macOS arm64 and x64. */
const TARGETS: [InstallPlatform, string][] = [
  ['win32', 'x64'],
  ['win32', 'arm64'],
  ['darwin', 'arm64'],
  ['darwin', 'x64']
]

function environmentFor(platform: InstallPlatform, arch: string): InstallEnvironment {
  return { ...(platform === 'win32' ? WINDOWS : MAC), platform, arch }
}

const SOURCES: Record<AgentKind, Record<InstallPlatform, string>> = {
  claude: { win32: 'https://claude.ai/install.ps1', darwin: 'https://claude.ai/install.sh' },
  codex: {
    win32: 'https://github.com/openai/codex/releases/latest/download/install.ps1',
    darwin: 'https://github.com/openai/codex/releases/latest/download/install.sh'
  },
  cursor: { win32: 'https://cursor.com/install?win32=true', darwin: 'https://cursor.com/install' }
}

/** The hosts each vendor's own documentation lives on: a recipe must cite one of them. */
const DOC_HOSTS: Record<AgentKind, string[]> = {
  claude: ['code.claude.com'],
  codex: ['github.com', 'developers.openai.com'],
  cursor: ['cursor.com']
}

describe('every kind has a recipe for Windows and macOS on both processors', () => {
  it.each(AGENT_KINDS.flatMap((kind) => TARGETS.map(([platform, arch]) => [kind, platform, arch] as const)))(
    '%s on %s %s',
    (kind, platform, arch) => {
      const recipe = resolveRecipe(kind, environmentFor(platform, arch))

      expect(recipe).not.toBeNull()
      expect(recipe?.kind).toBe(kind)
      expect(recipe?.platform).toBe(platform)
    }
  )

  it('has no recipe for another operating system or a 32-bit processor', () => {
    for (const kind of AGENT_KINDS) {
      expect(resolveRecipe(kind, { ...WINDOWS, platform: 'linux' })).toBeNull()
      expect(resolveRecipe(kind, { ...WINDOWS, arch: 'ia32' })).toBeNull()
      expect(resolveRecipe(kind, { ...MAC, arch: 'ppc64' })).toBeNull()
    }
  })
})

describe('every recipe uses a vendor-official HTTPS source and cites the doc it came from', () => {
  it.each(AGENT_KINDS.flatMap((kind) => (['win32', 'darwin'] as const).map((platform) => [kind, platform] as const)))(
    '%s on %s',
    (kind, platform) => {
      const recipe = resolveRecipe(kind, environmentFor(platform, 'x64'))

      expect(recipe?.scriptUrl).toBe(SOURCES[kind][platform])
      expect(new URL(recipe?.scriptUrl ?? '').protocol).toBe('https:')
      expect(new URL(recipe?.docsUrl ?? '').protocol).toBe('https:')
      expect(DOC_HOSTS[kind]).toContain(new URL(recipe?.docsUrl ?? '').hostname)
    }
  )

  it('checks the Codex installer against the digest GitHub publishes for that release asset', () => {
    const recipe = resolveRecipe('codex', WINDOWS)

    expect(recipe?.integrity).toEqual({
      type: 'github-release-digest',
      releaseApi: 'https://api.github.com/repos/openai/codex/releases/latest',
      asset: 'install.ps1',
      downloadPrefix: 'https://github.com/openai/codex/releases/download/'
    })
    expect(resolveRecipe('codex', MAC)?.integrity).toMatchObject({ asset: 'install.sh' })
  })

  it('leaves the Claude and Cursor installers to the checks the vendors build into them', () => {
    expect(resolveRecipe('claude', WINDOWS)?.integrity.type).toBe('vendor-installer')
    expect(resolveRecipe('cursor', MAC)?.integrity.type).toBe('vendor-installer')
  })
})

describe('installerLaunch runs a downloaded script without a shell string or renderer text', () => {
  const script = 'C:\\Temp\\dm-agent-1\\install.ps1'

  it('hands PowerShell the script by -File with the execution policy bypassed', () => {
    const recipe = resolveRecipe('claude', WINDOWS)
    if (!recipe) {
      throw new Error('no recipe')
    }

    expect(installerLaunch(recipe, script, WINDOWS)).toEqual({
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      env: {}
    })
  })

  it('runs a macOS script with bash or sh by absolute path, the script as its own argument', () => {
    const claude = resolveRecipe('claude', MAC)
    const codex = resolveRecipe('codex', MAC)
    if (!claude || !codex) {
      throw new Error('no recipe')
    }

    expect(installerLaunch(claude, '/var/tmp/dm/install.sh', MAC)).toMatchObject({
      file: '/bin/bash',
      args: ['/var/tmp/dm/install.sh']
    })
    expect(installerLaunch(codex, '/var/tmp/dm/install.sh', MAC)).toMatchObject({
      file: '/bin/sh',
      args: ['/var/tmp/dm/install.sh']
    })
  })

  it('makes the Codex installer non-interactive and never uses a command string', () => {
    const recipe = resolveRecipe('codex', WINDOWS)
    if (!recipe) {
      throw new Error('no recipe')
    }
    const launch = installerLaunch(recipe, script, WINDOWS)

    expect(launch.env).toEqual({ CODEX_NON_INTERACTIVE: '1' })
    expect(launch.args).not.toContain('-Command')
    expect(launch.args).not.toContain('-c')
  })
})

describe('a script path is one argument that no command interpreter ever parses', () => {
  const hostile = 'C:\\Users\\A&B 100%\\Temp\\dm "x"\\install.ps1'

  it.each(AGENT_KINDS.flatMap((kind) => TARGETS.map(([platform, arch]) => [kind, platform, arch] as const)))(
    '%s on %s %s starts PowerShell or an absolute shell, never cmd.exe or start',
    (kind, platform, arch) => {
      const environment = environmentFor(platform, arch)
      const recipe = resolveRecipe(kind, environment)
      if (!recipe) {
        throw new Error('no recipe')
      }

      const launch = installerLaunch(recipe, hostile, environment)

      expect(launch.file).toMatch(/powershell\.exe$|^\/bin\/(bash|sh)$/)
      expect(launch.args.at(-1)).toBe(hostile)
      expect(launch.args.filter((arg) => arg === hostile)).toHaveLength(1)
      expect([launch.file, ...launch.args.slice(0, -1)].join(' ')).not.toMatch(/\bcmd\b|\bstart\b|\/c\b/i)
    }
  )
})

describe('where each installer leaves the executable, so the probe can find it', () => {
  it.each(AGENT_KINDS.flatMap((kind) => (['win32', 'darwin'] as const).map((platform) => [kind, platform] as const)))(
    '%s on %s is an absolute path under the person home with an expected executable name',
    (kind, platform) => {
      const environment = environmentFor(platform, 'x64')
      const recipe = resolveRecipe(kind, environment)
      const layout = recipe?.layout(environment)
      const names = expectedExecutableNames(kind, platform)

      expect(layout?.executables.length).toBeGreaterThan(0)
      for (const path of layout?.executables ?? []) {
        expect(path.startsWith(platform === 'win32' ? 'C:\\Users\\Ada' : '/Users/ada')).toBe(true)
        expect(names).toContain(path.split(/[\\/]/).at(-1))
      }
      expect(layout?.folders.length).toBeGreaterThan(0)
    }
  )

  it('names the vendor documented default for each', () => {
    const at = (kind: AgentKind, environment: InstallEnvironment): string[] =>
      resolveRecipe(kind, environment)?.layout(environment).executables ?? []

    expect(at('claude', WINDOWS)).toEqual(['C:\\Users\\Ada\\.local\\bin\\claude.exe'])
    expect(at('claude', MAC)).toEqual(['/Users/ada/.local/bin/claude'])
    expect(at('codex', WINDOWS)).toEqual(['C:\\Users\\Ada\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'])
    expect(at('codex', MAC)).toEqual(['/Users/ada/.local/bin/codex'])
    expect(at('cursor', WINDOWS)[0]).toBe('C:\\Users\\Ada\\AppData\\Local\\cursor-agent\\agent.exe')
    expect(at('cursor', MAC)).toEqual(['/Users/ada/.local/bin/agent', '/Users/ada/.local/bin/cursor-agent'])
  })
})
