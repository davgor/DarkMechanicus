import type { GitErrorShape, GitResult } from '../../../shared/git/api'

/** A failed `window.github` call surfaced to UI code: its code and the message main wrote for the person. */
export class GithubCommandError extends Error {
  readonly code: GitErrorShape['code']

  constructor(shape: GitErrorShape) {
    super(shape.message)
    this.name = 'GithubCommandError'
    this.code = shape.code
  }
}

/** Unwraps a `window.github` result: its data, or a thrown GithubCommandError. */
export async function callGithub<T>(call: Promise<GitResult<T>>): Promise<T> {
  const result = await call
  if (result.ok) {
    return result.data
  }
  throw new GithubCommandError(result.error)
}
