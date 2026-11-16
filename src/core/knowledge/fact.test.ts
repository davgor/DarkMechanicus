import { describe, expect, it } from 'vitest'
import { parseFact, type KnowledgeDiagnostic } from './fact'

const origin = { layer: 'repo', path: '.darkmechanicus/knowledge/claim.md' } as const

function fact(frontmatter: string[], body = 'Do the thing.'): string {
  return ['---', ...frontmatter, '---', '', body, ''].join('\n')
}

const minimal = ['id: claim-flow', 'type: procedure', 'title: Claim flow']

function diagnosticOf(source: string): KnowledgeDiagnostic {
  const result = parseFact(source, origin)
  if (result.ok) throw new Error('expected a diagnostic')
  expect(result.diagnostic.layer).toBe('repo')
  expect(result.diagnostic.path).toBe(origin.path)
  return result.diagnostic
}

describe('parseFact full fact', () => {
  it('parses a full valid fact', () => {
    const source = fact(
      [
        '# leading comment',
        'id: ticket.claim-flow',
        'type: gotcha',
        'title: "Claim: always heartbeat"',
        '',
        'scope.roles: [orchestrator, worker]',
        'scope.events: [ticket.claimed, attempt.submitted]',
        'scope.topics: [leases]',
        'scope.paths: ["src/core/**"]',
        'priority: 80',
        'supersedes: [old.claim]',
        'anchors: [src/core/claim.ts]',
        'provenance: retro sprint 3'
      ],
      '  Heartbeat every 300s.\n\nOtherwise the lease expires.  '
    )
    const result = parseFact(source, origin)
    expect(result).toEqual({
      ok: true,
      fact: {
        id: 'ticket.claim-flow',
        type: 'gotcha',
        title: 'Claim: always heartbeat',
        scope: {
          roles: ['orchestrator', 'worker'],
          events: ['ticket.claimed', 'attempt.submitted'],
          topics: ['leases'],
          paths: ['src/core/**']
        },
        priority: 80,
        supersedes: ['old.claim'],
        anchors: ['src/core/claim.ts'],
        provenance: 'retro sprint 3',
        layer: 'repo',
        path: origin.path,
        body: 'Heartbeat every 300s.\n\nOtherwise the lease expires.',
        tokens: Math.ceil(('Claim: always heartbeat'.length + 'Heartbeat every 300s.\n\nOtherwise the lease expires.'.length) / 4)
      }
    })
  })
})

describe('parseFact defaults and lists', () => {
  it('applies defaults', () => {
    const result = parseFact(fact(minimal), { layer: 'builtin', path: 'claim.md' })
    expect(result).toEqual({
      ok: true,
      fact: {
        id: 'claim-flow',
        type: 'procedure',
        title: 'Claim flow',
        scope: { roles: ['orchestrator'], events: [], topics: [], paths: [] },
        priority: 50,
        supersedes: [],
        anchors: [],
        layer: 'builtin',
        path: 'claim.md',
        body: 'Do the thing.',
        tokens: Math.ceil(('Claim flow'.length + 'Do the thing.'.length) / 4)
      }
    })
  })

  it('keeps commas inside quoted list items', () => {
    const result = parseFact(fact([...minimal, 'scope.topics: ["a, b", c, "d \\"e\\""]']), origin)
    expect(result.ok && result.fact.scope.topics).toEqual(['a, b', 'c', 'd "e"'])
  })
})

describe('parseFact diagnostics', () => {
  it.each([
    ['id', 'id'],
    ['type', 'type'],
    ['title', 'title']
  ])('reports missing %s', (field) => {
    const lines = minimal.filter((line) => !line.startsWith(`${field}:`))
    const diagnostic = diagnosticOf(fact(lines))
    // Closing "---" sits on line 4 when two frontmatter lines remain.
    expect(diagnostic.message).toMatch(new RegExp(`^line 4: ${field}:`))
  })

  it('reports a bad id with its line', () => {
    const diagnostic = diagnosticOf(fact(['type: procedure', 'id: Bad_Id', 'title: X']))
    expect(diagnostic.message).toMatch(/^line 3: id:/)
  })

  it('reports an unknown type with its line', () => {
    const diagnostic = diagnosticOf(fact(['id: claim-flow', 'type: rumour', 'title: X']))
    expect(diagnostic.message).toMatch(/^line 3: type:/)
  })

  it('reports a nested map with its line number', () => {
    const diagnostic = diagnosticOf(fact([...minimal, 'scope:', '  roles: [worker]']))
    expect(diagnostic.message).toMatch(/^line 5: /)
  })

  it('reports a multi-line list with its line number', () => {
    const diagnostic = diagnosticOf(fact([...minimal, 'anchors: [a,', '  b]']))
    expect(diagnostic.message).toMatch(/^line 5: inline list must close/)
    const dashed = diagnosticOf(fact([...minimal, 'anchors:', '- a']))
    expect(dashed.message).toMatch(/^line 5: /)
  })

  it('reports an empty body', () => {
    const diagnostic = diagnosticOf(fact(minimal, '   \n  '))
    expect(diagnostic.message).toMatch(/^line 5: body is empty/)
  })

  it('reports a missing closing ---', () => {
    const diagnostic = diagnosticOf(['---', ...minimal, '', 'Body'].join('\n'))
    expect(diagnostic.message).toMatch(/^line \d+: missing closing "---"/)
  })
})

describe('parseFact syntax diagnostics', () => {
  it.each([
    ['an unterminated quoted string', 'title: "Claim flow', 'unterminated quoted string'],
    ['an unsupported escape', 'title: "Claim\\nflow"', 'unsupported escape in quoted string'],
    ['text after a quoted string', 'title: "Claim" flow', 'unexpected text after quoted string'],
    ['a single-quoted value', "title: 'Claim flow'", `unsupported value "'Claim flow'"`],
    ['an empty list item', 'anchors: [a, , b]', 'unsupported list item'],
    ['a single-quoted list item', "anchors: ['a']", 'unsupported list item'],
    ['list items without a comma', 'anchors: ["a" b]', 'expected "," between list items'],
    ['a trailing comma in a list', 'anchors: [a, b, ]', 'trailing "," in list'],
    ['an indented line', '  anchors: [a]', 'indented lines (nested maps or multi-line lists) are not supported'],
    ['a line that is not a key', 'Anchors: [a]', 'expected "key: value"']
  ])('reports %s with its line', (_name, line, message) => {
    const diagnostic = diagnosticOf(fact(['id: claim-flow', 'type: procedure', line]))
    expect(diagnostic.message).toBe(`line 4: ${message}`)
  })

  it('reads escaped quotes and backslashes in a quoted string', () => {
    const result = parseFact(fact(['id: claim-flow', 'type: procedure', 'title: "C:\\\\dm \\"claim\\""']), origin)
    expect(result.ok && result.fact.title).toBe('C:\\dm "claim"')
  })

  it('reports a duplicate key on its second line', () => {
    const diagnostic = diagnosticOf(fact([...minimal, 'priority: 10', 'priority: 20']))
    expect(diagnostic.message).toBe('line 6: duplicate key "priority"')
  })

  it('reports a key that conflicts with a dotted key of the same group, in either order', () => {
    expect(diagnosticOf(fact([...minimal, 'scope: x', 'scope.events: [a]'])).message).toBe(
      'line 6: "scope.events" conflicts with "scope"'
    )
    expect(diagnosticOf(fact([...minimal, 'scope.events: [a]', 'scope: x'])).message).toBe(
      'line 6: "scope" conflicts with "scope"'
    )
  })

  it('reports an unknown key against the frontmatter as a whole, at the closing ---', () => {
    const diagnostic = diagnosticOf(fact([...minimal, 'colour: red']))
    expect(diagnostic.message).toMatch(/^line 6: frontmatter: .*colour/)
  })
})
