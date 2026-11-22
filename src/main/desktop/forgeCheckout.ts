import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { readForgeReference } from '../../core/repo/forgeReference'
import { nodeFs } from '../../core/repo/nodeFs'
import type { ForgeGit } from './forgeGit'
import { githubRemote } from './forgeManifest'

function ordinaryDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== resolve(path)) throw new Error('The Forge World checkout path moved or uses a symbolic link. Reconnect its code repository.')
}

function hintedCheckout(file: string): string | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The Forge World checkout hint must be an ordinary file.')
  const hint = z.strictObject({ checkout: z.string().refine(isAbsolute, 'The checkout hint needs an absolute local directory.') }).parse(JSON.parse(readFileSync(file, 'utf8')))
  return resolve(hint.checkout)
}

/** Missing checkouts are normal on another computer; malformed hints are not trusted. */
export function readForgeCheckout(member: string): string | undefined {
  const local = join(member, '.darkmechanicus', 'local')
  const file = join(local, 'source-checkout.json')
  for (const path of [member, join(member, '.darkmechanicus'), local]) {
    if (!existsSync(path)) return undefined
    ordinaryDirectory(path)
  }
  const checkout = hintedCheckout(file)
  if (!checkout || !existsSync(checkout)) return undefined
  ordinaryDirectory(checkout)
  const fromWorld = relative(dirname(member), checkout)
  if (!isAbsolute(fromWorld) && fromWorld !== '..' && !fromWorld.startsWith('..' + sep)) throw new Error('The code checkout must be outside its Forge World ticket repository.')
  return checkout
}

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
