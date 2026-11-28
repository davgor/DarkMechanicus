/**
 * Each folder's "Always allow" sites for the agent browser, kept by main in one private file per folder:
 *
 *   <root>/<folderStoreId or projectless>.json   = { "version": 1, "origins": ["https://example.com", …] }
 *
 * `root` is `<userData>/browser/sites`. The file is named by the folder's durable `folderStoreId`, never its per-run
 * attachment key, so the list survives a restart. Only normalized origins (what `normalizeTarget` returns for the
 * origin itself) are stored, at most `MAX_SITES` of them. A file that is corrupt, of another version or holds anything
 * else loads as an empty list, so the browser asks again rather than allowing (logged once per file). Every write lands
 * whole through `writePrivateFile`, and writes run one at a time so two adds never lose one another.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { folderStoreId } from '../agentChat/folderStoreId'
import { writePrivateFile } from '../terminals/privateFile'
import { normalizeTarget } from './originPolicy'

export const MAX_SITES = 200

/** The file of the project-less browser's sites: not a hex digest, so no folder's store id can be it. */
const PROJECTLESS_FILE = 'projectless'

/** Whether the text is an http(s) origin exactly as the policy serializes it: `https://Example.com/` is not. */
function isNormalizedOrigin(text: string): boolean {
  const target = normalizeTarget(text)
  return 'origin' in target && target.origin === text
}

const siteFileSchema = z.strictObject({
  version: z.literal(1),
  origins: z
    .array(z.string().refine(isNormalizedOrigin))
    .max(MAX_SITES)
    .refine((origins) => new Set(origins).size === origins.length)
})

export interface SiteStore {
  /** The folder's always-allowed origins (`folder` is its canonical path, null when project-less). */
  list(folder: string | null): Promise<string[]>
  /** Adds a normalized origin; anything else throws `invalid_input`, a 201st site `capacity_exceeded`. */
  add(folder: string | null, origin: string): Promise<string[]>
  /** Removes an origin; removing one that is not listed changes nothing. */
  remove(folder: string | null, origin: string): Promise<string[]>
}

/** The file's content parsed as a site list; undefined when it is missing, null when it is unreadable or not JSON. */
async function readSiteFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? undefined : null
  }
}

export function createSiteStore(options: {
  /** Absolute path of the sites directory (`<userData>/browser/sites`). */
  root: string
  log: (line: string) => void
  platform?: NodeJS.Platform
}): SiteStore {
  const platform = options.platform ?? process.platform
  const logged = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()

  const fileOf = (folder: string | null) =>
    join(options.root, `${folder === null ? PROJECTLESS_FILE : folderStoreId(folder, platform)}.json`)

  const read = async (file: string): Promise<string[]> => {
    const content = await readSiteFile(file)
    const result = siteFileSchema.safeParse(content)
    if (result.success || content === undefined) return result.data?.origins ?? []
    if (!logged.has(file)) {
      logged.add(file)
      options.log(`Browser site list ${file} is unreadable or not a version 1 site list; treating it as empty.`)
    }
    return []
  }

  /** Runs after every earlier change, so each change reads what the one before it wrote; an unchanged list is not rewritten. */
  const change = (folder: string | null, edit: (origins: string[]) => string[]): Promise<string[]> => {
    const file = fileOf(folder)
    const next = queue.then(async () => {
      const listed = await read(file)
      const origins = edit(listed)
      if (origins !== listed) await writePrivateFile(file, `${JSON.stringify({ version: 1, origins }, null, 2)}\n`, 0o600)
      return origins
    })
    queue = next.catch(() => undefined)
    return next
  }

  return {
    list: async (folder) => {
      await queue
      return read(fileOf(folder))
    },
    add: async (folder, origin) => {
      if (!isNormalizedOrigin(origin)) throw new DomainError('invalid_input', 'Only a normalized http or https origin can be always allowed.')
      return change(folder, (origins) => {
        if (origins.includes(origin)) return origins
        if (origins.length >= MAX_SITES) throw new DomainError('capacity_exceeded', `A folder can always allow at most ${MAX_SITES} sites.`)
        return [...origins, origin]
      })
    },
    remove: async (folder, origin) =>
      change(folder, (origins) => (origins.includes(origin) ? origins.filter((listed) => listed !== origin) : origins))
  }
}
