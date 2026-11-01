/**
 * Cloning a repository into the folder the person chose with the native dialog (kept in `userData/clone.json`),
 * never one the renderer names: a request carries only the new folder's name. The URL and the name are checked
 * first (`cloneInput`). Git then runs with `GIT_ALLOW_PROTOCOL=https:ssh`, with the signed-in account's token for a
 * GitHub HTTPS URL (as fetch does), reports progress and can be cancelled. On cancel or failure the folder the clone
 * made is removed once git is gone; a folder that was there before (it had to be empty) is never removed. A finished
 * clone is tracked.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { TrackedFolderView } from '../../shared/desktop/api'
import type { CloneRequest, GitProgressEvent } from '../../shared/git/api'
import type { FolderRegistry } from '../desktop/folderRegistry'
import { checkCloneName, cloneUrl } from './cloneInput'
import { GitError, GitInputError } from './errors'
import { progressSink } from './progress'
import { networkAuth, type NetworkDeps } from './sync'

const PARENT_FILE_VERSION = 1
const parentFileSchema = z.object({ version: z.literal(PARENT_FILE_VERSION), parent: z.string().min(1) })
/** How long a failed clone waits for git to be gone before removing its folder anyway; the runner kills git 2 s after a cancel. */
const EXIT_WAIT_MS = 10_000

const GONE = (): string => 'The folder to clone into is gone. Choose it again, or another one.'
const UNWRITABLE = (target: string): string => `${dirname(target)} cannot be written to. Choose another folder to clone into.`
/** What a failed `mkdir` of the target tells the person, by error code; anything else is unexpected. */
const CLAIM_FAILURES: Partial<Record<string, (target: string) => string>> = {
  ENOENT: GONE,
  ENOTDIR: GONE,
  EACCES: UNWRITABLE,
  EPERM: UNWRITABLE,
  EROFS: UNWRITABLE,
  ENAMETOOLONG: () => 'That folder name is too long for this disk.'
}

interface CloneParentStore {
  /** The folder clones go into; null until one is chosen, or when the file is missing or corrupt. */
  get(): string | null
  /** Shows the native folder dialog and keeps the choice; null, with the stored folder unchanged, when dismissed. */
  choose(): Promise<string | null>
}

/** The clone parent in `file` (`{ version: 1, parent }`), chosen only through `pickDirectory`, the native dialog. */
export function createCloneParentStore(options: { file: string; pickDirectory(): Promise<string | null> }): CloneParentStore {
  const { file } = options
  return {
    get: () => {
      try {
        const parsed = parentFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
        return parsed.success && isAbsolute(parsed.data.parent) ? parsed.data.parent : null
      } catch {
        return null
      }
    },
    choose: async () => {
      const picked = await options.pickDirectory()
      if (picked !== null) {
        // Written whole, then renamed into place: a crash never leaves half a file.
        const temp = `${file}.tmp`
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(temp, `${JSON.stringify({ version: PARENT_FILE_VERSION, parent: picked }, null, 2)}\n`)
        renameSync(temp, file)
      }
      return picked
    }
  }
}

interface CloneDeps extends NetworkDeps {
  parents: CloneParentStore
  registry: Pick<FolderRegistry, 'track'>
  /** Sends a progress event of a clone to the windows; its folder is the clone parent. */
  onProgress(event: GitProgressEvent): void
  /** Tests only: lets `file://` URLs (and git's `file` transport) through, to clone a local bare repository. */
  allowFileProtocol?: boolean
  /** How long cleanup waits for a cancelled git to be gone; tests shorten it. */
  exitWaitMs?: number
}

export interface Cloner {
  getParent(): string | null
  chooseParent(): Promise<string | null>
  /** Clones into `<parent>/<name>` and returns the folder, now tracked. */
  clone(request: CloneRequest): Promise<TrackedFolderView>
  /** Aborts the clone `operationId` started into `parent`, which then fails `cancelled`; false if none runs. */
  cancel(parent: string, operationId: string): boolean
}

interface CloneRun {
  source: string
  parent: string
  target: string
  /** Called once git has ended, so a later cancel finds nothing to stop. */
  gitDone(): void
  operationId: string
  signal: AbortSignal
}

/** Where a request clones from and into, refused before anything runs when the URL, name or parent will not do. */
function prepare(deps: CloneDeps, request: CloneRequest): Pick<CloneRun, 'source' | 'parent' | 'target'> {
  const source = cloneUrl(request.url, { allowFile: deps.allowFileProtocol === true })
  checkCloneName(request.name)
  const parent = deps.parents.get()
  if (parent === null) {
    throw new GitInputError('Choose the folder to clone into first.')
  }
  return { source, parent, target: join(parent, request.name) }
}

/**
 * Makes the target folder (true: this clone made it), or accepts an empty folder already there (false); anything
 * else is `target_exists`. Made here rather than by git, so a folder that appears meanwhile is never taken for ours.
 */
async function claimTarget(target: string): Promise<boolean> {
  try {
    await mkdir(target)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code !== 'EEXIST') {
      const message = CLAIM_FAILURES[code]
      throw message === undefined ? error : new GitInputError(message(target))
    }
  }
  const stats = await lstat(target)
  if (!stats.isDirectory() || (await readdir(target)).length > 0) {
    throw new GitError('target_exists', '', `${target} already exists and is not an empty folder.`)
  }
  return false
}

/** `gone` is git's `onExit`; `waited` settles once it was called, or after `limitMs` should it never be. */
function exitSignal(limitMs: number): { gone(): void; waited(): Promise<void> } {
  let gone: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    gone = resolve
  })
  return {
    gone,
    waited: async () => {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, limitMs)))])
      clearTimeout(timer)
    }
  }
}

/** Runs `git clone`. A failed run is reported once git is gone, so the cleanup after it follows git's last write. */
async function runGitClone(deps: CloneDeps, run: CloneRun): Promise<void> {
  const auth = await networkAuth(deps, run.parent, run.source)
  const exit = exitSignal(deps.exitWaitMs ?? EXIT_WAIT_MS)
  let failed: { error: unknown } | null = null
  try {
    await deps.runner.run({
      cwd: run.parent,
      args: [...auth.args, 'clone', '--progress', '--', run.source, run.target],
      kind: 'network',
      env: { ...auth.env, GIT_ALLOW_PROTOCOL: deps.allowFileProtocol === true ? 'https:ssh:file' : 'https:ssh' },
      redact: auth.redact,
      signal: run.signal,
      onProgress: progressSink((progress) => {
        deps.onProgress({ folder: run.parent, operationId: run.operationId, operation: 'clone', ...progress })
      }),
      onExit: exit.gone
    })
  } catch (error) {
    failed = { error: auth.failure(error) }
  }
  // Once git has ended, a cancel has nothing left to stop.
  run.gitDone()
  if (failed !== null) {
    await exit.waited()
    throw failed.error
  }
}

/** Clones, then tracks; on any failure removes the target if this clone made it. */
async function cloneInto(deps: CloneDeps, run: CloneRun): Promise<TrackedFolderView> {
  const created = await claimTarget(run.target)
  try {
    await runGitClone(deps, run)
    return deps.registry.track(run.target).folder
  } catch (error) {
    if (created) {
      // Best effort: a folder that cannot be removed (held open on Windows) stays, and the clone's own error is reported.
      await rm(run.target, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
    throw error
  }
}

export function createCloner(deps: CloneDeps): Cloner {
  const running = new Map<string, AbortController>()
  /**
   * Parents a clone runs in, without case (one folder on macOS and Windows). The runner runs git in a folder one at a
   * time, so a second clone there would wait unseen, cancel included; it is refused instead.
   */
  const busy = new Set<string>()
  return {
    getParent: () => deps.parents.get(),
    chooseParent: () => deps.parents.choose(),
    async clone(request) {
      const where = prepare(deps, request)
      const key = `${where.parent}\0${request.operationId}`
      const parent = where.parent.normalize('NFC').toLowerCase()
      if (busy.has(parent)) {
        throw new GitInputError(`A clone into ${where.parent} is already running. Wait for it, or cancel it.`)
      }
      // Registered before the first await, so a cancel sent right after the start still finds it.
      const controller = new AbortController()
      running.set(key, controller)
      busy.add(parent)
      const gitDone = (): void => {
        running.delete(key)
      }
      try {
        return await cloneInto(deps, { ...where, operationId: request.operationId, signal: controller.signal, gitDone })
      } finally {
        gitDone()
        busy.delete(parent)
      }
    },
    cancel(parent, operationId) {
      const controller = running.get(`${parent}\0${operationId}`)
      controller?.abort()
      return controller !== undefined
    }
  }
}
