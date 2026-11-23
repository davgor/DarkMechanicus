import { join } from 'node:path'
import { z } from 'zod'
import type { ForgeWorld } from '../../shared/desktop/forgeWorld'
import { nodeFs } from './nodeFs'

export const FORGE_FILE = 'forge-world.json'

export function githubRemote(input: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(input)
  if (!match || /^\.{1,2}$/.test(match[2])) throw new Error('Enter a GitHub repository in owner/name format.')
  return 'https://github.com/' + match[1] + '/' + match[2] + '.git'
}

function portableFolder(name: string): string {
  const device = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
  if (!/^[a-z0-9][a-z0-9._ -]{0,254}$/i.test(name) || /[. ]$/.test(name) || device.test(name.split('.')[0].trimEnd())) {
    throw new Error('Choose a portable project folder name.')
  }
  return name
}

const schema = z.strictObject({
  version: z.literal(1),
  owner: z.string().regex(/^[\w-]{1,100}$/),
  projects: z.array(z.strictObject({ folder: z.string(), repository: z.string().transform(githubRemote) })),
  syncMinutes: z.number().int().min(1).max(1440)
})

export function parseForgeManifest(text: string, folderName = portableFolder): ForgeWorld {
  const world = schema.parse(JSON.parse(text))
  const projects = world.projects.map((project) => ({ ...project, folder: folderName(project.folder) }))
  const names = projects.map((project) => project.folder.toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('Duplicate Forge World project folder.')
  return { ...world, projects }
}

/** Reads the current manifest of an actual world root without following a linked metadata file. */
export function forgeWorldAt(root: string): ForgeWorld | undefined {
  const file = join(root, FORGE_FILE)
  if (!nodeFs.exists(file) && !nodeFs.isSymlink(file)) return undefined
  if (nodeFs.fileStamp(file) === null) throw new Error('Invalid Forge World manifest.')
  return parseForgeManifest(nodeFs.readFile(file))
}
