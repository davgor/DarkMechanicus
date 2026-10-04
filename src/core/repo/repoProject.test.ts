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

  it('holds exactly the seven Definition of Done checks, in order, each with its npm command', () => {
    expect((record.definitionOfDone ?? []).map(({ name, command }) => ({ name, command }))).toEqual([
      { name: 'lint', command: 'npm run lint' },
      { name: 'typecheck', command: 'npm run typecheck' },
      { name: 'test', command: 'npm test' },
      { name: 'coverage', command: 'npm run coverage' },
      { name: 'fireguard', command: 'npm run fireguard' },
      { name: 'deadcode', command: 'npm run deadcode' },
      { name: 'build', command: 'npm run build' }
    ])
  })

  it('describes every check, and says fireguard is graded against the sprint start and reported by its own ticket', () => {
    const checks = record.definitionOfDone ?? []
    expect(checks.filter((item) => item.description.trim() === '')).toEqual([])
    const fireguard = checks.find((item) => item.name === 'fireguard')?.description ?? ''
    expect(fireguard).toContain('FIREGUARD_BASE_REF')
    expect(fireguard).toMatch(/start commit/i)
    expect(fireguard).toMatch(/acceptance node/i)
    expect(fireguard).toMatch(/Fireguard ticket/)
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
