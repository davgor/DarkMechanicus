/**
 * The sanctums: app-owned workspaces of project-less cults, `realpath(userData)/cults/<cultId>`
 * (`docs/design/cults.md`, section 5). The registry is persisted in `userData/cults/sanctums.json` and written only by
 * the cult create and delete paths (`create`, `remove`), from a cult id the cult store minted; nothing reaches it from
 * IPC input. `resolve(path)` is the one trusted predicate the untracked-folder gates consult after the Folders
 * registry (`folders.resolve(p) ?? sanctums.resolve(p)`): it answers the canonical path only for a registered sanctum
 * that still exists, directly under the sanctum root. A sanctum never joins the Folders list, project-less reach
 * grants or forge membership.
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../terminals/privateFile'

/** A cult id as the cult store mints it (`ct_<ulid>`): it names a directory, so nothing else is accepted. */
const CULT_ID = /^ct_[0-9a-z]{26}$/
const FILE_VERSION = 1
const fileSchema = z.object({ version: z.literal(FILE_VERSION), sanctums: z.array(z.string().regex(CULT_ID)) })

export interface SanctumRegistry {
  /** Creates (or finds) the cult's sanctum and registers it; answers its canonical path. */
  create(cultId: string): Promise<string>
  /** Unregisters the cult's sanctum and removes its directory; nothing for a cult without one. */
  remove(cultId: string): Promise<void>
  /** The canonical path of the registered, existing sanctum `path` names; null for anything else. */
  resolve(path: string): string | null
  /** The canonical paths of the registered sanctums that exist, for the mail sweep; never in the Folders list. */
  list(): string[]
  /** The sanctum path of a cult, registered or not; refuses anything but a cult id. */
  pathOf(cultId: string): string
}

/**
 * The one trusted predicate of the untracked-folder gates (`docs/design/cults.md`, section 5): a tracked folder, else a
 * registered sanctum. Only `resolve` is widened; listing, reach and forge membership keep reading the Folders registry.
 */
export function withSanctums<T extends { resolve(path: string): string | null }>(folders: T, sanctums: Pick<SanctumRegistry, 'resolve'>): T {
  return Object.assign(Object.create(folders) as T, { resolve: (path: string) => folders.resolve(path) ?? sanctums.resolve(path) })
}

function requireCultId(cultId: string): string {
  if (!CULT_ID.test(cultId)) throw new Error(`${JSON.stringify(cultId)} is not a cult id.`)
  return cultId
}

function loadIds(file: string): Set<string> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return new Set(parsed.success ? parsed.data.sanctums : [])
  } catch {
    return new Set()
  }
}

/** The canonical path of an existing directory; null for anything else. */
function existingDirectory(path: string): string | null {
  try {
    const real = realpathSync.native(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** The sanctum root, `realpath(userData)/cults`, made on first use. */
function sanctumRoot(userData: string): string {
  mkdirSync(userData, { recursive: true })
  return join(realpathSync.native(userData), 'cults')
}

export function createSanctumRegistry(options: { userData: string }): SanctumRegistry {
  const root = sanctumRoot(options.userData)
  const file = join(root, 'sanctums.json')
  const ids = loadIds(file)
  const save = (): Promise<void> => writePrivateFile(file, `${JSON.stringify({ version: FILE_VERSION, sanctums: [...ids].sort() })}\n`, 0o600)
  const pathOf = (cultId: string): string => join(root, requireCultId(cultId))
  return {
    pathOf,
    async create(cultId) {
      const path = pathOf(cultId)
      mkdirSync(path, { recursive: true, mode: 0o700 })
      ids.add(cultId)
      await save()
      return realpathSync.native(path)
    },
    async remove(cultId) {
      const path = pathOf(cultId)
      if (ids.delete(cultId)) await save()
      rmSync(path, { recursive: true, force: true })
    },
    resolve(path) {
      const real = existingDirectory(path)
      return real !== null && dirname(real) === root && ids.has(basename(real)) ? real : null
    },
    list: () => [...ids].sort().flatMap((id) => (existingDirectory(join(root, id)) === join(root, id) ? [join(root, id)] : []))
  }
}
