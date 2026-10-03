import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parseRecord, profileRecord } from './portable'
import type { ProfileRecord } from './portable'
import { prettyJson } from '../canonical'

const profilesDir = resolve(__dirname, '../../..', '.darkmechanicus/profiles')

function readAndParseProfile(filename: string): { record: ProfileRecord; text: string } {
  const path = resolve(profilesDir, filename)
  const text = readFileSync(path, 'utf-8')
  const record = parseRecord(profileRecord, text, `${filename}`)
  return { record, text }
}

function serializeProfile(record: ProfileRecord): string {
  return prettyJson(record)
}

describe('Repository Profiles - Parse and Structure', () => {
  it('reads and validates core-implementation profile', () => {
    const { record } = readAndParseProfile('core-implementation.json')
    expect(record.name).toBe('core-implementation')
    expect(record.format).toBe('darkmechanicus.profile')
    expect(record.formatVersion).toBe(1)
  })

  it('reads and validates ui-implementation profile', () => {
    const { record } = readAndParseProfile('ui-implementation.json')
    expect(record.name).toBe('ui-implementation')
    expect(record.format).toBe('darkmechanicus.profile')
    expect(record.formatVersion).toBe(1)
  })

  it('reads and validates micro-change profile', () => {
    const { record } = readAndParseProfile('micro-change.json')
    expect(record.name).toBe('micro-change')
    expect(record.format).toBe('darkmechanicus.profile')
    expect(record.formatVersion).toBe(1)
  })
})

describe('Repository Profiles - Quality Preferences', () => {
  it('core-implementation has no quality preference', () => {
    const { record } = readAndParseProfile('core-implementation.json')
    expect(record.capability.preferences.quality).toBeNull()
  })

  it('ui-implementation has no quality preference', () => {
    const { record } = readAndParseProfile('ui-implementation.json')
    expect(record.capability.preferences.quality).toBeNull()
  })
})

describe('Repository Profiles - Micro-Change Profile', () => {
  it('has routine level, low effort, and low cost', () => {
    const { record } = readAndParseProfile('micro-change.json')
    expect(record.capability.reasoning.level).toBe('routine')
    expect(record.capability.reasoning.effort).toBe('low')
    expect(record.capability.preferences.cost).toBe('low')
  })

  it('has a non-empty one-line description', () => {
    const { record } = readAndParseProfile('micro-change.json')
    expect(record.description).toBeTruthy()
    expect(record.description).not.toContain('\n')
  })
})

describe('Repository Profiles - Vendor Neutrality', () => {
  it('no profile names a vendor or model', () => {
    const files = ['core-implementation.json', 'ui-implementation.json', 'micro-change.json']
    const vendorPatterns = /\b(claude|opus|sonnet|haiku|gpt|openai|anthropic|gemini|cursor|codex)\b/gi
    for (const file of files) {
      const { text } = readAndParseProfile(file)
      expect(text).not.toMatch(vendorPatterns)
    }
  })
})

describe('Repository Profiles - Serialization', () => {
  it('profiles round-trip through JSON serialization', () => {
    const files = ['core-implementation.json', 'ui-implementation.json', 'micro-change.json']
    for (const file of files) {
      const { record } = readAndParseProfile(file)
      const serialized = serializeProfile(record)
      const reparsed = parseRecord(profileRecord, serialized, `${file} (reserialized)`)
      expect(reparsed).toEqual(record)
    }
  })
})
