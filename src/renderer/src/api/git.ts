import type { GitErrorShape, GitResult } from '../../../shared/git/api'

/** A structured git failure surfaced to UI code. */
export class GitCommandError extends Error {
  readonly code: GitErrorShape['code']
  readonly detail: string | undefined

  constructor(shape: GitErrorShape) {
    super(shape.message)
    this.name = 'GitCommandError'
    this.code = shape.code
    this.detail = shape.detail
  }
}

/** Unwraps a `window.git` result: its data, or a thrown GitCommandError. */
export async function callGit<T>(call: Promise<GitResult<T>>): Promise<T> {
  const result = await call
  if (result.ok) {
    return result.data
  }
  throw new GitCommandError(result.error)
}
