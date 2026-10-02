import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const FORBIDDEN = /^(?:node:)?(?:fs|path|child_process)(?:\/|$)|^(?:electron|original-fs)(?:\/|$)/

/** `src`-relative path with forward slashes on every platform. */
function shown(file: string): string {
  return relative(SRC, file).split(sep).join('/')
}

function resolveModule(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier.replace(/\?raw$/, ''))
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base].find((path) => existsSync(path) && path.endsWith('.ts')) ?? null
}

/** Every module reachable from `entries` through relative imports, with the specifiers each imports. */
function importClosure(entries: string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const queue = entries.map((entry) => join(SRC, entry))
  while (queue.length > 0) {
    const file = queue.shift() ?? ''
    if (seen.has(file)) {
      continue
    }
    const specifiers = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.map((item) => item.fileName)
    seen.set(file, specifiers)
    const local = specifiers.filter((specifier) => specifier.startsWith('.'))
    queue.push(...local.map((specifier) => resolveModule(file, specifier)).filter((path) => path !== null))
  }
  return seen
}

function forbiddenImports(entries: string[]): string[] {
  return [...importClosure(entries)].flatMap(([file, specifiers]) =>
    specifiers.filter((specifier) => FORBIDDEN.test(specifier)).map((specifier) => `${shown(file)} -> ${specifier}`)
  )
}

describe('board module purity', () => {
  it('imports no file-system, path, process or Electron module in the parser or mapping, directly or indirectly', () => {
    const closure = [...importClosure(['core/board/parse.ts', 'core/board/plan.ts']).keys()].map(shown)
    expect(closure).toEqual(expect.arrayContaining(['core/board/parse.ts', 'core/board/plan.ts', 'core/schemas.ts']))
    expect(forbiddenImports(['core/board/parse.ts', 'core/board/plan.ts'])).toEqual([])
  })

  it('would catch such an import: the file adapter itself reads through one', () => {
    expect(forbiddenImports(['core/repo/nodeFs.ts'])).toEqual(['core/repo/nodeFs.ts -> node:fs'])
  })
})
