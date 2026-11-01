/**
 * Writes into Claude Code's own memory folders, `<config dir>/projects/<project>/memory/`, and the rules that make
 * the person's approval decide them: one set of rules for the chat adapter's in-process hook and for a chat
 * terminal's `PreToolUse` command hook (`claudeMemoryHook.ts`, run by the CLI with the call's JSON on its standard
 * input; `claudeSettingsFile.ts` registers it).
 *
 * Why. The CLI allows a write into that folder before it asks, so its own permission rules never see it, even with
 * auto-memory switched off. A note saved there is loaded into later sessions, so an agent that can write it unasked
 * can steer them. The CLI does run `PreToolUse` hooks before that check, and a hook that answers `ask` makes it ask
 * like any other edit (`hookSpecificOutput.permissionDecision`, checked against Claude Code 2.1.291's settings
 * schema and live, see docs/architecture.md, Adapters).
 *
 * Which writes. The target of a Write, Edit, MultiEdit or NotebookEdit is resolved the way the CLI resolves it
 * before it is compared with the folder: `~` is the home folder, a relative path starts from the chat folder and
 * from the directory the CLI reports (the call may follow a `cd`), `..` segments are folded, either slash is read,
 * and the comparison ignores letter case (a spelling the file system treats as another name is at worst one
 * question too many) and Unicode form. On Windows the prefixes `\\?\` and `\\.\`, a trailing dot or space on a
 * name and an alternate data stream suffix are dropped too, as Windows drops them. The path is then also compared
 * by its real path: links and junctions are followed for the part of it that exists, and for a file that is not
 * there yet through the nearest folder that is. A call the hook cannot read, or fails on, asks.
 *
 * Where. The configuration folder is `CLAUDE_CONFIG_DIR` from the environment the CLI is started with, and always
 * also `~/.claude`.
 *
 * The CLI's carve-out is also wider than Write and Edit: it lets a command it counts as read-only, such as
 * `echo hi >> <memory file>`, redirect into the folder unasked (checked live: that ran with no request). No hook
 * can tell which commands those are, so the app moves the carve-out instead: `pinnedMemoryFolder` is handed to the
 * CLI as its `autoMemoryDirectory`, in the settings of that process only (flag settings outrank the person's own).
 * The folder the CLI then exempts is one of the app's, in the temp folder, that nothing reads, because auto-memory
 * is off. A write into any other memory folder, a shell redirect included, now asks by the CLI's own rules, and
 * the hook asks first for the tools above, and for a write into the pinned folder.
 */
import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** The tools that write a file; the CLI tests this against the tool's name (a hook's `matcher`). */
export const MEMORY_WRITE_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit'
const WRITE_TOOL_NAMES = new Set(MEMORY_WRITE_TOOLS.split('|'))
/** The input fields that name the file a write tool changes. */
const PATH_FIELDS = ['file_path', 'notebook_path']
/** The pinned memory folder's name, in the temp folder. */
const PINNED_FOLDER = 'dark-mechanicus-unused-memory'

/** A hook's answer: ask the person, or `{}`, which leaves the call to the CLI's own rules and the person's settings. */
type MemoryHookAnswer =
  | Record<string, never>
  | { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'ask'; permissionDecisionReason: string } }

const ASK: MemoryHookAnswer = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: "This writes into Claude Code's own memory folder, which the CLI would allow without asking. Dark Mechanicus asks first."
  }
}
const LEAVE: MemoryHookAnswer = {}
/** The ask answer as the hook prints it. */
export const MEMORY_HOOK_ASK_OUTPUT = JSON.stringify(ASK)

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

/** The fields of a hook call this reads; anything may be missing or of another type. */
interface HookCall {
  hook_event_name?: unknown
  tool_name?: unknown
  tool_input?: unknown
  cwd?: unknown
}

function decide(input: unknown, folder: string, context: MemoryFolderContext, reader: Reader): MemoryHookAnswer {
  if (typeof input !== 'object' || input === null) {
    return ASK
  }
  const call = input as HookCall
  if (call.hook_event_name !== 'PreToolUse' || typeof call.tool_name !== 'string' || !WRITE_TOOL_NAMES.has(call.tool_name)) {
    return LEAVE
  }
  const files = filesOf(call.tool_input)
  const bases = typeof call.cwd === 'string' && call.cwd !== folder ? [folder, call.cwd] : [folder]
  return files === null || files.some((file) => targetsMemory(file, bases, context, reader)) ? ASK : LEAVE
}

/**
 * The answer to one hook call (the JSON the CLI sends a `PreToolUse` hook, as read): ask for a write into a memory
 * folder, `{}` for everything else. Never throws: a call that cannot be examined is not let through unasked.
 */
export function memoryHookAnswer(input: unknown, folder: string, context: MemoryFolderContext): MemoryHookAnswer {
  try {
    return decide(input, folder, context, readerOf(context))
  } catch {
    return ASK
  }
}

/**
 * What the hook script prints for one call: the ask answer as JSON, or nothing, which leaves the call to the CLI.
 * `args` are the script's arguments, the chat folder, the home folder and the temp folder, as main wrote them into
 * the hook command; `env` is the environment the CLI runs the hook with, the CLI's own. Arguments that are not
 * those three folders, and an input that is not JSON, ask.
 */
export function memoryHookOutput(args: readonly string[], stdin: string, env: NodeJS.ProcessEnv, platform: string): string {
  const [folder, home, tmp] = args
  if (args.length !== 3 || !folder || !home || !tmp) {
    return MEMORY_HOOK_ASK_OUTPUT
  }
  let input: unknown
  try {
    input = JSON.parse(stdin)
  } catch {
    return MEMORY_HOOK_ASK_OUTPUT
  }
  const answer = memoryHookAnswer(input, folder, { env, home, tmp, platform })
  return answer === ASK ? MEMORY_HOOK_ASK_OUTPUT : ''
}
