import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMcpConfig } from './mcpConfig'
import { claudeCodeServer, darkMechanicusServer, mergeMcpServer, type McpServerEntry } from './mcpJson'

const SERVER: McpServerEntry = {
  command: '/Apps/DM',
  args: ['/Apps/dm/mcp.js', '--repo', '/repos/site', '--role', 'planner', '--allow-save', '--label', 'Claude Code'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

const OTHER_SERVER = { command: 'npx', args: ['-y', '@acme/other-mcp'], env: { TOKEN_FILE: '~/.acme' } }

/** The file text as written: two-space JSON with a trailing newline. */
function fileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function writtenText(result: ReturnType<typeof mergeMcpServer>): string {
  if (result.outcome === 'created' || result.outcome === 'added' || result.outcome === 'replaced') {
    return result.text
  }
  throw new Error(`expected a write, got ${result.outcome}`)
}

describe('mergeMcpServer without a file', () => {
  it('creates a new .mcp.json holding only the darkmechanicus server', () => {
    const result = mergeMcpServer(null, SERVER, { replace: false })

    expect(result).toEqual({ outcome: 'created', text: fileText({ mcpServers: { darkmechanicus: SERVER } }) })
  })

  it('writes two-space indented JSON that ends with one newline', () => {
    const text = writtenText(mergeMcpServer(null, SERVER, { replace: false }))

    expect(text.split('\n').slice(0, 3)).toEqual(['{', '  "mcpServers": {', '    "darkmechanicus": {'])
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})

describe('mergeMcpServer into an existing file', () => {
  it('adds the server and keeps every other server and unknown top-level key', () => {
    const current = fileText({ $schema: 'https://example.com/mcp.json', mcpServers: { other: OTHER_SERVER }, extra: [1, { a: true }] })

    const result = mergeMcpServer(current, SERVER, { replace: false })

    expect(result.outcome).toBe('added')
    expect(JSON.parse(writtenText(result))).toEqual({
      $schema: 'https://example.com/mcp.json',
      mcpServers: { other: OTHER_SERVER, darkmechanicus: SERVER },
      extra: [1, { a: true }]
    })
  })

  it('keeps the order of the existing keys and appends the new server last', () => {
    const current = fileText({ first: 1, mcpServers: { zeta: OTHER_SERVER, alpha: OTHER_SERVER }, last: 2 })

    const merged = JSON.parse(writtenText(mergeMcpServer(current, SERVER, { replace: false })))

    expect(Object.keys(merged)).toEqual(['first', 'mcpServers', 'last'])
    expect(Object.keys(merged.mcpServers)).toEqual(['zeta', 'alpha', 'darkmechanicus'])
  })

  it('adds an mcpServers block to a file that has none', () => {
    const result = mergeMcpServer('{ "note": "hand-made" }', SERVER, { replace: false })

    expect(result).toEqual({ outcome: 'added', text: fileText({ note: 'hand-made', mcpServers: { darkmechanicus: SERVER } }) })
  })

  it('adds the server to an empty JSON object', () => {
    expect(mergeMcpServer('{}', SERVER, { replace: false })).toEqual({
      outcome: 'added',
      text: fileText({ mcpServers: { darkmechanicus: SERVER } })
    })
  })

  it('keeps a "__proto__" key as plain data', () => {
    const current = '{"__proto__": {"polluted": true}, "mcpServers": {"__proto__": {"command": "x"}}}'

    const text = writtenText(mergeMcpServer(current, SERVER, { replace: false }))

    expect(text).toContain('"__proto__": {\n    "polluted": true\n  }')
    expect(text).toContain('"__proto__": {\n      "command": "x"\n    }')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('mergeMcpServer with an existing darkmechanicus entry', () => {
  it('reports an identical entry as unchanged, whatever its key order or formatting', () => {
    const reordered = { env: SERVER.env, args: SERVER.args, command: SERVER.command }
    const current = JSON.stringify({ mcpServers: { darkmechanicus: reordered, other: OTHER_SERVER } })

    expect(mergeMcpServer(current, SERVER, { replace: false })).toEqual({ outcome: 'unchanged' })
    expect(mergeMcpServer(current, SERVER, { replace: true })).toEqual({ outcome: 'unchanged' })
  })

  it('reports a different entry as a conflict, showing what is there, and writes nothing', () => {
    const existing = { command: 'node', args: ['/old/mcp.js', '--repo', '/repos/site'] }
    const current = fileText({ mcpServers: { darkmechanicus: existing } })

    expect(mergeMcpServer(current, SERVER, { replace: false })).toEqual({
      outcome: 'conflict',
      existing: JSON.stringify(existing, null, 2)
    })
  })

  it('treats any difference as a conflict: an extra field, another role, a missing env', () => {
    const variants = [
      { ...SERVER, type: 'stdio' },
      { ...SERVER, args: SERVER.args.map((arg) => (arg === 'planner' ? 'orchestrator' : arg)) },
      { command: SERVER.command, args: SERVER.args },
      null
    ]

    const outcomes = variants.map(
      (variant) => mergeMcpServer(JSON.stringify({ mcpServers: { darkmechanicus: variant } }), SERVER, { replace: false }).outcome
    )

    expect(outcomes).toEqual(['conflict', 'conflict', 'conflict', 'conflict'])
  })

  it('replaces a different entry only when asked, in place, keeping everything else', () => {
    const current = fileText({ top: 'kept', mcpServers: { before: OTHER_SERVER, darkmechanicus: { command: 'old' }, after: OTHER_SERVER } })

    const result = mergeMcpServer(current, SERVER, { replace: true })

    expect(result.outcome).toBe('replaced')
    const merged = JSON.parse(writtenText(result))
    expect(merged).toEqual({ top: 'kept', mcpServers: { before: OTHER_SERVER, darkmechanicus: SERVER, after: OTHER_SERVER } })
    expect(Object.keys(merged.mcpServers)).toEqual(['before', 'darkmechanicus', 'after'])
  })
})

describe('mergeMcpServer with a file that cannot be merged', () => {
  it('refuses text that is not valid JSON, naming the file and saying it was left untouched', () => {
    const result = mergeMcpServer('{ "mcpServers": { ', SERVER, { replace: true })

    expect(result.outcome).toBe('invalid')
    expect(result).not.toHaveProperty('text')
    const message = result.outcome === 'invalid' ? result.message : ''
    expect(message).toMatch(/^\.mcp\.json is not valid JSON \(.+\), so it was left untouched\. Fix or remove it, then try again\.$/)
  })

  it('refuses an empty file and JSON with trailing text', () => {
    expect(mergeMcpServer('', SERVER, { replace: false }).outcome).toBe('invalid')
    expect(mergeMcpServer('   \n', SERVER, { replace: false }).outcome).toBe('invalid')
    expect(mergeMcpServer('{} {}', SERVER, { replace: false }).outcome).toBe('invalid')
  })

  it('refuses JSON whose top level is not an object', () => {
    const texts = ['[]', '[{"mcpServers": {}}]', 'null', '42', '"text"', 'true']

    const results = texts.map((text) => mergeMcpServer(text, SERVER, { replace: true }))

    expect(results).toEqual(
      texts.map(() => ({
        outcome: 'invalid',
        message: '.mcp.json does not hold a JSON object, so it was left untouched. Fix or remove it, then try again.'
      }))
    )
  })

  it('refuses an mcpServers value that is not an object', () => {
    const texts = ['{"mcpServers": []}', '{"mcpServers": null}', '{"mcpServers": "darkmechanicus"}', '{"mcpServers": 1}']

    const results = texts.map((text) => mergeMcpServer(text, SERVER, { replace: true }))

    expect(results).toEqual(
      texts.map(() => ({
        outcome: 'invalid',
        message: '"mcpServers" in .mcp.json is not an object, so the file was left untouched. Fix or remove it, then try again.'
      }))
    )
  })
})

describe('claudeCodeServer', () => {
  const packaged = { command: '/Apps/DM', args: ['/Apps/dm/mcp.js', '--repo', '/repos/site'], env: { ELECTRON_RUN_AS_NODE: '1' } }

  it('adds the role, the save permission and the Claude Code label after the launch arguments', () => {
    expect(claudeCodeServer(packaged, { role: 'planner', allowSave: true })).toEqual(SERVER)
  })

  it('leaves out --allow-save when saving is not allowed', () => {
    expect(claudeCodeServer(packaged, { role: 'orchestrator', allowSave: false }).args).toEqual([
      '/Apps/dm/mcp.js',
      '--repo',
      '/repos/site',
      '--role',
      'orchestrator',
      '--label',
      'Claude Code'
    ])
  })

  it('has no env block when the runtime needs no environment', () => {
    const dev = { command: 'node', args: ['/work/dm/out/main/mcp.js', '--repo', '/repos/site'], env: {} }

    expect(claudeCodeServer(dev, { role: 'planner', allowSave: true })).toEqual({
      command: 'node',
      args: ['/work/dm/out/main/mcp.js', '--repo', '/repos/site', '--role', 'planner', '--allow-save', '--label', 'Claude Code']
    })
  })

  it('copies its inputs instead of sharing them', () => {
    const config = { command: 'node', args: ['mcp.js'], env: { A: '1' } }

    const server = claudeCodeServer(config, { role: 'planner', allowSave: false })
    server.args.push('--extra')
    if (server.env !== undefined) server.env.B = '2'

    expect(config).toEqual({ command: 'node', args: ['mcp.js'], env: { A: '1' } })
  })
})

describe('the entry for a packaged macOS app', () => {
  const APP = '/Applications/DarkMechanicus.app'
  const EXEC = `${APP}/Contents/MacOS/DarkMechanicus`
  const ASAR = `${APP}/Contents/Resources/app.asar`
  const REPO = '/Users/you/src/DarkMechanicus'
  const SCRIPT = join(ASAR, 'out', 'main', 'mcp.js')
  /** This repository's hand-written .mcp.json, verbatim apart from the repository path. */
  const HAND_WRITTEN = `{
  "mcpServers": {
    "darkmechanicus": {
      "command": "${EXEC}",
      "args": [
        ${JSON.stringify(SCRIPT)},
        "--repo",
        "${REPO}",
        "--role",
        "planner",
        "--allow-save",
        "--label",
        "Claude Code"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
`
  const server = claudeCodeServer(buildMcpConfig({ packaged: true, execPath: EXEC, appPath: ASAR, repoPath: REPO }), {
    role: 'planner',
    allowSave: true
  })

  it('runs the app as Node on the bundled mcp.js as a planner that may save', () => {
    expect(server).toEqual({
      command: EXEC,
      args: [SCRIPT, '--repo', REPO, '--role', 'planner', '--allow-save', '--label', 'Claude Code'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('creates the same file as the hand-written one', () => {
    expect(JSON.parse(writtenText(mergeMcpServer(null, server, { replace: false })))).toEqual(JSON.parse(HAND_WRITTEN))
  })

  it('finds the hand-written file already up to date', () => {
    expect(mergeMcpServer(HAND_WRITTEN, server, { replace: false })).toEqual({ outcome: 'unchanged' })
  })
})

describe('darkMechanicusServer', () => {
  const dev = { command: 'node', args: ['/work/dm/out/main/mcp.js', '--repo', '/repos/site'], env: {} }

  it('names the session with the given label, kept as one argument', () => {
    const server = darkMechanicusServer(dev, { role: 'orchestrator', allowSave: true, label: 'Codex · Fix the build' })

    expect(server).toEqual({
      command: 'node',
      args: ['/work/dm/out/main/mcp.js', '--repo', '/repos/site', '--role', 'orchestrator', '--allow-save', '--label', 'Codex · Fix the build']
    })
  })

  it('is what claudeCodeServer builds with the Claude Code label', () => {
    expect(darkMechanicusServer(dev, { role: 'planner', allowSave: false, label: 'Claude Code' })).toEqual(
      claudeCodeServer(dev, { role: 'planner', allowSave: false })
    )
  })
})
