import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { assertForgeTransferIdle, boundForgeRoot, forgeBindingEpoch } from '../../core/repo/forgeBinding'
import { privateForgeSourceHint } from '../../core/repo/forgeCheckout'
import { readForgeReference } from '../../core/repo/forgeReference'
import { readLocalGitOrigin } from '../../core/repo/git'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { assertContained } from '../../core/repo/paths'
import type { TrackedFolderView } from '../../shared/desktop/api'
import { forgeWorldAt } from './forgeContext'
import { githubRemote } from './forgeManifest'

export const forgeSourceMappingSchema = z.strictObject({
  member: z.string().refine(isAbsolute),
  sourceRepository: z.string(),
  worldRepository: z.string()
})
export type ForgeSourceMapping = z.infer<typeof forgeSourceMappingSchema>
export { privateForgeSourceHint } from '../../core/repo/forgeCheckout'

function normalizedOrigin(root: string): string | null {
  const origin = readLocalGitOrigin(root)
  return origin === null ? null : githubRemote(origin).toLowerCase()
}

function ticketWorld(folder: TrackedFolderView): string | undefined {
  const { path, forgeParent } = folder
  return forgeParent && folder.available && folder.initialized && folder.storageMode === 'repo' && dirname(path) === forgeParent
    ? forgeParent : undefined
}

function isOutsideWorld(world: string, source: string): boolean {
  const location = relative(world, source)
  return isAbsolute(location) || location === '..' || location.startsWith('..' + sep)
}

function containsTicketStore(member: string): boolean {
  const layout = resolveLayout(member)
  const { projectFile, dbFile, machineFile, kanbanDir } = layout
  for (const path of [projectFile, dbFile, dbFile + '-wal', dbFile + '-shm', machineFile, kanbanDir]) assertContained(layout, nodeFs, path)
  return nodeFs.fileStamp(projectFile) !== null && nodeFs.realpath(projectFile) === projectFile
}

function availableMember(source: string, dmHome: string, folder: TrackedFolderView, origin: Omit<ForgeSourceMapping, 'member'>): boolean {
  const { path } = folder
  const world = ticketWorld(folder)
  if (world === undefined || !isOutsideWorld(world, source)) return false
  assertForgeTransferIdle(nodeFs, dmHome, path)
  if (boundForgeRoot(nodeFs, dmHome, path) !== path) return false
  const project = forgeWorldAt(world)?.projects.find(item => item.folder === basename(path))
  if (project?.repository.toLowerCase() !== origin.sourceRepository || normalizedOrigin(world) !== origin.worldRepository) return false
  if (!containsTicketStore(path)) return false
  const hint = privateForgeSourceHint(path)
  return hint === undefined || hint === source
}

/** Resolve only an explicit source against the tracked world's current manifest and the source's own reference. */
export function inspectForgeSource(source: string, dmHome: string, folders: () => readonly TrackedFolderView[]): ForgeSourceMapping | undefined {
  const reference = readForgeReference(nodeFs, source)
  if (reference === undefined) {
    // A stale local binding or retirement must never turn a migrated source into a standalone checkout.
    assertForgeTransferIdle(nodeFs, dmHome, source)
    if (forgeBindingEpoch(nodeFs, dmHome, source) !== null) throw new Error('The Forge World reference is missing.')
    return undefined
  }
  assertForgeTransferIdle(nodeFs, dmHome, source)
  const sourceRepository = normalizedOrigin(source)
  const worldRepository = reference.worldRepository.toLowerCase()
  if (sourceRepository === null) throw new Error('The code checkout has no verifiable Git origin.')
  const origin = { sourceRepository, worldRepository }
  const bound = forgeBindingEpoch(nodeFs, dmHome, source) === null ? undefined : boundForgeRoot(nodeFs, dmHome, source)
  const matching = folders().filter(folder => basename(folder.path) === reference.projectFolder && (bound === undefined || folder.path === bound))
  const members = matching.filter(folder => {
    try { return availableMember(source, dmHome, folder, origin) } catch { return false }
  })
  if (members.length !== 1) throw new Error('The code checkout must match one tracked, initialized Forge World project. Open its Forge World and reconnect the intended local code checkout.')
  return { member: members[0].path, ...origin }
}
