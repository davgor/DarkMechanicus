/**
 * What "download an agent" means for each kind on each platform: the vendor's own installer, where
 * it is fetched from, how it is run, and where it leaves the CLI. Pure data and path arithmetic, so
 * the installer, its confirmation text and the tests all read the same recipe. Nothing here is
 * influenced by the renderer: it only ever names a kind.
 *
 * Every source is a vendor-official HTTPS endpoint, with the vendor doc it was taken from next to it.
 * The installers detect the processor themselves (Windows x64 and arm64, macOS arm64 and x64), so one
 * recipe per kind and platform covers both processors; any other platform or a 32-bit processor has
 * no recipe. Linux is out of scope.
 *
 * Where the vendors publish a checksum for the installer script itself it is verified before the
 * script runs (Codex: the SHA-256 GitHub publishes for the release asset). Anthropic and Cursor
 * publish none for their scripts: Anthropic's installer verifies each binary against the SHA-256 in
 * its release manifest, Cursor's verifies nothing, and the confirmation says so.
 *
 * Vendor installers keep their default location so the terminal and the app use the same binary; the
 * `layout` of each recipe names that documented default, which is how the probe finds the executable
 * afterwards. No installer needs the app-managed `userData/agents/<kind>/` folder, because that is
 * only for a release that ships a bare binary, and all three vendors ship an installer.
 */
import { posix, win32 } from 'node:path'
import type { AgentKind } from '../../shared/desktop/api'

export type InstallPlatform = 'win32' | 'darwin'

/** What the recipes need to know about this machine; injected so tests can pose as any of them. */
export interface InstallEnvironment {
  platform: string
  arch: string
  homeDir: string
  /** `%LOCALAPPDATA%` (Windows only). */
  localAppData: string
  /** `%SystemRoot%`, where the system PowerShell lives (Windows only). */
  systemRoot: string
}

/** How the installer script itself is checked before it runs. */
export type ScriptIntegrity =
  /** No checksum is published for the script; the vendor's installer verifies what it installs. */
  | { type: 'vendor-installer' }
  /** The SHA-256 digest GitHub publishes for the release asset (`digest` in the releases API). */
  | { type: 'github-release-digest'; releaseApi: string; asset: string; downloadPrefix: string }

/** Where an installer leaves the CLI. */
interface InstallLayout {
  /** Candidate executables in the order they are looked for. */
  executables: string[]
  /** The folders the installer writes to, for the confirmation. */
  folders: string[]
}

export interface InstallRecipe {
  kind: AgentKind
  platform: InstallPlatform
  /** The vendor documentation this recipe was taken from. */
  docsUrl: string
  /** HTTPS address of the installer script (for GitHub releases, the `latest` redirect). */
  scriptUrl: string
  integrity: ScriptIntegrity
  /** Runs the script: PowerShell on Windows, an absolute shell path on macOS. */
  interpreter: 'powershell' | '/bin/bash' | '/bin/sh'
  /** Added to the environment the installer runs in. */
  env: Readonly<Record<string, string>>
  /** What the installer does besides installing, shown in the confirmation. */
  notes: readonly string[]
  layout(environment: InstallEnvironment): InstallLayout
}

type RecipeSpec = Omit<InstallRecipe, 'kind' | 'platform'>

/** One process to start. The script is a single argv entry; there is no shell string anywhere. */
export interface InstallLaunch {
  file: string
  args: readonly string[]
  /** Variables to add on top of the app's own environment. */
  env: Readonly<Record<string, string>>
}

const CODEX_RELEASES = 'https://github.com/openai/codex/releases'
const CODEX_INTEGRITY = {
  type: 'github-release-digest',
  releaseApi: 'https://api.github.com/repos/openai/codex/releases/latest',
  downloadPrefix: `${CODEX_RELEASES}/download/`
} as const
const NO_PUBLISHED_CHECKSUM: ScriptIntegrity = { type: 'vendor-installer' }

const CODEX_NOTES = [
  'The installer script is checked against the SHA-256 GitHub publishes for it, and the Codex package against the release checksums, before anything is installed.',
  'The installer adds its folder to your PATH, and Codex keeps its files under .codex in your home folder.'
]
const WINDOWS_PATH_NOTE = 'The installer adds its folder to your PATH.'
const UNIX_PATH_NOTE = 'The installer may add its folder to your PATH in your shell profile.'
const CLAUDE_NOTE =
  "Anthropic's installer checks the download against the SHA-256 in its release manifest, then keeps Claude Code up to date in the background."
const CURSOR_NOTE = 'Cursor publishes no checksum for this installer, so it cannot be verified before it runs.'

const claudeLayout = (join: typeof win32.join, exe: string) => (env: InstallEnvironment): InstallLayout => ({
  executables: [join(env.homeDir, '.local', 'bin', exe)],
  folders: [join(env.homeDir, '.local', 'bin'), join(env.homeDir, '.local', 'share', 'claude')]
})

function codexLayout(env: InstallEnvironment, platform: InstallPlatform): InstallLayout {
  if (platform === 'win32') {
    const bin = win32.join(env.localAppData, 'Programs', 'OpenAI', 'Codex', 'bin')
    return { executables: [win32.join(bin, 'codex.exe')], folders: [bin, win32.join(env.homeDir, '.codex')] }
  }
  const bin = posix.join(env.homeDir, '.local', 'bin')
  return { executables: [posix.join(bin, 'codex')], folders: [bin, posix.join(env.homeDir, '.codex')] }
}

function cursorLayout(env: InstallEnvironment, platform: InstallPlatform): InstallLayout {
  if (platform === 'win32') {
    const folder = win32.join(env.localAppData, 'cursor-agent')
    const names = ['agent.exe', 'agent.cmd', 'cursor-agent.exe', 'cursor-agent.cmd']
    return { executables: names.map((name) => win32.join(folder, name)), folders: [folder] }
  }
  const bin = posix.join(env.homeDir, '.local', 'bin')
  return {
    executables: [posix.join(bin, 'agent'), posix.join(bin, 'cursor-agent')],
    folders: [bin, posix.join(env.homeDir, '.local', 'share', 'cursor-agent')]
  }
}

const CLAUDE_DOCS = 'https://code.claude.com/docs/en/setup'
const CODEX_DOCS = 'https://github.com/openai/codex'
const CURSOR_DOCS = 'https://cursor.com/docs/cli/installation'

const RECIPES: Record<AgentKind, Record<InstallPlatform, RecipeSpec>> = {
  claude: {
    // Docs: "Native Install (Recommended)": `irm https://claude.ai/install.ps1 | iex` and
    // `curl -fsSL https://claude.ai/install.sh | bash`. The scripts redirect to downloads.claude.ai and
    // run `claude install`, which puts the launcher in ~/.local/bin (`%USERPROFILE%\.local\bin` on Windows).
    win32: {
      docsUrl: CLAUDE_DOCS,
      scriptUrl: 'https://claude.ai/install.ps1',
      integrity: NO_PUBLISHED_CHECKSUM,
      interpreter: 'powershell',
      env: {},
      notes: [CLAUDE_NOTE],
      layout: claudeLayout(win32.join, 'claude.exe')
    },
    darwin: {
      docsUrl: CLAUDE_DOCS,
      scriptUrl: 'https://claude.ai/install.sh',
      integrity: NO_PUBLISHED_CHECKSUM,
      interpreter: '/bin/bash',
      env: {},
      notes: [CLAUDE_NOTE],
      layout: claudeLayout(posix.join, 'claude')
    }
  },
  codex: {
    // Docs: the openai/codex README (`install.ps1` and `install.sh` at chatgpt.com/codex, which are also
    // attached to every GitHub release with a published SHA-256 digest; the release asset is what is
    // fetched so that digest can be checked). Windows: %LOCALAPPDATA%\Programs\OpenAI\Codex\bin;
    // macOS: ~/.local/bin. CODEX_NON_INTERACTIVE=1 stops its prompts.
    win32: {
      docsUrl: CODEX_DOCS,
      scriptUrl: `${CODEX_RELEASES}/latest/download/install.ps1`,
      integrity: { ...CODEX_INTEGRITY, asset: 'install.ps1' },
      interpreter: 'powershell',
      env: { CODEX_NON_INTERACTIVE: '1' },
      notes: CODEX_NOTES,
      layout: (env) => codexLayout(env, 'win32')
    },
    darwin: {
      docsUrl: CODEX_DOCS,
      scriptUrl: `${CODEX_RELEASES}/latest/download/install.sh`,
      integrity: { ...CODEX_INTEGRITY, asset: 'install.sh' },
      interpreter: '/bin/sh',
      env: { CODEX_NON_INTERACTIVE: '1' },
      notes: CODEX_NOTES,
      layout: (env) => codexLayout(env, 'darwin')
    }
  },
  cursor: {
    // Docs: `irm 'https://cursor.com/install?win32=true' | iex` and `curl https://cursor.com/install -fsS | bash`.
    // Windows installs to %LOCALAPPDATA%\cursor-agent (agent and cursor-agent shims); macOS links
    // ~/.local/bin/agent and ~/.local/bin/cursor-agent into ~/.local/share/cursor-agent.
    win32: {
      docsUrl: CURSOR_DOCS,
      scriptUrl: 'https://cursor.com/install?win32=true',
      integrity: NO_PUBLISHED_CHECKSUM,
      interpreter: 'powershell',
      env: {},
      notes: [CURSOR_NOTE, WINDOWS_PATH_NOTE],
      layout: (env) => cursorLayout(env, 'win32')
    },
    darwin: {
      docsUrl: CURSOR_DOCS,
      scriptUrl: 'https://cursor.com/install',
      integrity: NO_PUBLISHED_CHECKSUM,
      interpreter: '/bin/bash',
      env: {},
      notes: [CURSOR_NOTE, UNIX_PATH_NOTE],
      layout: (env) => cursorLayout(env, 'darwin')
    }
  }
}

const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64'])

function isInstallPlatform(platform: string): platform is InstallPlatform {
  return platform === 'win32' || platform === 'darwin'
}

/** The recipe for a kind on this machine, or null when its operating system or processor is unsupported. */
export function resolveRecipe(kind: AgentKind, environment: InstallEnvironment): InstallRecipe | null {
  const { platform } = environment
  if (!isInstallPlatform(platform) || !SUPPORTED_ARCHITECTURES.has(environment.arch)) {
    return null
  }
  return { kind, platform, ...RECIPES[kind][platform] }
}

/**
 * The process that runs a downloaded script. PowerShell gets the script by `-File` (never an `irm | iex`
 * pipeline or `-Command` string) with the execution policy bypassed for this one process, which
 * downloaded scripts need; macOS gets it as the argument of an absolute shell path.
 */
export function installerLaunch(recipe: InstallRecipe, scriptPath: string, environment: InstallEnvironment): InstallLaunch {
  if (recipe.interpreter === 'powershell') {
    return {
      file: win32.join(environment.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      env: recipe.env
    }
  }
  return { file: recipe.interpreter, args: [scriptPath], env: recipe.env }
}
