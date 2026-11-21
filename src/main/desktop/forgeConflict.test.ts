import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { ForgeGit } from './forgeGit'
import { createForge, FORGE_FILE, updateForge } from './forgeManifest'

it('keeps a divergent merge local for resolution, then validates the merge commit before pushing', async () => {
  const fixture = scratchDir('forge-conflict-')
  const root = fixture.path
  try {
    gitIn(root, 'init', '-b', 'main')
    gitIn(root, 'config', 'user.name', 'Test')
    gitIn(root, 'config', 'user.email', 'test@example.test')
    gitIn(root, 'remote', 'add', 'origin', 'https://github.com/example/world.git')
    createForge(root, 'example')
    gitIn(root, 'add', FORGE_FILE)
    gitIn(root, 'commit', '-m', 'Original Forge World')
    gitIn(root, 'switch', '-c', 'remote-fixture')
    updateForge(root, world => { world.syncMinutes = 15 })
    gitIn(root, 'add', FORGE_FILE)
    gitIn(root, 'commit', '-m', 'Remote interval')
    const upstream = gitIn(root, 'rev-parse', 'HEAD').trim()
    gitIn(root, 'switch', 'main')
    updateForge(root, world => { world.syncMinutes = 10 })
    const events: string[] = []
    const runner = createGitRunner()
    const client = new ForgeGit({ getAccount: () => null, getToken: () => null }, {
      run(req) {
        if (req.kind !== 'network') return runner.run(req)
        if (req.args.includes('fetch')) writeFileSync(join(root, '.git/FETCH_HEAD'), upstream + "\t\tbranch 'main'\n")
        if (req.args.includes('push')) events.push('push')
        return Promise.resolve({ code: 0, stderr: '', stdout: req.args.includes('ls-remote') ? upstream + '\trefs/heads/main\n' : '' })
      }
    })
    const validate = async () => { JSON.parse(readFileSync(join(root, FORGE_FILE), 'utf8')); events.push('validate') }
    await expect(client.sync(root, validate)).rejects.toThrow()
    expect(gitIn(root, 'diff', '--name-only', '--diff-filter=U').trim()).toBe(FORGE_FILE)
    expect(events).toEqual([])
    writeFileSync(join(root, FORGE_FILE), gitIn(root, 'show', 'remote-fixture:' + FORGE_FILE))
    gitIn(root, 'add', FORGE_FILE)
    gitIn(root, 'commit', '-m', 'Resolved interval')
    await client.sync(root, validate)
    expect(events).toEqual(['validate', 'push'])
  } finally { fixture.cleanup() }
})
