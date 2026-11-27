import { DomainError } from '../../core/errors'
import type { ChatRecord, DarkMechanicusCli } from '../../shared/agents/chat'
import { isSafeModelId } from '../../shared/agents/models'
import type { AgentView } from '../../shared/desktop/api'
import { pinnedCliScript } from '../terminals/dmLauncher'
import { terminalEnv } from '../terminals/terminalEnv'
import type { TerminalFiles } from '../terminals/terminalFiles'
import { windowsAgentProgram, type TerminalLaunchInput } from '../terminals/terminalLaunchSpec'

export interface AgentChatLaunchInput {
  /** Main prepares these facts: Claude uses claudeSessionExists; OMP uses ompSessionId(paths.omp.sessionDir). */
  chat: ChatRecord & { sessionStarted: boolean; kickoffSent: boolean }
  agent: AgentView
  /** Canonical tracked folder, or main's project-less scratch folder. */
  folder: string
  grant: DarkMechanicusCli
  /** From writeTerminalFiles, writeClaudeSettings and writeOmpFiles, identical to a terminal start. */
  paths: TerminalFiles
  platform: NodeJS.Platform
  env: TerminalLaunchInput['env']
  newSessionId: () => string
  kickoff: string | null
  reach?: TerminalLaunchInput['reach']
  repairCheckout?: string
  shimFs?: TerminalLaunchInput['shimFs']
}

export interface AgentChatLaunchSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  sessionId: string | null
  resumed: boolean
  protocol: 'omp' | 'claude'
  firstMessage: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function environmentFor(input: AgentChatLaunchInput): Record<string, string> {
  const { paths, platform } = input
  return terminalEnv({
    base: input.env, platform, kind: input.agent.kind, cli: input.grant,
    launcherDir: platform === 'win32' ? null : paths.launcherDir,
    headless: true,
    ...(paths.omp?.dmClient === undefined ? {} : { dmClient: paths.omp.dmClient }),
    ...(input.reach?.length === 0 ? { grantless: true as const } : {})
  })
}

function sessionFor(input: AgentChatLaunchInput): Pick<AgentChatLaunchSpec, 'sessionId' | 'resumed'> {
  const { chat } = input
  const storedId = chat.sessionId !== null && UUID.test(chat.sessionId) ? chat.sessionId : null
  const resumed = chat.sessionStarted && storedId !== null
  const sessionId = input.agent.kind === 'claude' ? storedId ?? input.newSessionId() : resumed ? storedId : null
  if (sessionId !== null && !UUID.test(sessionId)) throw new DomainError('invalid_input', 'The launch session id must be a UUID.')
  return { sessionId, resumed }
}

function modelArgs(model: string | null): string[] {
  return model !== null && model !== 'default' && isSafeModelId(model) ? ['--model', model] : []
}

function claudeArgs(paths: TerminalFiles, model: string | null, sessionId: string, resumed: boolean): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--forward-subagent-text', '--permission-prompt-tool', 'stdio',
    '--append-system-prompt-file', paths.instructions,
    ...(paths.claudeSettings === undefined ? [] : ['--settings', paths.claudeSettings]),
    ...modelArgs(model), resumed ? '--resume' : '--session-id', sessionId
  ]
}

function ompArgs(paths: TerminalFiles, cwd: string, model: string | null, sessionId: string | null): string[] {
  return [
    '--mode', 'rpc-ui', '--cwd', cwd, '--append-system-prompt', paths.instructions,
    ...(paths.omp === undefined ? [] : [
      '--config', paths.omp.config, '-e', paths.omp.extension, '--session-dir', paths.omp.sessionDir
    ]),
    ...modelArgs(model), ...(sessionId === null ? [] : ['--resume', sessionId])
  ]
}

function firstMessageFor(input: AgentChatLaunchInput, resumed: boolean): string | null {
  const { chat } = input
  if (resumed || chat.kickoffSent || chat.firstPromptDelivery === 'submitted' || chat.firstPromptDelivery === 'uncertain') return null
  return chat.firstPrompt ?? input.kickoff
}

/** Main-only, shell-free launch builder. No files are written and no process is started here. */
export function agentChatLaunch(input: AgentChatLaunchInput): AgentChatLaunchSpec {
  const { chat, agent, paths, platform } = input
  if (chat.agent !== agent.id) throw new DomainError('invalid_input', 'The chat and launch agent do not match.')
  const protocol = agent.kind
  if (protocol !== 'claude' && protocol !== 'omp') throw new DomainError('invalid_input', 'This agent has no GUI protocol.')
  pinnedCliScript(input.grant, input.reach === undefined ? input.folder : null)
  const cwd = input.repairCheckout ?? input.folder
  const env = environmentFor(input)
  const program = windowsAgentProgram(agent, env, platform, input.shimFs)
  const { sessionId, resumed } = sessionFor(input)
  const args = protocol === 'claude'
    ? claudeArgs(paths, chat.model, sessionId!, resumed)
    : ompArgs(paths, cwd, chat.model, sessionId)
  return {
    file: program.file, args: [...program.leading, ...args], cwd, env, sessionId, resumed, protocol,
    firstMessage: firstMessageFor(input, resumed)
  }
}
