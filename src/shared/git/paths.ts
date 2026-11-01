/** Folder path comparison shared by main and renderer. Renderer-safe: no Node imports. */

/**
 * Whether two paths name the same folder, such as a git root from `rev-parse --show-toplevel`
 * (forward slashes on Windows) and a tracked folder's canonical path. Slash style and trailing
 * slashes never matter; case does not matter on a Windows drive path. Main can pass `realpath`
 * to resolve links first; a path it cannot resolve is compared as given.
 */
export function sameFolder(a: string, b: string, realpath?: (path: string) => string): boolean {
  const left = clean(resolve(a, realpath))
  const right = clean(resolve(b, realpath))
  const windows = /^[a-z]:/i
  return windows.test(left) || windows.test(right) ? left.toLowerCase() === right.toLowerCase() : left === right
}

function resolve(path: string, realpath?: (path: string) => string): string {
  if (realpath === undefined) return path
  try {
    return realpath(path)
  } catch {
    return path
  }
}

function clean(path: string): string {
  const slashes = path.replace(/\\/g, '/')
  const trimmed = slashes.replace(/\/+$/, '')
  if (trimmed === '') return slashes === '' ? '' : '/'
  return /^[a-z]:$/i.test(trimmed) ? `${trimmed}/` : trimmed
}
