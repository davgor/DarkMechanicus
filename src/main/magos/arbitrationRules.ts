/**
 * Which pending prompts the Magos arbiter may never decide. Main asks this before any arbiter process starts;
 * every exclusion goes straight to the person. Every rule fails closed: anything this module cannot classify with
 * certainty (unparseable or ambiguous paths, unresolvable variables, inline code, over-deep inputs, a throwing rule)
 * is excluded, never arbitrated.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { GUI_PROTOCOL_KINDS, type PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import type { NotificationSettings } from '../../shared/desktop/notificationSettings'

export type ExclusionReason =
  | 'disabled' | 'not_magos_chat' | 'project_less' | 'unsupported_kind' | 'question' | 'always_ask'
  | 'no_tool_input' | 'control_file' | 'outside_folder' | 'path_too_long' | 'never_arbitrate'

/** The disk as this module reads it; each call throws a Node error with a `code` when it cannot read the path. */
interface ArbitrationFs {
  /** Canonical real path of an existing path. */
  realpath(path: string): string
  /** The entry itself, without following a final symlink. */
  lstat(path: string): unknown
}

export interface ArbitrationInput {
  /** The whole chat, so a registered predicate can tell chats apart. */
  chat: ChatRecord
  agentKind: string
  prompt: PendingPrompt
  /** The chat's canonical folder; null for a project-less chat. */
  folder: string | null
  settings: Pick<NotificationSettings, 'arbitration'>
  platform: NodeJS.Platform
  /**
   * Canonical worktree paths of the folder's repository (`git worktree list --porcelain`, read and canonicalized by
   * the caller). The folder itself is always a root; a path is inside when it is inside any root.
   */
  allowedRoots: readonly string[]
  /** `fs.realpathSync.native` and `fs.lstatSync` when omitted. */
  fs?: ArbitrationFs
}

/** Extra exclusions later sprints add (site approvals, desktop control) without editing this module. */
type NeverArbitrate = (input: ArbitrationInput) => boolean

/**
 * OMP stays out until it is observed that `omp -p --no-tools` loads no MCP tools and reads a nonempty stdin, and an
 * MCP-disabling configuration exists (docs/reports/agent-chat-protocols.md § Arbiter). A supplied overlay path changes nothing.
 */
const ARBITRABLE_KINDS: ReadonlySet<string> = new Set(GUI_PROTOCOL_KINDS.filter(kind => kind !== 'omp'))
const MAX_DEPTH = 8
/** The longest path component Linux (255 bytes) and Windows (255 UTF-16 units) accept; UTF-8 bytes bound both. */
const MAX_NAME_BYTES = 255
const MAX_STRINGS = 2000
const PATH_KEYS: ReadonlySet<string> = new Set(['file_path', 'path', 'notebook_path', 'cwd', 'directory'])
/**
 * Claude's file-editing tools: the key naming the file they write, and the keys holding the text written, never a path
 * the tool opens. `$HOME`, `//`, `\d` or `*` there is file content, so it is not path-scanned; the path key still is,
 * and must be there.
 */
const FILE_EDITS: ReadonlyMap<string, { pathKey: string; contentKeys: ReadonlySet<string> }> = new Map([
  ['Write', { pathKey: 'file_path', contentKeys: new Set(['content']) }],
  ['Edit', { pathKey: 'file_path', contentKeys: new Set(['old_string', 'new_string']) }],
  ['MultiEdit', { pathKey: 'file_path', contentKeys: new Set(['edits']) }],
  ['NotebookEdit', { pathKey: 'notebook_path', contentKeys: new Set(['new_source']) }]
])
const TOKEN_SPLIT = /[\s"'`=;|&<>(),@]+/
/** Words as a shell sees them once quotes and escapes are gone; commas stay so brace expansions stay whole. */
const SHELL_WORD_SPLIT = /[\s=;|&<>()@]+/
/**
 * Quotes and escape characters a shell drops: POSIX `\`, PowerShell `` ` ``, cmd `^`. Windows shells keep `\` as a
 * separator, so a second reading drops everything but `\`.
 */
const SHELL_READINGS = [/["'`^\\]/g, /["'`^]/g]
const SHELL_COMMAND_SPLIT = /[;&|\n\r(){}]+/
/** Bash expands braces around quoted or escaped whitespace (`{.,' '}`, `{.,\ }`) too, so any whitespace may sit inside. */
const BRACE_EXPANSION = /\{[^{}]*(,|\.\.)[^{}]*\}/
/** Wildcards of bash, PowerShell and cmd, and a brace expansion (`{c,}`); a lone `{` or `}` is literal. */
const GLOB = /[*?[\]]|\{[^{}]*(,|\.\.)/
/** Commands that move the shell to a directory not named in the command (home, the previous one, the stack). */
const DIRECTORY_COMMANDS: ReadonlySet<string> = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location'])
/** Directories whose contents configure an agent, git or CI, matched as any path segment. */
const CONTROL_DIRS: ReadonlySet<string> = new Set(['.claude', '.omp', '.git', '.vscode'])
const CONTROL_FILES: ReadonlySet<string> = new Set(['.mcp.json', 'claude.md', 'agents.md', '.gitattributes'])
const CONTROL_NAMES = [...CONTROL_DIRS, ...CONTROL_FILES, '.github']
const INLINE_CODE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ...['node', 'nodejs', 'bun', 'deno'].map(name => [name, new Set(['-e', '--eval', '-p', '--print', '-pe', 'eval'])] as const),
  ...['python', 'py', 'pythonw'].map(name => [name, new Set(['-c'])] as const),
  ...['perl', 'ruby'].map(name => [name, new Set(['-e'])] as const),
  ['php', new Set(['-r'])],
  ...['powershell', 'pwsh'].map(name => [name, new Set(['-e', '-ec', '/e', '/ec'])] as const)
])
const EVALUATORS: ReadonlySet<string> = new Set(['iex', 'invoke-expression', 'eval'])

const neverArbitrate = new Set<NeverArbitrate>()

/** Adds an exclusion checked after the built-in rules; a throwing predicate excludes. Returns its removal. */
export function registerNeverArbitrate(predicate: NeverArbitrate): () => void {
  neverArbitrate.add(predicate)
  return () => { neverArbitrate.delete(predicate) }
}

const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  disabled: 'The Magos arbiter is turned off; decide this yourself.',
  not_magos_chat: 'Only a run\'s Magos chat has an arbiter; decide this yourself.',
  project_less: 'The Magos never decides for a chat without a folder; decide this yourself.',
  unsupported_kind: 'The Magos cannot arbitrate for this agent yet; decide this yourself.',
  question: 'The Magos never decides questions; answer it yourself.',
  always_ask: 'This tool is on your always-ask list; decide this yourself.',
  no_tool_input: 'This request does not say which tool it runs with what input; decide this yourself.',
  control_file: 'This request touches agent, git or CI configuration; decide this yourself.',
  outside_folder: 'This request may reach outside the project folder; decide this yourself.',
  path_too_long: 'This request names a path too long to check; decide this yourself.',
  never_arbitrate: 'The Magos never decides this kind of request; decide this yourself.'
}

export function exclusionText(reason: ExclusionReason): string {
  return EXCLUSION_TEXT[reason]
}

/** Null when the Magos arbiter may decide `prompt`; otherwise the first rule, in precedence order, that excludes it. */
export function arbitrationExclusion(input: ArbitrationInput): { reason: ExclusionReason } | null {
  const reason = firstExclusion(input)
  return reason === null ? null : { reason }
}

function firstExclusion(input: ArbitrationInput): ExclusionReason | null {
  const { chat, folder, settings } = input
  if (!settings.arbitration.enabled) return 'disabled'
  if (chat.role !== 'orchestrator' || !chat.runId) return 'not_magos_chat'
  if (folder === null) return 'project_less'
  if (!ARBITRABLE_KINDS.has(input.agentKind)) return 'unsupported_kind'
  if (input.prompt.kind === 'question') return 'question'
  return toolExclusion(input, folder) ?? registeredExclusion(input)
}

function toolExclusion(input: ArbitrationInput, folder: string): ExclusionReason | null {
  const { prompt, settings } = input
  const { tool } = prompt
  if (tool !== undefined && alwaysAsked(tool.name, settings.arbitration.alwaysAsk)) return 'always_ask'
  if (tool === undefined || !isPlainObject(tool.input)) return 'no_tool_input'
  const edit = FILE_EDITS.get(tool.name)
  if (edit === undefined) return SCAN_EXCLUSION[scanReferences([prompt.title, prompt.detail, tool.input], folder, input)]
  // A file edit with no file named cannot be placed, so it is outside.
  if (typeof tool.input[edit.pathKey] !== 'string') return 'outside_folder'
  const scanned = Object.fromEntries(Object.entries(tool.input).filter(([key]) => !edit.contentKeys.has(key)))
  return SCAN_EXCLUSION[scanReferences([prompt.title, prompt.detail, scanned], folder, input)]
}

function registeredExclusion(input: ArbitrationInput): 'never_arbitrate' | null {
  const excludes = (predicate: NeverArbitrate): boolean => {
    try {
      return predicate(input)
    } catch {
      return true
    }
  }
  return [...neverArbitrate].some(excludes) ? 'never_arbitrate' : null
}

function alwaysAsked(name: string, entries: readonly string[]): boolean {
  const tool = name.toLowerCase()
  return entries.some(entry => {
    const pattern = entry.toLowerCase()
    return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `control` outranks `outside`, which outranks `too_long`; `inside` means every reference resolved inside a root and
 * none names a control file. `too_long`: a word is a name the disk refuses as too long, so where it leads is unknown.
 */
type Scan = 'inside' | 'too_long' | 'outside' | 'control'

const SCAN_EXCLUSION: Record<Scan, ExclusionReason | null> = {
  inside: null, too_long: 'path_too_long', outside: 'outside_folder', control: 'control_file'
}

interface ScanContext {
  readonly platform: NodeJS.Platform
  readonly path: typeof posix
  readonly folder: string
  readonly roots: readonly string[]
  readonly fs: ArbitrationFs
  /** Real paths already looked up in this scan; command text repeats the same words. */
  readonly real: Map<string, string | null>
  strings: number
  outside: boolean
  control: boolean
  tooLong: boolean
}

const nodeFs: ArbitrationFs = { realpath: path => realpathSync.native(path), lstat: path => lstatSync(path) }

/** Never throws: a failure while scanning counts as outside. */
function scanReferences(values: readonly unknown[], folder: string, input: ArbitrationInput): Scan {
  const path = input.platform === 'win32' ? win32 : posix
  try {
    const roots = [folder, ...input.allowedRoots]
      .filter(root => path.isAbsolute(root) && !ambiguousAbsolute(root, input.platform))
      .map(root => path.resolve(root))
    const context: ScanContext = {
      platform: input.platform, path, folder: path.resolve(folder), roots, fs: input.fs ?? nodeFs,
      real: new Map(), strings: 0, outside: false, control: false, tooLong: false
    }
    for (const value of values) walk(value, 1, context)
    return context.control ? 'control' : context.outside ? 'outside' : context.tooLong ? 'too_long' : 'inside'
  } catch {
    return 'outside'
  }
}

function walk(value: unknown, depth: number, context: ScanContext): void {
  if (typeof value === 'string') {
    countString(context)
    scanText(value, context, true)
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (depth > MAX_DEPTH) {
    context.outside = true
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, context)
    return
  }
  for (const [key, item] of Object.entries(value)) walkEntry(key, item, depth, context)
}

function walkEntry(key: string, item: unknown, depth: number, context: ScanContext): void {
  countString(context)
  scanText(key, context, true)
  if (PATH_KEYS.has(key)) {
    walkPathValue(item, depth + 1, context)
  } else if (key !== 'paths') {
    walk(item, depth + 1, context)
  } else if (Array.isArray(item) && depth + 1 <= MAX_DEPTH) {
    for (const entry of item) walkPathValue(entry, depth + 2, context)
  } else {
    context.outside = true
  }
}

/**
 * A path-keyed value is always a path reference, a relative one resolving against the folder. It names one path, not
 * a command, so it is not read as shell words: a Windows path's backslashes are separators there, not escapes.
 */
function walkPathValue(value: unknown, depth: number, context: ScanContext): void {
  if (typeof value !== 'string' || value.length === 0) {
    context.outside = true
    walk(value, depth, context)
    return
  }
  countString(context)
  checkReference(value, true, context)
  scanText(value, context, false)
}

function countString(context: ScanContext): void {
  context.strings += 1
  if (context.strings > MAX_STRINGS) context.outside = true
}

/**
 * Free text (a Bash command, a title), split into tokens. When `shell`, the text is also read as shells would after
 * dropping quotes and escapes, because the shell joins what the tokens split (`.clau''de`, `.cla\ude`, `'.'./x`). The
 * POSIX reading turns `C:\repo\a.ts` into `C:repoa.ts`, as unquoted bash does, so such a command escalates. A brace
 * expansion (`{.,.}.`, `{a..b}`) or a directory change to an unnamed place escalates too.
 */
function scanText(text: string, context: ScanContext, shell: boolean): void {
  scanTokens(text.split(TOKEN_SPLIT), context)
  if (!shell) return
  for (const reading of SHELL_READINGS) {
    const unquoted = text.replace(reading, '')
    scanTokens(unquoted.split(SHELL_WORD_SPLIT), context)
    if (BRACE_EXPANSION.test(unquoted) || changesToUnnamedDirectory(unquoted)) context.outside = true
  }
}

/** Each token is tested bare and with a leading `-x` or `--opt` stripped. */
function scanTokens(split: readonly string[], context: ScanContext): void {
  const tokens = split.filter(token => token.length > 0)
  if (runsInlineCode(tokens)) context.outside = true
  for (const token of tokens) {
    checkReference(token, false, context)
    const stripped = token.replace(/^(--[A-Za-z0-9][A-Za-z0-9-]*|-[A-Za-z0-9])/, '')
    if (stripped !== token && stripped.length > 0) checkReference(stripped, false, context)
  }
}

/** `cd`, `cd -`, `pushd` with no directory, `popd`: later relative paths then resolve somewhere unknown. */
function changesToUnnamedDirectory(text: string): boolean {
  return text.split(SHELL_COMMAND_SPLIT).some(command => {
    const words = command.split(TOKEN_SPLIT).filter(word => word.length > 0).map(word => word.toLowerCase())
    return words.some((word, index) => {
      const name = commandName(word)
      if (!DIRECTORY_COMMANDS.has(name)) return false
      const target = words.slice(index + 1).find(argument => !/^(-[a-z@]|--|\/d)$/.test(argument))
      return name.startsWith('pop') || target === undefined || target === '-'
    })
  })
}

/** Evaluators, encoded PowerShell and interpreters handed code inline can reach anything, so they escalate. */
function runsInlineCode(tokens: readonly string[]): boolean {
  // PowerShell takes en, em and horizontal-bar dashes as `-`.
  const lower = tokens.map(token => token.toLowerCase().replace(/^[\u2013\u2014\u2015]/, '-'))
  if (lower.some(token => EVALUATORS.has(token) || encodedCommandFlag(token))) return true
  return lower.some((token, index) => {
    const flags = INLINE_CODE.get(commandName(token))
    return flags !== undefined && lower.slice(index + 1).some(flag => flags.has(flag))
  })
}

/** `-EncodedCommand` and the prefixes PowerShell accepts for it from `-enc` on, with `-`, `--` or `/`. */
function encodedCommandFlag(token: string): boolean {
  const match = /^(?:--?|\/)([a-z]+)$/.exec(token)
  if (match === null) return false
  const flag = match[1]
  return flag === 'ec' || (flag.length >= 3 && 'encodedcommand'.startsWith(flag))
}

/** `C:\Python311\python3.11.exe` → `python`. */
function commandName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.replace(/\.(exe|cmd|bat)$/, '').replace(/[\d.]+$/, '')
}

function checkReference(token: string, keyed: boolean, context: ScanContext): void {
  const { platform } = context
  const absolute = absoluteForm(token, platform)
  // A relative mention names its file by itself (`echo x > .claude/settings.json`); an absolute one is checked below
  // by its form relative to the root it lies in, so a folder that itself lies under `~/.omp` is not a control file.
  if (!absolute && namesControlFile(token, platform)) context.control = true
  // Drive-relative, root-relative and `file:` forms, and any `..` segment, are references on every platform.
  const reference = keyed || absolute || /^([A-Za-z]:|\\|file:)/i.test(token) || token.split(/[\\/]/).includes('..')
  if (unresolvable(token, platform)) {
    context.outside = true
  } else if (resolvable(token, platform)) {
    // Every word that could name a path is resolved, so a committed link (`cat link/x`) cannot lead out unseen.
    checkResolved(token, context)
  } else if (reference) {
    context.outside = true
  }
}

function absoluteForm(token: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^([A-Za-z]:)?[\\/]/.test(token) : token.startsWith('/')
}

/** Both the path as written and its real path must lie inside a root, each by exact case. */
function checkResolved(token: string, context: ScanContext): void {
  const { path, platform } = context
  // Windows reports an over-long name absent rather than too long, so the name is measured before the disk is asked.
  if (token.split(/[\\/]/).some(name => Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES)) {
    context.tooLong = true
    return
  }
  const lexical = path.resolve(context.folder, token)
  if (!context.real.has(lexical)) context.real.set(lexical, realPrefix(lexical, context))
  const real = context.real.get(lexical) ?? UNKNOWN
  if (real === TOO_LONG) {
    context.tooLong = true
    return
  }
  if (real === UNKNOWN) {
    context.outside = true
    return
  }
  for (const target of [lexical, real]) {
    const root = context.roots.find(candidate => within(candidate, target, path))
    if (root === undefined) {
      context.outside = true
      return
    }
    if (namesControlFile(path.relative(root, target), platform)) context.control = true
  }
}

/** Environment variables, home references and NUL never resolve to a known place. */
function unresolvable(token: string, platform: NodeJS.Platform): boolean {
  if (token.includes('$') || /%[A-Za-z_][A-Za-z0-9_]*%/.test(token) || token.startsWith('~') || token.includes('\0')) return true
  // An 8.3 short name (`CLAUDE~1.MD`) can stand for any long name.
  return platform === 'win32' && /~\d/.test(token)
}

/**
 * Forms this module resolves exactly, never with a `..` segment (a symlink makes it ambiguous) or as `file:`: on win32
 * a drive-absolute or root-relative path with one separator style, never UNC, device (`\\?\`, `\\.\`), drive-relative
 * (`C:x`) or with a stream (`a.ts:x`); on POSIX, no backslash and no Windows drive.
 */
function resolvable(token: string, platform: NodeJS.Platform): boolean {
  if (/^file:/i.test(token) || token.split(/[\\/]/).includes('..')) return false
  if (platform !== 'win32') return !token.includes('\\') && !/^[A-Za-z]:/.test(token)
  const mixed = token.includes('/') && token.includes('\\')
  return !mixed && !/^[A-Za-z]:(?![\\/])/.test(token) && !ambiguousAbsolute(token, platform) && !token.includes(':', 2)
}

/** UNC and device paths on win32 (`\\server\share`, `//server/share`, `\\?\C:\x`). */
function ambiguousAbsolute(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(path)
}

/** What `realPrefix` reports when no real path is known; a real path is absolute, so it never equals either. */
const UNKNOWN = 'unknown'
const TOO_LONG = 'too_long'

/**
 * The real path of the longest existing prefix, with the missing rest appended unchanged; `UNKNOWN` when that cannot
 * be known, `TOO_LONG` when the disk refuses the name as too long (ENAMETOOLONG). Only an entry that is truly absent
 * (ENOENT from both realpath and lstat) lets the walk go up to its parent: a dangling symlink still exists as an entry
 * and may point anywhere, and EACCES, EPERM or ELOOP hide where it leads.
 */
function realPrefix(target: string, context: ScanContext): string {
  const { path, fs } = context
  const tail: string[] = []
  let current = target
  for (;;) {
    const real = attempt(() => fs.realpath(current))
    if (typeof real === 'string') return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    const entry = errorCode(real) === 'ENOENT' ? attempt(() => fs.lstat(current)) : real
    const code = errorCode(entry)
    if (code !== 'ENOENT') return code === 'ENAMETOOLONG' ? TOO_LONG : UNKNOWN
    const parent = path.dirname(current)
    if (parent === current) return UNKNOWN
    tail.push(path.basename(current))
    current = parent
  }
}

/** The call's result, or what it threw. */
function attempt<T>(call: () => T): T | { thrown: unknown } {
  try {
    return call()
  } catch (error) {
    return { thrown: error }
  }
}

/** The `code` of what `attempt` caught; null for a result or a throw without one. */
function errorCode(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('thrown' in result)) return null
  const { thrown } = result
  return typeof thrown === 'object' && thrown !== null && 'code' in thrown ? thrown.code : null
}

/** Inside by both `relative()` and an exact, case-sensitive prefix: a case difference on win32 is ambiguous, so outside. */
function within(root: string, target: string, path: typeof posix): boolean {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target === root || target.startsWith(prefix)
}

/**
 * Whether any segment of a (relative) path names agent, git or CI configuration: `.claude`, `.omp`, `.git`, `.vscode`,
 * `.github` (holding `workflows`), `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.gitattributes`. Compared case-insensitively
 * on every platform, ignoring win32's trailing dots and spaces. A wildcard segment counts when it starts with a dot
 * (`.c*`) or could match one of those names (`?claude`, `*.md`, `*`): PowerShell wildcards match leading dots.
 */
function namesControlFile(reference: string, platform: NodeJS.Platform): boolean {
  const segments = reference.split(/[\\/]/).map(segment => {
    const lower = segment.toLowerCase()
    return platform === 'win32' ? lower.replace(/[. ]+$/, '') : lower
  })
  return segments.some(segment => CONTROL_NAMES.includes(segment) || (GLOB.test(segment) && globNamesControl(segment)))
}

function globNamesControl(segment: string): boolean {
  if (segment.startsWith('.')) return true
  // A superset of every wildcard dialect: a bracket class is any one character, a brace or stray bracket anything.
  const source = segment
    .replace(/\[[^\]]*\]|[*?{}[\]]|[^*?{}[\]]+/g, part => {
      if (part === '?' || (part.startsWith('[') && part.length > 1)) return '.'
      if (/^[*{}[\]]$/.test(part)) return '.*'
      return part.replace(/[.+^$()|\\]/g, '\\$&')
    })
  const pattern = new RegExp(`^${source}$`)
  return CONTROL_NAMES.some(name => pattern.test(name))
}
