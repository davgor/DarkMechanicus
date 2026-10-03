import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Decides whether a set of changed repository paths needs a new app release.
 * Only inputs to the packaged app count: everything else (Dark Mechanicus records, docs, agent and
 * CI config, dev tooling) ships nothing, so it must not bump the version.
 * CLI: reads `git diff --name-only` output on stdin and prints `true` or `false`.
 */

/** Directories whose contents are built into the app (`skills/*.md` is bundled as MCP prompts). */
const RELEASE_DIRS = ['src', 'skills', 'build']

/** Root files that change the build, its dependencies, or the electron-builder config. */
const RELEASE_FILES = new Set([
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json'
])

const isReleasePath = (path) =>
  RELEASE_FILES.has(path) || RELEASE_DIRS.some((dir) => path.startsWith(`${dir}/`))

export function affectsRelease(paths) {
  return paths.some(isReleasePath)
}

export function parseChangedPaths(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

const isCli =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isCli) {
  process.stdout.write(String(affectsRelease(parseChangedPaths(readFileSync(0, 'utf8')))))
}
