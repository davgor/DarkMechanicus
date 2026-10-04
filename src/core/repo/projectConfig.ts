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
import { readProject } from './initialize'
import { displayPath } from './paths'
import { type ProjectRecord, projectRecord } from './portable'
import type { FsAdapter, RepoLayout } from './types'

interface ProjectEnv {
  layout: RepoLayout
  fs: FsAdapter
}

/**
 * Replaces the Definition of Done in `project.json` with `checks` and returns the record it wrote. An empty
 * list removes the key, so a project that clears its Definition of Done reads as one that never had it.
 * Invalid checks (a blank name or command, names that repeat ignoring case, too many) are refused with
 * `invalid_input` before anything is written.
 */
export function writeDefinitionOfDone(env: ProjectEnv, checks: z.input<typeof definitionOfDoneChecks>): ProjectRecord {
  const valid = parseInput(definitionOfDoneChecks, checks, 'Definition of Done')
  const project = readProject(env.layout, env.fs)
  if (project === null) {
    fail('not_initialized', `${displayPath(env.layout, env.layout.projectFile)} does not exist. Initialize the repository first.`)
  }
  const next = projectRecord.parse({ ...project, definitionOfDone: valid.length === 0 ? undefined : valid })
  writeFileSafely(env, env.layout.projectFile, prettyJson(next))
  return next
}
