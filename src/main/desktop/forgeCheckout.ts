import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readForgeCheckout } from '../../core/repo/forgeCheckout'
import { readForgeReference } from '../../core/repo/forgeReference'
import { nodeFs } from '../../core/repo/nodeFs'
import type { ForgeGit } from './forgeGit'
import { githubRemote } from './forgeManifest'

export { readForgeCheckout } from '../../core/repo/forgeCheckout'

/** Shared by startup health and Source control; neither can silently select another repository. */
export async function verifyForgeCheckout(member: string, repository: string, git: Pick<ForgeGit, 'run'>): Promise<string | undefined> {
  const checkout = readForgeCheckout(member)
  if (!checkout) return undefined
  const root = (await git.run(checkout, ['rev-parse', '--show-toplevel'])).stdout.trim()
  if (realpathSync.native(root) !== checkout) throw new Error('The Forge World checkout hint must name the code repository root.')
  const origin = githubRemote((await git.run(checkout, ['remote', 'get-url', 'origin'])).stdout.trim())
  if (origin.toLowerCase() !== githubRemote(repository).toLowerCase()) throw new Error('The local code repository origin does not match its Forge World mapping. Reconnect the intended code checkout.')
  const reference = readForgeReference(nodeFs, checkout)
  if (reference) {
    const world = githubRemote((await git.run(dirname(member), ['remote', 'get-url', 'origin'])).stdout.trim())
    if (reference.worldRepository.toLowerCase() !== world.toLowerCase() || join(dirname(member), reference.projectFolder) !== member) throw new Error('The code repository configuration points to a different Forge World project.')
  }
  return checkout
}
