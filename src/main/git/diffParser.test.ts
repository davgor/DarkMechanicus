import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diffParser'

const MODIFIED = [
  'diff --git a/src/a.txt b/src/a.txt',
  'index 1111111..2222222 100644',
  '--- a/src/a.txt',
  '+++ b/src/a.txt',
  '@@ -1,3 +1,4 @@ function f() {',
  ' one',
  '-two',
  '+TWO',
  '+extra',
  ' three',
  '@@ -10 +11 @@',
  '-x',
  '\\ No newline at end of file',
  '+y',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('parseUnifiedDiff', () => {
  it('parses hunks with old and new line numbers', () => {
    const diff = parseUnifiedDiff(MODIFIED)
    if (diff.kind !== 'text') {
      throw new Error('expected text')
    }
    expect(diff.path).toBe('src/a.txt')
    expect(diff.oldPath).toBeNull()
    expect(diff.oldMode).toBe('100644')
    expect(diff.newMode).toBe('100644')
    expect(diff.hunks).toHaveLength(2)
    const [first, second] = diff.hunks
    expect(first).toMatchObject({ header: '@@ -1,3 +1,4 @@ function f() {', oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 })
    expect(first.lines.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['context', 'one', 1, 1],
      ['delete', 'two', 2, null],
      ['add', 'TWO', null, 2],
      ['add', 'extra', null, 3],
      ['context', 'three', 3, 4]
    ])
    expect(second).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 1 })
    expect(second.lines.map((l) => [l.kind, l.noNewlineAtEnd])).toEqual([
      ['delete', true],
      ['add', true]
    ])
  })

  it('hashes the raw output with SHA-1', () => {
    expect(parseUnifiedDiff(MODIFIED).hash).toMatch(/^[0-9a-f]{40}$/)
    expect(parseUnifiedDiff(MODIFIED).hash).toBe(parseUnifiedDiff(MODIFIED).hash)
    expect(parseUnifiedDiff(MODIFIED + ' ').hash).not.toBe(parseUnifiedDiff(MODIFIED).hash)
    expect(parseUnifiedDiff('').hash).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
  })

  it('keeps a trailing carriage return', () => {
    const raw = ['diff --git a/c.txt b/c.txt', 'index 1..2 100644', '--- a/c.txt', '+++ b/c.txt', '@@ -1,2 +1,2 @@', ' keep\r', '-old\r', '+new\r', ''].join('\n')
    const diff = parseUnifiedDiff(raw)
    if (diff.kind !== 'text') {
      throw new Error('expected text')
    }
    expect(diff.hunks[0].lines.map((l) => l.text)).toEqual(['keep\r', 'old\r', 'new\r'])
  })

})

describe('parseUnifiedDiff (file headers)', () => {
  it('reads a new file', () => {
    const raw = ['diff --git a/n.txt b/n.txt', 'new file mode 100644', 'index 0000000..e69de29', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n')
    const diff = parseUnifiedDiff(raw)
    if (diff.kind !== 'text') {
      throw new Error('expected text')
    }
    expect(diff).toMatchObject({ path: 'n.txt', oldPath: null, oldMode: null, newMode: '100644' })
    expect(diff.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 })
    expect(diff.hunks[0].lines.map((l) => l.newNumber)).toEqual([1, 2])
  })

  it('reads a deleted file', () => {
    const raw = ['diff --git a/d.txt b/d.txt', 'deleted file mode 100755', 'index e69de29..0000000', '--- a/d.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', ''].join('\n')
    const diff = parseUnifiedDiff(raw)
    expect(diff).toMatchObject({ kind: 'text', path: 'd.txt', oldMode: '100755', newMode: null })
  })

  it('reads a rename with edits', () => {
    const raw = ['diff --git a/old name.txt b/new name.txt', 'similarity index 80%', 'rename from old name.txt', 'rename to new name.txt', 'index 1..2 100644', '--- a/old name.txt', '+++ b/new name.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
    expect(parseUnifiedDiff(raw)).toMatchObject({ kind: 'text', path: 'new name.txt', oldPath: 'old name.txt' })
  })

  it('treats a pure rename as empty', () => {
    const raw = ['diff --git a/x.txt b/y.txt', 'similarity index 100%', 'rename from x.txt', 'rename to y.txt', ''].join('\n')
    expect(parseUnifiedDiff(raw)).toMatchObject({ kind: 'empty', path: 'y.txt', oldPath: 'x.txt' })
  })

  it('reads a copy', () => {
    const raw = ['diff --git a/x.txt b/y.txt', 'similarity index 100%', 'copy from x.txt', 'copy to y.txt', ''].join('\n')
    expect(parseUnifiedDiff(raw)).toMatchObject({ kind: 'empty', path: 'y.txt', oldPath: 'x.txt' })
  })

  it('treats a mode-only change as empty and keeps both modes', () => {
    const raw = ['diff --git a/s.sh b/s.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
    expect(parseUnifiedDiff(raw)).toMatchObject({ kind: 'empty', path: 's.sh', oldPath: null, oldMode: '100644', newMode: '100755' })
  })

})

describe('parseUnifiedDiff (binary, quoting, typechange)', () => {
  it('reads binary files', () => {
    const raw = ['diff --git a/i.png b/i.png', 'index 1..2 100644', 'Binary files a/i.png and b/i.png differ', ''].join('\n')
    expect(parseUnifiedDiff(raw)).toMatchObject({ kind: 'binary', path: 'i.png' })
    const added = ['diff --git a/i.png b/i.png', 'new file mode 100644', 'index 0000000..2', 'Binary files /dev/null and b/i.png differ', ''].join('\n')
    expect(parseUnifiedDiff(added)).toMatchObject({ kind: 'binary', path: 'i.png', newMode: '100644' })
  })

  it('unquotes quoted paths', () => {
    const raw = ['diff --git "a/t\\tab.txt" "b/t\\tab.txt"', 'index 1..2 100644', '--- "a/t\\tab.txt"', '+++ "b/t\\tab.txt"', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
    expect(parseUnifiedDiff(raw)).toMatchObject({ path: 't\tab.txt' })
  })

  it('reads a typechange as one diff holding both sides', () => {
    const raw = [
      'diff --git a/l b/l',
      'deleted file mode 100644',
      'index 1..0000000',
      '--- a/l',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-text',
      'diff --git a/l b/l',
      'new file mode 120000',
      'index 0000000..2',
      '--- /dev/null',
      '+++ b/l',
      '@@ -0,0 +1 @@',
      '+target',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const diff = parseUnifiedDiff(raw)
    if (diff.kind !== 'text') {
      throw new Error('expected text')
    }
    expect(diff).toMatchObject({ path: 'l', oldMode: '100644', newMode: '120000' })
    expect(diff.hunks).toHaveLength(2)
  })

  it('returns empty for no output', () => {
    expect(parseUnifiedDiff('')).toMatchObject({ kind: 'empty', path: '' })
  })
})
