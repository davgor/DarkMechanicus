import type { ChatItem } from '../../../shared/agents/chat'
import { sameFolder } from '../../../shared/git/paths'

export const FILE_TOOLS = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  // OMP path keys are inferred in docs/reports/agent-chat-protocols.md, not live-verified.
  edit: 'path',
  write: 'path'
} as const

type Scope = { kind: 'chat' } | { kind: 'thread'; threadId: string }
type Change = {
  path: string
  absolutePath: string
  inFolder: boolean
  tool: string
  kind: 'written' | 'edited'
  count: number
}

/** Completed file tools only: shell edits are invisible. Items are in transcript order. */
export function agentChanges(items: readonly ChatItem[], scope: Scope, folder: string | null): Change[] {
  const threads = scope.kind === 'thread' ? descendantThreads(items, scope.threadId) : null
  const root = folder === null ? null : normalizePath(folder)
  const changes = new Map<string, Change>()
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (!isFileCall(item, threads)) continue
    const value = filePath(item)
    if (value === null) continue
    const absolutePath = resolvePath(value, root)
    const key = /^[a-z]:/i.test(absolutePath) ? absolutePath.toLowerCase() : absolutePath
    const existing = changes.get(key)
    if (existing) {
      existing.count++
      continue
    }
    changes.set(key, {
      ...displayPath(absolutePath, root),
      absolutePath,
      tool: item.name,
      kind: item.name === 'Write' || item.name === 'write' ? 'written' : 'edited',
      count: 1
    })
  }
  return [...changes.values()]
}

function filePath(item: Extract<ChatItem, { kind: 'tool_call' }>): string | null {
  const value = item.input[FILE_TOOLS[item.name as keyof typeof FILE_TOOLS]]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function descendantThreads(items: readonly ChatItem[], threadId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const item of items) {
    if (item.kind !== 'thread' || item.threadId === undefined) continue
    const siblings = children.get(item.threadId)
    if (siblings) siblings.push(item.id)
    else children.set(item.threadId, [item.id])
  }
  const threads = new Set([threadId])
  for (const id of threads) {
    for (const child of children.get(id) ?? []) threads.add(child)
  }
  return threads
}

function isFileCall(item: ChatItem, threads: Set<string> | null): item is Extract<ChatItem, { kind: 'tool_call' }> {
  return item.kind === 'tool_call' && item.status === 'completed' && Object.hasOwn(FILE_TOOLS, item.name)
    && (threads === null || (item.threadId !== undefined && threads.has(item.threadId)))
}

function resolvePath(value: string, root: string | null): string {
  const slashes = value.replace(/\\/g, '/')
  return normalizePath(root !== null && !/^(?:[a-z]:|\/)/i.test(slashes) ? `${root}/${slashes}` : slashes)
}

function displayPath(absolutePath: string, root: string | null): Pick<Change, 'path' | 'inFolder'> {
  if (root === null) return { path: absolutePath, inFolder: false }
  const prefix = root.endsWith('/') ? root : `${root}/`
  const inFolder = sameFolder(absolutePath, root) || sameFolder(absolutePath.slice(0, prefix.length), prefix)
  return { path: inFolder ? absolutePath.slice(prefix.length) || '.' : absolutePath, inFolder }
}

/** Lexical normalization only; no filesystem access or platform-dependent Node imports. */
function normalizePath(path: string): string {
  const slashes = path.replace(/\\/g, '/')
  const prefix = slashes.match(/^(?:[a-z]:\/?|\/\/|\/)/i)?.[0] ?? ''
  const segments: string[] = []
  for (const segment of slashes.slice(prefix.length).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.length > 0 && segments.at(-1) !== '..') segments.pop()
    else if (prefix === '') segments.push(segment)
  }
  return prefix + segments.join('/')
}
