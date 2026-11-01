/**
 * What a clone may be given, checked before git runs. The URL is `https://…`, `ssh://…`, scp-like `user@host:path`
 * or GitHub's `owner/repo` shorthand; every other transport (`file:`, `ext::`, `fd::`, `git://`, `http://`, a local
 * path) is refused, and git also runs with `GIT_ALLOW_PROTOCOL`, so an `insteadOf` rewrite cannot reach one either.
 * The new folder's name is a single, portable path segment.
 */
import { GitInputError } from './errors'

/** A percent-encoded control character (git decodes ssh URLs before using their parts). */
const ENCODED_CONTROL = /%(?:[01][0-9a-f]|7f)/i
/** GitHub's `owner/repo`: an owner of letters, digits, `-` and `_`, a repository of letters, digits, `.`, `-` and `_`. */
const SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})$/
/** `user@host:path`, with a user, host and path that cannot read as an option, and a path that is not `:…` (`git@ext::…`). */
const SCP_LIKE = /^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^:-]/
const SCHEMES: Partial<Record<string, string>> = { 'https:': 'https://', 'ssh:': 'ssh://' }

interface CloneUrlOptions {
  /** Tests only: also accept `file://` URLs, to clone a local bare repository. Never reachable over IPC. */
  allowFile?: boolean
}

/** Whether `text` holds a control character (a NUL, a newline, DEL…). */
function hasControlCharacter(text: string): boolean {
  return [...text].some((char) => char < ' ' || char === '\u007f')
}

function refuse(): never {
  throw new GitInputError('Enter an https:// or ssh:// URL, git@host:path, or owner/repo for GitHub.')
}

function fromShorthand(input: string): string | null {
  const match = SHORTHAND.exec(input)
  if (match === null) {
    return null
  }
  const repo = match[2].replace(/\.git$/i, '')
  return repo === '' || repo === '.' || repo === '..' ? null : `https://github.com/${match[1]}/${repo}.git`
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input)
  } catch {
    return null
  }
}

/** `part` with its percent-escapes decoded, as git decodes the host and user of an ssh URL; null when they do not decode. */
function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** An ssh host as git reads it: a name or IPv4 address, or an IPv6 address in brackets; never `-…`, `/…`, `[-…]` or spaces. */
const SSH_HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._~-]*|\[[0-9A-Fa-f:.]+\])$/
/** An ssh user as git reads it: no option, `@`, quote or shell syntax for ssh's `%r` to pass on. Empty when none is named. */
const SSH_USER = /^(?:[A-Za-z0-9_][A-Za-z0-9._~-]*)?$/

/**
 * Whether a URL names a host and a path. The https parser has checked an https host already; an ssh URL's host and
 * user go to ssh as git decodes them, so they must be plain names.
 */
function isRemote(url: URL): boolean {
  const path = url.pathname.replace(/^\/+/, '')
  if (url.hostname === '' || path === '') {
    return false
  }
  if (url.protocol === 'https:') {
    return !(decoded(url.username) ?? '-').startsWith('-')
  }
  return SSH_HOST.test(decoded(url.hostname) ?? '') && SSH_USER.test(decoded(url.username) ?? '-')
}

function schemeOf(url: URL, options: CloneUrlOptions): string | undefined {
  return options.allowFile === true && url.protocol === 'file:' ? 'file://' : SCHEMES[url.protocol]
}

/** An https or ssh URL (or, when allowed, a file URL) as parsed: git gets the form this check read. Null otherwise. */
function fromSchemeUrl(input: string, options: CloneUrlOptions): string | null {
  const url = parseUrl(input)
  const scheme = url === null ? undefined : schemeOf(url, options)
  // The scheme must be spelled out: the parser would also read `https:host/path` as an https URL.
  if (url === null || scheme === undefined || !input.toLowerCase().startsWith(scheme)) {
    return null
  }
  return url.protocol === 'file:' || isRemote(url) ? url.href : null
}

/** The URL to give `git clone` for what the person typed (spaces around it ignored), or a GitInputError. */
export function cloneUrl(input: string, options: CloneUrlOptions = {}): string {
  const url = input.trim()
  if (url === '' || url.startsWith('-') || hasControlCharacter(input) || ENCODED_CONTROL.test(input)) {
    return refuse()
  }
  if (SCP_LIKE.test(url)) {
    return url
  }
  return fromShorthand(url) ?? fromSchemeUrl(url, options) ?? refuse()
}

/** Device names Windows reserves, with or without an extension (`nul.txt` too). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i
const MAX_NAME_LENGTH = 255
/** The code points HFS+ ignores in a name (git's `is_hfs_dotgit` skips the same ones). */
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g

/** Each rule a folder name must pass, in order, with the message for the first it fails. */
const NAME_RULES: ReadonlyArray<readonly [(name: string) => boolean, string]> = [
  [(name) => name !== '', 'Enter a name for the new folder.'],
  [(name) => name !== '.' && name !== '..', 'The folder name cannot be . or ..'],
  [(name) => !/[\\/<>:"|?*]/.test(name) && !hasControlCharacter(name), 'The folder name cannot contain / \\ < > : " | ? * or control characters.'],
  [(name) => name.length <= MAX_NAME_LENGTH, `The folder name is longer than ${MAX_NAME_LENGTH} characters.`],
  [(name) => !/[. ]$/.test(name), 'The folder name cannot end in a dot or a space.'],
  [(name) => !RESERVED.test(name.split('.')[0].trimEnd()), 'That folder name is one Windows reserves for devices.'],
  // A clone named `.git` would be the repository folder of the folder it is in; `git~1` is its short name on Windows,
  // and HFS+ ignores the invisible characters removed here, as git's own check does (CVE-2014-9390).
  [(name) => !/^(\.git|git~1)$/i.test(name.replace(HFS_IGNORED, '')), 'The folder name cannot be .git.']
]

/** Refuses a name that is not one portable folder name. */
export function checkCloneName(name: string): void {
  const failed = NAME_RULES.find(([passes]) => !passes(name))
  if (failed !== undefined) {
    throw new GitInputError(failed[1])
  }
}
