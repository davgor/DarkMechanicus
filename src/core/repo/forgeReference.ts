import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { nodeFs } from './nodeFs'
import type { FsAdapter } from './types'

export const FORGE_CONFIG = '.forge-world.json'
const legacyPointer = 'FORGE-WORLD.md'

function repository(input: string): string {
  const match = /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(input)
  if (!match || /^\.{1,2}$/.test(match[2])) throw new Error('The Forge World configuration needs a GitHub HTTPS repository URL.')
  return `https://github.com/${match[1]}/${match[2]}.git`
}

const schema = z.strictObject({
  version: z.literal(1),
  worldRepository: z.string().transform(repository),
  projectFolder: z.string().min(1).max(255).regex(/^[a-z0-9][a-z0-9._ -]*$/i)
    .refine(value => !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), 'Choose a portable project folder name.')
})
type ForgeReference = z.infer<typeof schema>

export function parseForgeConfig(text: string): ForgeReference {
  return schema.parse(JSON.parse(text))
}

function readPointerFile(fs: FsAdapter, source: string, name: string): string | undefined {
  const file = join(source, name)
  if (fs.isSymlink(file)) throw new Error('The Forge World pointer must be an ordinary file.')
  if (!fs.exists(file)) return undefined
  if (fs.fileStamp(file) === null) throw new Error('The Forge World pointer must be an ordinary file.')
  return fs.readFile(file)
}

function sameReference(left: ForgeReference, right: ForgeReference): boolean {
  return left.worldRepository.toLowerCase() === right.worldRepository.toLowerCase() && left.projectFolder === right.projectFolder
}

/** Both formats can travel with source; conflicting pointers require an explicit human edit. */
export function readForgeReference(fs: FsAdapter, source: string): ForgeReference | undefined {
  const config = readPointerFile(fs, source, FORGE_CONFIG)
  const note = readPointerFile(fs, source, legacyPointer)
  const value = config === undefined ? undefined : parseForgeConfig(config)
  if (note === undefined) return value
  const match = /^Forge World: (\S+)\r?\nProject folder: (.+?)\r?$/m.exec(note)
  if (!match) throw new Error('Cannot read the Forge World pointer for this project.')
  const legacy = schema.parse({ version: 1, worldRepository: match[1], projectFolder: match[2] })
  if (value && !sameReference(value, legacy)) throw new Error('The Forge World configuration and legacy pointer disagree. Choose the intended world and project before reopening.')
  return value ?? legacy
}

/** Create only: source-control edits and customized matching formatting remain owned by the person. */
export function ensureForgeConfig(source: string, reference: ForgeReference): void {
  const validated = schema.parse(reference)
  const existing = readForgeReference(nodeFs, source)
  if (existing && !sameReference(existing, validated)) throw new Error('The Forge World configuration and requested project disagree.')
  const file = join(source, FORGE_CONFIG)
  if (!nodeFs.exists(file)) writeFileSync(file, JSON.stringify(validated, null, 2) + '\n', { flag: 'wx' })
}
