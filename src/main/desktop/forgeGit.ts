import { lstatSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { RenameRetryNote } from '../../core/repo/forgeManifest'
import { credentialArgs, type CredentialSession } from '../git/credentials'
import { createGitRunner, type GitRunner } from '../git/runner'
import { ensureForgeDirections, FORGE_DIRECTIONS } from './forgeDirections'
import { FORGE_FILE, githubRemote, parseForge } from './forgeManifest'

const MAIN_REF = 'refs/heads/main'

function privateState(path: string): boolean {
  return /(?:^|\/)\.darkmechanicus\/local(?:\/|$)/i.test(path)
}

function inspectEntries(entries: string): void {
  for (const entry of entries.split('\0').filter(Boolean)) {
    const path = entry.slice(entry.indexOf('\t') + 1).toLowerCase()
    if (privateState(path)) throw new Error('The Forge World contains tracked machine-private state.')
    if ((path === FORGE_FILE || path === FORGE_DIRECTIONS.toLowerCase() || /(?:^|\/)\.darkmechanicus(?:\/|$)/.test(path)) && (entry.startsWith('120000 ') || entry.startsWith('160000 '))) {
      throw new Error('Ticket records and repository directions must be ordinary files.')
    }
  }
}

/** The stage of a `ls-files --stage` entry, `<mode> <object> <stage>\t<path>`: 0 when merged, 1 to 3 while unmerged. */
const STAGE = /^[0-7]+ [0-9a-f]+ ([0-3])\t/

/**
 * `ls-files -t --stage --others --exclude-standard -z`, read as the index (unmerged entries refused, every entry
 * inspected) and the paths a commit stages: tracked and untracked, without machine-private state. `-t` tags each
 * untracked path `? ` and each index entry with another letter, so neither is read as the other.
 */
function commitCandidates(listing: string): string[] {
  const index: string[] = []
  const paths: string[] = []
  for (const tagged of listing.split('\0').filter(Boolean)) {
    const entry = tagged.slice(2)
    if (tagged.startsWith('? ')) {
      paths.push(entry)
      continue
    }
    if (STAGE.exec(entry)?.[1] !== '0') throw new Error('Forge World has an unresolved merge.')
    index.push(entry)
    paths.push(entry.slice(entry.indexOf('\t') + 1))
  }
  // A Forge World is its own repository: sync includes its documentation and
  // every portable project file, including formats added after this client.
  // Private state is never publishable, even if someone force-staged it.
  inspectEntries(index.join('\0'))
  return paths.filter(path => !privateState(path))
}

/**
 * What a check of a Forge World checkout established, reused by the rest of one sync instead of asking git again: the
 * check confirmed the folder is its repository's root and on `main`, and inspected the index and HEAD's tree.
 */
export interface WorldCheckout {
  /** The origin's GitHub repository URL. */
  url: string
  /** Commits whose trees were inspected. A commit's tree never changes, so each is inspected once. */
  inspected: Set<string>
}

/**
 * Passed on each command, never written to a config: git's automatic maintenance after a commit, fetch or push
 * (packing loose objects, repacking) finishes before the command returns. Detached, it went on in the background and
 * changed `.git/objects` between the two reads of a checkout's metadata that provisioning compares
 * (`forgeProvisioningWork.ts` `readOrigin`), which failed the creation as "metadata changed" on a loaded machine.
 */
export const FORGE_GIT_MAINTENANCE = ['-c', 'maintenance.autoDetach=false', '-c', 'gc.autoDetach=false'] as const

export class ForgeGit {
  /** `onRenameRetry` is told of each busy directions rename that is asked again (the main process logs it). */
  constructor(private readonly session: CredentialSession, private readonly runner: GitRunner = createGitRunner(), private readonly onRenameRetry?: RenameRetryNote) {}

  run(root: string, args: string[], url?: string, options: { acceptExitCodes?: number[]; stdin?: string; beforeStart?: () => void } = {}) {
    const credentials = url ? credentialArgs(url, this.session) : null
    return this.runner.run({ cwd: root, kind: url ? 'network' : 'write', args: [
      '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...FORGE_GIT_MAINTENANCE,
      ...(credentials?.args ?? []), ...args
    ], stdin: options.stdin, env: credentials?.env, redact: credentials?.secrets, acceptExitCodes: options.acceptExitCodes, beforeStart: options.beforeStart })
  }

  async inspectTree(root: string, ref: string) {
    const tree = (await this.run(root, ['ls-tree', '-r', '-z', ref])).stdout
    inspectEntries(tree)
  }

  /** Check imported/staged data before anything treats local hints as machine-owned. HEAD's commit joins `inspected`. */
  async inspectCheckout(root: string, inspected = new Set<string>()): Promise<void> {
    const [, index] = await Promise.all([this.inspectHead(root, inspected), this.run(root, ['ls-files', '--stage', '-z'])])
    inspectEntries(index.stdout)
  }

  /** Inspects HEAD's tree unless its commit is in `inspected`; nothing while HEAD is unborn. */
  private async inspectHead(root: string, inspected: Set<string>): Promise<void> {
    const head = await this.run(root, ['rev-parse', '--verify', 'HEAD'], undefined, { acceptExitCodes: [0, 128] })
    if (head.code === 0) await this.inspectCommit(root, head.stdout.trim(), inspected)
  }

  /** Inspects the tree of `commit` (a full commit id) unless it is in `inspected`. */
  private async inspectCommit(root: string, commit: string, inspected: Set<string>): Promise<void> {
    if (inspected.has(commit)) return
    await this.inspectTree(root, commit)
    inspected.add(commit)
  }

  private async inspectOutgoing(root: string, range: string) {
    const history = (await this.run(root, ['log', '--format=', '--name-only', '--no-renames', '-z', range])).stdout
    if (history.split('\0').some(path => privateState(path.trimStart()))) {
      throw new Error('The Forge World has machine-private state in outgoing history. Remove it from the unpublished commits before syncing.')
    }
  }

  private async commitRepository(root: string) {
    const listing = (await this.run(root, ['ls-files', '-t', '--stage', '--others', '--exclude-standard', '-z'])).stdout
    const pathspec = commitCandidates(listing).join('\0') + '\0'
    await this.run(root, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], undefined, { stdin: pathspec })
    inspectEntries((await this.run(root, ['ls-files', '--stage', '-z'])).stdout)
    const changed = (await this.run(root, ['diff', '--cached', '--quiet'], undefined, { acceptExitCodes: [0, 1] })).code === 1
    const merging = !changed && (await this.run(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], undefined, { acceptExitCodes: [0, 1] })).code === 0
    if (changed || merging) {
      const user = this.session.getAccount()?.login
      const identity = user && (await this.run(root, ['var', 'GIT_AUTHOR_IDENT'], undefined, { acceptExitCodes: [0, 128] })).code !== 0
        ? ['-c', 'user.name=' + user, '-c', 'user.email=' + user + '@users.noreply.github.com'] : []
      await this.run(root, [...identity, 'commit', '-m', 'Sync Forge World repository'])
    }
  }

  /** Keep the dedicated ticket repository on main while retaining all off-branch work. */
  async ensureMain(root: string): Promise<void> {
    const branch = await this.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, { acceptExitCodes: [0, 1] })
    if (branch.stdout.trim() === 'main') return
    const gitRoot = (await this.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (relative(gitRoot, root) !== '') throw new Error('The Forge World must be the root of its ticket repository.')
    const manifest = lstatSync(join(root, FORGE_FILE))
    if (!manifest.isFile() || manifest.isSymbolicLink()) throw new Error('Invalid Forge World manifest.')
    parseForge(readFileSync(join(root, FORGE_FILE), 'utf8'))
    await this.inspectCheckout(root)
    await this.commitRepository(root)
    const prior = (await this.run(root, ['rev-parse', 'HEAD'])).stdout.trim()
    const main = await this.run(root, ['show-ref', '--verify', '--quiet', 'refs/heads/main'], undefined, { acceptExitCodes: [0, 1] })
    await this.run(root, main.code === 0 ? ['switch', 'main'] : ['switch', '-c', 'main'])
    if (main.code === 0) await this.run(root, ['merge', '--no-edit', '-m', 'Recover off-main Forge World work into main', prior])
  }

  /** What a sync checks first when no Forge World check just did: the root, the manifest, the origin and `main`. */
  private async checkSyncTarget(root: string): Promise<WorldCheckout> {
    const gitRoot = (await this.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (relative(gitRoot, root) !== '') throw new Error('The Forge World must be the root of its ticket repository.')
    parseForge(readFileSync(join(root, FORGE_FILE), 'utf8'))
    const url = githubRemote((await this.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    await this.ensureMain(root)
    return { url, inspected: new Set() }
  }

  /**
   * Fetches main from origin and merges it, after inspecting its tree and the history this checkout would publish.
   * Returns HEAD's commit before the merge and the range of unpublished history. Leaves the index and HEAD's tree inspected.
   */
  private async mergeOrigin(root: string, url: string, inspected: Set<string>): Promise<{ local: string; range: string }> {
    const hasUpstream = (await this.run(root, ['ls-remote', '--heads', url, MAIN_REF], url)).stdout.trim() !== ''
    if (hasUpstream) await this.run(root, ['fetch', '--no-tags', url, MAIN_REF], url)
    const [local = '', upstream] = (await this.run(root, ['rev-parse', 'HEAD', ...(hasUpstream ? ['FETCH_HEAD'] : [])])).stdout.trim().split(/\s+/)
    const range = upstream === undefined ? '' : upstream + '..'
    if (upstream !== undefined) await this.inspectCommit(root, upstream, inspected)
    // Reject private unpublished history before opening a merge or invoking validation.
    await this.inspectOutgoing(root, range + local)
    if (upstream === undefined) {
      // The commit before this inspected the index it left, and HEAD is `local`.
      await this.inspectCommit(root, local, inspected)
    } else {
      await this.run(root, ['merge', '--no-edit', '-m', 'Merge remote main into Forge World main', upstream])
      await this.inspectCheckout(root, inspected)
    }
    return { local, range }
  }

  /**
   * Commits, merges main from origin and publishes. `checked` is a Forge World check made just before (its root, origin
   * and `main` are reused, and the trees it inspected are not inspected again); without one the sync checks them
   * itself. `validate` gets the checkout as the merge left it, its index and HEAD's tree inspected, for the check it
   * runs to reuse.
   */
  async sync(root: string, validate: (checkout: WorldCheckout) => Promise<void>, beforePush?: () => void, checked?: WorldCheckout) {
    if (checked !== undefined) parseForge(readFileSync(join(root, FORGE_FILE), 'utf8'))
    const { url, inspected } = checked ?? await this.checkSyncTarget(root)
    await this.inspectHead(root, inspected)
    ensureForgeDirections(root, this.onRenameRetry)
    await this.commitRepository(root)
    const { local, range } = await this.mergeOrigin(root, url, inspected)
    await validate({ url, inspected })
    // Reconciliation/health upgrades can create portable records after merging.
    // Include those writes in this same sync rather than leaving them behind.
    await this.commitRepository(root)
    // Pin the checked object: another local commit may arrive while the network runner queues the push.
    const revision = (await this.run(root, ['rev-parse', 'HEAD'])).stdout.trim()
    await this.inspectCommit(root, revision, inspected)
    if (revision !== local) await this.inspectOutgoing(root, range + revision)
    beforePush?.()
    await this.run(root, ['push', url, revision + ':' + MAIN_REF], url, { beforeStart: beforePush })
  }
}
