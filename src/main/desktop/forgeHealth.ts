import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { assertForgeWorldSyncAllowed, bindForge, boundForgeRoot } from '../../core/repo/forgeBinding'
import { ensureForgeConfig, readForgeReference } from '../../core/repo/forgeReference'
import { readProject } from '../../core/repo/initialize'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import type { ForgeWorld } from '../../shared/desktop/forgeWorld'
import { readForgeCheckout, verifyForgeCheckout } from './forgeCheckout'
import { ensureForgeDirections } from './forgeDirections'
import type { ForgeGit, WorldCheckout } from './forgeGit'
import { FORGE_FILE, githubRemote, parseForge, projectName } from './forgeManifest'

interface HealthOptions {
  git: Pick<ForgeGit, 'run' | 'inspectCheckout'>
  home: string
  /** What the sync running this check has just established about the world's repository; checked again when absent. */
  checked?: WorldCheckout
}
const repairable = z.looseObject({ projects: z.array(z.looseObject({ folder: z.string(), repository: z.string().optional() })) })

function ordinary(path: string, directory: boolean): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || realpathSync.native(path) !== resolve(path)) throw new Error('Forge World metadata is missing or uses an unsafe path: ' + path)
}

function validateMember(root: string, name: string): string {
  const member = join(root, projectName(name))
  ordinary(member, true)
  ordinary(join(member, '.darkmechanicus'), true)
  ordinary(join(member, '.darkmechanicus', 'project.json'), false)
  if (!readProject(resolveLayout(member), nodeFs)) throw new Error('Forge World project has no valid ticket metadata: ' + name)
  return member
}

async function recoverRepository(root: string, member: string, worldRepository: string, git: HealthOptions['git']): Promise<string> {
  const checkout = readForgeCheckout(member)
  const reference = checkout ? readForgeReference(nodeFs, checkout) : undefined
  if (!checkout || !reference || reference.worldRepository.toLowerCase() !== worldRepository.toLowerCase() || join(root, reference.projectFolder) !== member) {
    throw new Error('Forge World repository mapping is missing for ' + member + '. Restore its GitHub repository URL in forge-world.json; no verified local pointer can recover it.')
  }
  const repository = githubRemote((await git.run(checkout, ['remote', 'get-url', 'origin'])).stdout.trim())
  await verifyForgeCheckout(member, repository, git, worldRepository)
  return repository
}

async function checkedWorld(root: string, text: string, repository: string, git: HealthOptions['git']): Promise<ForgeWorld> {
  const data = repairable.parse(JSON.parse(text))
  const names = new Set(data.projects.map(project => project.folder.toLowerCase()))
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || names.has(entry.name.toLowerCase()) || !existsSync(join(root, entry.name, '.darkmechanicus', 'project.json'))) continue
    data.projects.push({ folder: entry.name })
  }
  for (const project of data.projects) {
    const member = validateMember(root, project.folder)
    if (project.repository === undefined) project.repository = await recoverRepository(root, member, repository, git)
  }
  return parseForge(JSON.stringify(data))
}

function saveRepairedManifest(root: string, before: string, world: ForgeWorld): void {
  const parsed: unknown = JSON.parse(before)
  if (JSON.stringify(parsed) === JSON.stringify(world)) return
  const file = join(root, FORGE_FILE), lock = file + '.lock', temp = file + '.' + randomUUID()
  writeFileSync(lock, '', { flag: 'wx' })
  try {
    if (readFileSync(file, 'utf8') !== before) throw new Error('Forge World manifest changed during its health check. Reopen it to check the new mapping.')
    writeFileSync(temp, JSON.stringify(world, null, 2) + '\n', { flag: 'wx' })
    renameSync(temp, file)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
    unlinkSync(lock)
  }
}

function repairCodePointer({ source, member, folder }: { source: string; member: string; folder: string }, repository: string, home: string): void {
  ensureForgeConfig(source, { version: 1, worldRepository: repository, projectFolder: folder })
  const note = join(source, 'FORGE-WORLD.md')
  if (!existsSync(note)) writeFileSync(note, '# Ticket source control\n\nForge World: ' + repository + '\nProject folder: ' + folder + '\n\nClone or pull the Forge World above, then open the named folder for tickets.\nThe root forge-world.json contains all linked project folders and their repository URLs.\n', { flag: 'wx' })
  try { if (boundForgeRoot(nodeFs, home, source) === member) return } catch { /* A verified pointer newly added above needs one local binding. */ }
  bindForge(home, source, member, readFileSync(note, 'utf8'))
}

/** The world's repository checks no sync has just made: it is the repository's root, its index and HEAD's tree, and its origin. */
async function checkWorldRepository(root: string, git: HealthOptions['git']): Promise<WorldCheckout> {
  const gitRoot = (await git.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
  if (realpathSync.native(gitRoot) !== root) throw new Error('Choose the Forge World Git repository root.')
  const inspected = new Set<string>()
  await git.inspectCheckout(root, inspected)
  return { url: githubRemote((await git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim()), inspected }
}

/** The one idempotent upgrade/check path for boot, opening, sync and all Forge mutations. */
export async function ensureForgeWorld(root: string, { git, home, checked }: HealthOptions): Promise<WorldCheckout> {
  assertForgeWorldSyncAllowed(nodeFs, home, root)
  ordinary(root, true)
  ordinary(join(root, FORGE_FILE), false)
  const checkout = checked ?? await checkWorldRepository(root, git)
  const repository = checkout.url
  const text = readFileSync(join(root, FORGE_FILE), 'utf8')
  const world = await checkedWorld(root, text, repository, git)
  const checkouts = []
  for (const project of world.projects) {
    const member = join(root, project.folder)
    const source = await verifyForgeCheckout(member, project.repository, git, repository)
    if (source) checkouts.push({ source, member, folder: project.folder })
  }
  saveRepairedManifest(root, text, world)
  ensureForgeDirections(root)
  for (const checkout of checkouts) repairCodePointer(checkout, repository, home)
  return checkout
}
