/** The Skitarii theme is the one file the app adds under OMP's folder; nothing of the person's is read or changed. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKITARII_THEME_NAME, installSkitariiTheme, skitariiThemeFile } from './ompSkitariiTheme'

let agentDir: string
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'omp-agent-'))
})
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
})

const themePath = (): string => join(agentDir, 'themes', `${SKITARII_THEME_NAME}.json`)

describe('installSkitariiTheme', () => {
  it('adds themes/skitarii.json and nothing else, leaving the default theme setting and other themes as they are', async () => {
    const config = 'theme:\n  dark: dark-nord\n'
    writeFileSync(join(agentDir, 'config.yml'), config)
    mkdirSync(join(agentDir, 'themes'))
    writeFileSync(join(agentDir, 'themes', 'mine.json'), '{"name":"mine"}')
    const before = statSync(join(agentDir, 'config.yml')).mtimeMs

    await installSkitariiTheme(agentDir)

    expect(JSON.parse(readFileSync(themePath(), 'utf8'))).toEqual(skitariiThemeFile)
    expect(readFileSync(join(agentDir, 'config.yml'), 'utf8')).toBe(config)
    expect(statSync(join(agentDir, 'config.yml')).mtimeMs).toBe(before)
    expect(readFileSync(join(agentDir, 'themes', 'mine.json'), 'utf8')).toBe('{"name":"mine"}')
    expect(readdirSync(agentDir).sort()).toEqual(['config.yml', 'themes'])
    expect(readdirSync(join(agentDir, 'themes')).sort()).toEqual(['mine.json', 'skitarii.json'])
  })

  it('creates the folder on a fresh install, replaces a stale copy and leaves a current one untouched', async () => {
    await installSkitariiTheme(agentDir)
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(themePath(), old, old)

    await installSkitariiTheme(agentDir)
    expect(statSync(themePath()).mtime).toEqual(old)

    writeFileSync(themePath(), '{"name":"stale"}')
    await installSkitariiTheme(agentDir)
    expect(JSON.parse(readFileSync(themePath(), 'utf8'))).toEqual(skitariiThemeFile)
  })

  it('does not reject when the folder cannot be written: the chat starts in OMP\'s own look', async () => {
    const blocked = join(agentDir, 'file')
    writeFileSync(blocked, 'x')

    await expect(installSkitariiTheme(blocked)).resolves.toBeUndefined()
  })
})
