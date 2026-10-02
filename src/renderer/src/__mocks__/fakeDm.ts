import type { CommandName } from '../../../shared/domain/api'
import { deferred } from './deferred'
import type { Deferred } from './deferred'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type {
  ClaudeCodeConnectRequest,
  ClaudeCodeConnectResult,
  CommandInput,
  CommandOutput,
  CommandResult,
  DmApi,
  FolderPickResult,
  McpConfigView,
  TrackedFolderView
} from '../../../shared/desktop/api'

interface CommandCall {
  folder: string
  name: CommandName
  input: unknown
}

type PlainMethod =
  | 'listFolders'
  | 'pickFolder'
  | 'untrackFolder'
  | 'getMcpConfig'
  | 'installSkills'
  | 'connectClaudeCode'

export const MCP_JSON = '{\n  "mcpServers": {\n    "darkmechanicus": { "command": "dm-mcp" }\n  }\n}'

/**
 * Hand-written window.dm for renderer tests. It records every call and answers commands from
 * canned `responses` (or a `handlers` function), so tests assert on recorded state, not mocks.
 */
export class FakeDm implements DmApi {
  folders: TrackedFolderView[] = []
  pickQueue: FolderPickResult[] = []
  responses: Partial<Record<CommandName, unknown>> = {
    listEpics: [],
    searchHistory: [],
    listBranchEpics: [],
    listProfiles: []
  }
  handlers: Partial<Record<CommandName, (input: unknown, folder: string) => unknown>> = {}
  failures: Partial<Record<CommandName, DomainErrorShape>> = {}
  holds: Partial<Record<CommandName, Deferred[]>> = {}
  rejects: Partial<Record<PlainMethod, string>> = {}
  commandCalls: CommandCall[] = []
  calls: string[] = []
  copied: string[] = []
  skillInstalls: string[] = []
  skillsWritten: string[] = ['.claude/skills/darkmechanicus-planner/SKILL.md']
  claudeConnects: { folder: string; request: ClaudeCodeConnectRequest }[] = []
  /** Answers to connectClaudeCode, in order; once used up, every write is `created`. */
  claudeOutcomes: ClaudeCodeConnectResult[] = []
  mcpConfig: McpConfigView = {
    command: 'dm-mcp',
    args: ['--repo', '~/code/alpha'],
    env: {},
    json: MCP_JSON,
    note: 'development build'
  }

  listFolders(): Promise<TrackedFolderView[]> {
    return this.answer('listFolders', () => [...this.folders])
  }

  pickFolder(): Promise<FolderPickResult> {
    return this.answer('pickFolder', () => this.pickQueue.shift() ?? { folder: null, added: false })
  }

  untrackFolder(path: string): Promise<TrackedFolderView[]> {
    return this.answer('untrackFolder', () => {
      this.folders = this.folders.filter((folder) => folder.path !== path)
      return [...this.folders]
    })
  }

  getMcpConfig(folder: string): Promise<McpConfigView> {
    this.calls.push(`getMcpConfig:${folder}`)
    return this.answer('getMcpConfig', () => this.mcpConfig)
  }

  installSkills(folder: string): Promise<{ written: string[] }> {
    this.skillInstalls.push(folder)
    return this.answer('installSkills', () => ({ written: this.skillsWritten }))
  }

  connectClaudeCode(folder: string, request: ClaudeCodeConnectRequest): Promise<ClaudeCodeConnectResult> {
    this.claudeConnects.push({ folder, request })
    return this.answer('connectClaudeCode', () => this.claudeOutcomes.shift() ?? { outcome: 'created' })
  }

  copyText(text: string): Promise<void> {
    this.copied.push(text)
    return Promise.resolve()
  }

  openExternal(): Promise<boolean> {
    return Promise.resolve(true)
  }

  async command<K extends CommandName>(
    folder: string,
    name: K,
    input: CommandInput<K>
  ): Promise<CommandResult<CommandOutput<K>>> {
    this.commandCalls.push({ folder, name, input })
    await this.holds[name]?.shift()?.promise
    const failure = this.failures[name]
    if (failure) {
      return { ok: false, error: failure }
    }
    const handler = this.handlers[name]
    const data = handler ? handler(input, folder) : this.responses[name]
    return { ok: true, data: data as CommandOutput<K> }
  }

  /** Makes the next call of `name` wait until the returned deferred is resolved. */
  holdNext(name: CommandName): Deferred {
    const hold = deferred()
    this.holds[name] = [...(this.holds[name] ?? []), hold]
    return hold
  }

  callsOf(name: CommandName): CommandCall[] {
    return this.commandCalls.filter((call) => call.name === name)
  }

  private answer<T>(method: PlainMethod, produce: () => T): Promise<T> {
    this.calls.push(method)
    const message = this.rejects[method]
    return message === undefined ? Promise.resolve(produce()) : Promise.reject(new Error(message))
  }
}
