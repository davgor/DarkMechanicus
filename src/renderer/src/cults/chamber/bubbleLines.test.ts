import { describe, expect, it } from 'vitest'
import { activityLine, drawQuip, IDLE_QUIPS, mailLine, QUIP_GAP_MS, QUIP_IDLE_MS, quipDue } from './bubbleLines'
import { BUBBLE_MAX_CHARS } from './chamberState'

const length = (text: string): number => [...text].length

describe('bubbleLines: activity', () => {
  it('phrases each tool kind with its Mechanicus template', () => {
    expect(activityLine({ name: 'edit', target: 'cults/CultPage.tsx' })).toBe('Sanctifying cults/CultPage.tsx')
    expect(activityLine({ name: 'write', target: 'gerry/index.html' })).toBe('Sanctifying gerry/index.html')
    expect(activityLine({ name: 'read', target: 'docs/cults.md' })).toBe('Consulting the archive: docs/cults.md')
    expect(activityLine({ name: 'bash', target: 'npm run typecheck' })).toBe('Invoking the rite of npm run typecheck')
    expect(activityLine({ name: 'grep', target: 'useChamberLog' })).toBe('Scrying the noosphere for useChamberLog')
    expect(activityLine({ name: 'web_search', target: 'omnissiah' })).toBe('Scrying the noosphere for omnissiah')
  })

  it('falls back to "Using {tool}" for another tool, or a known tool without a target', () => {
    expect(activityLine({ name: 'todo_write', target: '' })).toBe('Using todo_write')
    expect(activityLine({ name: 'lsp', target: 'whatever' })).toBe('Using lsp')
    expect(activityLine({ name: 'edit', target: '   ' })).toBe('Using edit')
    expect(activityLine({ name: 'constructor', target: 'x' })).toBe('Using constructor')
  })

  it('caps the line at the bubble limit with an ellipsis', () => {
    const line = activityLine({ name: 'bash', target: 'x'.repeat(80) })
    expect(length(line)).toBe(BUBBLE_MAX_CHARS)
    expect(line.endsWith('…')).toBe(true)
    expect(line.startsWith('Invoking the rite of xxx')).toBe(true)
  })

  it('keeps markup literal and turns control characters into spaces', () => {
    expect(activityLine({ name: 'edit', target: '<img src=x onerror=alert(1)>' })).toBe('Sanctifying <img src=x onerror=alert(1)>')
    expect(activityLine({ name: 'bash', target: 'echo\u001b[31m hi\nrm' })).toBe('Invoking the rite of echo [31m hi rm')
  })
})

describe('bubbleLines: mail', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(mailLine('\n  \r\n  Draft the shrine layout.  \nThen the tickets.')).toBe('Draft the shrine layout.')
    expect(mailLine(' \n\t\n')).toBeNull()
  })

  it('caps the line at 60 characters and keeps markup as typed', () => {
    const line = mailLine(`${'a'.repeat(70)}\nsecond`)!
    expect(BUBBLE_MAX_CHARS).toBe(60)
    expect(length(line)).toBe(60)
    expect(line).toBe(`${'a'.repeat(59)}…`)
    expect(mailLine('<b>Not bold</b> **not markdown**')).toBe('<b>Not bold</b> **not markdown**')
  })
})

describe('bubbleLines: idle quips', () => {
  it('has at least 12 plain one-line quips, each within the bubble limit', () => {
    expect(IDLE_QUIPS.length).toBeGreaterThanOrEqual(12)
    expect(IDLE_QUIPS).toEqual(expect.arrayContaining(['Praise the Omnissiah', '*whirr*', 'Who touched my cogitator?']))
    for (const quip of IDLE_QUIPS) {
      expect(length(quip)).toBeLessThanOrEqual(BUBBLE_MAX_CHARS)
      expect(quip).not.toMatch(/[<>\n]/)
    }
  })

  it('is due after 20 s idle, then at most once every 30 s', () => {
    expect(QUIP_IDLE_MS).toBe(20_000)
    expect(QUIP_GAP_MS).toBe(30_000)
    expect(quipDue({ idleSince: null, lastQuipAt: null }, 1e9)).toBe(false)
    expect(quipDue({ idleSince: 0, lastQuipAt: null }, 19_999)).toBe(false)
    expect(quipDue({ idleSince: 0, lastQuipAt: null }, 20_000)).toBe(true)
    expect(quipDue({ idleSince: 0, lastQuipAt: 20_000 }, 49_999)).toBe(false)
    expect(quipDue({ idleSince: 0, lastQuipAt: 20_000 }, 50_000)).toBe(true)
  })

  it('draws the same quips from the same seed and spreads over the table', () => {
    const draws = (seed: number, count: number): string[] => {
      const out: string[] = []
      let state = seed
      for (let index = 0; index < count; index += 1) {
        const [quip, next] = drawQuip(state)
        out.push(quip)
        state = next
      }
      return out
    }
    expect(draws(42, 20)).toEqual(draws(42, 20))
    expect(draws(42, 20)).not.toEqual(draws(43, 20))
    expect(new Set(draws(7, 200)).size).toBe(IDLE_QUIPS.length)
  })
})
