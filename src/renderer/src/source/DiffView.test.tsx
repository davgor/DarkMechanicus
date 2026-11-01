// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffHunk, DiffLine, FileDiff } from '../../../shared/git/diff'
import { DiffView } from './DiffView'

afterEach(cleanup)

const line = (kind: DiffLine['kind'], text: string, numbers: [number | null, number | null], noNewlineAtEnd = false): DiffLine => ({
  kind,
  text,
  oldNumber: numbers[0],
  newNumber: numbers[1],
  noNewlineAtEnd
})

const base = { path: 'src/a.ts', oldPath: null, oldMode: null, newMode: null, hash: 'h' }

function textDiff(hunks: DiffHunk[]): FileDiff {
  return { ...base, kind: 'text', hunks }
}

const TWO_HUNKS = textDiff([
  {
    header: '@@ -1,3 +1,3 @@ function a()',
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [line('context', 'one', [1, 1]), line('delete', 'two', [2, null]), line('add', 'TWO', [null, 2]), line('context', 'three', [3, 3])]
  },
  {
    header: '@@ -10,2 +10,3 @@ class B',
    oldStart: 10,
    oldLines: 2,
    newStart: 10,
    newLines: 3,
    lines: [line('context', 'ten', [10, 10]), line('add', 'eleven', [null, 11]), line('context', 'twelve', [11, 12])]
  }
])

const idle = { loading: false, error: null }

describe('DiffView text diff', () => {
  it('renders each hunk header and every line with its old and new numbers', () => {
    render(<DiffView diff={TWO_HUNKS} {...idle} />)
    const table = screen.getByRole('table', { name: 'Diff of src/a.ts' })
    expect(within(table).getByText('@@ -1,3 +1,3 @@ function a()')).toBeTruthy()
    expect(within(table).getByText('@@ -10,2 +10,3 @@ class B')).toBeTruthy()
    const rows = [...table.querySelectorAll('tbody tr')]
    const numbers = rows.map((row) => [...row.querySelectorAll('.diff-num')].map((cell) => cell.textContent))
    expect(numbers).toEqual([
      [], // hunk 1 header
      ['1', '1'],
      ['2', ''],
      ['', '2'],
      ['3', '3'],
      [], // hunk 2 header
      ['10', '10'],
      ['', '11'],
      ['11', '12']
    ])
    expect(rows.map((row) => row.className)).toEqual([
      'diff-hunk',
      'diff-line diff-context',
      'diff-line diff-delete',
      'diff-line diff-add',
      'diff-line diff-context',
      'diff-hunk',
      'diff-line diff-context',
      'diff-line diff-add',
      'diff-line diff-context'
    ])
    expect(rows.slice(1, 4).map((row) => row.querySelector('.diff-marker [aria-hidden="true"]')?.textContent)).toEqual([' ', '-', '+'])
  })

  it('gives each changed line screen-reader text', () => {
    render(<DiffView diff={TWO_HUNKS} {...idle} />)
    expect(screen.getByText('removed line 2')).toBeTruthy()
    expect(screen.getByText('added line 2')).toBeTruthy()
    expect(screen.getByText('added line 11')).toBeTruthy()
  })

});

describe('DiffView text edge cases', () => {
  it('keeps whitespace, hides a trailing carriage return and marks a missing final newline', () => {
    const diff = textDiff([
      {
        header: '@@ -1,2 +1,2 @@',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [line('context', '\tindented  two\r', [1, 1]), line('add', 'last', [null, 2], true)]
      }
    ])
    const { container } = render(<DiffView diff={diff} {...idle} />)
    const code = [...container.querySelectorAll('.diff-text')].map((cell) => cell.textContent)
    expect(code[0]).toBe('\tindented  two')
    expect(code[0]).not.toContain('\r')
    expect(screen.getAllByText('No newline at end of file')).toHaveLength(1)
  })

  it('renders only the first 2,000 lines and shows the rest on request', () => {
    const lines = Array.from({ length: 2500 }, (_, i) => line('add', `l${i + 1}`, [null, i + 1]))
    const diff = textDiff([{ header: '@@ -0,0 +1,2500 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2500, lines }])
    const { container } = render(<DiffView diff={diff} {...idle} />)
    expect(container.querySelectorAll('tr.diff-line')).toHaveLength(2000)
    fireEvent.click(screen.getByRole('button', { name: 'Show 500 more lines' }))
    expect(container.querySelectorAll('tr.diff-line')).toHaveLength(2500)
    expect(screen.queryByRole('button', { name: /more lines/ })).toBeNull()
  })

  it('shows no button at exactly 2,000 lines', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => line('add', `l${i}`, [null, i + 1]))
    const diff = textDiff([{ header: '@@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2000, lines }])
    render(<DiffView diff={diff} {...idle} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('DiffView states', () => {
  it('asks for a file when none is selected', () => {
    render(<DiffView diff={null} {...idle} />)
    expect(screen.getByText('Select a file to see its changes')).toBeTruthy()
  })

  it('shows loading', () => {
    render(<DiffView diff={null} loading={true} error={null} />)
    expect(screen.getByText('Loading diff…')).toBeTruthy()
  })

  it('shows an error', () => {
    render(<DiffView diff={null} loading={false} error="git failed" />)
    expect(screen.getByRole('alert').textContent).toContain('git failed')
  })

  it('shows a binary file', () => {
    render(<DiffView diff={{ ...base, kind: 'binary' }} {...idle} />)
    expect(screen.getByText('Binary file changed')).toBeTruthy()
  })

  it('shows a too-large diff and Show anyway calls onShowLarge', () => {
    const onShowLarge = vi.fn()
    render(<DiffView diff={{ ...base, kind: 'too_large', bytes: 3 * 1024 * 1024 }} {...idle} onShowLarge={onShowLarge} />)
    expect(screen.getByText('This diff is large (3 MB)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show anyway' }))
    expect(onShowLarge).toHaveBeenCalledTimes(1)
  })

  it('omits Show anyway without a handler', () => {
    render(<DiffView diff={{ ...base, kind: 'too_large', bytes: 3 * 1024 * 1024 }} {...idle} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows an empty diff', () => {
    render(<DiffView diff={{ ...base, kind: 'empty' }} {...idle} />)
    expect(screen.getByText('No content changes: the file mode or name changed')).toBeTruthy()
  })
})
