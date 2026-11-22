import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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

const start = '<!-- darkmechanicus:forge-repositories:v1:start -->'
const end = '<!-- darkmechanicus:forge-repositories:end -->'
const managed = /<!-- darkmechanicus:forge-repositories:v\d+:start -->[\s\S]*?<!-- darkmechanicus:forge-repositories:end -->/g

function currentDirections(existing: string): string {
  const block = start + '\n## Repository checkout instructions\n\n' + FORGE_REPOSITORY_GUIDANCE + '\n' + end
  const matches = existing.match(managed)
  if (existing.includes('<!-- darkmechanicus:forge-repositories:')) {
    if (matches?.length !== 1 || existing.replace(managed, '').includes('<!-- darkmechanicus:forge-repositories:')) throw new Error('The Forge World directions have a malformed managed section. Repair its markers before updating.')
    return existing.replace(managed, block)
  }
  const oldGenerated = '# Forge World repositories\n\n' + FORGE_REPOSITORY_GUIDANCE + '\n'
  if (existing.replace(/\r\n/g, '\n') === oldGenerated || existing === '') return '# Forge World repositories\n\n' + block + '\n'
  return existing + '\n\n' + block + '\n'
}

function replaceDirections(file: string, before: string, after: string): void {
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, after, { flag: 'wx' })
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(file, 'utf8') !== before) throw new Error('Forge World directions changed during their update. Reopen the world to check them again.')
    renameSync(temporary, file)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Upgrade only the marked app-owned section; custom prose remains byte-for-byte intact. */
export function ensureForgeDirections(root: string): void {
  const file = join(root, FORGE_DIRECTIONS)
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Forge World repository directions must be an ordinary file.')
    const before = readFileSync(file, 'utf8')
    const after = currentDirections(before)
    if (after !== before) replaceDirections(file, before, after)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    writeFileSync(file, currentDirections(''), { flag: 'wx' })
  }
}
