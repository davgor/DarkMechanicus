import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FORGE_FILE, parseForgeManifest, replaceForgeFile, type RenameRetryNote } from '../../core/repo/forgeManifest'
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

/**
 * Runs `write` while holding the manifest writers' lock (`forge-world.json.lock`, created exclusively), with a fresh
 * temporary name beside the manifest that is removed afterwards unless `write` renamed it into place.
 */
function underForgeLock(file: string, write: (temp: string) => void): void {
  const lock = file + '.lock'
  writeFileSync(lock, '', { flag: 'wx' })
  const temp = file + '.' + randomUUID()
  try {
    write(temp)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
    unlinkSync(lock)
  }
}

export function updateForge(root: string, change: (world: ForgeWorld) => void, onRetry?: RenameRetryNote): void {
  const file = join(root, FORGE_FILE)
  underForgeLock(file, temp => {
    const world = parseForge(readFileSync(file, 'utf8'))
    change(world)
    writeFileSync(temp, JSON.stringify(parseForge(JSON.stringify(world)), null, 2) + '\n', { flag: 'wx' })
    replaceForgeFile(temp, file, onRetry)
  })
}

/**
 * Writes the first manifest of `root`, refusing (EEXIST) a root that already has anything at that name. It is written
 * whole under a temporary name and renamed into place under the writers' lock, never hard-linked: on Windows, deleting
 * the temporary second name of a hard-linked manifest made a kernel handle (System, PID 4) hold the manifest for up to
 * a second on a quiet host and past 15 s on a loaded one, refusing the next writer's replacing rename (EPERM).
 */
export function createForge(root: string, owner: string, onRetry?: RenameRetryNote): void {
  const world = parseForge(JSON.stringify({ version: 1, owner, projects: [], syncMinutes: 5 }))
  const file = join(root, FORGE_FILE)
  underForgeLock(file, temp => {
    if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) {
      throw Object.assign(new Error(`EEXIST: file already exists, ${file}`), { code: 'EEXIST' })
    }
    writeFileSync(temp, JSON.stringify(world, null, 2) + '\n', { flag: 'wx' })
    replaceForgeFile(temp, file, onRetry)
  })
}
