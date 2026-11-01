// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { DiffLine, FileDiff } from '../../../shared/git/diff'
import { DiffView } from './DiffView'

afterEach(cleanup)

const line = (kind: DiffLine['kind'], text: string, numbers: [number | null, number | null]): DiffLine => ({
  kind,
  text,
  oldNumber: numbers[0],
  newNumber: numbers[1],
  noNewlineAtEnd: false
})

/** Changed lines are numbered 0 (removed line 2), 1 (added line 2), 2 (added line 11), 3 (added line 12). */
const DIFF: FileDiff = {
  path: 'src/a.ts',
  oldPath: null,
  oldMode: null,
  newMode: null,
  hash: 'h',
  kind: 'text',
  hunks: [
    {
      header: '@@ -1,3 +1,3 @@ function a()',
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [line('context', 'one', [1, 1]), line('delete', 'two', [2, null]), line('add', 'TWO', [null, 2]), line('context', 'three', [3, 3])]
    },
    {
      header: '@@ -10,2 +10,4 @@ class B',
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: 4,
      lines: [line('context', 'ten', [10, 10]), line('add', 'eleven', [null, 11]), line('add', 'twelve', [null, 12]), line('context', 'end', [11, 13])]
    }
  ]
}

const idle = { loading: false, error: null }

function mount(selected: number[]): Mock {
  const onToggle = vi.fn()
  render(<DiffView diff={DIFF} {...idle} selection={{ selected: new Set(selected), onToggle }} />)
  return onToggle
}

const check = (name: string): HTMLElement => screen.getByRole('checkbox', { name })
const rowOf = (name: string): HTMLElement => check(name).closest('tr') as HTMLElement

describe('DiffView line selection', () => {
  it('shows each changed line checked or not and dims the excluded ones', () => {
    mount([0, 2])
    expect(screen.getAllByRole('checkbox', { name: /^Include (added|removed) line/ })).toHaveLength(4)
    expect(check('Include removed line 2').getAttribute('aria-checked')).toBe('true')
    expect(check('Include added line 2').getAttribute('aria-checked')).toBe('false')
    expect(check('Include added line 11').getAttribute('aria-checked')).toBe('true')
    expect(rowOf('Include added line 2').classList.contains('diff-excluded')).toBe(true)
    expect(rowOf('Include removed line 2').classList.contains('diff-excluded')).toBe(false)
    expect(screen.getByText('one').closest('tr')?.classList.contains('diff-excluded')).toBe(false)
  })

  it('toggles a line when its gutter is clicked, the line numbers included', () => {
    const onToggle = mount([0, 2])
    fireEvent.mouseDown(check('Include added line 2'))
    fireEvent.mouseUp(window)
    expect(onToggle).toHaveBeenLastCalledWith([1], true)
    const numberCell = rowOf('Include removed line 2').querySelector('.diff-num') as HTMLElement
    fireEvent.mouseDown(numberCell)
    fireEvent.mouseUp(window)
    expect(onToggle).toHaveBeenLastCalledWith([0], false)
    fireEvent.mouseDown(screen.getByText('TWO'))
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('sets a dragged range to the toggled state of its first line, until the button is released', () => {
    const onToggle = mount([0, 1, 2, 3])
    fireEvent.mouseDown(check('Include added line 2'))
    expect(onToggle).toHaveBeenLastCalledWith([1], false)
    fireEvent.mouseEnter(check('Include added line 12'), { buttons: 1 })
    expect(onToggle).toHaveBeenLastCalledWith([1, 2, 3], false)
    fireEvent.mouseEnter(check('Include removed line 2'), { buttons: 1 })
    expect(onToggle).toHaveBeenLastCalledWith([0, 1], false)
    fireEvent.mouseUp(window)
    fireEvent.mouseEnter(check('Include added line 11'), { buttons: 1 })
    expect(onToggle).toHaveBeenCalledTimes(3)
  })

  it('ends a drag whose button was released outside the window', () => {
    const onToggle = mount([0, 1, 2, 3])
    fireEvent.mouseDown(check('Include added line 2'))
    fireEvent.mouseEnter(check('Include added line 11'))
    fireEvent.mouseEnter(check('Include added line 12'), { buttons: 1 })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('ignores a right-click on the gutter', () => {
    const onToggle = mount([])
    fireEvent.mouseDown(check('Include added line 2'), { button: 2 })
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('DiffView hunk and keyboard selection', () => {
  it('toggles a whole hunk from its header gutter: all in when some are out, all out when all are in', () => {
    const onToggle = mount([0, 2, 3])
    expect(check('Include hunk @@ -1,3 +1,3 @@ function a()').getAttribute('aria-checked')).toBe('mixed')
    expect(check('Include hunk @@ -10,2 +10,4 @@ class B').getAttribute('aria-checked')).toBe('true')
    fireEvent.mouseDown(check('Include hunk @@ -1,3 +1,3 @@ function a()'))
    expect(onToggle).toHaveBeenLastCalledWith([0, 1], true)
    fireEvent.mouseDown(check('Include hunk @@ -10,2 +10,4 @@ class B'))
    expect(onToggle).toHaveBeenLastCalledWith([2, 3], false)
  })

  it('shows a hunk with nothing included as unchecked', () => {
    mount([0, 1])
    expect(check('Include hunk @@ -10,2 +10,4 @@ class B').getAttribute('aria-checked')).toBe('false')
  })

  it('toggles the focused line or hunk with Space, and nothing with other keys', () => {
    const onToggle = mount([1])
    const removed = check('Include removed line 2')
    expect(removed.tabIndex).toBe(0)
    fireEvent.keyDown(removed, { key: ' ' })
    expect(onToggle).toHaveBeenLastCalledWith([0], true)
    fireEvent.keyDown(check('Include added line 2'), { key: ' ' })
    expect(onToggle).toHaveBeenLastCalledWith([1], false)
    fireEvent.keyDown(check('Include hunk @@ -10,2 +10,4 @@ class B'), { key: ' ' })
    expect(onToggle).toHaveBeenLastCalledWith([2, 3], true)
    fireEvent.keyDown(removed, { key: 'a' })
    expect(onToggle).toHaveBeenCalledTimes(3)
  })
})

describe('DiffView without a selection', () => {
  it('is read-only: no checkboxes, nothing dimmed, and the gutter does nothing', () => {
    const { container } = render(<DiffView diff={DIFF} {...idle} />)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(container.querySelectorAll('.diff-excluded')).toHaveLength(0)
    expect(container.querySelectorAll('.diff-check')).toHaveLength(0)
  })
})
