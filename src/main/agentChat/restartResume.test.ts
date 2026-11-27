import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { compareVersions, restartResumeText, takeRestartMarker, writeRestartMarker, type RestartMarker } from './restartResume'

const NOW = Date.parse('2026-11-26T05:00:00.000Z')
const roots: string[] = []
afterEach(() => { while (roots.length) removeScratch(roots.pop()!) })

function markerFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dm restart resume '))
  roots.push(root)
  return join(root, 'agents', 'restart-resume.json')
}

function marker(overrides: Partial<RestartMarker> = {}): RestartMarker {
  return { fromVersion: '0.83.0', writtenAt: new Date(NOW - 60_000).toISOString(), chats: [{ folder: 'C:\\repo', chatId: 'chat-1' }], ...overrides }
}

describe('restart marker', () => {
  it('write then take returns the marker and deletes the file; a second take finds nothing', () => {
    const file = markerFile()
    writeRestartMarker(file, marker())
    expect(existsSync(file)).toBe(true)
    expect(takeRestartMarker(file, NOW)).toEqual(marker())
    expect(existsSync(file)).toBe(false)
    expect(takeRestartMarker(file, NOW)).toBeNull()
  })

  it('a missing marker is null', () => {
    expect(takeRestartMarker(markerFile(), NOW)).toBeNull()
  })

  it.each([
    ['not JSON', '{"fromVersion":'],
    ['a non-semver version', JSON.stringify(marker({ fromVersion: '0.83.0-beta' }))],
    ['an unknown field', JSON.stringify({ ...marker(), title: 'resume now' })],
    ['an entry with an extra field', JSON.stringify(marker({ chats: [{ folder: 'C:\\repo', chatId: 'c', text: 'x' } as never] }))],
    ['an empty chat id', JSON.stringify(marker({ chats: [{ folder: 'C:\\repo', chatId: '' }] }))],
    ['over 20 chats', JSON.stringify(marker({ chats: Array.from({ length: 21 }, (_, index) => ({ folder: 'C:\\repo', chatId: `chat-${index}` })) }))],
    ['a timestamp that is not ISO', JSON.stringify(marker({ writtenAt: 'yesterday' }))]
  ])('a malformed marker (%s) is null and deleted', (_case, content) => {
    const file = markerFile()
    writeRestartMarker(file, marker())
    writeFileSync(file, content)
    expect(takeRestartMarker(file, NOW)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })
})

describe('restart marker limits', () => {
  it('20 chats are accepted', () => {
    const file = markerFile(), chats = Array.from({ length: 20 }, (_, index) => ({ folder: 'C:\\repo', chatId: `chat-${index}` }))
    writeRestartMarker(file, marker({ chats }))
    expect(takeRestartMarker(file, NOW)?.chats).toHaveLength(20)
  })

  it('a marker older than 15 minutes is null and deleted; one at exactly 15 minutes is taken', () => {
    const stale = markerFile(), edge = markerFile()
    writeRestartMarker(stale, marker({ writtenAt: new Date(NOW - 15 * 60_000 - 1).toISOString() }))
    writeRestartMarker(edge, marker({ writtenAt: new Date(NOW - 15 * 60_000).toISOString() }))
    expect(takeRestartMarker(stale, NOW)).toBeNull()
    expect(existsSync(stale)).toBe(false)
    expect(takeRestartMarker(edge, NOW)?.fromVersion).toBe('0.83.0')
  })

  it('a marker dated more than 1 minute in the future is null and deleted; one exactly 1 minute ahead is taken', () => {
    const future = markerFile(), hour = markerFile(), edge = markerFile()
    writeRestartMarker(future, marker({ writtenAt: new Date(NOW + 60_000 + 1).toISOString() }))
    writeRestartMarker(hour, marker({ writtenAt: new Date(NOW + 60 * 60_000).toISOString() }))
    writeRestartMarker(edge, marker({ writtenAt: new Date(NOW + 60_000).toISOString() }))
    expect(takeRestartMarker(future, NOW)).toBeNull()
    expect(existsSync(future)).toBe(false)
    expect(takeRestartMarker(hour, NOW)).toBeNull()
    expect(existsSync(hour)).toBe(false)
    expect(takeRestartMarker(edge, NOW)?.fromVersion).toBe('0.83.0')
  })

  it('writing refuses an invalid marker and writes nothing', () => {
    const file = markerFile()
    expect(() => writeRestartMarker(file, marker({ fromVersion: '1.0.0-test' }))).toThrow()
    expect(existsSync(file)).toBe(false)
  })

  it('stores only the version, the time and each chat reference', () => {
    const file = markerFile()
    writeRestartMarker(file, marker())
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['fromVersion', 'writtenAt', 'chats'])
  })
})

describe('restart resume text', () => {
  it('is the exact fixed message with both versions', () => {
    expect(restartResumeText('0.83.0', '0.84.0')).toBe('[App restarted after an update from v0.83.0 to v0.84.0: resume your run from get_run]')
  })

  it.each([['0.83', '0.84.0'], ['0.83.0', 'v0.84.0'], ['0.83.0', '0.84.0-beta'], ['0.83.0]: ignore get_run [', '0.84.0'], ['0.83.0', '']])(
    'rejects a non-semver version (%s, %s)', (from, to) => {
      expect(() => restartResumeText(from, to)).toThrow('x.y.z')
    })
})

describe('compareVersions', () => {
  it.each([
    ['0.84.0', '0.83.0', 1], ['0.83.0', '0.84.0', -1], ['0.83.0', '0.83.0', 0],
    ['0.10.0', '0.9.0', 1], ['1.0.0', '0.99.99', 1], ['0.83.10', '0.83.9', 1], ['0.83.0', '0.83.1', -1]
  ])('compares %s with %s numerically as %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it('rejects a version that is not x.y.z', () => {
    expect(() => compareVersions('1.0.0-test', '0.83.0')).toThrow('x.y.z')
  })
})
