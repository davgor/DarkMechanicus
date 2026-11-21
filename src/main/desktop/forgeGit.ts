import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { credentialArgs, type CredentialSession } from '../git/credentials'
import { createGitRunner, type GitRunner } from '../git/runner'
import { FORGE_FILE, githubRemote, parseForge } from './forgeManifest'

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
    for (const entry of tree.split('\0').filter(Boolean)) {
      const path = entry.slice(entry.indexOf('\t') + 1).toLowerCase()
      if (path.split('/').includes('.darkmechanicus') && /\/local(?:\/|$)/.test(path)) {
        throw new Error('The Forge World contains tracked machine-private state.')
      }
      if ((path === FORGE_FILE || path.includes('/.darkmechanicus/')) && (entry.startsWith('120000 ') || entry.startsWith('160000 '))) {
        throw new Error('Ticket records must be ordinary files.')
      }
    }
  }

  private async commitTickets(root: string, eligible: (path: string) => boolean) {
    const files = (await this.run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout
    const paths = files.split('\0').filter(eligible)
    const pathspec = paths.join('\0') + '\0'
    const unresolved = async () => (await this.run(root, ['ls-files', '-u'])).stdout !== ''
    if (await unresolved()) throw new Error('Forge World has an unresolved merge.')
    // Stage only portable ticket files; preserve unrelated index entries.
    const outside = (await this.run(root, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean)
    if (outside.some(p => !eligible(p))) {
      throw new Error('Finish the separately staged changes before syncing this Forge World.')
    }
    await this.run(root, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], undefined, { stdin: pathspec })
    if ((await this.run(root, ['diff', '--cached', '--quiet'], undefined, { acceptExitCodes: [0, 1] })).code === 1) {
      const user = this.session.getAccount()?.login
      const identity = user && (await this.run(root, ['var', 'GIT_AUTHOR_IDENT'], undefined, { acceptExitCodes: [0, 128] })).code !== 0
        ? ['-c', 'user.name=' + user, '-c', 'user.email=' + user + '@users.noreply.github.com'] : []
      await this.run(root, [...identity, '--literal-pathspecs', 'commit', '--only', '-m', 'Sync Forge World ticket records', '--pathspec-from-file=-', '--pathspec-file-nul'], undefined, { stdin: pathspec })
    }
  }

  async sync(root: string, validate: () => Promise<void>) {
    const gitRoot = (await this.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (relative(gitRoot, root) !== '') throw new Error('The Forge World must be the root of its ticket repository.')
    const world = parseForge(readFileSync(join(root, FORGE_FILE), 'utf8'))
    const url = githubRemote((await this.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    const branch = (await this.run(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
    const previous = await this.run(root, ['show', 'HEAD:' + FORGE_FILE], undefined, { acceptExitCodes: [0, 128] })
    const previousProjects = previous.code === 0 ? parseForge(previous.stdout).projects : []
    const roots = [...world.projects, ...previousProjects].map(p => p.folder + '/.darkmechanicus/')
    const eligible = (path: string) => path === FORGE_FILE || roots.some(prefix =>
      path.startsWith(prefix) && /^(?:project\.json$|\.gitignore$|(?:epics|history|profiles|kanban|observations|knowledge)\/)/.test(path.slice(prefix.length)))
    await this.commitTickets(root, eligible)
    const ref = 'refs/heads/' + branch
    if ((await this.run(root, ['ls-remote', '--heads', url, ref], url)).stdout.trim()) {
      await this.run(root, ['fetch', '--no-tags', url, ref], url)
      await this.inspectTree(root, 'FETCH_HEAD')
      const base = (await this.run(root, ['merge-base', 'HEAD', 'FETCH_HEAD'])).stdout.trim()
      const outgoing = (await this.run(root, ['diff', '--name-only', '-z', base, 'HEAD'])).stdout.split('\0').filter(Boolean)
      if (outgoing.some(path => !eligible(path))) throw new Error('Publish unrelated local commits through Source control before syncing tickets.')
      await this.run(root, ['merge', '--no-edit', 'FETCH_HEAD'])
    } else {
      const history = await this.run(root, ['log', '--format=', '--name-only', '-z', 'HEAD'])
      if (history.stdout.split('\0').filter(Boolean).some(path => !eligible(path))) throw new Error('Publish this branch through Source control before enabling ticket sync.')
    }
    await this.inspectTree(root, 'HEAD')
    await validate()
    await this.run(root, ['push', url, 'HEAD:' + ref], url)
  }
}
