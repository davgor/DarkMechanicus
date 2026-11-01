import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** A comment, or a quoted string (backslash escapes; an unterminated one stops at end of line). */
const COMMENT_OR_STRING = /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/g

interface OpenBlock {
  prelude: string
  line: number
}

/**
 * Brace-balance check for one stylesheet. Returns one message per problem, each naming
 * `<file>:<line>`: unclosed blocks (at the line that opened them), stray `}`, and a block
 * opened inside an ordinary rule (only at-rules may contain blocks; the renderer uses no nesting).
 */
function checkCssBalance(file: string, css: string): string[] {
  // Blank comments and strings with spaces, keeping newlines so line numbers hold.
  const text = css.replace(COMMENT_OR_STRING, (match) => match.replace(/[^\n]/g, ' '))
  const problems: string[] = []
  const stack: OpenBlock[] = []
  let segmentStart = 0
  for (const { 0: ch, index } of text.matchAll(/[{};]/g)) {
    if (ch === '{') {
      const raw = text.slice(segmentStart, index)
      const prelude = raw.trim().replace(/\s+/g, ' ')
      const start = segmentStart + raw.length - raw.trimStart().length
      const open = { prelude, line: text.slice(0, start).split('\n').length }
      const parent = stack.at(-1)
      if (parent && !parent.prelude.startsWith('@')) {
        problems.push(
          `${file}:${open.line}: block \`${prelude}\` opens inside rule \`${parent.prelude}\` (line ${parent.line}), which was never closed`
        )
      }
      stack.push(open)
    } else if (ch === '}' && !stack.pop()) {
      problems.push(`${file}:${text.slice(0, index).split('\n').length}: unexpected \`}\` with no open block`)
    }
    segmentStart = index + 1
  }
  for (const open of stack) problems.push(`${file}:${open.line}: rule \`${open.prelude}\` is never closed`)
  return problems
}

const RENDERER_DIR = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/source.fde854b-truncated.css', import.meta.url))

const SHEETS = readdirSync(RENDERER_DIR, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.css'))
  .map((path) => `./${path.split('\\').join('/')}`)

describe('renderer stylesheets balance their braces', () => {
  it('finds stylesheets to check', () => {
    expect(SHEETS.length).toBeGreaterThan(0)
  })

  it.each(SHEETS)('%s has balanced braces and no rule left open', (sheet) => {
    expect(checkCssBalance(sheet, readFileSync(join(RENDERER_DIR, sheet), 'utf8'))).toEqual([])
  })
})

describe('checkCssBalance', () => {
  it('flags the truncated source.css from merge fde854b at its unclosed rule', () => {
    const problems = checkCssBalance('source.css', readFileSync(FIXTURE, 'utf8'))
    expect(problems).toEqual(['source.css:307: rule `.history-summary` is never closed'])
  })

  it('flags a block opened inside a rule that was never closed', () => {
    const css = '.a {\n  color: red;\n.b {\n  color: blue;\n}\n'
    expect(checkCssBalance('x.css', css)).toContain(
      'x.css:3: block `.b` opens inside rule `.a` (line 1), which was never closed'
    )
  })

  it('flags a stray closing brace', () => {
    expect(checkCssBalance('x.css', '.a {}\n}\n')).toEqual(['x.css:2: unexpected `}` with no open block'])
  })

  it('allows blocks inside at-rules such as @media and @keyframes', () => {
    const css = '@media (x) {\n  .a { color: red; }\n}\n@keyframes k {\n  from { opacity: 0; }\n}\n'
    expect(checkCssBalance('x.css', css)).toEqual([])
  })

  it('ignores braces inside comments and strings', () => {
    const css = "/* { */\n.a::before { content: \"{\"; }\n.b::after { content: '}\\'}'; }\n/* } */\n"
    expect(checkCssBalance('x.css', css)).toEqual([])
  })
})
