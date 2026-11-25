/**
 * DM-949: moves one canonical target branch from a prepared `oldHead` to `newHead` with an exact expected-old
 * compare-and-set, without ever changing which branch a checkout has checked out.
 *
 * A branch no worktree has checked out moves by a held `git update-ref --stdin` transaction naming its expected old
 * value. A checked-out branch moves by a held transaction on that worktree's `HEAD`, which locks both the symbolic HEAD
 * and the branch it names and verifies the branch is still at `oldHead`. While both stay locked the worktree's index
 * and files move from `oldHead` to `newHead` with `git read-tree -m -u`, and only once that git has actually exited
 * is the transaction committed (or aborted). A cancel never kills that git: killed mid-write it can leave a truncated
 * file or a stale `index.lock` that no later run can prove it caused, so a cancel is honoured before the next write
 * starts and once the running one has exited. No switch, detach, reset, stash or force checkout is ever used.
 *
 * Before moving files the transition classifies by content, never by stat, every path the commit range changes: a
 * file holding exactly its `oldHead` or exactly its `newHead` bytes (an interrupted transition restored it) is
 * accepted and the index is aligned to it; anything else, like every staged or modified tracked path outside the
 * range, is someone's work, and the transition refuses with `dirty_worktree` having changed nothing.
 */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannedLearningTarget } from '../../shared/git/learningIntegration'
import { GitError } from './errors'
import { fail, isAncestor, label, type LearningIntegrationDeps, LearningIntegrationError, read, resolveCommit, short } from './learningIntegration'
import { openRefTransaction } from './refTransaction'

/** The one deadline of a held transition (the runner's write limit, not raised), the only thing that kills a hung owned write; locks are released only after git exits. */
const TRANSITION_DEADLINE_MS = 120_000
const ABSENT = /^0+$/

interface TransitionContext {
  deps: LearningIntegrationDeps
  cardId: string
  target: PlannedLearningTarget
  signal: AbortSignal | undefined
  /** Re-validates that the recorded checkout is still the prepared repository; throws `foreign_repository`. */
  verify(): Promise<void>
}

interface Side {
  mode: string
  oid: string
}

/** One path the commit range changes, with its entry at `oldHead` and at `newHead` (`null` where absent). */
interface RangePath {
  path: string
  old: Side | null
  next: Side | null
}

type State = 'old' | 'new' | 'other'

export const interrupted = (target: PlannedLearningTarget, during: string): LearningIntegrationError =>
  new LearningIntegrationError(
    'interrupted',
    `The integration of ${label(target.repository)} was cancelled ${during}; ${target.targetRef} was left consistent at its actual commit. Run recovery to continue.`
  )

/** Where the target is now: still at `oldHead`, or already containing `newHead` (completed earlier). Anything else is refused. */
export async function targetState(deps: LearningIntegrationDeps, target: PlannedLearningTarget): Promise<'old' | 'complete'> {
  const actual = await resolveCommit(deps.runner, target.checkout, target.targetRef)
  if (actual === target.newHead) return 'complete'
  if (actual === target.oldHead) return 'old'
  if (actual !== null && (await isAncestor(deps.runner, target.checkout, target.newHead, actual))) return 'complete'
  return fail(
    'target_moved',
    `${target.targetRef} in ${label(target.repository)} is at ${actual === null ? 'no commit' : short(actual)}, neither the prepared ${short(target.oldHead)} nor a commit containing ${short(target.newHead)}. Nothing was changed; prepare the integration again.`
  )
}

/** The worktree that has the target branch checked out, or null; refuses when more than one has. */
async function checkedOutIn(ctx: TransitionContext): Promise<string | null> {
  const listed = (await read(ctx.deps.runner, ctx.target.checkout, ['worktree', 'list', '--porcelain', '-z'])).out
  const holders: string[] = []
  let path = ''
  for (const field of listed.split('\0')) {
    if (field.startsWith('worktree ')) path = field.slice('worktree '.length)
    else if (field === `branch ${ctx.target.targetRef}`) holders.push(path)
  }
  if (holders.length > 1) fail('target_moved', `${ctx.target.targetRef} is checked out in more than one worktree of ${label(ctx.target.repository)}.`)
  return holders[0] ?? null
}

const side = (mode: string, oid: string): Side | null => (ABSENT.test(oid) ? null : { mode, oid })

/** `git diff-* --raw -z` records: path → [source side, destination side, status]. */
function parseRaw(raw: string): Map<string, { from: Side | null; to: Side | null; status: string }> {
  const fields = raw.split('\0')
  const records = new Map<string, { from: Side | null; to: Side | null; status: string }>()
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [fromMode, toMode, fromOid, toOid, status] = (fields[index] as string).slice(1).split(' ')
    records.set(fields[index + 1] as string, { from: side(fromMode ?? '', fromOid ?? ''), to: side(toMode ?? '', toOid ?? ''), status: status ?? '' })
  }
  return records
}

async function rangePaths(ctx: TransitionContext): Promise<RangePath[]> {
  const { oldHead, newHead } = ctx.target
  const raw = (await read(ctx.deps.runner, ctx.target.checkout, ['diff-tree', '-r', '-z', '--no-renames', '--raw', oldHead, newHead])).out
  return [...parseRaw(raw)].map(([path, record]) => ({ path, old: record.from, next: record.to }))
}

/** The blob each listed file's bytes would be stored as (Git's filters applied), `null` when absent, `undefined` when not a plain file. */
async function fileBlobs(ctx: TransitionContext, worktree: string, paths: readonly string[]): Promise<Map<string, string | null | undefined>> {
  const blobs = new Map<string, string | null | undefined>()
  const hashable: string[] = []
  for (const path of paths) {
    const kind = fileKind(join(worktree, path))
    blobs.set(path, kind === 'absent' ? null : undefined)
    if (kind === 'file' && !path.includes('\n')) hashable.push(path)
  }
  if (hashable.length === 0) return blobs
  const hashed = await ctx.deps.runner.run({ cwd: worktree, args: ['hash-object', '--stdin-paths'], kind: 'read', stdin: `${hashable.join('\n')}\n` })
  hashed.stdout
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .forEach((oid, index) => blobs.set(hashable[index] as string, oid))
  return blobs
}

function fileKind(path: string): 'absent' | 'file' | 'other' {
  try {
    return lstatSync(path).isFile() ? 'file' : 'other'
  } catch {
    return 'absent'
  }
}

/** Which side of the range an index entry (mode and blob) or a file's bytes (blob only) is exactly. */
function stateOf(found: Side | null | undefined, path: RangePath, withMode: boolean): State {
  if (found === undefined) return 'other'
  const same = (want: Side | null): boolean => (want === null ? found === null : found !== null && found.oid === want.oid && (!withMode || found.mode === want.mode))
  if (same(path.old)) return 'old'
  return same(path.next) ? 'new' : 'other'
}

interface Classified {
  /** Paths that are someone's work: staged, modified or colliding with neither side's exact content. */
  blocking: string[]
  /** `update-index -z --index-info` records aligning each range path's index entry with its file's exact side. */
  align: string[]
}

/** Classifies the holder worktree against the range, by content; every read runs without optional locks. */
async function classify(ctx: TransitionContext, worktree: string): Promise<Classified> {
  const { runner } = ctx.deps
  const range = await rangePaths(ctx)
  const inRange = new Set(range.map((path) => path.path))
  const staged = parseRaw((await read(runner, worktree, ['diff-index', '--cached', '-z', '--no-renames', '--raw', ctx.target.oldHead, '--'])).out)
  const modified = (await read(runner, worktree, ['diff', '-z', '--name-only', '--no-renames', '--'])).out.split('\0').filter((path) => path !== '')
  const blocking = [...new Set([...staged.keys(), ...modified])].filter((path) => !inRange.has(path))
  const files = await fileBlobs(
    ctx,
    worktree,
    range.map((path) => path.path)
  )
  const align: string[] = []
  for (const path of range) {
    const record = staged.get(path.path)
    const index = record === undefined ? 'old' : record.status === 'U' ? 'other' : stateOf(record.to, path, true)
    const blob = files.get(path.path)
    const file = stateOf(blob === undefined || blob === null ? blob : { mode: '', oid: blob }, path, false)
    if (index === 'other' || file === 'other') blocking.push(path.path)
    else if (index !== file) align.push(entry(file === 'old' ? path.old : path.next, path.path))
  }
  return { blocking: blocking.sort(), align }
}

const entry = (found: Side | null, path: string): string => (found === null ? `0 ${'0'.repeat(40)}\t${path}` : `${found.mode} ${found.oid}\t${path}`)

/**
 * Runs an owned worktree write to its end and resolves (or rejects) only once git has actually exited, so the held
 * refs are never released while it may still be writing. A cancel does not kill it (see the header): it is refused
 * just before git would start and honoured once git has exited. Only the deadline kills a hung write.
 */
async function ownedWrite(ctx: TransitionContext, worktree: string, write: { args: string[]; deadline: AbortSignal; stdin?: string }): Promise<void> {
  const { args, deadline, stdin } = write
  const halt = (): void => {
    if (ctx.signal?.aborted === true || deadline.aborted) throw interrupted(ctx.target, `while ${worktree} was being updated`)
  }
  let markGone: () => void = () => undefined
  const gone = new Promise<void>((resolve) => (markGone = resolve))
  const request = { cwd: worktree, args, kind: 'write' as const, timeoutMs: null, signal: deadline, stdin, beforeStart: halt, onExit: () => markGone() }
  const failure = await ctx.deps.runner.run(request).then(
    () => null,
    (error: unknown) => error
  )
  await gone
  halt()
  if (failure === null) return
  if (failure instanceof GitError && failure.code === 'local_changes_would_be_overwritten') {
    fail('dirty_worktree', `${worktree} changed while it was being updated (${failure.detail}); nothing was moved. Commit, stash or discard those changes yourself, then run recovery.`)
  }
  throw failure
}

/** With the branch and HEAD held: the worktree still names the branch and is the prepared repository; move its files. */
async function moveWorktree(ctx: TransitionContext, worktree: string, deadline: AbortSignal): Promise<void> {
  const head = (await read(ctx.deps.runner, worktree, ['symbolic-ref', '-q', 'HEAD'], [0, 1])).out
  if (head !== ctx.target.targetRef) fail('target_moved', `${worktree} no longer has ${ctx.target.targetRef} checked out; nothing was changed.`)
  await ctx.verify()
  const classified = await classify(ctx, worktree)
  if (classified.blocking.length > 0) {
    fail(
      'dirty_worktree',
      `${worktree} has changes that are neither ${short(ctx.target.oldHead)} nor the integration's exact ${short(ctx.target.newHead)}: ${classified.blocking.join(', ')}. Nothing was changed; commit, stash or discard them yourself, then run recovery.`
    )
  }
  if (ctx.signal?.aborted === true || deadline.aborted) throw interrupted(ctx.target, 'before its worktree was updated')
  if (classified.align.length > 0) {
    await ownedWrite(ctx, worktree, { args: ['update-index', '-z', '--index-info'], deadline, stdin: `${classified.align.join('\0')}\0` })
  }
  await ownedWrite(ctx, worktree, { args: ['read-tree', '-m', '-u', ctx.target.oldHead, ctx.target.newHead], deadline })
  if (classified.align.length > 0) await ownedWrite(ctx, worktree, { args: ['update-index', '-q', '--refresh'], deadline })
}

/** A branch nobody had checked out: still the prepared repository, and still not checked out anywhere. */
async function checkUnheld(ctx: TransitionContext): Promise<void> {
  await ctx.verify()
  if ((await checkedOutIn(ctx)) !== null) fail('target_moved', `${ctx.target.targetRef} was checked out while it was being integrated; nothing was changed. Run recovery.`)
}

/** Opens the exact expected-old transaction; a refusal is explained from the target's actual state. */
async function hold(ctx: TransitionContext, gitDir: string, checkedOut: boolean) {
  const { target } = ctx
  try {
    return await openRefTransaction(ctx.deps.runner, {
      gitDir,
      message: `learning integration ${ctx.cardId} ${short(target.oldHead)}..${short(target.newHead)}`,
      noDeref: false,
      commands: [`update ${checkedOut ? 'HEAD' : target.targetRef} ${target.newHead} ${target.oldHead}`]
    })
  } catch (error) {
    if ((await targetState(ctx.deps, target)) === 'complete') return null
    const detail = error instanceof GitError ? error.detail : String(error)
    return fail(
      'locked',
      `Another Git process holds ${target.targetRef} or HEAD in ${label(target.repository)} (${detail}). Nothing was changed; run recovery once it has finished, and remove a .lock file only if no Git process is running.`
    )
  }
}

/** Moves the target from `oldHead` to `newHead`; resolves once the change is committed (or found already made). */
export async function transition(ctx: TransitionContext): Promise<void> {
  const holder = await checkedOutIn(ctx)
  const gitDir = holder === null ? ctx.target.identity.commonDir : (await read(ctx.deps.runner, holder, ['rev-parse', '--absolute-git-dir'])).out
  await ctx.verify()
  if (ctx.signal?.aborted === true) throw interrupted(ctx.target, 'before it started')
  const held = await hold(ctx, gitDir, holder !== null)
  if (held === null) return
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), TRANSITION_DEADLINE_MS)
  try {
    await (holder === null ? checkUnheld(ctx) : moveWorktree(ctx, holder, deadline.signal))
  } catch (error) {
    await held.abort()
    throw error
  } finally {
    clearTimeout(timer)
  }
  await held.commit()
}
