import { lstatSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { credentialArgs, type CredentialSession } from '../git/credentials'
import { createGitRunner, type GitRunner } from '../git/runner'
import { ensureForgeDirections, FORGE_DIRECTIONS } from './forgeDirections'
import { FORGE_FILE, githubRemote, parseForge } from './forgeManifest'

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

export class ForgeGit {
  constructor(private readonly session: CredentialSession, private readonly runner: GitRunner = createGitRunner()) {}

  run(root: string, args: string[], url?: string, options: { acceptExitCodes?: number[]; stdin?: string } = {}) {
    const credentials = url ? credentialArgs(url, this.session) : null
    return this.runner.run({ cwd: root, kind: url ? 'network' : 'write', args: [
      '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      ...(credentials?.args ?? []), ...args
    ], stdin: options.stdin, env: credentials?.env, redact: credentials?.secrets, acceptExitCodes: options.acceptExitCodes })
  }

  async inspectTree(root: string, ref: string) {
    const tree = (await this.run(root, ['ls-tree', '-r', '-z', ref])).stdout
    inspectEntries(tree)
  }

  /** Check imported/staged data before anything treats local hints as machine-owned. */
  async inspectCheckout(root: string): Promise<void> {
    const [head, index] = await Promise.all([
      this.run(root, ['rev-parse', '--verify', 'HEAD'], undefined, { acceptExitCodes: [0, 128] }),
      this.run(root, ['ls-files', '--stage', '-z'])
    ])
    inspectEntries(index.stdout)
    if (head.code === 0) await this.inspectTree(root, 'HEAD')
  }

  private async inspectOutgoing(root: string, range: string) {
    const history = (await this.run(root, ['log', '--format=', '--name-only', '--no-renames', '-z', range])).stdout
    if (history.split('\0').some(path => privateState(path.trimStart()))) {
      throw new Error('The Forge World has machine-private state in outgoing history. Remove it from the unpublished commits before syncing.')
    }
  }

  private async commitRepository(root: string) {
    const unresolved = (await this.run(root, ['ls-files', '-u'])).stdout !== ''
    if (unresolved) throw new Error('Forge World has an unresolved merge.')
    // A Forge World is its own repository: sync includes its documentation and
    // every portable project file, including formats added after this client.
    // Private state is never publishable, even if someone force-staged it.
    inspectEntries((await this.run(root, ['ls-files', '--stage', '-z'])).stdout)
    const files = (await this.run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout
    const paths = files.split('\0').filter(path => path !== '' && !privateState(path))
    const pathspec = paths.join('\0') + '\0'
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
    if (main.code === 0) await this.run(root, ['merge', '--no-edit', prior])
  }

  async sync(root: string, validate: () => Promise<void>) {
    const gitRoot = (await this.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (relative(gitRoot, root) !== '') throw new Error('The Forge World must be the root of its ticket repository.')
    parseForge(readFileSync(join(root, FORGE_FILE), 'utf8'))
    const url = githubRemote((await this.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    await this.ensureMain(root)
    if ((await this.run(root, ['rev-parse', '--verify', 'HEAD'], undefined, { acceptExitCodes: [0, 128] })).code === 0) await this.inspectTree(root, 'HEAD')
    ensureForgeDirections(root)
    await this.commitRepository(root)
    const ref = 'refs/heads/main'
    if ((await this.run(root, ['ls-remote', '--heads', url, ref], url)).stdout.trim()) {
      await this.run(root, ['fetch', '--no-tags', url, ref], url)
      await this.inspectTree(root, 'FETCH_HEAD')
      await this.inspectOutgoing(root, 'FETCH_HEAD..HEAD')
      await this.run(root, ['merge', '--no-edit', 'FETCH_HEAD'])
    } else {
      await this.inspectOutgoing(root, 'HEAD')
    }
    await this.inspectTree(root, 'HEAD')
    await validate()
    // Reconciliation/health upgrades can create portable records after merging.
    // Include those writes in this same sync rather than leaving them behind.
    await this.commitRepository(root)
    await this.inspectTree(root, 'HEAD')
    await this.run(root, ['push', url, 'HEAD:' + ref], url)
  }
}
