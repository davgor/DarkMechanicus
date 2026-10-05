/**
 * Machine-local registry of connected agents (`userData/agents.json`). One entry per agent kind.
 * Entries are identified by kind: `claude`, `codex`, or `cursor`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { AGENT_KINDS } from '../../shared/desktop/agentKinds'
import type { AgentKind, AgentView } from '../../shared/desktop/api'

/** The filesystem surface the registry uses; tests inject fakes and faults through it. */
export interface RegistryFs {
  readFile(path: string): string
  writeFile(path: string, data: string): void
  rename(from: string, to: string): void
  mkdirp(path: string): void
}

/** What a caller supplies when connecting an agent; the registry stamps the timestamps. */
export type AgentConnection = Pick<AgentView, 'kind' | 'executablePath' | 'version' | 'connectedVia'>

export interface AgentRegistry {
  /** Connected agents in insertion order, at most one per kind. */
  list(): AgentView[]
  /** Replaces the entry for the agent's kind, or adds one; `connectedAt` survives a replacement. */
  upsert(agent: AgentConnection): AgentView
  /** Removes only the registry entry for a kind (never uninstalls the CLI or touches the executable). */
  remove(kind: AgentKind): void
}

const FILE_VERSION = 1

const registryFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  agents: z.array(z.unknown())
})

const agentEntrySchema = z.object({
  kind: z.enum(AGENT_KINDS),
  executablePath: z.string().min(1),
  version: z.string().nullable(),
  connectedVia: z.enum(['found', 'downloaded']),
  connectedAt: z.string(),
  lastProbed: z.string()
})

type AgentEntry = z.infer<typeof agentEntrySchema>

const nodeRegistryFs: RegistryFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => {
    writeFileSync(path, data, 'utf8')
  },
  rename: renameSync,
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  }
}

interface RegistryContext {
  file: string
  fs: RegistryFs
  now: () => string
}

interface RegistryState {
  entries: AgentEntry[]
}

function parseEntries(raw: unknown): AgentEntry[] {
  const file = registryFileSchema.safeParse(raw)
  if (!file.success) {
    return []
  }
  const entries = file.data.agents.flatMap((item) => {
    const entry = agentEntrySchema.safeParse(item)
    return entry.success ? [entry.data] : []
  })
  // A hand-edited file could repeat a kind; the first entry wins so the registry holds one per kind.
  return entries.filter((entry, index) => entries.findIndex((other) => other.kind === entry.kind) === index)
}

/** A missing, unreadable, or corrupt registry file is an empty registry; loading never throws. */
function loadEntries(fs: RegistryFs, file: string): AgentEntry[] {
  try {
    return parseEntries(JSON.parse(fs.readFile(file)))
  } catch {
    return []
  }
}

function saveEntries(context: RegistryContext, entries: readonly AgentEntry[]): void {
  const { fs, file } = context
  const temp = `${file}.tmp`
  const data = `${JSON.stringify({ version: FILE_VERSION, agents: entries }, null, 2)}\n`
  fs.mkdirp(dirname(file))
  fs.writeFile(temp, data)
  fs.rename(temp, file)
}

/** Persists first and only then updates memory, so a failed write leaves both unchanged. */
function commit(context: RegistryContext, state: RegistryState, next: AgentEntry[]): void {
  saveEntries(context, next)
  state.entries = next
}

function findEntry(entries: readonly AgentEntry[], kind: AgentKind): AgentEntry | undefined {
  return entries.find((entry) => entry.kind === kind)
}

function toView(entry: AgentEntry): AgentView {
  return {
    kind: entry.kind,
    executablePath: entry.executablePath,
    version: entry.version,
    connectedVia: entry.connectedVia,
    connectedAt: entry.connectedAt,
    lastProbed: entry.lastProbed
  }
}

/** Replaces the entry for this kind or adds one, keeping `connectedAt` and refreshing `lastProbed`. */
function upsertAgent(context: RegistryContext, state: RegistryState, agent: AgentConnection): AgentView {
  const now = context.now()
  const existing = findEntry(state.entries, agent.kind)

  const entry: AgentEntry = {
    kind: agent.kind,
    executablePath: agent.executablePath,
    version: agent.version,
    connectedVia: agent.connectedVia,
    connectedAt: existing?.connectedAt ?? now,
    lastProbed: now
  }

  const next = existing
    ? state.entries.map((e) => (e.kind === agent.kind ? entry : e))
    : [...state.entries, entry]

  commit(context, state, next)
  return toView(entry)
}

function removeAgent(context: RegistryContext, state: RegistryState, kind: AgentKind): void {
  const existing = findEntry(state.entries, kind)
  if (existing !== undefined) {
    commit(
      context,
      state,
      state.entries.filter((entry) => entry.kind !== kind)
    )
  }
}

export function createAgentRegistry(options: {
  /** Absolute path of the registry JSON file. */
  file: string
  fs?: RegistryFs
  /** ISO timestamp source for `connectedAt` and `lastProbed`. */
  now?: () => string
}): AgentRegistry {
  const context: RegistryContext = {
    file: options.file,
    fs: options.fs ?? nodeRegistryFs,
    now: options.now ?? (() => new Date().toISOString())
  }
  const state: RegistryState = { entries: loadEntries(context.fs, context.file) }
  return {
    list: () => state.entries.map((entry) => toView(entry)),
    upsert: (entry) => upsertAgent(context, state, entry),
    remove: (kind) => removeAgent(context, state, kind)
  }
}
