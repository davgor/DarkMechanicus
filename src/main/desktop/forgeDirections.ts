import { lstatSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FORGE_DIRECTIONS = 'FORGE-REPOSITORIES.md'

/** Portable guidance reads the manifest instead of duplicating links that can become stale. */
export const FORGE_REPOSITORY_GUIDANCE = [
  'This Forge World stores tickets, plans and history. Its project folders are ticket stores, not source-code checkouts.',
  'Read forge-world.json: each projects entry names the ticket folder in folder and its GitHub clone URL in repository. Read the current manifest whenever projects change.',
  'Obtain a repository only when the task needs its code. Reuse a local checkout after verifying its Git origin matches the repository URL.',
  'A project may record a machine-local checkout in <ticket folder>/.darkmechanicus/local/source-checkout.json as {"checkout":"absolute path"}. That hint is private to this computer and may be absent or stale.',
  'If no matching checkout exists, choose a new code directory outside the Forge World and clone the repository there. Never clone into or overwrite a ticket folder. Use the existing Git authentication; do not put credentials in URLs or in this world.',
  'After cloning, keep code edits and code tests in the code checkout, and use the ticket folder for Dark Mechanicus commands. Follow the code repository’s own setup instructions. Record the checkout only in the machine-local source-checkout.json, never in the portable manifest.',
  'Opening this Forge World does not download every code repository. The agent clones only the repositories needed for the current task.'
].join('\n\n')

/** Preserve custom directions; refuse a link rather than writing through it. */
export function ensureForgeDirections(root: string): void {
  const file = join(root, FORGE_DIRECTIONS)
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Forge World repository directions must be an ordinary file.')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    writeFileSync(file, '# Forge World repositories\n\n' + FORGE_REPOSITORY_GUIDANCE + '\n', { flag: 'wx' })
  }
}
