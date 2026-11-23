import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { ensureForgeDirections, FORGE_DIRECTIONS, FORGE_REPOSITORY_GUIDANCE } from './forgeDirections'

let fixture: ReturnType<typeof scratchDir>
beforeEach(() => { fixture = scratchDir('forge-directions-') })
afterEach(() => fixture.cleanup())
const begin = '<!-- darkmechanicus:forge-repositories:v2:start -->'
const end = '<!-- darkmechanicus:forge-repositories:end -->'

it('upgrades an old managed section while preserving custom prose and leaving the next check unchanged', () => {
  const file = join(fixture.path, FORGE_DIRECTIONS)
  const before = '# Team conventions\r\nKeep this before.\r\n\r\n'
  const after = '\r\n\r\nKeep this after.\r\n'
  writeFileSync(file, before + '<!-- darkmechanicus:forge-repositories:v1:start -->\r\nOutdated generated directions.\r\n' + end + after)
  ensureForgeDirections(fixture.path)
  const current = readFileSync(file, 'utf8')
  expect(current.startsWith(before)).toBe(true)
  expect(current.endsWith(after)).toBe(true)
  expect(current).toContain(begin)
  expect(current).toContain(FORGE_REPOSITORY_GUIDANCE)
  expect(current).toContain('Keep this Forge World repository on main')
  expect(current).toContain('Feature branches and worktrees belong in the code checkout')
  expect(current).toContain('forge-recipes.yaml')
  expect(current).toContain('<member>/.darkmechanicus/knowledge/forge-setup/guide.md')
  expect(current).toContain('<member>/.darkmechanicus/knowledge/forge-setup/workflow.yaml')
  expect(current).toContain('Delivery Standards')
  expect(current).toContain('Verify the environment on this computer')
  expect(current).not.toContain('Outdated generated directions.')
  const stamp = statSync(file, { bigint: true })
  ensureForgeDirections(fixture.path)
  expect(readFileSync(file, 'utf8')).toBe(current)
  expect(statSync(file, { bigint: true })).toMatchObject({ ino: stamp.ino, mtimeNs: stamp.mtimeNs })
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

const originalUnmarked = [
  'This Forge World stores tickets, plans and history. Its project folders are ticket stores, not source-code checkouts.',
  'Read forge-world.json: each projects entry names the ticket folder in folder and its GitHub clone URL in repository. Read the current manifest whenever projects change.',
  'Obtain a repository only when the task needs its code. Reuse a local checkout after verifying its Git origin matches the repository URL.',
  'A project may record a machine-local checkout in <ticket folder>/.darkmechanicus/local/source-checkout.json as {"checkout":"absolute path"}. That hint is private to this computer and may be absent or stale.',
  'If no matching checkout exists, choose a new code directory outside the Forge World and clone the repository there. Never clone into or overwrite a ticket folder. Use the existing Git authentication; do not put credentials in URLs or in this world.',
  'After cloning, keep code edits and code tests in the code checkout, and use the ticket folder for Dark Mechanicus commands. Follow the code repository’s own setup instructions. Record the checkout only in the machine-local source-checkout.json, never in the portable manifest.',
  'Opening this Forge World does not download every code repository. The agent clones only the repositories needed for the current task.'
].join('\n\n')

it.each([
  originalUnmarked,
  originalUnmarked + '\n\nKeep this Forge World repository on main. Do not create or switch ticket-world branches. Feature branches and worktrees belong in the code checkout; the desktop commits, pulls and pushes this world on main.'
])('adopts a legacy unmarked app guide without duplicating its directions (%#)', text => {
  const file = join(fixture.path, FORGE_DIRECTIONS)
  writeFileSync(file, ('# Forge World repositories\n\n' + text + '\n').replaceAll('\n', '\r\n'))
  ensureForgeDirections(fixture.path)
  const current = readFileSync(file, 'utf8')
  expect(current).toContain(begin)
  expect(current.split('This Forge World stores tickets, plans and history.')).toHaveLength(2)
  expect(current).toContain('forge-recipes.yaml')
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
