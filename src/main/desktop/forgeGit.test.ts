import { gatedRunner } from '../../test/gatedRunner'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { seedForgeFixture } from '../../test/forgeFixture'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createGitRunner, type GitRunner } from '../git/runner'
import { ForgeGit } from './forgeGit'
import { createForge, githubRemote, parseForge } from './forgeManifest'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

function repositoryPair() {
  const scratch = scratchDir('forge-git-')
  cleanups.push(scratch.cleanup)
  const root = scratch.path
  const bare = join(root, 'origin.git')
  const first = join(root, 'one')
  const second = join(root, 'two')
  gitIn(root, 'init', '--bare', '--initial-branch=main', bare)
  gitIn(root, 'clone', bare, first)
  const url = 'https://github.com/tester/tickets.git'
  const real = createGitRunner()
  const runner: GitRunner = {
    run: request => request.kind !== 'network' ? real.run(request) : real.run({ ...request, args: [
      '-c', 'url.' + pathToFileURL(bare).href + '.insteadOf=' + url,
      ...request.args.map(a => a === 'protocol.allow=never' ? 'protocol.file.allow=always' : a)
    ] })
  }
  const client = new ForgeGit({ getAccount: () => null, getToken: () => null }, runner)
  const setup = (cwd: string) => {
    gitIn(cwd, 'remote', 'set-url', 'origin', url)
    gitIn(cwd, 'config', 'user.email', 'forge@example.test')
    gitIn(cwd, 'config', 'user.name', 'Forge Test')
  }
  setup(first)
  return { root, bare, first, second, client, setup, runner }
}

function portableFiles(first: string) {
  seedForgeFixture(first, 'tester', [{ folder: 'Demo', repository: 'tester/Demo' }])
  const store = join(first, 'Demo', '.darkmechanicus')
  mkdirSync(join(store, 'local'), { recursive: true })
  writeFileSync(join(store, '.gitignore'), 'local/\n')
  writeFileSync(join(store, 'project.json'), '{}')
  writeFileSync(join(store, 'local', 'state.sqlite'), 'private')
  const recovered = join(store, 'recovered-attachments', 'im_example')
  mkdirSync(recovered, { recursive: true })
  const attachment = Buffer.from([0, 255, 17, 200, 10])
  writeFileSync(join(recovered, 'evidence.png'), attachment)
  writeFileSync(join(recovered, 'metadata.json'), '{"id":"im_example","attemptId":"at_missing"}')
  writeFileSync(join(first, '.gitignore'), 'scratch.txt\n')
  writeFileSync(join(first, 'scratch.txt'), 'ignored')
  writeFileSync(join(first, 'README.md'), 'World directions')
  writeFileSync(join(first, 'notes.txt'), 'World notes')
  writeFileSync(join(first, 'Demo', 'SETUP.md'), 'Clone code when needed')
  writeFileSync(join(first, 'Demo', 'obsolete.md'), 'Remove after first sync')
  gitIn(first, 'add', 'README.md')
  return { store, attachment }
}

it('rejects ambiguous project folders and credential-bearing clone URLs', () => {
  expect(() => githubRemote('https://user:password@github.com/owner/repo')).toThrow()
  const data = { version: 1, owner: 'tester', syncMinutes: 5, projects: ['Alpha', 'alpha'].map(folder => ({ folder, repository: 'user/repo' })) }
  expect(() => parseForge(JSON.stringify(data))).toThrow('Duplicate')
  data.projects[0].folder = '../outside'
  expect(() => parseForge(JSON.stringify(data))).toThrow()
})

it('syncs every repository file, recovered attachment and deletion between real checkouts while excluding private and ignored files', async () => {
  const { root, bare, first, second, client, setup } = repositoryPair()
  const { store, attachment } = portableFiles(first)
  await client.sync(first, async () => undefined)
  gitIn(root, 'clone', bare, second)
  setup(second)
  expect(gitIn(second, 'ls-files')).not.toMatch(/state.sqlite|scratch.txt/)
  expect(readFileSync(join(second, 'notes.txt'), 'utf8')).toBe('World notes')
  expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('World directions')
  expect(readFileSync(join(second, 'Demo', 'SETUP.md'), 'utf8')).toBe('Clone code when needed')
  expect(readFileSync(join(second, 'Demo/.darkmechanicus/recovered-attachments/im_example/evidence.png'))).toEqual(attachment)
  expect(readFileSync(join(second, 'Demo/.darkmechanicus/recovered-attachments/im_example/metadata.json'), 'utf8')).toBe('{"id":"im_example","attemptId":"at_missing"}')
  expect(existsSync(join(second, 'FORGE-REPOSITORIES.md'))).toBe(true)
  writeFileSync(join(second, 'Demo/.darkmechanicus/project.json'), '{"changed":true}')
  writeFileSync(join(second, 'notes.txt'), 'Updated notes')
  unlinkSync(join(second, 'Demo', 'obsolete.md'))
  gitIn(second, 'add', 'notes.txt')
  gitIn(second, 'commit', '-m', 'Update world notes independently')
  await client.sync(second, async () => undefined)
  await client.sync(first, async () => undefined)
  expect(readFileSync(join(store, 'project.json'), 'utf8')).toBe('{"changed":true}')
  expect(readFileSync(join(first, 'notes.txt'), 'utf8')).toBe('Updated notes')
  expect(existsSync(join(first, 'Demo', 'obsolete.md'))).toBe(false)
})

it.each(['post-reconcile inspection', 'queued push'] as const)(
  'keeps local commits without publishing when the workspace closes during %s', async (boundary) => {
    const { first, bare, client, runner } = repositoryPair()
    createForge(first, 'tester')
    await client.sync(first, async () => undefined)
    const original = gitIn(bare, 'rev-parse', 'main')
    let validated = false
    let tracked = true
    const gated = gatedRunner(runner, ({ args }) => validated && args.includes(boundary === 'queued push' ? 'push' : 'ls-tree'))
    const workspace = new ForgeGit({ getAccount: () => null, getToken: () => null }, gated)
    const sync = workspace.sync(first, async () => {
      writeFileSync(join(first, 'post-import.txt'), 'Keep this local commit')
      validated = true
    }, () => {
      if (!tracked) throw new Error('The Forge World was untracked before publishing.')
    })
    try {
      expect(await Promise.race([gated.reached.then(() => true), sync.then(() => false)])).toBe(true)
      expect(gitIn(first, 'show', 'HEAD:post-import.txt')).toBe('Keep this local commit')
      tracked = false
    } finally {
      gated.release()
    }
    await expect(sync).rejects.toThrow('untracked before publishing')
    expect(gitIn(bare, 'rev-parse', 'main')).toBe(original)
  }
)

it('does not overwrite a peer that advances main after the fetch and publishes both histories next sync', async () => {
  const { root, bare, first, second, client, setup, runner } = repositoryPair()
  createForge(first, 'tester')
  const validate = async () => undefined
  await client.sync(first, validate)
  gitIn(root, 'clone', bare, second)
  setup(second)
  const gated = gatedRunner(runner, ({ args }) => args.includes('push'))
  const syncer = new ForgeGit({ getAccount: () => null, getToken: () => null }, gated)
  writeFileSync(join(first, 'local.txt'), 'Keep local work')
  const syncing = syncer.sync(first, validate)
  let local = '', remote = ''
  try {
    expect(await Promise.race([gated.reached.then(() => true), syncing.then(() => false)])).toBe(true)
    local = gitIn(first, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(second, 'remote.txt'), 'Keep peer work')
    gitIn(second, 'add', 'remote.txt')
    gitIn(second, 'commit', '-m', 'Peer publishes while the first push waits')
    gitIn(second, 'push', bare, 'main')
    remote = gitIn(second, 'rev-parse', 'HEAD').trim()
  } finally { gated.release() }
  await expect(syncing).rejects.toThrow(/rejected|fetch first/i)
  expect(gitIn(first, 'rev-parse', 'HEAD').trim()).toBe(local)
  expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(remote)
  await client.sync(first, validate)
  expect(gitIn(bare, 'rev-list', '--parents', '-n', '1', 'main').trim().split(' ').slice(1)).toEqual([local, remote])
  expect(gitIn(bare, 'show', 'main:local.txt')).toBe('Keep local work')
  expect(gitIn(bare, 'show', 'main:remote.txt')).toBe('Keep peer work')
})

it('publishes only the inspected commit when HEAD changes before Git starts the push', async () => {
  const { bare, first, client, runner } = repositoryPair()
  createForge(first, 'tester')
  await client.sync(first, async () => undefined)
  writeFileSync(join(first, 'inspected.txt'), 'Ready for publication')
  const gated = gatedRunner(runner, ({ args }) => args.includes('push'))
  const syncer = new ForgeGit({ getAccount: () => null, getToken: () => null }, gated)
  const syncing = syncer.sync(first, async () => undefined)
  let inspected = ''
  try {
    expect(await Promise.race([gated.reached.then(() => true), syncing.then(() => false)])).toBe(true)
    inspected = gitIn(first, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(first, 'late.txt'), 'Concurrent local work')
    gitIn(first, 'add', 'late.txt')
    gitIn(first, 'commit', '-m', 'Concurrent local commit')
  } finally { gated.release() }
  await syncing
  expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(inspected)
  expect(gitIn(first, 'show', 'HEAD:late.txt')).toBe('Concurrent local work')
  expect(gitIn(bare, 'ls-tree', 'main', 'late.txt')).toBe('')
})

it('rejects machine-private outgoing history before opening a merge for a resolver', async () => {
  const { root, bare, first, second, client, setup } = repositoryPair()
  createForge(first, 'tester')
  writeFileSync(join(first, 'README.md'), 'Originally shared\n')
  await client.sync(first, async () => undefined)
  gitIn(root, 'clone', bare, second)
  setup(second)
  writeFileSync(join(second, 'README.md'), 'Peer main\n')
  await client.sync(second, async () => undefined)
  const published = gitIn(bare, 'rev-parse', 'main')

  const privatePath = '.darkmechanicus/local/fixture.txt'
  mkdirSync(join(first, '.darkmechanicus', 'local'), { recursive: true })
  writeFileSync(join(first, privatePath), 'Disposable private fixture')
  gitIn(first, 'add', '-f', privatePath)
  gitIn(first, 'commit', '-m', 'Accidentally commit nonportable test data')
  gitIn(first, 'rm', privatePath)
  gitIn(first, 'commit', '-m', 'Remove fixture from current tree only')
  writeFileSync(join(first, 'README.md'), 'Unpublished local edit\n')
  await expect(client.sync(first, async () => undefined)).rejects.toThrow('machine-private')
  expect(gitIn(first, 'ls-files', '-u')).toBe('')
  expect(gitIn(first, 'show', 'HEAD:README.md')).toBe('Unpublished local edit\n')
  expect(gitIn(bare, 'rev-parse', 'main')).toBe(published)
})

it('recovers a world branch onto main without losing either branch or publishing an extra branch', async () => {
  const { bare, first, client } = repositoryPair()
  createForge(first, 'tester')
  await client.sync(first, async () => undefined)
  gitIn(first, 'switch', '-c', 'accidental')
  writeFileSync(join(first, 'branch.txt'), 'Committed branch work')
  gitIn(first, 'add', 'branch.txt')
  gitIn(first, 'commit', '-m', 'Preserve branch work')
  const preserved = gitIn(first, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(first, 'uncommitted.txt'), 'Pending portable work')
  await client.sync(first, async () => undefined)
  expect(gitIn(first, 'branch', '--show-current').trim()).toBe('main')
  expect(gitIn(first, 'merge-base', '--is-ancestor', preserved, 'main')).toBe('')
  expect(readFileSync(join(first, 'branch.txt'), 'utf8')).toBe('Committed branch work')
  expect(readFileSync(join(first, 'uncommitted.txt'), 'utf8')).toBe('Pending portable work')
  expect(gitIn(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim()).toBe('refs/heads/main')
  expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(gitIn(first, 'rev-parse', 'HEAD').trim())
})

it.each(['missing-main', 'detached'])('recovers %s onto main while retaining its committed tree', async mode => {
  const { bare, first, client } = repositoryPair()
  createForge(first, 'tester')
  if (mode === 'missing-main') gitIn(first, 'symbolic-ref', 'HEAD', 'refs/heads/old-default')
  else {
    await client.sync(first, async () => undefined)
    gitIn(first, 'checkout', '--detach')
  }
  writeFileSync(join(first, 'retained.txt'), 'Keep this content')
  await client.sync(first, async () => undefined)
  expect(gitIn(first, 'branch', '--show-current').trim()).toBe('main')
  expect(gitIn(bare, 'show', 'main:retained.txt')).toBe('Keep this content')
})

it('leaves branch-recovery conflicts on main without pushing or losing the preserved branch', async () => {
  const { bare, first, client } = repositoryPair()
  createForge(first, 'tester')
  writeFileSync(join(first, 'README.md'), 'Base\n')
  await client.sync(first, async () => undefined)
  gitIn(first, 'branch', 'accidental')
  writeFileSync(join(first, 'README.md'), 'Main work\n')
  gitIn(first, 'commit', '-am', 'Main work')
  const main = gitIn(first, 'rev-parse', 'HEAD').trim()
  gitIn(first, 'switch', 'accidental')
  writeFileSync(join(first, 'README.md'), 'Branch work\n')
  const published = gitIn(bare, 'rev-parse', 'main')
  await expect(client.sync(first, async () => undefined)).rejects.toThrow()
  expect(gitIn(first, 'branch', '--show-current').trim()).toBe('main')
  expect(gitIn(first, 'rev-parse', 'HEAD').trim()).toBe(main)
  expect(gitIn(first, 'show', 'accidental:README.md')).toBe('Branch work\n')
  expect(gitIn(first, 'ls-files', '-u')).toContain('README.md')
  expect(gitIn(bare, 'rev-parse', 'main')).toBe(published)
})

it.each(['nested-root', 'directory-manifest'] as const)('refuses unsafe main recovery for %s without committing, switching or publishing', async invalid => {
  const { first, bare, client } = repositoryPair()
  createForge(first, 'tester')
  await client.sync(first, async () => undefined)
  gitIn(first, 'switch', '-c', 'preserve-work')
  writeFileSync(join(first, 'pending.txt'), 'Keep pending work')
  let target = first
  if (invalid === 'nested-root') {
    target = join(first, 'Nested')
    mkdirSync(target)
    createForge(target, 'tester')
  } else {
    renameSync(join(first, 'forge-world.json'), join(first, 'original-manifest.json'))
    mkdirSync(join(first, 'forge-world.json'))
  }
  const before = [gitIn(first, 'rev-parse', 'HEAD'), gitIn(first, 'ls-files', '--stage'), gitIn(first, 'status', '--porcelain')]
  await expect(client.ensureMain(target)).rejects.toThrow(invalid === 'nested-root' ? 'must be the root' : 'Invalid Forge World manifest')
  expect(gitIn(first, 'branch', '--show-current').trim()).toBe('preserve-work')
  expect([gitIn(first, 'rev-parse', 'HEAD'), gitIn(first, 'ls-files', '--stage'), gitIn(first, 'status', '--porcelain')]).toEqual(before)
  expect(gitIn(bare, 'rev-parse', 'main')).toBe(before[0])
})

it('finishes an ours-only resolved merge even when its staged tree is unchanged, preserving remote ancestry', async () => {
  const { root, bare, first, second, client, setup } = repositoryPair()
  createForge(first, 'tester')
  writeFileSync(join(first, 'README.md'), 'Base\n')
  await client.sync(first, async () => undefined)
  gitIn(root, 'clone', bare, second)
  setup(second)
  writeFileSync(join(second, 'README.md'), 'Remote\n')
  await client.sync(second, async () => undefined)
  const remote = gitIn(second, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(first, 'README.md'), 'Local\n')
  await expect(client.sync(first, async () => undefined)).rejects.toThrow()
  // The conflict stays staged: a sync refuses it before staging anything over it.
  await expect(client.sync(first, async () => undefined)).rejects.toThrow('unresolved merge')
  gitIn(first, 'checkout', '--ours', 'README.md')
  gitIn(first, 'add', 'README.md')
  expect(gitIn(first, 'diff', '--cached', '--name-only')).toBe('')
  await client.sync(first, async () => undefined)
  expect(gitIn(first, 'merge-base', '--is-ancestor', remote, 'main')).toBe('')
  expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(gitIn(first, 'rev-parse', 'HEAD').trim())
  expect(gitIn(bare, 'show', 'main:README.md')).toBe('Local\n')
})

it('inspects each commit tree once in a sync that commits and merges', async () => {
  const { first, client, runner } = repositoryPair()
  createForge(first, 'tester')
  await client.sync(first, async () => undefined)
  const published = gitIn(first, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(first, 'README.md'), 'Next\n')
  const trees: string[] = []
  const counting = new ForgeGit({ getAccount: () => null, getToken: () => null }, {
    run: request => {
      if (request.args.includes('ls-tree')) trees.push(request.args.at(-1) ?? '')
      return runner.run(request)
    }
  })
  await counting.sync(first, async () => undefined)
  const committed = gitIn(first, 'rev-parse', 'HEAD').trim()
  expect(trees).toEqual([published, committed])
})
