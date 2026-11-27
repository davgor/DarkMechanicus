import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

export function updateForge(root: string, change: (world: ForgeWorld) => void, onRetry?: RenameRetryNote): void {
  const file = join(root, FORGE_FILE)
  const lock = file + '.lock'
  writeFileSync(lock, '', { flag: 'wx' })
  const temp = file + '.' + randomUUID()
  try {
    const world = parseForge(readFileSync(file, 'utf8'))
    change(world)
    writeFileSync(temp, JSON.stringify(parseForge(JSON.stringify(world)), null, 2) + '\n', { flag: 'wx' })
    replaceForgeFile(temp, file, onRetry)
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
