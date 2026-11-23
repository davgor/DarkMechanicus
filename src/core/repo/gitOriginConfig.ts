import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { nodeFs } from './nodeFs'

const MAX_CONFIG_BYTES = 1024 * 1024
const WINDOWS_GIT_DIRECTORY = /[\\/](?:mingw32|mingw64|ucrt64|clangarm64)[\\/](?:bin|libexec[\\/]git-core)$/i
const NATIVE_HEADERS = new Set([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca])
const AMBIGUOUS_PATH = /["']|(?:^|[\\/])\.\.?([\\/]|$)/

type RunGit = (args: string[]) => { code: number; stdout: string }

function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

function nativePosixGit(path: string): boolean {
  accessSync(path, constants.X_OK)
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    return readSync(fd, header) === header.length && NATIVE_HEADERS.has(header.readUInt32BE())
  } finally { closeSync(fd) }
}

function unambiguousWindowsPath(directory: string, cwd: string): boolean {
  return /^[a-z]:[\\/]/i.test(directory) &&
    ![join(cwd, 'git.com'), join(cwd, 'git.exe'), join(directory, 'git.com')].some(present)
}

function firstNativeGit(path: string, cwd: string): { path: string; stamp: string } | null {
  const directory = path.split(delimiter)[0]
  if (!isAbsolute(directory) || AMBIGUOUS_PATH.test(directory)) return null
  const windows = process.platform === 'win32'
  const executable = join(directory, windows ? 'git.exe' : 'git')
  if (windows && !unambiguousWindowsPath(directory, cwd)) return null
  const stamp = nodeFs.fileStamp(executable)
  if (stamp === null) return null
  const canonical = realpathSync.native(executable)
  const native = windows ? WINDOWS_GIT_DIRECTORY.test(dirname(canonical)) : nativePosixGit(canonical)
  return native ? { path: canonical, stamp } : null
}

export function gitOriginContext(env: NodeJS.ProcessEnv) {
  const pathKeys = Object.keys(env).filter(key => key.toUpperCase() === 'PATH')
  let cwd = ''
  let executable: ReturnType<typeof firstNativeGit> = null
  try {
    cwd = process.cwd()
    if (pathKeys.length === 1 && !Object.keys(env).some(key => key.toUpperCase() === 'GIT_CONFIG')) {
      executable = firstNativeGit(env[pathKeys[0]] ?? '', cwd)
    }
  } catch { /* Any ambiguity uses the original Git commands. */ }
  const key = createHash('sha256').update(JSON.stringify([cwd, executable, Object.entries(env).sort()])).digest('hex')
  return { key, executable: executable?.path ?? null }
}

function configBytes(path: string): string | null {
  const stamp = nodeFs.fileStamp(path)
  if (stamp === null) return null
  const file = lstatSync(path, { bigint: true })
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.ino !== file.ino || opened.dev !== file.dev || opened.size > MAX_CONFIG_BYTES) return null
    const bytes = Buffer.alloc(Number(opened.size) + 1)
    const size = readSync(fd, bytes)
    if (size !== Number(opened.size) || nodeFs.fileStamp(path) !== stamp) return null
    return `${stamp}:${createHash('sha256').update(bytes.subarray(0, size)).digest('hex')}`
  } finally { closeSync(fd) }
}

function configProof(root: string): string | null {
  const git = join(root, '.git')
  try {
    const stat = lstatSync(git, { bigint: true, throwIfNoEntry: false })
    if (stat?.isDirectory() !== true || present(join(git, 'commondir')) || present(join(git, 'config.worktree'))) return null
    const config = configBytes(join(git, 'config'))
    return config === null ? null : `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${config}`
  } catch { return null }
}

function ordinaryDiscovery(root: string, run: RunGit): boolean {
  const result = run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--git-path', 'config'])
  const git = join(root, '.git')
  const expected = [root, git, git, join(git, 'config')]
  const reported = result.stdout.trim().split(/\r?\n/)
  if (result.code !== 0 || reported.length !== expected.length) return false
  try { return reported.every((path, index) => realpathSync.native(path.trim()) === expected[index]) }
  catch { return false }
}

export function queryLocalGitOrigin(run: RunGit): string | null {
  const origin = run(['config', '--local', '--no-includes', '--get-all', 'remote.origin.url'])
  const urls = origin.stdout.trim().split(/\r?\n/)
  return origin.code === 0 && urls.length === 1 && urls[0] !== '' ? urls[0] : null
}

interface ProofLookup {
  initial: ReturnType<typeof gitOriginContext>
  contextNow(): ReturnType<typeof gitOriginContext>
  run: RunGit
  fallback(): string | null
}

/** Short-lived positive config receipts. Discovery and ownership always come from live Git. */
export class LocalGitOriginConfigCache {
  private readonly proofs = new Map<string, { config: string; context: string; origin: string }>()

  constructor(private readonly normalize: (origin: string) => string) {}

  read(root: string, { initial, contextNow, run, fallback }: ProofLookup): string | null {
    if (initial.executable === null) return fallback()
    const config = configProof(root)
    if (config === null || !ordinaryDiscovery(root, run)) return fallback()
    const current = () => configProof(root) === config && contextNow().key === initial.key
    if (!current()) return fallback()
    const previous = this.proofs.get(root)
    if (previous?.config === config && previous.context === initial.key) return previous.origin
    const origin = queryLocalGitOrigin(run)
    if (!current()) return fallback()
    if (origin === null) return null
    const normalized = this.normalize(origin)
    this.proofs.set(root, { config, context: initial.key, origin: normalized })
    return normalized
  }
}
