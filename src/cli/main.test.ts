import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../core/errors'
import { createStubWorkspace } from '../test/stubWorkspace'
import type { OpenWorkspaceOptions } from '../core/workspace'
import { type CliHost, resolveCommand, runCli, snakeCase } from './main'

// Resolved, as the CLI resolves them: on Windows `/work/repo` becomes `D:\work\repo`.
const CWD = resolve('/work/repo')
const TOKEN_FILE = resolve('/secrets/dm')

interface Recorded {
  host: CliHost
  stdout: string[]
  stderr: string[]
  exits: number[]
  opened: OpenWorkspaceOptions[]
  files: Record<string, string>
}

function recorder(argv: string[], options: { env?: Record<string, string | undefined>; files?: Record<string, string>; openError?: Error } = {}): Recorded {
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const opened: OpenWorkspaceOptions[] = []
  const files = options.files ?? {}
  return {
    stdout,
    stderr,
    exits,
    opened,
    files,
    host: {
      argv,
      env: options.env ?? {},
      cwd: CWD,
      open: (open) => {
        opened.push(open)
        if (options.openError !== undefined) {
          throw options.openError
        }
        return createStubWorkspace({ canned: { listEpics: [] } })
      },
      readFile: (path) => files[path] ?? '',
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      exit: (code) => exits.push(code)
    }
  }
}

function payload(recorded: Recorded): { ok: boolean; data?: unknown; error?: { code: string } } {
  return JSON.parse(recorded.stdout.join('')) as { ok: boolean; data?: unknown; error?: { code: string } }
}

describe('command names', () => {
  it('converts the internal spelling to the one the skills use', () => {
    expect(snakeCase('claimTicket')).toBe('claim_ticket')
    expect(snakeCase('getCapabilities')).toBe('get_capabilities')
    expect(snakeCase('read')).toBe('read')
  })

  it.each(['claim_ticket', 'claimTicket'])('accepts %s', (name) => {
    expect(resolveCommand(name)).toBe('claimTicket')
  })

  it('resolves nothing for a name that is no command', () => {
    expect(resolveCommand('frobnicate')).toBeNull()
    expect(resolveCommand('claim ticket')).toBeNull()
  })
})

describe('dm --list and --describe', () => {
  it('lists every command with the capability it needs, without opening the repository', async () => {
    const recorded = recorder(['--list'])
    await runCli(recorded.host)
    const data = payload(recorded).data as { command: string; capability: string }[]
    expect(data.find((entry) => entry.command === 'claim_ticket')?.capability).toBe('attempt.claim')
    expect(recorded.opened).toEqual([])
    expect(recorded.exits).toEqual([0])
  })

  it('describes one command and its input fields', async () => {
    const recorded = recorder(['--describe', 'create_epic'])
    await runCli(recorded.host)
    expect(payload(recorded).data).toMatchObject({ command: 'create_epic', alias: 'createEpic', mutates: true })
  })

  it('refuses an unknown name with the usage exit code and writes nothing to stdout', async () => {
    const recorded = recorder(['--describe', 'frobnicate'])
    await runCli(recorded.host)
    expect(recorded.exits).toEqual([2])
    expect(recorded.stdout).toEqual([])
    expect(recorded.stderr.join('')).toContain('unknown command')
  })
})

describe('dm call', () => {
  it('opens the repository as a cli session and prints the result', async () => {
    const recorded = recorder(['call', 'list_epics'])
    await runCli(recorded.host)
    expect(recorded.opened[0]).toMatchObject({ transport: 'cli', repoRoot: CWD })
    expect(payload(recorded)).toEqual({ ok: true, data: [] })
    expect(recorded.exits).toEqual([0])
  })

  it('presents no grant when neither the environment nor a file has one', async () => {
    const recorded = recorder(['call', 'list_epics'])
    await runCli(recorded.host)
    expect(recorded.opened[0]?.grantToken).toBeUndefined()
  })

  it('presents the token from the environment', async () => {
    const recorded = recorder(['call', 'list_epics'], { env: { DM_SESSION_TOKEN: 'dmg_abc' } })
    await runCli(recorded.host)
    expect(recorded.opened[0]?.grantToken).toBe('dmg_abc')
  })

  it('prefers a token file, and trims it', async () => {
    const recorded = recorder(['--token-file', TOKEN_FILE, 'call', 'list_epics'], {
      env: { DM_SESSION_TOKEN: 'dmg_env' },
      files: { [TOKEN_FILE]: 'dmg_file\n' }
    })
    await runCli(recorded.host)
    expect(recorded.opened[0]?.grantToken).toBe('dmg_file')
  })

  it('reports a refused command as a failure, not a crash', async () => {
    const recorded = recorder(['call', 'create_epic', '{"title":"x"}'], {
      openError: new DomainError('unauthorized', 'That grant is not usable')
    })
    await runCli(recorded.host)
    expect(recorded.exits).toEqual([1])
    expect(payload(recorded).ok).toBe(false)
  })

})

describe('dm and the grant hint', () => {
  it('says where a role comes from when a session with no grant is refused', async () => {
    const recorded = recorder(['call', 'create_epic', '{"title":"x"}'], {
      openError: new DomainError('unauthorized', 'not permitted')
    })
    await runCli(recorded.host)
    expect(recorded.stderr.join('')).toContain('presented no grant')
    expect(recorded.stderr.join('')).toContain('Agent access')
  })

  it('does not offer that hint to a session that did present one', async () => {
    const recorded = recorder(['call', 'create_epic', '{"title":"x"}'], {
      env: { DM_SESSION_TOKEN: 'dmg_abc' },
      openError: new DomainError('unauthorized', 'not permitted')
    })
    await runCli(recorded.host)
    expect(recorded.stderr.join('')).not.toContain('presented no grant')
  })

  it('keeps the hint off stdout, so the JSON stays machine-readable', async () => {
    const recorded = recorder(['call', 'create_epic', '{"title":"x"}'], {
      openError: new DomainError('unauthorized', 'not permitted')
    })
    await runCli(recorded.host)
    expect(() => JSON.parse(recorded.stdout.join(''))).not.toThrow()
  })

  it('refuses arguments that are not JSON', async () => {
    const recorded = recorder(['call', 'list_epics', 'not json'])
    await runCli(recorded.host)
    expect(payload(recorded)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(recorded.exits).toEqual([1])
  })
})

describe('dm usage errors', () => {
  it('exits 2 and explains, without printing a JSON result', async () => {
    const recorded = recorder(['--role', 'orchestrator'])
    await runCli(recorded.host)
    expect(recorded.exits).toEqual([2])
    expect(recorded.stdout).toEqual([])
    expect(recorded.stderr.join('')).toContain('Unknown option "--role"')
  })

  it('prints the help on request', async () => {
    const recorded = recorder(['--help'])
    await runCli(recorded.host)
    expect(recorded.stdout.join('')).toContain('Usage: dm')
    expect(recorded.exits).toEqual([0])
  })
})
