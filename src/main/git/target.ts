import type { SourceControlTarget } from '../../shared/git/api'
import type { TrackedFolderView } from '../../shared/desktop/api'
import { join } from 'node:path'
import { GitInputError } from './errors'
import { refuseSwappedFolder } from '../agents/launchFolder'
import { hasForgeManifest } from '../desktop/forgeContext'
import { verifyForgeCheckout } from '../desktop/forgeCheckout'
import { FORGE_REPOSITORY_GUIDANCE } from '../desktop/forgeDirections'
import { ForgeGit } from '../desktop/forgeGit'
import { forgeProjectFor } from '../desktop/forgeManifest'
import type { GitRunner } from './runner'

/** Callers authorize the tracked identity first; only its validated local binding can select untracked code. */
export async function sourceControlTarget(tracked: string, runner: GitRunner, folders?: readonly TrackedFolderView[]): Promise<SourceControlTarget> {
  refuseSwappedFolder(tracked)
  const project = mappedProject(tracked, folders)
  if (!project) return { kind: 'available', path: tracked, displayPath: tracked }
  const unavailable = (reason: string): SourceControlTarget => ({ kind: 'unavailable', repository: project.repository, reason, directions: FORGE_REPOSITORY_GUIDANCE })
  try {
    const checkout = await verifyForgeCheckout(tracked, project.repository, new ForgeGit({ getAccount: () => null, getToken: () => null }, runner))
    return checkout === undefined
      ? unavailable('This code repository is not downloaded or linked on this computer. Open its local checkout in Dark Mechanicus after cloning it when needed.')
      : { kind: 'available', path: checkout, displayPath: checkout, repository: project.repository }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'The linked code checkout could not be verified.')
  }
}

function mappedProject(tracked: string, folders: readonly TrackedFolderView[] = []) {
  const view = folders.find(folder => folder.path === tracked)
  if (view?.forgeParent) {
    const parent = view.forgeParent
    const world = folders.find(folder => folder.path === parent)?.forgeWorld
    const project = world?.projects.find(entry => join(parent, entry.folder) === tracked)
    if (!project) throw new GitInputError('This Forge World project has no valid repository mapping. Repair its Forge World metadata before using Source control.')
    return project
  }
  return view?.forgeWorld || hasForgeManifest(tracked) ? undefined : forgeProjectFor(tracked)
}
