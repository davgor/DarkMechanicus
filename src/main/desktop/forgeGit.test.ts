import { gitIn, scratchDir } from '../../test/gitScratch'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitRunner } from '../git/runner'
import { ForgeGit } from './forgeGit'
import { createForge, githubRemote, parseForge, updateForge } from './forgeManifest'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

describe('Forge World', () => {
  it('rejects ambiguous project folders and credential-bearing clone URLs', () => {
    expect(() => githubRemote('https://user:password@github.com/owner/repo')).toThrow()
    const data = { version: 1, owner: 'tester', syncMinutes: 5, projects: ['Alpha', 'alpha'].map(folder => ({ folder, repository: 'user/repo' })) }
    expect(() => parseForge(JSON.stringify(data))).toThrow('Duplicate')
    data.projects[0].folder = '../outside'
    expect(() => parseForge(JSON.stringify(data))).toThrow()
  })
  it('syncs a portable project between two real Git checkouts and excludes local state', async () => {
    const scratch = scratchDir('forge-git-')
    cleanups.push(scratch.cleanup)
    const root = scratch.path
    const bare = join(root, 'origin.git')
    const first = join(root, 'one')
    const second = join(root, 'two')
    const command = gitIn
    command(root, 'init', '--bare', '--initial-branch=main', bare)
    command(root, 'clone', bare, first)
    const url = 'https://github.com/tester/tickets.git'
    const real = createGitRunner()
    const client = new ForgeGit({ getAccount: () => null, getToken: () => null }, {
      run: request => request.kind !== 'network' ? real.run(request) : real.run({ ...request, args: [
        '-c', 'url.' + pathToFileURL(bare).href + '.insteadOf=' + url,
        ...request.args.map(a => a === 'protocol.allow=never' ? 'protocol.file.allow=always' : a)
      ] })
    })
    function setup(cwd: string) {
      command(cwd, 'remote', 'set-url', 'origin', url)
      command(cwd, 'config', 'user.email', 'forge@example.test')
      command(cwd, 'config', 'user.name', 'Forge Test')
    }
    setup(first)
    createForge(first, 'tester')
    updateForge(first, w => w.projects.push({ folder: 'Demo', repository: 'tester/Demo' }))
    const store = join(first, 'Demo', '.darkmechanicus')
    mkdirSync(join(store, 'local'), { recursive: true })
    writeFileSync(join(store, '.gitignore'), 'local/\n')
    writeFileSync(join(store, 'project.json'), '{}')
    writeFileSync(join(store, 'local', 'state.sqlite'), 'private')
    writeFileSync(join(first, 'notes.txt'), 'unrelated')
    await client.sync(first, async () => undefined)
    command(root, 'clone', bare, second)
    setup(second)
    expect(command(second, 'ls-files')).not.toMatch(/state.sqlite|notes.txt/)
    writeFileSync(join(second, 'Demo/.darkmechanicus/project.json'), '{"changed":true}')
    await client.sync(second, async () => undefined)
    await client.sync(first, async () => undefined)
    expect(readFileSync(join(store, 'project.json'), 'utf8')).toBe('{"changed":true}')
  })
})
