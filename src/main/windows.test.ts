import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN_DIR = fileURLToPath(new URL('.', import.meta.url))
const NEW_WINDOW = /\bnew\s+BrowserWindow\b/

/** Every production source file of the main process, keyed by its path relative to src/main. */
function mainSources(): [string, string][] {
  return readdirSync(MAIN_DIR, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .map((path): [string, string] => [path.split('\\').join('/'), readFileSync(join(MAIN_DIR, path), 'utf8')])
    .sort(([a], [b]) => a.localeCompare(b))
}

describe('app windows', () => {
  it('creates the main window only: a chat’s terminal is shown in it, never in a window of its own', () => {
    const sources = mainSources()
    expect(sources.filter(([, text]) => NEW_WINDOW.test(text)).map(([path]) => path)).toEqual(['index.ts'])
    expect(sources.find(([path]) => path === 'index.ts')?.[1].match(new RegExp(NEW_WINDOW, 'g'))).toHaveLength(1)
    expect(sources.filter(([path, text]) => path.startsWith('terminals/') && text.includes('BrowserWindow')).map(([path]) => path)).toEqual([])
  })
})
