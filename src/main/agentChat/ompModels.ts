/**
 * Which models a Skitarii (OMP) chat can use, asked of OMP itself in one of two ways, both normalized by
 * `chatModelOptions` (unsafe ids dropped):
 * - a live chat: its own session, `get_available_models` over the RPC stdin it already owns (`ompRequest`), which
 *   names exactly the providers that process is signed into;
 * - before a chat starts (New chat, Start run), or a chat that is not running: `omp models --json`, run through the
 *   registered executable as the GUI launch runs it (`windowsAgentProgram`: an npm shim followed to its script, never
 *   cmd.exe), argv only with no shell, stopped after `CATALOG_TIMEOUT_MS`, and cached for `CATALOG_CACHE_MS` per
 *   executable path and version unless the caller asks for a refresh.
 */
import { DomainError } from '../../core/errors'
import { chatModelOptions, type ChatModelOption } from '../../shared/agents/models'
import type { AgentId, AgentView } from '../../shared/desktop/api'
import type { ChatRef } from '../agents/chatStore'
import type { ProcessRunner } from '../desktop/agentProbe'
import { windowsAgentProgram } from '../terminals/terminalLaunchSpec'
import type { AgentChatSessions } from './agentChatSessions'

export const CATALOG_TIMEOUT_MS = 15_000
export const CATALOG_CACHE_MS = 10 * 60_000
/** Constant arguments only: nothing the renderer sends reaches this command line. */
const CATALOG_ARGS = ['models', '--json'] as const
/** A catalog of every provider OMP knows runs to a few hundred KiB; a version probe's 64 KiB cap would cut it. */
const MAX_CATALOG_CHARS = 4 * 1024 * 1024

export interface OmpModelsDeps {
  sessions: Pick<AgentChatSessions, 'ompRequest'>
  agentFor(id: AgentId): AgentView | null
  /** A stored chat's agent; null when the chat is gone. */
  chatAgent(ref: ChatRef): AgentId | null
  run: ProcessRunner
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  /** Epoch milliseconds, for the cache. */
  now?: () => number
}

export interface OmpModels {
  /** The live session's catalog; null when the chat has no live OMP process. */
  sessionModels(ref: ChatRef): Promise<ChatModelOption[]> | null
  /** The agent's catalog without a session: `omp models --json`, cached unless `refresh`. */
  catalogModels(agentId: AgentId, options?: { refresh?: boolean }): Promise<ChatModelOption[]>
  /** A chat's catalog: its live session's when it runs, else its agent's sessionless one. */
  chatModels(ref: ChatRef, options?: { refresh?: boolean }): Promise<ChatModelOption[]>
}

function ompAgent(agent: AgentView | null): AgentView {
  if (agent === null) throw new DomainError('not_found', 'That agent is not connected.')
  if (agent.kind !== 'omp') throw new DomainError('unsupported', 'Only Skitarii (OMP) agents list their models.')
  return agent
}

/** The JSON document in the output, tolerating a warning line before or after it; null when there is none. */
function catalogDocument(output: string): unknown {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  try {
    return start >= 0 && end > start ? (JSON.parse(output.slice(start, end + 1)) as unknown) : null
  } catch {
    return null
  }
}

export function createOmpModels(deps: OmpModelsDeps): OmpModels {
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; options: ChatModelOption[] }>()

  async function listCatalog(agent: AgentView): Promise<ChatModelOption[]> {
    const program = windowsAgentProgram(agent, deps.env, deps.platform)
    const outcome = await deps.run({ file: program.file, args: [...program.leading, ...CATALOG_ARGS], verbatimArguments: false }, CATALOG_TIMEOUT_MS, MAX_CATALOG_CHARS)
    if (outcome.kind === 'timed_out') throw new DomainError('timeout', `OMP did not list its models within ${CATALOG_TIMEOUT_MS / 1000} seconds.`)
    if (outcome.kind === 'spawn_failed') throw new DomainError('operation_unavailable', 'OMP did not start to list its models.')
    if (outcome.exitCode !== 0) throw new DomainError('operation_unavailable', `OMP could not list its models (exit code ${outcome.exitCode}).`)
    const catalog = catalogDocument(outcome.output)
    if (catalog === null) throw new DomainError('operation_unavailable', 'OMP listed its models in a way this app does not recognise.')
    return chatModelOptions(catalog)
  }

  const sessionModels = (ref: ChatRef): Promise<ChatModelOption[]> | null =>
    deps.sessions.ompRequest(ref, 'get_available_models')?.then(chatModelOptions) ?? null

  async function catalogModels(agentId: AgentId, options: { refresh?: boolean } = {}): Promise<ChatModelOption[]> {
    const agent = ompAgent(deps.agentFor(agentId))
    const key = `${agent.executablePath}\u0000${agent.version ?? ''}`
    const cached = cache.get(key)
    if (!options.refresh && cached !== undefined && now() - cached.at < CATALOG_CACHE_MS) return cached.options
    const listed = await listCatalog(agent)
    cache.set(key, { at: now(), options: listed })
    return listed
  }

  return {
    sessionModels,
    catalogModels,
    chatModels: async (ref, options) => {
      const agent = deps.chatAgent(ref)
      if (agent === null) throw new DomainError('not_found', 'The chat no longer exists.')
      ompAgent(deps.agentFor(agent))
      return sessionModels(ref) ?? catalogModels(agent, options)
    }
  }
}
