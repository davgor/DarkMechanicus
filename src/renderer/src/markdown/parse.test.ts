import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, safeHref, type Inline } from './parse'


describe('safeHref', () => {
  it('allows http, https and mailto and normalizes them', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/')
    expect(safeHref('http://example.com/a?b=1')).toBe('http://example.com/a?b=1')
    expect(safeHref('mailto:dev@example.com')).toBe('mailto:dev@example.com')
    expect(safeHref('  HTTPS://Example.com/x  ')).toBe('https://example.com/x')
  })

  it('rejects script-capable, local and relative targets', () => {
    expect(safeHref('javascript:alert(1)')).toBe(null)
    expect(safeHref('JaVaScRiPt:alert(1)')).toBe(null)
    expect(safeHref('java\nscript:alert(1)')).toBe(null)
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBe(null)
    expect(safeHref('file:///etc/passwd')).toBe(null)
    expect(safeHref('vbscript:msgbox(1)')).toBe(null)
    expect(safeHref('/relative/path')).toBe(null)
    expect(safeHref('')).toBe(null)
  })
})

describe('parseInline (1)', () => {
  it('returns plain text as one text node', () => {
    expect(parseInline('hello world')).toEqual([{ kind: 'text', text: 'hello world' }])
  })

  it('parses strong, emphasis and inline code', () => {
    expect(parseInline('a **b** *c* _d_ __e__ `f`')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'd' }] },
      { kind: 'text', text: ' ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'e' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'f' }
    ])
  })

  it('nests emphasis inside strong and strong inside emphasis', () => {
    expect(parseInline('**bold *it* bold**')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'text', text: 'bold ' },
          { kind: 'em', children: [{ kind: 'text', text: 'it' }] },
          { kind: 'text', text: ' bold' }
        ]
      }
    ])
    expect(parseInline('*a **b** c*')).toEqual([
      {
        kind: 'em',
        children: [
          { kind: 'text', text: 'a ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
          { kind: 'text', text: ' c' }
        ]
      }
    ])
  })

  it('handles triple delimiters as strong around emphasis', () => {
    expect(parseInline('***x***')).toEqual([
      { kind: 'strong', children: [{ kind: 'em', children: [{ kind: 'text', text: 'x' }] }] }
    ])
  })
})

describe('parseInline (2)', () => {
  it('keeps unmatched or space-flanked delimiters literal', () => {
    expect(parseInline('*unclosed')).toEqual([{ kind: 'text', text: '*unclosed' }])
    expect(parseInline('* not emphasis *')).toEqual([{ kind: 'text', text: '* not emphasis *' }])
    expect(parseInline('****')).toEqual([{ kind: 'text', text: '****' }])
    expect(parseInline('**a*')).toEqual([
      { kind: 'text', text: '*' },
      { kind: 'em', children: [{ kind: 'text', text: 'a' }] }
    ])
    expect(parseInline('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }])
    expect(parseInline('x*')).toEqual([{ kind: 'text', text: 'x*' }])
    expect(parseInline('* a*')).toEqual([{ kind: 'text', text: '* a*' }])
    expect(parseInline('***a*')).toEqual([
      { kind: 'text', text: '**' },
      { kind: 'em', children: [{ kind: 'text', text: 'a' }] }
    ])
  })

  it('rejects an empty emphasis span', () => {
    expect(parseInline('** **')).toEqual([{ kind: 'text', text: '** **' }])
  })

  it('does not close underscore emphasis inside a word', () => {
    expect(parseInline('_a_b')).toEqual([{ kind: 'text', text: '_a_b' }])
    expect(parseInline('_a_ b')).toEqual([
      { kind: 'em', children: [{ kind: 'text', text: 'a' }] },
      { kind: 'text', text: ' b' }
    ])
  })

  it('treats backslash escapes literally', () => {
    expect(parseInline('\\*not em\\*')).toEqual([{ kind: 'text', text: '*not em*' }])
    expect(parseInline('a\\b')).toEqual([{ kind: 'text', text: 'a\\b' }])
    expect(parseInline('end\\')).toEqual([{ kind: 'text', text: 'end\\' }])
  })

})

describe('parseInline (2b)', () => {
  it('parses code spans with longer fences and trims one padding space', () => {
    expect(parseInline('`` a`b ``')).toEqual([{ kind: 'code', text: 'a`b' }])
    expect(parseInline('` `')).toEqual([{ kind: 'code', text: ' ' }])
    expect(parseInline('`a\nb`')).toEqual([{ kind: 'code', text: 'a b' }])
    expect(parseInline('`unclosed')).toEqual([{ kind: 'text', text: '`unclosed' }])
    expect(parseInline('`**not strong**`')).toEqual([{ kind: 'code', text: '**not strong**' }])
  })

  it('parses allow-listed links and keeps other link targets as plain text', () => {
    expect(parseInline('see [docs](https://example.com/a) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', href: 'https://example.com/a', children: [{ kind: 'text', text: 'docs' }] },
      { kind: 'text', text: ' now' }
    ])
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ kind: 'text', text: 'x' }])
    expect(parseInline('[x](data:text/html,hi)')).toEqual([{ kind: 'text', text: 'x' }])
    expect(parseInline('[x](file:///etc/passwd)')).toEqual([{ kind: 'text', text: 'x' }])
    expect(parseInline('[x](vbscript:msgbox)')).toEqual([{ kind: 'text', text: 'x' }])
  })
})

describe('parseInline (3)', () => {
  it('supports titles, angle destinations and balanced parentheses in links', () => {
    expect(parseInline('[a](https://e.com/x "Title")')).toEqual([
      { kind: 'link', href: 'https://e.com/x', children: [{ kind: 'text', text: 'a' }] }
    ])
    expect(parseInline('[a](<https://e.com/a b>)')).toEqual([
      { kind: 'link', href: 'https://e.com/a%20b', children: [{ kind: 'text', text: 'a' }] }
    ])
    expect(parseInline('[w](https://e.com/Foo_(bar))')).toEqual([
      { kind: 'link', href: 'https://e.com/Foo_(bar)', children: [{ kind: 'text', text: 'w' }] }
    ])
  })

  it('parses emphasis inside link text; the first closing bracket ends the text so links never nest', () => {
    expect(parseInline('[a [b](https://x.com) c](https://y.com)')).toEqual([
      { kind: 'link', href: 'https://x.com/', children: [{ kind: 'text', text: 'a [b' }] },
      { kind: 'text', text: ' c](https://y.com)' }
    ])
    expect(parseInline('[**b**](https://e.com)')).toEqual([
      {
        kind: 'link',
        href: 'https://e.com/',
        children: [{ kind: 'strong', children: [{ kind: 'text', text: 'b' }] }]
      }
    ])
  })

  it('allows intraword asterisk emphasis', () => {
    expect(parseInline('foo*bar*')).toEqual([
      { kind: 'text', text: 'foo' },
      { kind: 'em', children: [{ kind: 'text', text: 'bar' }] }
    ])
  })

  it('finds the next closing bracket after an earlier failed link', () => {
    expect(parseInline('[a] and [b](https://e.com)')).toEqual([
      { kind: 'text', text: '[a] and ' },
      { kind: 'link', href: 'https://e.com/', children: [{ kind: 'text', text: 'b' }] }
    ])
  })

  it('re-searches for an earlier closing angle after a failed link looked further ahead', () => {
    expect(parseInline('[<https://e.com>](<x> z')).toEqual([
      { kind: 'text', text: '[' },
      { kind: 'link', href: 'https://e.com/', children: [{ kind: 'text', text: 'https://e.com' }] },
      { kind: 'text', text: '](<x> z' }
    ])
  })
})

describe('parseInline (4)', () => {
  it('keeps a backslash at the end of link text literal', () => {
    expect(parseInline('[a\\](https://e.com)')).toEqual([
      { kind: 'link', href: 'https://e.com/', children: [{ kind: 'text', text: 'a\\' }] }
    ])
  })

  it('finds a link or autolink right after a stray closing bracket', () => {
    expect(parseInline('a][b](https://e.com)')).toEqual([
      { kind: 'text', text: 'a]' },
      { kind: 'link', href: 'https://e.com/', children: [{ kind: 'text', text: 'b' }] }
    ])
    expect(parseInline('-><https://e.com>')).toEqual([
      { kind: 'text', text: '->' },
      { kind: 'link', href: 'https://e.com/', children: [{ kind: 'text', text: 'https://e.com' }] }
    ])
  })

  it('leaves malformed links literal', () => {
    expect(parseInline('[a] (https://e.com)')).toEqual([{ kind: 'text', text: '[a] (https://e.com)' }])
    expect(parseInline('[a](https://e.com')).toEqual([{ kind: 'text', text: '[a](https://e.com' }])
    expect(parseInline('[unclosed')).toEqual([{ kind: 'text', text: '[unclosed' }])
    expect(parseInline('[a](<https://e.com)')).toEqual([{ kind: 'text', text: '[a](<https://e.com)' }])
    expect(parseInline('[a](https://e.com "t)')).toEqual([{ kind: 'text', text: '[a](https://e.com "t)' }])
  })

  it('renders images as links to their target without loading them', () => {
    expect(parseInline('![shot](https://e.com/a.png)')).toEqual([
      { kind: 'link', href: 'https://e.com/a.png', children: [{ kind: 'text', text: 'shot' }] }
    ])
    expect(parseInline('![shot](file:///c.png)')).toEqual([{ kind: 'text', text: 'shot' }])
    expect(parseInline('wow!')).toEqual([{ kind: 'text', text: 'wow!' }])
  })

  it('parses autolinks and shows raw HTML as text', () => {
    expect(parseInline('<https://e.com/x>')).toEqual([
      { kind: 'link', href: 'https://e.com/x', children: [{ kind: 'text', text: 'https://e.com/x' }] }
    ])
    expect(parseInline('<dev@example.com>')).toEqual([
      { kind: 'link', href: 'mailto:dev@example.com', children: [{ kind: 'text', text: 'dev@example.com' }] }
    ])
    expect(parseInline('<script>alert(1)</script>')).toEqual([
      { kind: 'text', text: '<script>alert(1)</script>' }
    ])
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)>' }
    ])
    expect(parseInline('<javascript:alert(1)>')).toEqual([{ kind: 'text', text: '<javascript:alert(1)>' }])
    expect(parseInline('a < b')).toEqual([{ kind: 'text', text: 'a < b' }])
  })
})

describe('parseInline (5)', () => {
  it('turns two trailing spaces or a backslash before a newline into a hard break', () => {
    expect(parseInline('a  \nb')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'break' },
      { kind: 'text', text: 'b' }
    ])
    expect(parseInline('a\\\nb')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'break' },
      { kind: 'text', text: 'b' }
    ])
    expect(parseInline('a \nb')).toEqual([{ kind: 'text', text: 'a \nb' }])
  })

  it('keeps many unmatched openers literal (linear scan on hostile input)', () => {
    const openers = '*a '.repeat(30_000)
    expect(parseInline(openers)).toEqual([{ kind: 'text', text: openers }])
    const brackets = `${'['.repeat(30_000)}x`
    expect(parseInline(brackets)).toEqual([{ kind: 'text', text: brackets }])
    const angles = `${'<a '.repeat(30_000)}`
    expect(parseInline(angles)).toEqual([{ kind: 'text', text: angles }])
    const ticks = `${'`'.repeat(3)}${'a'.repeat(10)}${'``'}`
    expect(parseInline(ticks)).toEqual([{ kind: 'text', text: ticks }])
  })
})

describe('parseInline (6)', () => {
  const t = (text: string): Inline => ({ kind: 'text', text })

  it('nests four emphasis levels and keeps a fifth level (inside link text) literal', () => {
    expect(parseInline('**a *b __c _d_ c__ b* a**')).toEqual([
      {
        kind: 'strong',
        children: [
          t('a '),
          {
            kind: 'em',
            children: [
              t('b '),
              { kind: 'strong', children: [t('c '), { kind: 'em', children: [t('d')] }, t(' c')] },
              t(' b')
            ]
          },
          t(' a')
        ]
      }
    ])
    expect(parseInline('[**a *b __c _d_ c__ b* a**](https://x.y)')).toEqual([
      {
        kind: 'link',
        href: 'https://x.y/',
        children: [
          {
            kind: 'strong',
            children: [t('a '), { kind: 'em', children: [t('b '), { kind: 'strong', children: [t('c _d_ c')] }, t(' b')] }, t(' a')]
          }
        ]
      }
    ])
  })
})

describe('parseMarkdown (1)', () => {
  it('parses headings, paragraphs and rules', () => {
    expect(parseMarkdown('# Title\n\nSome *text*\nmore\n\n---\n## Next ##')).toEqual([
      { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'Title' }] },
      {
        kind: 'paragraph',
        children: [
          { kind: 'text', text: 'Some ' },
          { kind: 'em', children: [{ kind: 'text', text: 'text' }] },
          { kind: 'text', text: '\nmore' }
        ]
      },
      { kind: 'rule' },
      { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Next' }] }
    ])
  })

  it('distinguishes heading-like text that is not a heading', () => {
    expect(parseMarkdown('#hashtag')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '#hashtag' }] }
    ])
    expect(parseMarkdown('####### seven')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '####### seven' }] }
    ])
    expect(parseMarkdown('###### six')).toEqual([
      { kind: 'heading', level: 6, children: [{ kind: 'text', text: 'six' }] }
    ])
    expect(parseMarkdown('# C#')).toEqual([
      { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'C#' }] }
    ])
    expect(parseMarkdown('#')).toEqual([{ kind: 'heading', level: 1, children: [] }])
    expect(parseMarkdown('# ##')).toEqual([{ kind: 'heading', level: 1, children: [] }])
    expect(parseMarkdown('    # indented')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '# indented' }] }
    ])
  })

  it('recognizes rules made of three or more matching characters', () => {
    expect(parseMarkdown('***')).toEqual([{ kind: 'rule' }])
    expect(parseMarkdown('_ _ _')).toEqual([{ kind: 'rule' }])
    expect(parseMarkdown('--')).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: '--' }] }])
    expect(parseMarkdown('-*-')).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: '-*-' }] }])
  })
})

describe('parseMarkdown (2)', () => {
  it('keeps fenced code verbatim, including HTML', () => {
    expect(parseMarkdown('```ts\nconst a = "<b>"\n**x**\n```\nafter')).toEqual([
      { kind: 'code', lang: 'ts', text: 'const a = "<b>"\n**x**' },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'after' }] }
    ])
    expect(parseMarkdown('~~~\nopen')).toEqual([{ kind: 'code', lang: '', text: 'open' }])
    expect(parseMarkdown('````\n```\n````')).toEqual([{ kind: 'code', lang: '', text: '```' }])
    expect(parseMarkdown('``` a`b')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '``` a`b' }] }
    ])
  })

  it('parses unordered, ordered and task lists', () => {
    expect(parseMarkdown('- one\n- [x] done\n- [ ] open\n\n3. three\n4. four')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          { task: null, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'one' }] }] },
          { task: 'done', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'done' }] }] },
          { task: 'open', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'open' }] }] }
        ]
      },
      {
        kind: 'list',
        ordered: true,
        start: 3,
        items: [
          { task: null, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'three' }] }] },
          { task: null, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'four' }] }] }
        ]
      }
    ])
  })
})

describe('parseMarkdown (3)', () => {
  it('nests indented lists and keeps lazy continuation lines in the item', () => {
    expect(parseMarkdown('- a\n  - b\ncontinued\n- c')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            task: null,
            blocks: [
              { kind: 'paragraph', children: [{ kind: 'text', text: 'a' }] },
              {
                kind: 'list',
                ordered: false,
                start: 1,
                items: [
                  {
                    task: null,
                    blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'b\ncontinued' }] }]
                  }
                ]
              }
            ]
          },
          { task: null, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'c' }] }] }
        ]
      }
    ])
  })
})

describe('parseMarkdown (4)', () => {
  it('keeps an item open across a blank line followed by indented text', () => {
    expect(parseMarkdown('- a\n\n  b\n\nc')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            task: null,
            blocks: [
              { kind: 'paragraph', children: [{ kind: 'text', text: 'a' }] },
              { kind: 'paragraph', children: [{ kind: 'text', text: 'b' }] }
            ]
          }
        ]
      },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'c' }] }
    ])
  })

  it('starts a new list when the marker changes and ends at other blocks', () => {
    expect(parseMarkdown('- a\n+ b\n# h')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [{ task: null, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'a' }] }] }]
      },
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [{ task: null, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'b' }] }] }]
      },
      { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'h' }] }
    ])
    expect(parseMarkdown('-\n-x')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [{ task: null, blocks: [] }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: '-x' }] }
    ])
  })
})

describe('parseMarkdown (4b)', () => {
  it('dedents item content by the marker width, so deeper indentation stays in the item', () => {
    expect(parseMarkdown('- a\n\n     # h')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            task: null,
            blocks: [
              { kind: 'paragraph', children: [{ kind: 'text', text: 'a' }] },
              { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'h' }] }
            ]
          }
        ]
      }
    ])
  })

  it('continues after a fenced code block that follows a paragraph', () => {
    expect(parseMarkdown('text\n```\ncode\n```\nafter')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'text' }] },
      { kind: 'code', lang: '', text: 'code' },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'after' }] }
    ])
  })
})

describe('parseMarkdown (5)', () => {
  it('parses block quotes recursively and interrupts paragraphs', () => {
    expect(parseMarkdown('text\n> quoted **b**\n>> deeper')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'text' }] },
      {
        kind: 'quote',
        blocks: [
          {
            kind: 'paragraph',
            children: [
              { kind: 'text', text: 'quoted ' },
              { kind: 'strong', children: [{ kind: 'text', text: 'b' }] }
            ]
          },
          { kind: 'quote', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'deeper' }] }] }
        ]
      }
    ])
  })

  it('never produces HTML blocks: raw HTML stays paragraph text', () => {
    expect(parseMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>')).toEqual([
      {
        kind: 'paragraph',
        children: [{ kind: 'text', text: '<script>alert(1)</script>\n<img src=x onerror=alert(1)>' }]
      }
    ])
  })

  it('bounds nesting depth for deeply nested quotes and lists', () => {
    const quotes = parseMarkdown(`${'>'.repeat(500)} deep`)
    let depth = 0
    let blocks = quotes
    while (blocks[0]?.kind === 'quote') {
      depth += 1
      blocks = blocks[0].blocks
    }
    expect(depth).toBe(6)
    expect(blocks[0]?.kind).toBe('paragraph')
    const lists = parseMarkdown(Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n'))
    expect(JSON.stringify(lists).split('"list"').length - 1).toBe(6)
  })
})

describe('parseMarkdown (6)', () => {
  it('normalizes Windows line endings and skips blank lines', () => {
    expect(parseMarkdown('a\r\n\r\n\r\nb\r')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'a' }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'b' }] }
    ])
    expect(parseMarkdown('')).toEqual([])
  })
})
