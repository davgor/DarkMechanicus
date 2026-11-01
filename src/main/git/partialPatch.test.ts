import { describe, expect, it } from 'vitest'
import { changedLineIndices, type FileDiff } from '../../shared/git/diff'
import { parseUnifiedDiff } from './diffParser'
import { buildPartialPatch } from './partialPatch'

type TextDiff = Extract<FileDiff, { kind: 'text' }>

function textDiff(lines: string[]): TextDiff {
  const diff = parseUnifiedDiff(`${lines.join('\n')}\n`)
  if (diff.kind !== 'text') {
    throw new Error('expected a text diff')
  }
  return diff
}

const patch = (diff: TextDiff, selected: number[]): string | null => buildPartialPatch(diff, new Set(selected))
const text = (lines: string[]): string => `${lines.join('\n')}\n`

const MODIFIED_HEADER = ['diff --git a/f.txt b/f.txt', 'index 1111111..2222222 100644', '--- a/f.txt', '+++ b/f.txt']
const PATCH_HEADER = ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt']

const MIXED = textDiff([...MODIFIED_HEADER, '@@ -1,4 +1,4 @@ ctx', ' a', '-b', '-c', '+B', '+C', ' d'])

describe('changedLineIndices', () => {
  it('numbers add and delete lines in order across hunks, and leaves context unnumbered', () => {
    const diff = textDiff([...MODIFIED_HEADER, '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -10,2 +10,2 @@', '-x', '+y', ' z'])
    expect(changedLineIndices(diff)).toEqual([
      [null, 0, 1, null],
      [2, 3, null]
    ])
  })
})

describe('buildPartialPatch', () => {
  it('returns null when nothing is selected', () => {
    expect(patch(MIXED, [])).toBeNull()
  })

  it('keeps selected lines, drops unselected additions and turns unselected deletions into context', () => {
    expect(patch(MIXED, [0, 3])).toBe(text([...PATCH_HEADER, '@@ -1,4 +1,4 @@', ' a', '-b', ' c', '+C', ' d']))
  })

  it('keeps additions only', () => {
    expect(patch(MIXED, [2, 3])).toBe(text([...PATCH_HEADER, '@@ -1,4 +1,6 @@', ' a', ' b', ' c', '+B', '+C', ' d']))
  })

  it('keeps deletions only', () => {
    expect(patch(MIXED, [0, 1])).toBe(text([...PATCH_HEADER, '@@ -1,4 +1,2 @@', ' a', '-b', '-c', ' d']))
  })

  it('reproduces the whole diff when every line is selected', () => {
    expect(patch(MIXED, [0, 1, 2, 3])).toBe(text([...PATCH_HEADER, '@@ -1,4 +1,4 @@', ' a', '-b', '-c', '+B', '+C', ' d']))
  })

  it('drops hunks with no selected change and shifts later hunks by the earlier ones', () => {
    const diff = textDiff([
      ...MODIFIED_HEADER,
      '@@ -1,2 +1,4 @@', ' a', '+n1', '+n2', ' b',
      '@@ -5,2 +7,2 @@', '-x', '+X', ' y',
      '@@ -10,3 +12,1 @@', ' p', '-q', '-r'
    ])
    expect(patch(diff, [0, 5])).toBe(text([...PATCH_HEADER, '@@ -1,2 +1,3 @@', ' a', '+n1', ' b', '@@ -10,3 +11,2 @@', ' p', ' q', '-r']))
    expect(patch(diff, [3])).toBe(text([...PATCH_HEADER, '@@ -5,2 +5,3 @@', ' x', '+X', ' y']))
  })

  it('counts a pure insertion hunk from the line it follows', () => {
    const diff = textDiff([...MODIFIED_HEADER, '@@ -0,0 +1,2 @@', '+top', '+top2', '@@ -3,0 +6,1 @@', '+mid'])
    expect(patch(diff, [0, 2])).toBe(text([...PATCH_HEADER, '@@ -0,0 +1,1 @@', '+top', '@@ -3,0 +5,1 @@', '+mid']))
  })

  it('writes CRLF lines byte-exact', () => {
    const diff = textDiff([...MODIFIED_HEADER, '@@ -1,2 +1,2 @@', ' a\r', '-b\r', '+B\r'])
    expect(patch(diff, [1])).toBe(text([...PATCH_HEADER, '@@ -1,2 +1,3 @@', ' a\r', ' b\r', '+B\r']))
  })
})

describe('buildPartialPatch with a missing final newline', () => {
  const NO_NEWLINE = '\\ No newline at end of file'
  const diff = textDiff([...MODIFIED_HEADER, '@@ -1,2 +1,2 @@', ' a', '-b', NO_NEWLINE, '+c', NO_NEWLINE])

  it('keeps the marker after a deletion that becomes context', () => {
    expect(patch(diff, [])).toBeNull()
    const other = textDiff([...MODIFIED_HEADER, '@@ -1,3 +1,2 @@', '-a', ' b', '-c', NO_NEWLINE, '+C', NO_NEWLINE])
    expect(patch(other, [0])).toBe(text([...PATCH_HEADER, '@@ -1,3 +1,2 @@', '-a', ' b', ' c', NO_NEWLINE]))
  })

  it('keeps the marker after a selected deletion when the addition is dropped', () => {
    expect(patch(diff, [0])).toBe(text([...PATCH_HEADER, '@@ -1,2 +1,1 @@', ' a', '-b', NO_NEWLINE]))
  })

  it('re-adds an unterminated old last line with a newline when a selected addition follows it', () => {
    expect(patch(diff, [1])).toBe(text([...PATCH_HEADER, '@@ -1,2 +1,3 @@', ' a', '-b', NO_NEWLINE, '+b', '+c', NO_NEWLINE]))
  })

  it('adds a final newline when only the new line ending is selected', () => {
    const fix = textDiff([...MODIFIED_HEADER, '@@ -1,2 +1,2 @@', ' a', '-b', NO_NEWLINE, '+b'])
    expect(patch(fix, [0, 1])).toBe(text([...PATCH_HEADER, '@@ -1,2 +1,2 @@', ' a', '-b', NO_NEWLINE, '+b']))
  })
})

describe('buildPartialPatch headers', () => {
  it('creates a partly selected new file with only the selected lines', () => {
    const diff = textDiff(['diff --git a/n.txt b/n.txt', 'new file mode 100755', 'index 0000000..1111111', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,3 @@', '+1', '+2', '+3'])
    expect(patch(diff, [0, 2])).toBe(text(['diff --git a/n.txt b/n.txt', 'new file mode 100755', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+1', '+3']))
  })

  it('turns a partly selected deleted file into a modification, and keeps a fully selected one a deletion', () => {
    const lines = ['diff --git a/d.txt b/d.txt', 'deleted file mode 100644', 'index 1111111..0000000', '--- a/d.txt', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-1', '-2', '-3']
    const diff = textDiff(lines)
    expect(patch(diff, [1])).toBe(text(['diff --git a/d.txt b/d.txt', '--- a/d.txt', '+++ b/d.txt', '@@ -1,3 +1,2 @@', ' 1', '-2', ' 3']))
    expect(patch(diff, [0, 1, 2])).toBe(
      text(['diff --git a/d.txt b/d.txt', 'deleted file mode 100644', '--- a/d.txt', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-1', '-2', '-3'])
    )
  })
})

describe('buildPartialPatch renames and modes', () => {
  it('keeps a rename and a mode change', () => {
    const diff = textDiff([
      'diff --git a/old.txt b/new.txt',
      'old mode 100644',
      'new mode 100755',
      'similarity index 80%',
      'rename from old.txt',
      'rename to new.txt',
      'index 1111111..2222222',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' b'
    ])
    expect(patch(diff, [1])).toBe(
      text([
        'diff --git a/old.txt b/new.txt',
        'old mode 100644',
        'new mode 100755',
        'rename from old.txt',
        'rename to new.txt',
        '--- a/old.txt',
        '+++ b/new.txt',
        '@@ -1,2 +1,3 @@',
        ' a',
        '+A',
        ' b'
      ])
    )
  })
})

describe('buildPartialPatch path quoting', () => {
  it('quotes paths git would quote and marks paths with spaces', () => {
    const diff: TextDiff = { ...MIXED, path: 'dir/a "b"\t.txt', oldPath: null }
    const spaced: TextDiff = { ...MIXED, path: 'a b.txt', oldPath: null }
    expect(patch(diff, [0])?.split('\n').slice(0, 3)).toEqual([
      'diff --git "a/dir/a \\"b\\"\\t.txt" "b/dir/a \\"b\\"\\t.txt"',
      '--- "a/dir/a \\"b\\"\\t.txt"\t',
      '+++ "b/dir/a \\"b\\"\\t.txt"\t'
    ])
    expect(patch(spaced, [0])?.split('\n').slice(0, 3)).toEqual(['diff --git a/a b.txt b/a b.txt', '--- a/a b.txt\t', '+++ b/a b.txt\t'])
  })

  it('writes other control characters as octal escapes, in rename lines too', () => {
    const diff: TextDiff = { ...MIXED, path: 'b\u0001.txt', oldPath: 'a\u007f.txt' }
    expect(patch(diff, [0])?.split('\n').slice(0, 5)).toEqual([
      'diff --git "a/a\\177.txt" "b/b\\001.txt"',
      'rename from "a\\177.txt"',
      'rename to "b\\001.txt"',
      '--- "a/a\\177.txt"',
      '+++ "b/b\\001.txt"'
    ])
  })
})
