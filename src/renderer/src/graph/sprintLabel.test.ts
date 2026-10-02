import { describe, expect, it } from 'vitest'
import { sprintLabelSize } from './sprintLabel'

function goalLines(goal: string): number {
  return sprintLabelSize(goal, 'detail', false).goalLines
}

describe('sprint label goal lines', () => {
  it('fits up to 20 characters on one line and wraps the 21st', () => {
    expect(goalLines('x'.repeat(20))).toBe(1)
    expect(goalLines(`${'x'.repeat(10)} ${'y'.repeat(9)}`)).toBe(1)
    expect(goalLines(`${'x'.repeat(10)} ${'y'.repeat(10)}`)).toBe(2)
  })

  it('wraps greedily at word boundaries', () => {
    expect(goalLines('Authoring through MCP')).toBe(2)
    expect(goalLines('one two three four five six seven')).toBe(2)
    expect(goalLines('one two three four five six seven eight nine ten eleven twelve')).toBe(4)
  })

  it('breaks a word longer than a line, as overflow-wrap: anywhere does', () => {
    expect(goalLines('x'.repeat(21))).toBe(2)
    expect(goalLines('x'.repeat(40))).toBe(2)
    expect(goalLines('x'.repeat(41))).toBe(3)
    expect(goalLines(`ab ${'x'.repeat(25)}`)).toBe(3)
    expect(goalLines(`${'x'.repeat(25)} ab`)).toBe(2)
    expect(goalLines(`${'x'.repeat(25)} abcdefghijklmn`)).toBe(2)
    expect(goalLines(`${'x'.repeat(25)} abcdefghijklmno`)).toBe(3)
  })

  it('collapses runs of whitespace and counts an empty goal as one line', () => {
    expect(goalLines('')).toBe(1)
    expect(goalLines('   ')).toBe(1)
    expect(goalLines(`  ${'x'.repeat(10)} \n\n  ${'y'.repeat(9)}  `)).toBe(1)
  })

  it('caps the goal at six lines however long it is', () => {
    expect(goalLines('x'.repeat(120))).toBe(6)
    expect(goalLines('x'.repeat(121))).toBe(6)
    expect(goalLines('word '.repeat(300))).toBe(6)
  })
})

describe('sprint label height', () => {
  it('stacks the heading, the goal and the detail on 18px lines', () => {
    expect(sprintLabelSize('Storage foundation', '3 tickets', false)).toEqual({ goalLines: 1, height: 54 })
    expect(sprintLabelSize('x'.repeat(41), '3 tickets', false)).toEqual({ goalLines: 3, height: 90 })
  })

  it('counts a detail that wraps onto a second line', () => {
    expect(sprintLabelSize('Goal', 'Active · 1 of 4 accepted', false)).toEqual({ goalLines: 1, height: 72 })
    expect(sprintLabelSize('Goal', 'Waiting on checkpoint 2', false).height).toBe(72)
    expect(sprintLabelSize('Goal', 'Awaiting checkpoint', false).height).toBe(54)
  })

  it('adds the + Ticket button (a 6px gap and a 24px control) only when asked', () => {
    expect(sprintLabelSize('Goal', '3 tickets', true).height - sprintLabelSize('Goal', '3 tickets', false).height).toBe(30)
  })

  it('tops out at the heading, six goal lines and the detail', () => {
    expect(sprintLabelSize('x'.repeat(2000), '3 tickets', false).height).toBe(18 + 6 * 18 + 18)
    expect(sprintLabelSize('x'.repeat(2000), '3 tickets', true).height).toBe(18 + 6 * 18 + 18 + 30)
  })
})
