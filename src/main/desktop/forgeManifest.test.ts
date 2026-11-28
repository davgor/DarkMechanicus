import type { PathLike } from 'node:fs'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { refuseRenames, refuseUnlinks, releaseRenames, renamesAsked } from '../../test/busyRename'
import { scratchDir } from '../../test/gitScratch'
import { createForge, FORGE_FILE, updateForge } from './forgeManifest'

/** Each name `unlinkSync` removed while its file had another name too. */
const secondNamesRemoved = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async original => {
  const fs = (await import('../../test/busyRename')).withBusyRename(await original())
  return {
    ...fs,
    unlinkSync(path: PathLike): void {
      if ((fs.lstatSync(path, { throwIfNoEntry: false })?.nlink ?? 0) > 1) secondNamesRemoved.push(String(path))
      fs.unlinkSync(path)
    }
  }
})

let fixture: ReturnType<typeof scratchDir>
beforeEach(() => { fixture = scratchDir('forge-manifest-') })
afterEach(() => {
  releaseRenames()
  secondNamesRemoved.length = 0
  fixture.cleanup()
})

function refusal(write: () => void): string | undefined {
  try {
    write()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
  throw new Error('The write was not refused')
}

it('renames a new manifest into place and never removes a second name of it', () => {
  // On Windows, removing the temporary second name of a hard-linked manifest left a kernel handle on the manifest
  // that refused the next writer's replacing rename (EPERM) for up to a second, and past 15 s on a loaded host.
  refuseRenames()
  createForge(fixture.path, 'example')
  expect(secondNamesRemoved).toEqual([])
  expect(renamesAsked()).toBe(1)
  expect(readdirSync(fixture.path)).toEqual([FORGE_FILE])
  expect(JSON.parse(readFileSync(join(fixture.path, FORGE_FILE), 'utf8'))).toEqual({ version: 1, owner: 'example', projects: [], syncMinutes: 5 })

  const software = { folder: 'Software', repository: 'https://github.com/example/software.git' }
  updateForge(fixture.path, world => { world.projects.push(software) })
  expect(readdirSync(fixture.path)).toEqual([FORGE_FILE])
  expect(JSON.parse(readFileSync(join(fixture.path, FORGE_FILE), 'utf8')).projects).toEqual([software])
})

it('refuses a root that already has a manifest or a folder at its name and leaves it as it was', () => {
  const file = join(fixture.path, FORGE_FILE)
  writeFileSync(file, 'kept\n')
  expect(refusal(() => createForge(fixture.path, 'example'))).toBe('EEXIST')
  expect(readFileSync(file, 'utf8')).toBe('kept\n')
  expect(readdirSync(fixture.path)).toEqual([FORGE_FILE])

  const other = join(fixture.path, 'other')
  mkdirSync(join(other, FORGE_FILE), { recursive: true })
  expect(refusal(() => createForge(other, 'example'))).toBe('EEXIST')
  expect(readdirSync(other)).toEqual([FORGE_FILE])
})

it('writes no manifest while another manifest writer holds the lock', () => {
  const lock = join(fixture.path, FORGE_FILE + '.lock')
  writeFileSync(lock, '')
  expect(refusal(() => createForge(fixture.path, 'example'))).toBe('EEXIST')
  expect(readdirSync(fixture.path)).toEqual([FORGE_FILE + '.lock'])
})

it('notes a busy publishing rename and writes the manifest once it is asked again', () => {
  refuseRenames('EPERM')
  const notes: Array<[string, string]> = []
  createForge(fixture.path, 'example', (code, file) => notes.push([code, file]))
  expect(notes).toEqual([['EPERM', join(fixture.path, FORGE_FILE)]])
  expect(renamesAsked()).toBe(2)
  expect(readdirSync(fixture.path)).toEqual([FORGE_FILE])
})

it('releases the writers lock when the failed write cannot delete its temporary file', () => {
  createForge(fixture.path, 'example')
  refuseRenames('EIO')
  refuseUnlinks(/forge-world\.json\.[0-9a-f-]{36}$/)
  expect(refusal(() => updateForge(fixture.path, world => { world.syncMinutes = 10 }))).toBe('EPERM')
  const left = readdirSync(fixture.path)
  expect(left).not.toContain(FORGE_FILE + '.lock')
  expect(left.filter(name => name !== FORGE_FILE)).toEqual([expect.stringMatching(/^forge-world\.json\.[0-9a-f-]{36}$/)])

  releaseRenames()
  updateForge(fixture.path, world => { world.syncMinutes = 10 })
  expect(JSON.parse(readFileSync(join(fixture.path, FORGE_FILE), 'utf8')).syncMinutes).toBe(10)
})
