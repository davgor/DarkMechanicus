import { gitIn, scratchDir } from '../../test/gitScratch'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createGitRunner } from '../git/runner'
import { ForgeGit } from './forgeGit'
import { createForge, githubRemote, parseForge, updateForge } from './forgeManifest'

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
  const client = new ForgeGit({ getAccount: () => null, getToken: () => null }, {
    run: request => request.kind !== 'network' ? real.run(request) : real.run({ ...request, args: [
      '-c', 'url.' + pathToFileURL(bare).href + '.insteadOf=' + url,
      ...request.args.map(a => a === 'protocol.allow=never' ? 'protocol.file.allow=always' : a)
    ] })
  })
  const setup = (cwd: string) => {
    gitIn(cwd, 'remote', 'set-url', 'origin', url)
    gitIn(cwd, 'config', 'user.email', 'forge@example.test')
    gitIn(cwd, 'config', 'user.name', 'Forge Test')
  }
  setup(first)
  return { root, bare, first, second, client, setup }
}

function portableFiles(first: string) {
  createForge(first, 'tester')
  updateForge(first, w => w.projects.push({ folder: 'Demo', repository: 'tester/Demo' }))
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
