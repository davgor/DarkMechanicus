import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { McpServerEntry } from './mcpJson'
import { writeMcpServer, type McpJsonFs } from './mcpJsonFile'

const SERVER: McpServerEntry = { command: 'node', args: ['/dm/out/main/mcp.js', '--repo', '/repo', '--role', 'planner'] }
const SERVER_TEXT = `${JSON.stringify({ mcpServers: { darkmechanicus: SERVER } }, null, 2)}\n`

interface Sandbox {
  repo: string
  outside: string
}

/** A repository and an unrelated directory that must never be written to. */
function withSandbox(run: (sandbox: Sandbox) => void): void {
  // Native realpath, like production, so Windows 8.3 temp names (RUNNER~1) are already expanded.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-mcp-json-')))
  try {
    const repo = join(base, 'repo')
    const outside = join(base, 'outside')
    mkdirSync(repo)
    mkdirSync(outside)
    run({ repo, outside })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function errorOf(action: () => unknown): { code: string; message: string } {
  try {
    action()
  } catch (error) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message }
    }
    return { code: 'unexpected', message: String(error) }
  }
  return { code: 'no error', message: '' }
}

/** File symlinks need a privilege on Windows; report false there instead of failing the suite. */
function tryFileSymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return false
    }
    throw error
  }
}

function mcpJson(repo: string): string {
  return join(repo, '.mcp.json')
}

describe('writeMcpServer on a real repository', () => {
  it('creates .mcp.json at the repository root', () => {
    withSandbox(({ repo }) => {
      expect(writeMcpServer(repo, SERVER, { replace: false })).toEqual({ outcome: 'created' })
      expect(readFileSync(mcpJson(repo), 'utf8')).toBe(SERVER_TEXT)
      expect(readdirSync(repo)).toEqual(['.mcp.json'])
    })
  })

  it('adds the server to an existing file and keeps the other servers', () => {
    withSandbox(({ repo }) => {
      writeFileSync(mcpJson(repo), '{"mcpServers": {"other": {"command": "x"}}}')

      expect(writeMcpServer(repo, SERVER, { replace: false })).toEqual({ outcome: 'added' })
      expect(JSON.parse(readFileSync(mcpJson(repo), 'utf8'))).toEqual({
        mcpServers: { other: { command: 'x' }, darkmechanicus: SERVER }
      })
    })
  })

})

describe('writeMcpServer with an existing entry or a broken file', () => {
  it('leaves the file as it is when it is already up to date', () => {
    withSandbox(({ repo }) => {
      const current = JSON.stringify({ mcpServers: { darkmechanicus: SERVER } })
      writeFileSync(mcpJson(repo), current)

      expect(writeMcpServer(repo, SERVER, { replace: true })).toEqual({ outcome: 'unchanged' })
      expect(readFileSync(mcpJson(repo), 'utf8')).toBe(current)
    })
  })

  it('reports a different darkmechanicus entry without writing, and replaces it when asked', () => {
    withSandbox(({ repo }) => {
      const current = '{"mcpServers": {"darkmechanicus": {"command": "old"}}}'
      writeFileSync(mcpJson(repo), current)

      expect(writeMcpServer(repo, SERVER, { replace: false })).toEqual({
        outcome: 'conflict',
        existing: '{\n  "command": "old"\n}'
      })
      expect(readFileSync(mcpJson(repo), 'utf8')).toBe(current)

      expect(writeMcpServer(repo, SERVER, { replace: true })).toEqual({ outcome: 'replaced' })
      expect(readFileSync(mcpJson(repo), 'utf8')).toBe(SERVER_TEXT)
    })
  })

  it('leaves a file that is not valid JSON untouched and says why', () => {
    withSandbox(({ repo }) => {
      writeFileSync(mcpJson(repo), '{ broken')

      const result = writeMcpServer(repo, SERVER, { replace: true })

      expect(result.outcome).toBe('invalid')
      expect(result.outcome === 'invalid' ? result.message : '').toContain('.mcp.json is not valid JSON')
      expect(readFileSync(mcpJson(repo), 'utf8')).toBe('{ broken')
    })
  })

  it('reports a missing repository folder as not_found and creates nothing', () => {
    withSandbox(({ repo }) => {
      const gone = join(repo, 'gone')

      expect(errorOf(() => writeMcpServer(gone, SERVER, { replace: false })).code).toBe('not_found')
      expect(existsSync(gone)).toBe(false)
    })
  })
})

describe('writeMcpServer refusals', () => {
  it('refuses when .mcp.json is a symbolic link out of the repository and leaves its target alone', () => {
    withSandbox(({ repo, outside }) => {
      const target = join(outside, 'precious.json')
      writeFileSync(target, '{"mcpServers": {}}')
      if (!tryFileSymlink(target, mcpJson(repo))) {
        expect(process.platform).toBe('win32')
        return
      }

      expect(errorOf(() => writeMcpServer(repo, SERVER, { replace: true }))).toEqual({
        code: 'unsafe_path',
        message: `Refusing to write .mcp.json: ${mcpJson(repo)} is a symbolic link.`
      })
      expect(readFileSync(target, 'utf8')).toBe('{"mcpServers": {}}')
    })
  })

  it('refuses a dangling symbolic link instead of creating its target', () => {
    withSandbox(({ repo, outside }) => {
      const target = join(outside, 'created-by-link.json')
      if (!tryFileSymlink(target, mcpJson(repo))) {
        expect(process.platform).toBe('win32')
        return
      }

      expect(errorOf(() => writeMcpServer(repo, SERVER, { replace: false })).code).toBe('unsafe_path')
      expect(existsSync(target)).toBe(false)
    })
  })

})

describe('writeMcpServer with other entries at .mcp.json', () => {
  it('refuses a symbolic link even when it points inside the repository', () => {
    withSandbox(({ repo }) => {
      const target = join(repo, 'real.json')
      writeFileSync(target, '{}')
      if (!tryFileSymlink(target, mcpJson(repo))) {
        expect(process.platform).toBe('win32')
        return
      }

      expect(errorOf(() => writeMcpServer(repo, SERVER, { replace: false })).code).toBe('unsafe_path')
      expect(readFileSync(target, 'utf8')).toBe('{}')
    })
  })

  it('refuses when .mcp.json is a directory', () => {
    withSandbox(({ repo }) => {
      mkdirSync(mcpJson(repo))

      expect(errorOf(() => writeMcpServer(repo, SERVER, { replace: false }))).toEqual({
        code: 'unsafe_path',
        message: `Refusing to write .mcp.json: ${mcpJson(repo)} is not a regular file.`
      })
      expect(readdirSync(mcpJson(repo))).toEqual([])
    })
  })

  it('writes into the real folder when the repository path itself is a link to it', () => {
    withSandbox(({ repo, outside }) => {
      const link = join(outside, 'repo-link')
      symlinkSync(repo, link, 'junction')

      expect(writeMcpServer(link, SERVER, { replace: false })).toEqual({ outcome: 'created' })
      expect(readFileSync(mcpJson(repo), 'utf8')).toBe(SERVER_TEXT)
    })
  })
})

interface FakeFile {
  kind: ReturnType<McpJsonFs['entryKind']>
  text?: string
}

/** In-memory McpJsonFs: one optional .mcp.json, real paths remapped, writes recorded. */
function createFakeFs(file: FakeFile, realpaths: Record<string, string>): { fs: McpJsonFs; written: string[] } {
  const written: string[] = []
  const fs: McpJsonFs = {
    entryKind: () => file.kind,
    readFile: () => file.text ?? '',
    writeFile: (path) => {
      written.push(path)
    },
    realpath: (path) => realpaths[path] ?? path
  }
  return { fs, written }
}

describe('writeMcpServer containment', () => {
  const root = join(sep, 'repo')
  const file = join(root, '.mcp.json')
  const existing: FakeFile = { kind: 'file', text: '{}' }

  it('writes when the resolved file stays inside the repository', () => {
    const { fs, written } = createFakeFs(existing, {})

    expect(writeMcpServer(root, SERVER, { replace: false }, fs)).toEqual({ outcome: 'added' })
    expect(written).toEqual([file])
  })

  it('creates the file at the repository root without resolving it', () => {
    const { fs, written } = createFakeFs({ kind: 'missing' }, { [file]: join(sep, 'elsewhere', '.mcp.json') })

    expect(writeMcpServer(root, SERVER, { replace: false }, fs)).toEqual({ outcome: 'created' })
    expect(written).toEqual([file])
  })

  it('refuses when the resolved file escapes the repository', () => {
    const { fs, written } = createFakeFs(existing, { [file]: join(sep, 'elsewhere', '.mcp.json') })

    expect(errorOf(() => writeMcpServer(root, SERVER, { replace: false }, fs))).toEqual({
      code: 'unsafe_path',
      message: `Refusing to write .mcp.json outside the repository: ${join(sep, 'elsewhere', '.mcp.json')}`
    })
    expect(written).toEqual([])
  })

  it('refuses a sibling folder whose name merely starts with the repository name', () => {
    const { fs, written } = createFakeFs(existing, { [file]: join(sep, 'repo-evil', '.mcp.json') })

    expect(errorOf(() => writeMcpServer(root, SERVER, { replace: false }, fs)).code).toBe('unsafe_path')
    expect(written).toEqual([])
  })

})

describe('writeMcpServer containment edge cases', () => {
  const root = join(sep, 'repo')
  const file = join(root, '.mcp.json')
  const existing: FakeFile = { kind: 'file', text: '{}' }

  it('refuses a file that resolves to the repository root or its parent', () => {
    const atRoot = createFakeFs(existing, { [file]: root })
    const atParent = createFakeFs(existing, { [file]: join(root, '..') })

    expect(errorOf(() => writeMcpServer(root, SERVER, { replace: false }, atRoot.fs)).code).toBe('unsafe_path')
    expect(errorOf(() => writeMcpServer(root, SERVER, { replace: false }, atParent.fs)).code).toBe('unsafe_path')
    expect(atRoot.written.concat(atParent.written)).toEqual([])
  })

  it('canonicalizes the repository root before comparing', () => {
    const real = join(sep, 'real', 'repo')
    const { fs, written } = createFakeFs(existing, { [root]: real, [file]: join(real, '.mcp.json') })

    expect(writeMcpServer(root, SERVER, { replace: false }, fs)).toEqual({ outcome: 'added' })
    expect(written).toEqual([file])
  })

  it('refuses other kinds of entries before reading anything', () => {
    const reads: string[] = []
    const { fs, written } = createFakeFs({ kind: 'other' }, {})
    fs.readFile = (path) => {
      reads.push(path)
      return '{}'
    }

    expect(errorOf(() => writeMcpServer(root, SERVER, { replace: false }, fs)).code).toBe('unsafe_path')
    expect(reads).toEqual([])
    expect(written).toEqual([])
  })
})
