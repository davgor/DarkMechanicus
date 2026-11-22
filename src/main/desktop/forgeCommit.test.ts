import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { ForgeGit } from './forgeGit'
import { createForge, updateForge } from './forgeManifest'

it('publishes all portable repository files after validation and refuses staged or committed private state', async () => {
  const fixture = scratchDir('forge-commit-')
  const root = fixture.path
  const events: string[] = []
  try {
    gitIn(root, 'init', '-b', 'main')
    gitIn(root, 'config', 'user.name', 'Fixture')
    gitIn(root, 'config', 'user.email', 'fixture@example.test')
    gitIn(root, 'remote', 'add', 'origin', 'https://github.com/example/world.git')
    createForge(root, 'example')
    updateForge(root, w => w.projects.push({ folder: 'Demo', repository: 'example/Demo' }))
    const store = join(root, 'Demo/.darkmechanicus')
    mkdirSync(join(store, 'local'), { recursive: true })
    writeFileSync(join(store, 'project.json'), '{}')
    writeFileSync(join(store, 'local/private'), 'local only')
    writeFileSync(join(root, 'unrelated'), 'manual work')
    const git = createGitRunner()
    const client = new ForgeGit({ getAccount: () => null, getToken: () => null }, {
      run: request => {
        if (request.kind !== 'network') return git.run(request)
        events.push(request.args.includes('push') ? 'push' : 'remote')
        return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      }
    })
    await client.sync(root, async () => { events.push('validate') })
    expect(events).toEqual(['remote', 'validate', 'push'])
    expect(gitIn(root, 'ls-tree', '--name-only', '-r', 'HEAD').trim().split('\n')).toEqual(['Demo/.darkmechanicus/project.json', 'FORGE-REPOSITORIES.md', 'forge-world.json', 'unrelated'])
    const published = gitIn(root, 'rev-parse', 'HEAD').trim()
    gitIn(root, 'add', '--force', 'Demo/.darkmechanicus/local/private')
    await expect(client.sync(root, async () => undefined)).rejects.toThrow('machine-private')
    expect(gitIn(root, 'rev-parse', 'HEAD').trim()).toBe(published)
    expect(gitIn(root, 'diff', '--cached', '--name-only').trim()).toBe('Demo/.darkmechanicus/local/private')
    gitIn(root, 'commit', '-m', 'Unsafe imported branch fixture')
    await expect(client.inspectTree(root, 'HEAD')).rejects.toThrow('machine-private')
    await expect(client.sync(root, async () => undefined)).rejects.toThrow('machine-private')
    gitIn(root, 'rm', '--cached', 'Demo/.darkmechanicus/local/private')
    gitIn(root, 'commit', '-m', 'Remove private state from current tree')
    await expect(client.sync(root, async () => undefined)).rejects.toThrow('machine-private')
    await expect(client.sync(store, async () => undefined)).rejects.toThrow('must be the root')
    expect(events.filter(e => e === 'push')).toEqual(['push'])
  } finally { fixture.cleanup() }
})

it('refuses staged symbolic ticket directories before creating a commit or pushing', async () => {
  const fixture = scratchDir('forge-symbolic-')
  const root = fixture.path
  try {
    gitIn(root, 'init', '-b', 'main')
    gitIn(root, 'remote', 'add', 'origin', 'https://github.com/example/world.git')
    createForge(root, 'example')
    writeFileSync(join(root, '.git', 'link-target'), '../outside')
    const blob = gitIn(root, 'hash-object', '-w', '.git/link-target').trim()
    gitIn(root, 'update-index', '--add', '--cacheinfo', '120000,' + blob + ',Demo/.darkmechanicus')
    let networkCalls = 0
    const git = createGitRunner()
    const client = new ForgeGit({ getAccount: () => null, getToken: () => null }, {
      run: request => {
        if (request.kind !== 'network') return git.run(request)
        networkCalls++
        return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      }
    })
    await expect(client.sync(root, async () => undefined)).rejects.toThrow('ordinary files')
    expect(gitIn(root, 'ls-files', '--stage')).toContain('120000 ' + blob + ' 0\tDemo/.darkmechanicus')
    expect(networkCalls).toBe(0)
  } finally { fixture.cleanup() }
})
