/**
 * Member activity from fixture transcripts on the real disk, on a fake clock: nothing waits on wall time. A spy over the
 * file reads records every path the tracker touches, so a non-member's transcript beside the members' is never read.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../terminals/__mocks__/terminalSessionsRig'
import { ompFilePaths } from '../terminals/ompSession'
import { ACTIVITY_THROTTLE_MS, type ActivityFiles, createMemberActivity, type MemberActivityTracker, reduceTarget } from './memberActivity'

/** A 5 KB tool input full of control characters. */
const RAW = `pattern\u0000\u001b[31m\r\n${'\u0007a\tb'.repeat(1300)}`

/** Whether any character is a C0 or C1 control (checked by code point, so no control-character regex is needed). */
function hasControl(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 0x20 || (char.charCodeAt(0) >= 0x7f && char.charCodeAt(0) <= 0x9f))
}

const BASE = Date.parse('2026-11-27T09:00:00.000Z')
const SESSION = '2026-11-27T09-00-00-000Z_01a2183e-671f-77a4-af4f-4626eb9fee75.jsonl'
const MAGOS = 'chat_magos'
const ACOLYTE = 'chat_acolyte'
const STRANGER = 'chat_stranger'

interface Fixture {
  userData: string
  clock: FakeClock
  reads: string[]
  changes: string[]
  tracker: MemberActivityTracker
}

let f: Fixture

const toolCall = (name: string, args: unknown) => ({
  type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking' }, { type: 'toolCall', id: 't1', name, arguments: args }] }
})

function writeTranscript(chatId: string, entries: unknown[]): string {
  const { sessionDir } = ompFilePaths(f.userData, chatId)
  mkdirSync(sessionDir, { recursive: true })
  const path = join(sessionDir, SESSION)
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  return path
}

function writeStatus(chatId: string, state: string): void {
  writeFileSync(join(dirname(ompFilePaths(f.userData, chatId).config), 'cult-status.json'), JSON.stringify({ state, since: 'x' }))
}

/** Real disk reads, each path recorded. */
function spyFiles(reads: string[]): ActivityFiles {
  return {
    list: (dir) => {
      reads.push(dir)
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    tail: (path) => {
      reads.push(path)
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
  }
}

beforeEach(() => {
  const clock = new FakeClock()
  const reads: string[] = []
  const changes: string[] = []
  const userData = mkdtempSync(join(tmpdir(), 'dm-activity-'))
  const tracker = createMemberActivity({
    userData, files: spyFiles(reads),
    clock: { now: () => new Date(BASE + clock.now).toISOString(), after: (callback, ms) => clock.after(callback, ms) }
  })
  tracker.onChange((runId) => changes.push(runId))
  f = { userData, clock, reads, changes, tracker }
})

afterEach(() => {
  f.tracker.dispose()
  expect(f.clock.pending).toBe(0)
  rmSync(f.userData, { recursive: true, force: true })
})

describe('member activity: tool targets', () => {
  it('projects an edit tool as its name and the path\'s last two segments', () => {
    writeTranscript(MAGOS, [toolCall('Edit', { path: '/repo/src/renderer/src/cults/CultPage.tsx', old_text: 'secret', new_text: 'x' })])
    f.tracker.track('run_1', MAGOS)
    f.clock.advance(ACTIVITY_THROTTLE_MS)

    expect(f.tracker.of(MAGOS)).toEqual({ working: true, tool: { name: 'edit', target: 'cults/CultPage.tsx' }, at: new Date(BASE + ACTIVITY_THROTTLE_MS).toISOString() })
    expect(f.changes).toEqual(['run_1'])
  })

  it('projects a shell tool as the first 40 characters of its command', () => {
    const command = 'npm run test -- src/main/cults/memberActivity.test.ts --reporter=verbose'
    writeTranscript(MAGOS, [toolCall('bash', { command, env: { TOKEN: 'secret' } })])
    f.tracker.track('run_1', MAGOS)
    f.clock.advance(ACTIVITY_THROTTLE_MS)

    expect(f.tracker.of(MAGOS)?.tool).toEqual({ name: 'bash', target: command.slice(0, 40) })
  })

  it('projects a search tool as its pattern and anything else as no target', () => {
    expect(reduceTarget('grep', { pattern: 'cults:event', path: '/home/secret' })).toBe('cults:event')
    expect(reduceTarget('ask', { question: 'secret' })).toBe('')
  })

  it('cuts a 5 KB input with control characters to at most 80 characters with none left, never the raw input', () => {
    expect(RAW.length).toBeGreaterThan(5000)
    writeTranscript(MAGOS, [toolCall('grep', { pattern: RAW })])
    f.tracker.track('run_1', MAGOS)
    f.clock.advance(ACTIVITY_THROTTLE_MS)

    const target = f.tracker.of(MAGOS)?.tool?.target ?? ''
    expect(target.length).toBeLessThanOrEqual(80)
    expect(hasControl(target)).toBe(false)
    expect(target).not.toBe(RAW)
  })

  it('reduces every kind of tool input to at most 80 characters without controls', () => {
    for (const tool of ['edit', 'bash', 'grep']) {
      const reduced = reduceTarget(tool, { path: RAW, command: RAW, pattern: RAW })
      expect(reduced.length).toBeLessThanOrEqual(80)
      expect(hasControl(reduced)).toBe(false)
    }
  })
})

describe('member activity: working, throttling and lifetime', () => {
  it('takes working from cult-status.json over the transcript, and idle from a finished turn', () => {
    writeTranscript(MAGOS, [toolCall('read', { path: 'a/b/c.ts' }), { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text' }] } }])
    f.tracker.track('run_1', MAGOS)
    f.clock.advance(ACTIVITY_THROTTLE_MS)
    expect(f.tracker.of(MAGOS)).toMatchObject({ working: false, tool: { name: 'read', target: 'b/c.ts' } })

    writeStatus(MAGOS, 'working')
    f.clock.advance(ACTIVITY_THROTTLE_MS)
    expect(f.tracker.of(MAGOS)?.working).toBe(true)
  })

  it('coalesces updates within 2 s into one per member', () => {
    writeTranscript(MAGOS, [toolCall('read', { path: 'a/one.ts' })])
    f.tracker.track('run_1', MAGOS)
    f.clock.advance(ACTIVITY_THROTTLE_MS)
    for (const name of ['two', 'three', 'four']) {
      writeTranscript(MAGOS, [toolCall('read', { path: `a/${name}.ts` })])
      f.clock.advance(ACTIVITY_THROTTLE_MS / 4)
    }
    expect(f.changes).toHaveLength(1)
    expect(f.tracker.of(MAGOS)?.tool?.target).toBe('a/one.ts')

    f.clock.advance(ACTIVITY_THROTTLE_MS)
    expect(f.changes).toHaveLength(2)
    expect(f.tracker.of(MAGOS)?.tool?.target).toBe('a/four.ts')
  })

  it('stops tracking when the run ends: no timer left and no file read after', () => {
    writeTranscript(MAGOS, [toolCall('read', { path: 'a/one.ts' })])
    f.tracker.track('run_1', MAGOS)
    f.clock.advance(ACTIVITY_THROTTLE_MS)
    f.tracker.endRun('run_1')

    expect(f.tracker.polling()).toBe(false)
    expect(f.clock.pending).toBe(0)
    expect(f.tracker.of(MAGOS)).toBeNull()
    const before = f.reads.length
    f.clock.advance(10 * ACTIVITY_THROTTLE_MS)
    expect(f.reads).toHaveLength(before)
  })
})

describe('member activity: only members are read', () => {
  it('never reads a non-member\'s transcript', () => {
    writeTranscript(MAGOS, [toolCall('read', { path: 'a/one.ts' })])
    writeTranscript(ACOLYTE, [toolCall('bash', { command: 'ls' })])
    const stranger = writeTranscript(STRANGER, [toolCall('bash', { command: 'cat secrets' })])
    f.tracker.track('run_1', MAGOS)
    f.tracker.track('run_1', ACOLYTE)
    f.clock.advance(5 * ACTIVITY_THROTTLE_MS)

    expect(f.tracker.of(ACOLYTE)?.tool).toEqual({ name: 'bash', target: 'ls' })
    expect(f.reads.length).toBeGreaterThan(0)
    expect(f.reads.filter((path) => path.includes(STRANGER))).toEqual([])
    expect(f.reads.every((path) => path.includes(MAGOS) || path.includes(ACOLYTE))).toBe(true)
    expect(f.tracker.of(STRANGER)).toBeNull()
    expect(stranger).toContain(STRANGER)
  })
})

describe('member activity: the real disk reader', () => {
  it('reads the tail of a session file and closes it', () => {
    const tracker = createMemberActivity({ userData: f.userData, clock: { now: () => new Date(BASE + f.clock.now).toISOString(), after: (callback, ms) => f.clock.after(callback, ms) } })
    writeTranscript(MAGOS, [{ type: 'message', message: { role: 'user', content: 'x'.repeat(70_000) } }, toolCall('write', { path: 'C:\\repo\\docs\\notes.md' })])
    tracker.track('run_1', MAGOS)
    f.clock.advance(ACTIVITY_THROTTLE_MS)
    expect(tracker.of(MAGOS)?.tool).toEqual({ name: 'write', target: 'docs/notes.md' })
    tracker.dispose()
    expect(tracker.polling()).toBe(false)
  })
})
