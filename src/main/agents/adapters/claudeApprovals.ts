/**
 * Which of the Claude tools may run without asking the person, and what to call a request that asks.
 *
 * The CLI only calls `canUseTool` for what it would itself ask about, so this is the second line:
 * reads and searches inside the chat folder never become a request (even when a settings rule says
 * ask), and everything else does. A read or search that reaches outside the folder asks, as
 * category `other`, and the summary says so. Paths are judged as written, not through symlinks.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ApprovalCategory } from '../../../shared/agents/chat'
import { clipMasked } from '../claimTokenMask'

type ToolVerdict =
  | { kind: 'allow' }
  | { kind: 'ask'; category: ApprovalCategory; summary: string }
  /** A tool this chat cannot run at all; the message goes to the agent so it can ask in plain text. */
  | { kind: 'deny'; message: string }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])

/** Read-only tools and the input fields that name where they look. A search pattern is not a path. */
const READ_TOOL_PATHS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Read', ['file_path']],
  ['Glob', ['path', 'pattern']],
  ['Grep', ['path']],
  ['LS', ['path']],
  ['NotebookRead', ['notebook_path']]
])

/** Tools that need an answer from the person, which a chat has no way to collect. */
const UNSUPPORTED_TOOLS = new Map([
  ['AskUserQuestion', 'Questions with answer buttons are not supported in this chat. Ask the question in plain text instead.']
])

const MAX_COMMAND_CHARS = 200

function text(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function insideFolder(folder: string, target: string): boolean {
  const path = relative(folder, resolve(folder, target))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** The first path a read-only tool names that lies outside the folder, if any. */
function outsidePath(folder: string, names: readonly string[], input: Record<string, unknown>): string | null {
  for (const name of names) {
    const target = text(input, name)
    if (target !== null && !insideFolder(folder, target)) {
      return target
    }
  }
  return null
}

function command(input: Record<string, unknown>): string | null {
  const value = text(input, 'command')
  if (value === null) {
    return null
  }
  const line = value.replace(/\s+/g, ' ').trim()
  return clipMasked(line, MAX_COMMAND_CHARS)
}

function summaryOf(tool: string, input: Record<string, unknown>): string {
  const run = COMMAND_TOOLS.has(tool) ? command(input) : null
  if (run !== null) {
    return `Run ${run}`
  }
  const path = text(input, 'file_path') ?? text(input, 'notebook_path')
  if (EDIT_TOOLS.has(tool) && path !== null) {
    return `${tool === 'Write' ? 'Write' : 'Edit'} ${path}`
  }
  return `Use ${tool}`
}

function categoryOf(tool: string): ApprovalCategory {
  if (EDIT_TOOLS.has(tool)) {
    return 'file_edit'
  }
  return COMMAND_TOOLS.has(tool) ? 'command' : 'other'
}

/** Decides one tool call: run it, ask with this category and summary, or refuse it. */
export function classifyTool(tool: string, input: Record<string, unknown>, folder: string): ToolVerdict {
  const unsupported = UNSUPPORTED_TOOLS.get(tool)
  if (unsupported !== undefined) {
    return { kind: 'deny', message: unsupported }
  }
  const readPaths = READ_TOOL_PATHS.get(tool)
  if (readPaths !== undefined) {
    const outside = outsidePath(folder, readPaths, input)
    return outside === null ? { kind: 'allow' } : { kind: 'ask', category: 'other', summary: `${tool} outside the chat folder: ${outside}` }
  }
  return { kind: 'ask', category: categoryOf(tool), summary: summaryOf(tool, input) }
}
