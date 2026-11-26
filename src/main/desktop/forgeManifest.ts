import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FORGE_FILE, parseForgeManifest } from '../../core/repo/forgeManifest'
import type { ForgeWorld } from '../../shared/desktop/forgeWorld'
import { checkCloneName } from '../git/cloneInput'

export { FORGE_FILE, githubRemote } from '../../core/repo/forgeManifest'

export function projectName(name: string): string {
  checkCloneName(name)
  if (!/^[a-z0-9][a-z0-9._ -]*$/i.test(name)) throw new Error('Choose a portable project folder name.')
  return name
}

export function parseForge(text: string): ForgeWorld {
  return parseForgeManifest(text, projectName)
}

export function forgeProjectFor(member: string) {
  const manifest = join(dirname(member), FORGE_FILE)
  if (!existsSync(manifest)) return undefined
  return parseForge(readFileSync(manifest, 'utf8')).projects.find(project => project.folder === basename(member))
}

export function forgeKickoff(member: string): string {
  const project = forgeProjectFor(member)
  if (!project) return ''
  return '\n\nTicket location: ' + member + '. Code repository: ' + project.repository +
    '. Use the checkout recorded in .darkmechanicus/local/source-checkout.json when available, or clone the code repository outside the ticket store. ' +
    'The parent forge-world.json lists the other repositories available for this work.'
}

/** What Windows answers a rename onto a file another handle holds open (a scan, a reader) for a moment. */
const RENAME_BUSY: Record<string, true> = { EPERM: true, EACCES: true, EBUSY: true }
/** Waits after each busy refusal: 300 ms in all. */
const RENAME_PAUSES_MS = [50, 100, 150]

/**
 * Renames the written `temp` over `forge-world.json`. A busy refusal is asked again after each of
 * `RENAME_PAUSES_MS`; any other error, or the last refusal, is thrown as it came, with the target untouched.
 */
export function replaceForgeFile(temp: string, file: string, rename: (from: string, to: string) => void = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temp, file)
      return
    } catch (error) {
      const pause = RENAME_PAUSES_MS[attempt]
      if (pause === undefined || !Object.hasOwn(RENAME_BUSY, (error as NodeJS.ErrnoException).code ?? '')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause)
    }
  }
}

export function updateForge(root: string, change: (world: ForgeWorld) => void): void {
  const file = join(root, FORGE_FILE)
  const lock = file + '.lock'
  writeFileSync(lock, '', { flag: 'wx' })
  const temp = file + '.' + randomUUID()
  try {
    const world = parseForge(readFileSync(file, 'utf8'))
    change(world)
    writeFileSync(temp, JSON.stringify(parseForge(JSON.stringify(world)), null, 2) + '\n', { flag: 'wx' })
    replaceForgeFile(temp, file)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
    unlinkSync(lock)
  }
}

export function createForge(root: string, owner: string): void {
  const world = parseForge(JSON.stringify({ version: 1, owner, projects: [], syncMinutes: 5 }))
  const temp = join(root, randomUUID() + '.tmp')
  writeFileSync(temp, JSON.stringify(world, null, 2) + '\n', { flag: 'wx' })
  try { linkSync(temp, join(root, FORGE_FILE)) } finally { unlinkSync(temp) }
}
