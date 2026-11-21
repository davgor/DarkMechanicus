import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { ForgeWorld } from '../../shared/desktop/forgeWorld'
import { checkCloneName } from '../git/cloneInput'

export const FORGE_FILE = 'forge-world.json'

export function projectName(name: string): string {
  checkCloneName(name)
  if (!/^[a-z0-9][a-z0-9._ -]*$/i.test(name)) throw new Error('Choose a portable project folder name.')
  return name
}

export function githubRemote(input: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(input)
  if (!match || /^\.{1,2}$/.test(match[2])) throw new Error('Enter a GitHub repository in owner/name format.')
  return 'https://github.com/' + match[1] + '/' + match[2] + '.git'
}

const schema = z.strictObject({
  version: z.literal(1),
  owner: z.string().regex(/^[\w-]{1,100}$/),
  projects: z.array(z.strictObject({ folder: z.string().transform(projectName), repository: z.string().transform(githubRemote) })),
  syncMinutes: z.number().int().min(1).max(1440)
})

export function parseForge(text: string): ForgeWorld {
  const world = schema.parse(JSON.parse(text))
  const names = world.projects.map(p => p.folder.toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('Duplicate Forge World project folder.')
  return world
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

export function updateForge(root: string, change: (world: ForgeWorld) => void): void {
  const file = join(root, FORGE_FILE)
  const lock = file + '.lock'
  writeFileSync(lock, '', { flag: 'wx' })
  const temp = file + '.' + randomUUID()
  try {
    const world = parseForge(readFileSync(file, 'utf8'))
    change(world)
    writeFileSync(temp, JSON.stringify(parseForge(JSON.stringify(world)), null, 2) + '\n', { flag: 'wx' })
    renameSync(temp, file)
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
