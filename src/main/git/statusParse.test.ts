import { describe, expect, it } from 'vitest'
import { parseStatusV2 } from './status'

const z = (...parts: string[]): string => parts.join('\0') + '\0'

describe('parseStatusV2', () => {
  it('reads the branch headers', () => {
    const out = z('# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3')
    expect(parseStatusV2(out).branch).toEqual({ name: 'main', headOid: 'abc123', upstream: 'origin/main', ahead: 2, behind: 3 })
  })

  it('maps an unborn branch and a detached HEAD to null', () => {
    expect(parseStatusV2(z('# branch.oid (initial)', '# branch.head main')).branch).toMatchObject({ name: 'main', headOid: null, upstream: null, ahead: 0, behind: 0 })
    expect(parseStatusV2(z('# branch.oid abc', '# branch.head (detached)')).branch).toMatchObject({ name: null, headOid: 'abc' })
  })
})

describe('parseStatusV2 (entries)', () => {
  it('classifies entries against HEAD and sorts by path', () => {
    const h = 'N... 100644 100644 100644 aaa bbb'
    const out = z(
      '# branch.oid abc',
      '# branch.head main',
      `1 .M ${h} z mod.txt`,
      `1 A. ${h} added file.txt`,
      `1 AM ${h} addmod.txt`,
      `1 AD ${h} addgone.txt`,
      `1 .D ${h} gone.txt`,
      `1 D. ${h} gone2.txt`,
      `1 .T ${h} type.txt`,
      `2 R. ${h} R100 renamed.txt`,
      'orig name.txt',
      `2 RM ${h} R90 b.txt`,
      'a.txt',
      `2 RD ${h} R90 newgone.txt`,
      'oldgone.txt',
      `2 C. ${h} C100 copy.txt`,
      'src.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked dir/new.txt',
      '! ignored.txt'
    )
    expect(parseStatusV2(out).files).toEqual([
      { path: 'added file.txt', oldPath: null, kind: 'added' },
      { path: 'addmod.txt', oldPath: null, kind: 'added' },
      { path: 'b.txt', oldPath: 'a.txt', kind: 'renamed' },
      { path: 'conflict.txt', oldPath: null, kind: 'conflicted' },
      { path: 'copy.txt', oldPath: 'src.txt', kind: 'copied' },
      { path: 'gone.txt', oldPath: null, kind: 'deleted' },
      { path: 'gone2.txt', oldPath: null, kind: 'deleted' },
      { path: 'oldgone.txt', oldPath: null, kind: 'deleted' },
      { path: 'renamed.txt', oldPath: 'orig name.txt', kind: 'renamed' },
      { path: 'type.txt', oldPath: null, kind: 'typechange' },
      { path: 'untracked dir/new.txt', oldPath: null, kind: 'untracked' },
      { path: 'z mod.txt', oldPath: null, kind: 'modified' }
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parseStatusV2('').files).toEqual([])
  })
})
