import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { ForgeGit } from './forgeGit'
import { createForge, updateForge } from './forgeManifest'

it('publishes only ticket paths to an empty destination after validation', async () => {
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
    expect(gitIn(root, 'ls-tree', '--name-only', '-r', 'HEAD').trim().split('\n')).toEqual(['Demo/.darkmechanicus/project.json', 'forge-world.json'])
  } finally { fixture.cleanup() }
})
