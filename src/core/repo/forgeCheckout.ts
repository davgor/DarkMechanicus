import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { FORGE_POINTER, assertForgeTransferIdle, boundForgeRoot, forgeBindingEpoch, isForgeMember } from './forgeBinding'
import { FORGE_FILE, forgeWorldAt, githubRemote } from './forgeManifest'
import { FORGE_CONFIG, readForgeReference } from './forgeReference'
import { gitCheckoutStamp, isUntrackedLocalGitPath, readLocalGitOrigin } from './git'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import type { FsAdapter } from './types'

const hintSchema = z.strictObject({ checkout: z.string().refine(isAbsolute) })

function checkoutHintPath(member: string): string {
  return join(resolveLayout(member).localDir, 'source-checkout.json')
}

function ordinaryDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== resolve(path)) throw new Error('The Forge World checkout path moved or uses a symbolic link. Reconnect its code repository.')
}

function hintedCheckout(file: string): string | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The Forge World checkout hint must be an ordinary file.')
  try {
    const hint = hintSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    return resolve(hint.checkout)
  } catch {
    throw new Error('The Forge World checkout hint must contain an absolute local directory.')
  }
}

/** Missing checkouts are normal on another computer; malformed hints are not trusted. */
export function readForgeCheckout(member: string): string | undefined {
  const local = join(member, '.darkmechanicus', 'local')
  const file = checkoutHintPath(member)
  for (const path of [member, join(member, '.darkmechanicus'), local]) {
    if (!existsSync(path)) return undefined
    ordinaryDirectory(path)
  }
  const checkout = hintedCheckout(file)
  if (!checkout || !existsSync(checkout)) return undefined
  ordinaryDirectory(checkout)
  requireOutsideWorld(member, checkout)
  return checkout
}

function requireOutsideWorld(member: string, checkout: string): void {
  const fromWorld = relative(dirname(member), checkout)
  if (!isAbsolute(fromWorld) && fromWorld !== '..' && !fromWorld.startsWith('..' + sep)) {
    throw new Error('The code checkout must be outside its Forge World ticket repository.')
  }
}

export function privateForgeSourceHint(member: string): string | undefined {
  const { localDir } = resolveLayout(member)
  const hint = checkoutHintPath(member)
  if (!nodeFs.exists(hint) && !nodeFs.isSymlink(hint)) return undefined
  const world = dirname(member)
  // This picker consumes only the selected member's machine-private area. World-wide import/sync validation remains separate.
  if (!isUntrackedLocalGitPath(world, relative(world, localDir).split(sep).join('/'))) throw new Error('The Forge World checkout hint must be machine-private.')
  return readForgeCheckout(member)
}

function checkoutFor(member: string, boundSource: string | undefined): string {
  const hint = privateForgeSourceHint(member)
  if (hint !== undefined && boundSource !== undefined && hint !== boundSource) {
    throw new Error('The Forge World checkout hint points to a different local code checkout.')
  }
  const path = checkoutHintPath(member)
  if (hint === undefined && (boundSource === undefined || nodeFs.exists(path) || nodeFs.isSymlink(path))) {
    throw new Error('This Forge World project has no available local code checkout.')
  }
  const checkout = hint ?? boundSource!
  ordinaryDirectory(checkout)
  requireOutsideWorld(member, checkout)
  return checkout
}

function matchingOrigin(root: string, expected: string): boolean {
  const origin = readLocalGitOrigin(root)
  return origin !== null && githubRemote(origin).toLowerCase() === expected.toLowerCase()
}

/** A damaged Forge mapping must never quietly become an ordinary checkout. */
export function isForgeCodeMember(fs: FsAdapter, member: string): boolean {
  if (isForgeMember(fs, member)) return true
  if (fs.exists(join(member, '.git'))) return false
  const manifest = join(dirname(member), FORGE_FILE)
  const hint = checkoutHintPath(member)
  return fs.exists(manifest) || fs.isSymlink(manifest) || fs.exists(hint) || fs.isSymlink(hint)
}

interface ForgeCheckoutVerification {
  root: string
  assertCurrent(): void
}

function fileVersion(path: string): (string | boolean | null)[] {
  return [nodeFs.fileStamp(path), nodeFs.isSymlink(path), nodeFs.exists(path)]
}

function worldVersion(world: string, member: string): string {
  const hint = checkoutHintPath(member)
  for (const path of [member, join(member, '.darkmechanicus'), dirname(hint)]) {
    if (nodeFs.exists(path) || nodeFs.isSymlink(path)) ordinaryDirectory(path)
  }
  return JSON.stringify([gitCheckoutStamp(world, true), fileVersion(join(world, FORGE_FILE)), fileVersion(hint)])
}

function codeVersion(checkout: string, home: string): string {
  return JSON.stringify([
    gitCheckoutStamp(checkout, false), forgeBindingEpoch(nodeFs, home, checkout),
    fileVersion(join(checkout, FORGE_CONFIG)), fileVersion(join(checkout, FORGE_POINTER))
  ])
}

function validateCodeOrigin(checkout: string, expected: string, world: string, member: string): void {
  if (!matchingOrigin(checkout, expected)) {
    throw new Error('The local code checkout origin does not match the Forge World project mapping.')
  }
  const reference = readForgeReference(nodeFs, checkout)
  if (reference === undefined || reference.projectFolder !== basename(member) || !matchingOrigin(world, reference.worldRepository)) {
    throw new Error('The code checkout configuration does not match this Forge World project.')
  }
}

/** Resolve code verification from the world's mapping and this machine's checkout, never from submitted evidence. */
export function forgeCodeCheckout(member: string, home: string, boundSource: string | undefined): ForgeCheckoutVerification {
  const world = dirname(member)
  const worldBefore = worldVersion(world, member)
  const project = forgeWorldAt(world)?.projects.find((item) => item.folder === basename(member))
  if (project === undefined) throw new Error('The Forge World manifest no longer maps this ticket project.')
  const checkout = checkoutFor(member, boundSource)
  const codeBefore = codeVersion(checkout, home)
  assertForgeTransferIdle(nodeFs, home, checkout)
  const hasBinding = boundSource !== undefined || forgeBindingEpoch(nodeFs, home, checkout) !== null
  if (hasBinding && boundForgeRoot(nodeFs, home, checkout) !== member) {
    throw new Error('The code checkout is bound to a different Forge World ticket project.')
  }
  validateCodeOrigin(checkout, project.repository, world, member)

  const assertCurrent = (): void => {
    assertForgeTransferIdle(nodeFs, home, checkout)
    if (worldVersion(world, member) !== worldBefore || codeVersion(checkout, home) !== codeBefore) {
      throw new Error('The Forge World checkout or its mapping changed during code verification.')
    }
  }
  assertCurrent()
  return { root: checkout, assertCurrent }
}
