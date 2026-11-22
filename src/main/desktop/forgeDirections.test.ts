import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { ensureForgeDirections, FORGE_DIRECTIONS, FORGE_REPOSITORY_GUIDANCE } from './forgeDirections'

let fixture: ReturnType<typeof scratchDir>
beforeEach(() => { fixture = scratchDir('forge-directions-') })
afterEach(() => fixture.cleanup())
const begin = '<!-- darkmechanicus:forge-repositories:v1:start -->'
const end = '<!-- darkmechanicus:forge-repositories:end -->'

it('upgrades an old managed section while preserving custom prose and leaving the next check unchanged', () => {
  const file = join(fixture.path, FORGE_DIRECTIONS)
  writeFileSync(file, '# Team conventions\nKeep this before.\n\n<!-- darkmechanicus:forge-repositories:v0:start -->\nOutdated generated directions.\n' + end + '\n\nKeep this after.\n')
  ensureForgeDirections(fixture.path)
  const current = readFileSync(file, 'utf8')
  expect(current).toContain('Keep this before.')
  expect(current).toContain('Keep this after.')
  expect(current).toContain(begin)
  expect(current).toContain(FORGE_REPOSITORY_GUIDANCE)
  expect(current).not.toContain('Outdated generated directions.')
  ensureForgeDirections(fixture.path)
  expect(readFileSync(file, 'utf8')).toBe(current)
})

it('preserves an entirely custom guide and appends exactly one maintained instruction section', () => {
  const file = join(fixture.path, FORGE_DIRECTIONS)
  writeFileSync(file, '# Custom\nUse our internal setup notes.\n')
  ensureForgeDirections(fixture.path)
  const first = readFileSync(file, 'utf8')
  expect(first.startsWith('# Custom\nUse our internal setup notes.\n')).toBe(true)
  expect(first.split(begin)).toHaveLength(2)
  ensureForgeDirections(fixture.path)
  expect(readFileSync(file, 'utf8')).toBe(first)
})

it('adopts the previous app-generated guide without duplicating its directions', () => {
  const file = join(fixture.path, FORGE_DIRECTIONS)
  writeFileSync(file, '# Forge World repositories\n\n' + FORGE_REPOSITORY_GUIDANCE + '\n')
  ensureForgeDirections(fixture.path)
  const current = readFileSync(file, 'utf8')
  expect(current).toContain(begin)
  expect(current.split(FORGE_REPOSITORY_GUIDANCE)).toHaveLength(2)
})

it('refuses malformed managed markers and nonregular guides without replacing them', () => {
  const file = join(fixture.path, FORGE_DIRECTIONS)
  const malformed = '# Custom\n' + begin + '\nKeep this unfinished section.'
  writeFileSync(file, malformed)
  expect(() => ensureForgeDirections(fixture.path)).toThrow('managed section')
  expect(readFileSync(file, 'utf8')).toBe(malformed)
  const other = join(fixture.path, 'other')
  mkdirSync(other)
  mkdirSync(join(other, FORGE_DIRECTIONS))
  expect(() => ensureForgeDirections(other)).toThrow('ordinary file')
})
