/**
 * Writes into Claude Code's own memory folders, `<config dir>/projects/<project>/memory/`, and the
 * hook that makes the person's approval decide them.
 *
 * Why. The CLI allows a write into that folder before it asks the host, so `canUseTool` never sees
 * it, even with auto-memory switched off. A note saved there is loaded into later sessions, so an
 * agent that can write it unasked can steer them. The CLI does run `PreToolUse` hooks before that
 * check, and a hook that answers `ask` makes it ask the host through `canUseTool` like any other
 * edit (Agent SDK `HookCallbackMatcher`, `PreToolUseHookSpecificOutput.permissionDecision`; checked
 * live against Claude Code 2.1.281 with SDK 0.3.289, see docs/architecture.md, Adapters).
 *
 * Which writes. The target of a Write, Edit, MultiEdit or NotebookEdit is resolved the way the CLI
 * resolves it before it is compared with the folder: `~` is the home folder, a relative path starts
 * from the chat folder and from the directory the CLI reports (the call may follow a `cd`), `..`
 * segments are folded, either slash is read, and the comparison ignores letter case (a spelling the
 * file system treats as another name is at worst one question too many) and Unicode form. On Windows
 * the prefixes `\\?\` and `\\.\`, a trailing dot or space on a name and an alternate data stream
 * suffix are dropped too, as Windows drops them. The path is then also compared by its real path:
 * links and junctions are followed for the part of it that exists, and for a file that is not there
 * yet through the nearest folder that is. A call the hook cannot read, or fails on, asks.
 *
 * Where. The configuration folder is `CLAUDE_CONFIG_DIR` from the environment the CLI is started
 * with, and always also `~/.claude`.
 *
 * The CLI's carve-out is also wider than Write and Edit: it lets a command it counts as read-only,
 * such as `echo hi >> <memory file>`, redirect into the folder unasked (checked live: that ran with
 * no request). No hook can tell which commands those are, so the app moves the carve-out instead:
 * `pinnedMemoryFolder` is handed to the CLI as its `autoMemoryDirectory`, in the `--settings` of
 * that process only (flag settings outrank the person's own, and no file is written). The folder the
 * CLI then exempts is one of the app's, in the temp folder, that nothing reads, because auto-memory is
 * off. A write into any other memory folder, a shell redirect included, now asks by the CLI's own
 * rules, and this hook asks first for the tools above, and for a write into the pinned folder.
 */
import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { HookCallback, HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

/** The tools that write a file; the CLI tests this against the tool's name. */
const MEMORY_WRITE_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit'
const WRITE_TOOL_NAMES = new Set(MEMORY_WRITE_TOOLS.split('|'))
/** The input fields that name the file a write tool changes. */
const PATH_FIELDS = ['file_path', 'notebook_path']
/** The pinned memory folder's name, in the temp folder. */
const PINNED_FOLDER = 'dark-mechanicus-unused-memory'

const ASK: HookJSONOutput = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: "This writes into Claude Code's own memory folder, which the CLI would allow without asking. Dark Mechanicus asks first."
  }
}

export interface MemoryFolderContext {
  /** The environment the CLI is started with: a `CLAUDE_CONFIG_DIR` in it moves the folders. */
  env: NodeJS.ProcessEnv
  /** The person's home folder, which `~` stands for. */
  home: string
  /** The temp folder, where the memory folder the CLI is pointed at lies. */
  tmp: string
  /** The platform the CLI runs on; it decides how paths are read. */
  platform: string
  /** The real path of something that exists, throwing when it does not. Default: the file system's. */
  realpath?: (path: string) => string
}

interface Reader {
  flavour: typeof win32
  windows: boolean
  home: string
  realpath: (path: string) => string
}

function readerOf(context: MemoryFolderContext): Reader {
  const windows = context.platform === 'win32'
  return { flavour: windows ? win32 : posix, windows, home: context.home, realpath: context.realpath ?? realpathSync.native }
}

/** Where the CLI is told to keep its memory in a hosted chat: a folder of the app's, which nothing reads. */
export function pinnedMemoryFolder(context: MemoryFolderContext): string {
  return readerOf(context).flavour.join(context.tmp, PINNED_FOLDER)
}

function expandHome(path: string, reader: Reader): string {
  if (path === '~') {
    return reader.home
  }
  const homeRelative = path.startsWith('~/') || (reader.windows && path.startsWith('~\\'))
  return homeRelative ? reader.flavour.join(reader.home, path.slice(2)) : path
}

/** What Windows makes of one name: no alternate data stream, no trailing dots or spaces. */
function windowsName(name: string): string {
  const bare = (name.split(':')[0] as string).replace(/[. ]+$/, '')
  return bare === '' ? name : bare
}

/** An absolute path as its names, compared case-insensitively and by Unicode form. */
function namesOf(absolute: string, reader: Reader): string[] {
  const path = reader.windows && /^\\\\[?.]\\/.test(absolute) ? absolute.slice(4) : absolute
  return path
    .split(reader.windows ? /[\\/]+/ : /\/+/)
    .filter((name) => name !== '')
    .map((name, index) => (reader.windows && index > 0 ? windowsName(name) : name).normalize('NFC').toLowerCase())
}

/** The real path of an absolute one: of the part that exists, with the rest as written. */
function realPathOf(absolute: string, reader: Reader): string {
  const rest: string[] = []
  let current = absolute
  for (;;) {
    try {
      return reader.flavour.join(reader.realpath(current), ...rest)
    } catch {
      const parent = reader.flavour.dirname(current)
      if (parent === current) {
        return absolute
      }
      rest.unshift(reader.flavour.basename(current))
      current = parent
    }
  }
}

/** The names of a path as written and as it really is. */
function formsOf(absolute: string, reader: Reader): string[][] {
  return [namesOf(absolute, reader), namesOf(realPathOf(absolute, reader), reader)]
}

/** Every configuration folder the CLI may be using: `CLAUDE_CONFIG_DIR`, from each starting point, and the default. */
function configFolders(bases: readonly string[], env: NodeJS.ProcessEnv, reader: Reader): string[][] {
  const moved = env.CLAUDE_CONFIG_DIR?.trim() ?? ''
  const folders = [reader.flavour.join(reader.home, '.claude')]
  if (moved !== '') {
    folders.push(...bases.map((base) => reader.flavour.resolve(base, expandHome(moved, reader))))
  }
  return folders.flatMap((folder) => formsOf(folder, reader))
}

/** `folder` itself, or anything below it. */
function under(target: readonly string[], folder: readonly string[]): boolean {
  return target.length >= folder.length && folder.every((name, index) => name === target[index])
}

/** `<config dir>/projects/<project>/memory`, or anything below it. */
function inMemoryFolder(target: readonly string[], config: readonly string[]): boolean {
  const at = config.length
  return target.length >= at + 3 && under(target, config) && target[at] === 'projects' && target[at + 2] === 'memory'
}

function targetsMemory(file: string, bases: readonly string[], context: MemoryFolderContext, reader: Reader): boolean {
  const configs = configFolders(bases, context.env, reader)
  const pinned = formsOf(pinnedMemoryFolder(context), reader)
  return bases
    .flatMap((base) => formsOf(reader.flavour.resolve(base, expandHome(file, reader)), reader))
    .some((target) => configs.some((config) => inMemoryFolder(target, config)) || pinned.some((folder) => under(target, folder)))
}

/** The files a write tool names, or null when it names none in a way that is known. */
function filesOf(toolInput: unknown): string[] | null {
  const input = (typeof toolInput === 'object' && toolInput !== null ? toolInput : {}) as Record<string, unknown>
  const files = PATH_FIELDS.flatMap((field) => (typeof input[field] === 'string' && input[field] !== '' ? [input[field] as string] : []))
  return files.length === 0 ? null : files
}

function decide(input: HookInput, folder: string, context: MemoryFolderContext, reader: Reader): HookJSONOutput {
  if (input.hook_event_name !== 'PreToolUse' || !WRITE_TOOL_NAMES.has(input.tool_name)) {
    return {}
  }
  const files = filesOf(input.tool_input)
  const bases = typeof input.cwd === 'string' && input.cwd !== folder ? [folder, input.cwd] : [folder]
  return files === null || files.some((file) => targetsMemory(file, bases, context, reader)) ? ASK : {}
}

/**
 * The hook that sends a write into a memory folder to the person. It answers `{}` for everything
 * else, which leaves the call to the CLI's own rules, the person's settings and `canUseTool`.
 */
export function memoryWriteMatcher(context: MemoryFolderContext, folder: string): HookCallbackMatcher {
  const reader = readerOf(context)
  const hook: HookCallback = (input) => {
    try {
      return Promise.resolve(decide(input, folder, context, reader))
    } catch {
      // A call that cannot be examined is not let through unasked.
      return Promise.resolve(ASK)
    }
  }
  return { matcher: MEMORY_WRITE_TOOLS, hooks: [hook] }
}
