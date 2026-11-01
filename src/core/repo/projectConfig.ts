/**
 * Changes to the tracked project record, `.darkmechanicus/project.json`. It is written the way the rest of the
 * app writes records (sorted keys, two-space indent, one trailing newline, atomic replace), and only here
 * and at initialization, so a person's own edits to it stay the single source of the project's configuration.
 */
import type { z } from 'zod'
import { prettyJson } from '../canonical'
import { fail } from '../errors'
import { definitionOfDoneChecks, parseInput } from '../schemas'
import { writeFileSafely } from './finalizer'
import { detectRepositories, readProject } from './initialize'
import { displayPath } from './paths'
import { type ProjectRecord, projectRecord, type RepositoryEntry } from './portable'
import type { FsAdapter, RepoLayout } from './types'

interface ProjectEnv {
  layout: RepoLayout
  fs: FsAdapter
}

/**
 * Replaces a Definition of Done in `project.json` with `checks` and returns the record it wrote. In a single
 * repository that is the project's list, and `repo` is refused; in a folder of repositories it is the list of
 * repository `repo`, which is then required (the folder has no list of its own). An empty list removes the key,
 * so a project or repository that clears its Definition of Done reads as one that never had it. Invalid checks
 * (a blank name or command, names that repeat ignoring case, too many) and an unknown `repo` are refused with
 * `invalid_input` before anything is written.
 */
export function writeDefinitionOfDone(
  env: ProjectEnv,
  checks: z.input<typeof definitionOfDoneChecks>,
  repo?: string
): ProjectRecord {
  const valid = parseInput(definitionOfDoneChecks, checks, 'Definition of Done')
  const project = readProject(env.layout, env.fs)
  if (project === null) {
    fail('not_initialized', `${displayPath(env.layout, env.layout.projectFile)} does not exist. Initialize the repository first.`)
  }
  const definitionOfDone = valid.length === 0 ? undefined : valid
  const next = projectRecord.parse(
    project.repositories === undefined
      ? { ...project, definitionOfDone: projectLevel(env, repo, definitionOfDone) }
      : { ...project, repositories: withRepositoryChecks(project.repositories, repo, definitionOfDone) }
  )
  writeFileSafely(env, env.layout.projectFile, prettyJson(next))
  return next
}

/** The project-level list of a single repository, refusing a `repo`: there is no child repository to name. */
function projectLevel<T>(env: ProjectEnv, repo: string | undefined, definitionOfDone: T): T {
  if (repo !== undefined) {
    fail('invalid_input', `${env.layout.root} is a single repository, not a folder of repositories: set its Definition of Done without repo.`, {
      repo
    })
  }
  return definitionOfDone
}

/** `entries` with repository `repo`'s checks replaced, refusing a missing or unknown `repo`. */
function withRepositoryChecks(
  entries: RepositoryEntry[],
  repo: string | undefined,
  definitionOfDone: RepositoryEntry['definitionOfDone']
): RepositoryEntry[] {
  if (repo === undefined) {
    fail('invalid_input', 'This project is a folder of repositories, which has no Definition of Done of its own: name the repository (repo) whose checks to set.')
  }
  if (!entries.some((entry) => entry.name === repo)) {
    fail('invalid_input', `This folder of repositories has no repository ${JSON.stringify(repo)}.`, { repo })
  }
  return entries.map((entry) => (entry.name === repo ? { ...entry, definitionOfDone } : entry))
}

/** What a rescan changed: the names it appended and the names it found missing, plus the record it wrote. */
interface RepositoryRescan {
  project: ProjectRecord
  added: string[]
  missing: string[]
}

/**
 * Re-detects the child repositories of a folder of repositories and rewrites `repositories` in `project.json`:
 * new folders are appended, recorded ones that are gone get `missing: true`, and returning ones lose it. No
 * entry is ever removed. A single-repository project (no `repositories` key) is refused with `invalid_input`.
 */
export function rescanRepositories(env: ProjectEnv): RepositoryRescan {
  const project = readProject(env.layout, env.fs)
  if (project === null) {
    fail('not_initialized', `${displayPath(env.layout, env.layout.projectFile)} does not exist. Initialize the repository first.`)
  }
  const recorded = project.repositories
  if (recorded === undefined) {
    fail('invalid_input', `${env.layout.root} is a single repository, not a folder of repositories: there is nothing to rescan.`)
  }
  const found = new Set(detectRepositories(env.layout.root, env.fs))
  // Keep everything else recorded for a repository (its Definition of Done) through a rescan; only `missing` changes.
  const kept = recorded.map((entry) => ({ ...entry, missing: found.has(entry.name) ? undefined : (true as const) }))
  const known = new Set(recorded.map((entry) => entry.name))
  const added = [...found].filter((name) => !known.has(name))
  const next = projectRecord.parse({ ...project, repositories: [...kept, ...added.map((name) => ({ name }))] })
  writeFileSafely(env, env.layout.projectFile, prettyJson(next))
  return { project: next, added, missing: kept.filter((entry) => entry.missing === true).map((entry) => entry.name) }
}
