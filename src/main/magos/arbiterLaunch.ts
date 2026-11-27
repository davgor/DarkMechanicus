import { DomainError } from '../../core/errors'
import type { AgentView } from '../../shared/desktop/api'
import { arbiterEnv } from '../terminals/terminalEnv'
import { windowsAgentProgram, type TerminalLaunchInput } from '../terminals/terminalLaunchSpec'

interface ArbiterLaunchInput {
  agent: Pick<AgentView, 'kind' | 'executablePath'>
  platform: NodeJS.Platform
  baseEnv: TerminalLaunchInput['env']
  /** Runner-owned fresh empty mkdtemp under os.tmpdir(), never the chat folder or userData. */
  tempDir: string
  systemPrompt: string
  shimFs?: TerminalLaunchInput['shimFs']
  /** Required for candidate OMP specs, but not proof of isolation: no live OMP arbiter may run yet. */
  ompConfig?: string
}

export interface ArbiterLaunchSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  protocol: 'claude' | 'omp'
}

/**
 * Main-only, shell-free one-shot argv builder; request text goes to stdin in the runner.
 * Claude safe-mode retains admin policy/managed-plugin hooks; flags are not a sandbox.
 * OMP is a candidate spec only: policy must refuse it until MCP isolation and stdin are observed.
 */
export function arbiterLaunch(input: ArbiterLaunchInput): ArbiterLaunchSpec {
  const { agent, platform, tempDir, systemPrompt, ompConfig } = input
  const protocol = agent.kind
  if (protocol !== 'claude' && protocol !== 'omp') throw new DomainError('invalid_input', 'This agent has no arbiter protocol.')
  if (protocol === 'omp' && !ompConfig) throw new DomainError('invalid_input', 'An OMP arbiter candidate requires a config overlay; OMP arbitration remains unsupported_kind.')
  const env = arbiterEnv(input.baseEnv, protocol)
  const program = windowsAgentProgram(agent, env, platform, input.shimFs)
  const args = protocol === 'claude'
    ? ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--safe-mode', '--system-prompt', systemPrompt]
    : ['-p', '--mode', 'text', '--no-session', '--no-tools', '--no-lsp', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-title', '--max-time', '60', '--system-prompt', systemPrompt, '--cwd', tempDir, ...(ompConfig ? ['--config', ompConfig] : [])]
  return { file: program.file, args: [...program.leading, ...args], cwd: tempDir, env, protocol }
}
