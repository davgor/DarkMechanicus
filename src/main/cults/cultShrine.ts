/**
 * The run's Shrine in main (DM-632): `cult_publish_shrine` from the Magos or an acolyte names one file; main resolves its
 * real path and requires it inside the run's own work dir (a `..` or a symlink out of it is refused), with an allowed
 * extension (`png|jpg|jpeg|svg|html`) and at most 10 MiB, then records it at the run's next Shrine revision. A debounced
 * watch on that one file bumps the revision each time it changes, told as a run change (`cults:event`); the watch stops
 * when the file is published over, when the run ends, and on dispose. The content is served only by `shrineProtocol.ts`,
 * which checks the file again on every read.
 */
import { constants, watch as watchFs } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fail } from '../../core/errors'
import type { CultMemberView, CultRunView } from '../../shared/cults/cult'
import { SHRINE_MAX_BYTES, shrineExtension, type ShrineExtension, shrineKind, type ShrineKind } from '../../shared/cults/shrine'
import type { CultStore } from './cultStore'
import { CULT_CHANGED, type CultSupervisor } from './cultSupervisor'
import { type SupervisorClock, systemClock } from './runTimer'

/** How long the file must be quiet before a change bumps the revision: an editor's save is several writes. */
const DEBOUNCE_MS = 300

interface ResolvedShrine {
  /** The file's real path: no symlink left in it. */
  path: string
  kind: ShrineKind
}

/** Whether `path` lies strictly inside `root` (both real paths); a path on another drive is outside. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The file a Shrine may show, resolved: `path` (relative to the work dir, or absolute) through every symlink to a
 * regular file inside the work dir's own real path, with an allowed extension and at most 10 MiB; `shrine_refused` else.
 */
export async function resolveShrine(workDir: string, path: string): Promise<ResolvedShrine> {
  const root = await realpath(workDir)
  const real = await realpath(resolve(root, path)).catch(() => fail('shrine_refused', 'The Shrine file does not exist.'))
  if (!isInside(root, real)) fail('shrine_refused', 'The Shrine file is outside the run\'s work dir.')
  const kind = shrineKind(real) ?? fail('shrine_refused', 'A Shrine is a png, jpg, jpeg, svg or html file.')
  const info = await stat(real)
  if (!info.isFile()) fail('shrine_refused', 'The Shrine is not a regular file.')
  if (info.size > SHRINE_MAX_BYTES) fail('shrine_refused', 'The Shrine file is over 10 MiB.')
  return { path: real, kind }
}

/** A recorded Shrine's content as the protocol serves it. */
export interface ShrineContent {
  bytes: Uint8Array
  extension: ShrineExtension
}

/** A recorded Shrine's bytes, checked again as at publish; the stored path must still be its own real path. */
export async function readShrine(workDir: string, shrinePath: string): Promise<ShrineContent> {
  const shrine = await resolveShrine(workDir, shrinePath)
  if (shrine.path !== shrinePath) fail('shrine_refused', 'The Shrine file was replaced by a link.')
  // Opening the real path without following a link closes the gap between the check and the read on POSIX.
  const handle = await open(shrine.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > SHRINE_MAX_BYTES) fail('shrine_refused', 'The Shrine file changed while it was read.')
    const bytes = new Uint8Array(info.size)
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0)
    return { bytes: bytes.subarray(0, bytesRead), extension: shrineExtension(shrine.path) ?? fail('shrine_refused', 'Not a Shrine type.') }
  } finally {
    await handle.close()
  }
}

/** A watch on one directory; `filename` is null where the platform does not say which entry changed. */
type WatchDir = (dir: string, onChange: (filename: string | null) => void, onError: (error: unknown) => void) => { close(): void }

const watchDir: WatchDir = (dir, onChange, onError) => {
  // The directory, not the file: an editor that saves by replacing the file would end a watch on the old one.
  const watcher = watchFs(dir, { persistent: false }, (_event, filename) => onChange(filename === null ? null : String(filename)))
  watcher.on('error', onError)
  return watcher
}

interface CultShrineDeps {
  cults: Pick<CultStore, 'getRun' | 'recordShrine' | 'bumpShrine'>
  supervisor: Pick<CultSupervisor, 'on' | 'changed'>
  clock?: Pick<SupervisorClock, 'after'>
  watch?: WatchDir
  onError?: (error: unknown) => void
}

export interface CultShrines {
  /** Publishes `path` as the run's Shrine for `member`; `shrine_refused`, `run_paused` or `run_ending` when it may not. */
  publish(run: CultRunView, member: CultMemberView, path: string): Promise<{ shrinePath: string; kind: ShrineKind; revision: string }>
  /** Whether the run's published file is being watched. */
  watching(runId: string): boolean
  /** Resolves once every change check already started has finished (what a test awaits instead of a delay). */
  settled(): Promise<void>
  /** Stops every watch and stops hearing run changes. */
  dispose(): void
}

/** One run's watch on its published file. */
interface Watch {
  path: string
  /** The file as last told: modified time, size and inode; a change event that leaves it alike tells nothing. */
  signature: string | null
  watcher: { close(): void }
  cancelDebounce: () => void
}

interface State {
  deps: CultShrineDeps
  clock: Pick<SupervisorClock, 'after'>
  watch: WatchDir
  onError: (error: unknown) => void
  watches: Map<string, Watch>
  /** Change checks in flight. */
  checks: Set<Promise<void>>
}

async function signatureOf(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  return info === null ? null : `${info.mtimeMs}:${info.size}:${info.ino}`
}

function stop(s: State, runId: string): void {
  const current = s.watches.get(runId)
  if (current === undefined) return
  s.watches.delete(runId)
  current.cancelDebounce()
  current.watcher.close()
}

/** The file went quiet: a real change of the file bumps the revision and is told as a run change. */
async function settleChange(s: State, runId: string, entry: Watch): Promise<void> {
  const signature = await signatureOf(entry.path)
  if (s.watches.get(runId) !== entry || signature === entry.signature) return
  entry.signature = signature
  if (s.deps.cults.bumpShrine(runId, entry.path) !== null) s.deps.supervisor.changed(runId)
}

function startWatch(s: State, runId: string, path: string, signature: string | null): void {
  stop(s, runId)
  const name = basename(path)
  const entry: Watch = { path, signature, watcher: { close: () => {} }, cancelDebounce: () => {} }
  entry.watcher = s.watch(dirname(path), (filename) => {
    if (filename !== null && filename !== name) return
    entry.cancelDebounce()
    entry.cancelDebounce = s.clock.after(() => {
      const check = settleChange(s, runId, entry).catch(s.onError).finally(() => s.checks.delete(check))
      s.checks.add(check)
    }, DEBOUNCE_MS)
  }, s.onError)
  s.watches.set(runId, entry)
}

async function publish(s: State, run: CultRunView, member: CultMemberView, path: string) {
  if (run.state === 'paused') fail('run_paused', 'The cult run is paused.')
  if (run.state === 'ended') fail('run_ending', 'The cult run has ended.')
  const shrine = await resolveShrine(run.workDir, path)
  const signature = await signatureOf(shrine.path)
  const recorded = s.deps.cults.recordShrine(run.id, { path: shrine.path, memberName: member.displayName })
  startWatch(s, run.id, shrine.path, signature)
  // The run may have ended while the file was checked: its end was told before this watch existed.
  if (s.deps.cults.getRun(run.id)?.state === 'ended') stop(s, run.id)
  return { shrinePath: shrine.path, kind: shrine.kind, revision: recorded.shrineRevision ?? '' }
}

export function createCultShrines(deps: CultShrineDeps): CultShrines {
  const s: State = { deps, clock: deps.clock ?? systemClock, watch: deps.watch ?? watchDir, onError: deps.onError ?? (() => {}), watches: new Map(), checks: new Set() }
  const unsubscribe = deps.supervisor.on(CULT_CHANGED, (snapshot) => {
    if (snapshot.run.state === 'ended') stop(s, snapshot.run.id)
  })
  return {
    publish: (run, member, path) => publish(s, run, member, path),
    watching: (runId) => s.watches.has(runId),
    settled: async () => {
      await Promise.all(s.checks)
    },
    dispose: () => {
      unsubscribe()
      for (const runId of s.watches.keys()) stop(s, runId)
    }
  }
}
