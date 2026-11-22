import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { bindForge, boundForgeRoot, FORGE_POINTER } from './forgeBinding'
import { FORGE_CONFIG, ensureForgeConfig, parseForgeConfig, readForgeReference } from './forgeReference'
import { nodeFs } from './nodeFs'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })
const config = { version: 1 as const, worldRepository: 'https://github.com/example/world.git', projectFolder: 'Software' }
const note = 'Forge World: https://github.com/example/world.git\nProject folder: Software\n'
function fixture() {
  const scratch = scratchDir('forge-reference-')
  cleanups.push(scratch.cleanup)
  const source = join(scratch.path, 'source'), member = join(scratch.path, 'world', 'Software')
  mkdirSync(source)
  mkdirSync(member, { recursive: true })
  return { source, member, home: join(scratch.path, 'home') }
}

it('creates portable configuration without replacing matching customized formatting or conflicting pointers', () => {
  const { source } = fixture()
  writeFileSync(join(source, FORGE_POINTER), note)
  ensureForgeConfig(source, config)
  expect(JSON.parse(readFileSync(join(source, FORGE_CONFIG), 'utf8'))).toEqual(config)
  const formatted = JSON.stringify({ ...config, worldRepository: 'https://github.com/Example/World.git' })
  writeFileSync(join(source, FORGE_CONFIG), formatted)
  ensureForgeConfig(source, config)
  expect(readFileSync(join(source, FORGE_CONFIG), 'utf8')).toBe(formatted)
  writeFileSync(join(source, FORGE_POINTER), note.replace('Software', 'Other'))
  expect(() => readForgeReference(nodeFs, source)).toThrow('disagree')
  expect(() => ensureForgeConfig(source, config)).toThrow('disagree')
  expect(readFileSync(join(source, FORGE_CONFIG), 'utf8')).toBe(formatted)
})

it.each([
  { ...config, version: 2 }, { ...config, token: 'no-secrets' },
  { ...config, worldRepository: 'https://user:secret@github.com/example/world.git' },
  { ...config, worldRepository: 'file:///tmp/world' },
  { ...config, projectFolder: '../outside' }, { ...config, projectFolder: 'C:\\code' },
  { ...config, projectFolder: 'CON' }, { ...config, projectFolder: 'Software.' }
])('rejects invalid or nonportable configuration %#', value => {
  expect(() => parseForgeConfig(JSON.stringify(value))).toThrow()
})

it('requires setup for config-only checkouts and fences edited or removed configuration after binding', () => {
  const { source, member, home } = fixture()
  ensureForgeConfig(source, config)
  expect(readForgeReference(nodeFs, source)).toEqual(config)
  expect(() => boundForgeRoot(nodeFs, home, source)).toThrow('retrieve its Forge World')
  bindForge(home, source, member, '')
  expect(boundForgeRoot(nodeFs, home, source)).toBe(member)
  writeFileSync(join(source, FORGE_CONFIG), JSON.stringify({ ...config, projectFolder: 'Other' }))
  expect(() => boundForgeRoot(nodeFs, home, source)).toThrow('retrieve its Forge World')
  writeFileSync(join(source, FORGE_CONFIG), JSON.stringify(config))
  writeFileSync(join(source, FORGE_POINTER), note)
  bindForge(home, source, member, note)
  unlinkSync(join(source, FORGE_CONFIG))
  expect(() => boundForgeRoot(nodeFs, home, source)).toThrow('retrieve its Forge World')
  expect(existsSync(join(source, '.darkmechanicus'))).toBe(false)
})

it('rejects symbolic and nonregular configuration before reading it', () => {
  const { source } = fixture()
  const file = join(source, FORGE_CONFIG)
  writeFileSync(file, JSON.stringify(config))
  expect(() => readForgeReference({ ...nodeFs, isSymlink: path => path === file }, source)).toThrow('ordinary file')
  unlinkSync(file)
  mkdirSync(file)
  expect(() => readForgeReference(nodeFs, source)).toThrow('ordinary file')
})
