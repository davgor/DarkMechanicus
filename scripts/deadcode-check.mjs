/**
 * Fail when ts-prune reports new unused exports not listed in .tsprune-ignore.
 * Scans tsconfig.node.json (main/preload) and tsconfig.web.json (renderer). Both include src/shared, so an export is
 * dead only when every project that includes its file reports it: one the renderer never imports may be used by main.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IGNORE_PATH = join(ROOT, '.tsprune-ignore')
const PROJECTS = ['tsconfig.node.json', 'tsconfig.web.json']

/** @param {string} line */
export function normalizeTsPruneLine(line) {
  if (!line) return ''
  let normalized = line.replace(/^[^\w\\/]+/, '').trim()
  if (!normalized) return ''
  normalized = normalized.replace(/\\+/g, '/')
  normalized = normalized.replace(/\s*\([^)]*\)\s*$/, '')
  normalized = normalized.replace(/^\//, '')
  return normalized
}

/**
 * Baseline key for a normalized ts-prune line: `file - export`, line number dropped,
 * so an export that only moved within its file stays baselined.
 * @param {string} line
 */
export function baselineKey(line) {
  return line.replace(/^(.*?):\d+(?= - )/, '$1')
}

/** @param {string} path */
export function readIgnoreSet(path) {
  if (!existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim()
        return trimmed.length > 0 && !trimmed.startsWith('#')
      })
      .map((line) => baselineKey(normalizeTsPruneLine(line)))
      .filter(Boolean)
  )
}

/**
 * Normalized ts-prune lines whose file + export is not in the baseline.
 * @param {string[]} lines
 * @param {Set<string>} ignore
 */
export function findNewDeadExports(lines, ignore) {
  return lines.filter((line) => !ignore.has(baselineKey(line)))
}

/**
 * The files a tsconfig project includes, from the TypeScript API, as paths relative to `root` with forward slashes
 * (the form ts-prune reports).
 * @param {string} project
 * @param {string} [root]
 */
export function projectFiles(project, root = ROOT) {
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    }
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, project), {}, host)
  if (parsed === undefined) throw new Error(`Cannot read ${project}.`)
  return new Set(parsed.fileNames.map((file) => relative(root, file).split('\\').join('/')))
}

/**
 * The exports dead in every project that includes their file, one line each (as the first project reporting it wrote it).
 * An export one project reports and another project including the same file does not is used there.
 * @param {{ lines: string[], files: Set<string> }[]} reports normalized ts-prune lines and included files, per project
 */
export function deadInEveryProject(reports) {
  const reported = reports.map(({ lines }) => new Set(lines.map(baselineKey)))
  const dead = new Map()
  reports.forEach(({ lines }, index) => {
    for (const line of lines) {
      const key = baselineKey(line)
      const file = key.slice(0, key.indexOf(' - '))
      const everywhere = reports.every(({ files }, other) => other === index || !files.has(file) || reported[other].has(key))
      if (everywhere && !dead.has(key)) dead.set(key, line)
    }
  })
  return [...dead.values()]
}

/** @param {string} project */
function runTsPrune(project) {
  const result = spawnSync('npx', ['ts-prune', '--project', project], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim()
    throw new Error(stderr || `ts-prune failed for ${project} with exit code ${result.status}`)
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => normalizeTsPruneLine(line))
    .filter(Boolean)
}

/** The exports ts-prune finds dead in every scanned project that includes their file. */
export function collectDeadExports() {
  return deadInEveryProject(PROJECTS.map((project) => ({ lines: runTsPrune(project), files: projectFiles(project) })))
}

function main() {
  const findings = findNewDeadExports(collectDeadExports(), readIgnoreSet(IGNORE_PATH))

  if (findings.length > 0) {
    console.error('New dead exports detected:')
    for (const line of findings) {
      console.error(line)
    }
    process.exit(1)
  }

  console.log('No new dead exports found.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
