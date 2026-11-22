import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { scratchDir, gitIn } from '../../test/gitScratch'
import { verifyForgeCheckout } from './forgeCheckout'
import { ForgeGit } from './forgeGit'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })
const git = new ForgeGit({ getAccount: () => null, getToken: () => null })
const repository = 'https://github.com/example/software.git'
function fixture() {
  const scratch = scratchDir('forge-checkout-')
  cleanups.push(scratch.cleanup)
  const root = join(scratch.path, 'world'), source = join(scratch.path, 'code'), member = join(root, 'Software')
  for (const [path, url] of [[root, 'https://github.com/example/world.git'], [source, repository]]) {
    mkdirSync(path)
    gitIn(path, 'init', '-b', 'main')
    gitIn(path, 'remote', 'add', 'origin', url)
  }
  const local = join(member, '.darkmechanicus', 'local')
  mkdirSync(local, { recursive: true })
  const hint = join(local, 'source-checkout.json')
  writeFileSync(hint, JSON.stringify({ checkout: source }))
  return { root, source, member, local, hint }
}

it('refuses a code directory inside the ticket world and a subdirectory instead of a Git root', async () => {
  const f = fixture()
  writeFileSync(f.hint, JSON.stringify({ checkout: f.member }))
  await expect(verifyForgeCheckout(f.member, repository, git)).rejects.toThrow('outside its Forge World')
  const subdirectory = join(f.source, 'src')
  mkdirSync(subdirectory)
  writeFileSync(f.hint, JSON.stringify({ checkout: subdirectory }))
  await expect(verifyForgeCheckout(f.member, repository, git)).rejects.toThrow('repository root')
})

it('refuses a matching Git origin whose portable configuration points to another world or project', async () => {
  const f = fixture()
  const config = join(f.source, '.forge-world.json')
  writeFileSync(config, JSON.stringify({ version: 1, worldRepository: 'https://github.com/example/other-world.git', projectFolder: 'Software' }))
  await expect(verifyForgeCheckout(f.member, repository, git)).rejects.toThrow('different Forge World project')
  writeFileSync(config, JSON.stringify({ version: 1, worldRepository: 'https://github.com/example/world.git', projectFolder: 'Other' }))
  await expect(verifyForgeCheckout(f.member, repository, git)).rejects.toThrow('different Forge World project')
})

it('refuses malformed hints and linked private directories instead of following their targets', async () => {
  const f = fixture()
  writeFileSync(f.hint, JSON.stringify({ checkout: '../code' }))
  await expect(verifyForgeCheckout(f.member, repository, git)).rejects.toThrow('absolute')
  const moved = f.local + '-moved'
  renameSync(f.local, moved)
  symlinkSync(moved, f.local, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifyForgeCheckout(f.member, repository, git)).rejects.toThrow('symbolic link')
})

it('refuses a nonregular hint and permits an absent machine-local hint', async () => {
  const f = fixture()
  renameSync(f.hint, f.hint + '.old')
  expect(await verifyForgeCheckout(f.member, repository, git)).toBeUndefined()
  mkdirSync(f.hint)
  await expect(verifyForgeCheckout(f.member, repository, git)).rejects.toThrow('ordinary file')
})
