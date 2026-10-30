/** This repository's own `.darkmechanicus/project.json`: the Definition of Done every sprint's acceptance node must prove. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prettyJson } from '../canonical'
import { parseRecord, projectRecord } from './portable'

const PROJECT_FILE = fileURLToPath(new URL('../../../.darkmechanicus/project.json', import.meta.url))
const text = readFileSync(PROJECT_FILE, 'utf8').replace(/\r\n/g, '\n')
const record = parseRecord(projectRecord, text, '.darkmechanicus/project.json')

describe("this repository's project record", () => {
  it('is valid, and keeps its identity', () => {
    expect(record).toMatchObject({ format: 'darkmechanicus.project', formatVersion: 1, keyPrefix: 'DM', name: 'DarkMechanicus' })
  })

  it('holds exactly the six Definition of Done checks, in order, each with its npm command', () => {
    expect((record.definitionOfDone ?? []).map(({ name, command }) => ({ name, command }))).toEqual([
      { name: 'lint', command: 'npm run lint' },
      { name: 'typecheck', command: 'npm run typecheck' },
      { name: 'test', command: 'npm test' },
      { name: 'coverage', command: 'npm run coverage' },
      { name: 'deadcode', command: 'npm run deadcode' },
      { name: 'build', command: 'npm run build' }
    ])
  })

  it('describes every check', () => {
    expect((record.definitionOfDone ?? []).filter((item) => item.description.trim() === '')).toEqual([])
  })

  it('names every command after a script that package.json defines', () => {
    const scripts = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as {
      scripts: Record<string, string>
    }).scripts
    for (const { command } of record.definitionOfDone ?? []) {
      const script = command === 'npm test' ? 'test' : command.replace(/^npm run /, '')
      expect(Object.keys(scripts), command).toContain(script)
    }
  })

  it('is written exactly as the app writes a project record: sorted keys, two-space indent, one trailing newline', () => {
    expect(text).toBe(prettyJson(record))
  })
})
