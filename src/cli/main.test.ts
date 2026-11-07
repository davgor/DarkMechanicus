import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../core/errors'
import type { LinearIssueItem, LinearTransferPacket } from '../shared/domain/transfer'
import { createStubWorkspace } from '../test/stubWorkspace'
import type { OpenWorkspaceOptions } from '../core/workspace'
import { skillBody } from '../mcp/skills'
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

function recorder(
  argv: string[],
  options: { env?: Record<string, string | undefined>; files?: Record<string, string>; stdin?: string; openError?: Error } = {}
): Recorded {
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
      readStdin: () => options.stdin ?? '',
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

  it('discovers the external launch capability and explicit nonempty cardIds contract', async () => {
    const listed = recorder(['--list'])
    await runCli(listed.host)
    expect(payload(listed).data).toContainEqual(expect.objectContaining({ command: 'launch_kanban_cards', capability: 'kanban.launch' }))
    const described = recorder(['--describe', 'launch_kanban_cards'])
    await runCli(described.host)
    expect(payload(described).data).toMatchObject({ command: 'launch_kanban_cards', capability: 'kanban.launch', mutates: true, input: { fields: ['cardIds'] } })
    expect(payload(described).data).toMatchObject({ input: { descriptions: { cardIds: expect.stringContaining('Explicit nonempty') } } })
    const { recorded, seen } = capturing(['call', 'launch_kanban_cards', '{"cardIds":["kc_00000000000000000000000001"]}'])
    await runCli(recorded.host)
    expect(seen).toEqual([{ cardIds: ['kc_00000000000000000000000001'] }])
    expect(recorded.exits).toEqual([0])
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

  it('presents no token for an empty token file, even when the environment has one', async () => {
    const recorded = recorder(['--token-file', TOKEN_FILE, 'call', 'list_epics'], {
      env: { DM_SESSION_TOKEN: 'dmg_env' },
      files: { [TOKEN_FILE]: '   ' }
    })
    await runCli(recorded.host)
    expect(recorded.opened[0]?.grantToken).toBeUndefined()
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

  it('says how to write a Windows path and names both other sources when the JSON is bad', async () => {
    const recorded = recorder(['call', 'create_epic', '{"title":"C:\\Users"}'])
    await runCli(recorded.host)
    const text = recorded.stdout.join('')
    expect(text).toContain('doubled backslashes')
    expect(text).toContain('forward slashes')
    expect(text).toContain('--args-file <path>')
    expect(text).toContain('pass -')
    expect(recorded.exits).toEqual([1])
  })
})

/** A recorder whose workspace keeps the input each command was run with. */
function capturing(argv: string[], options: Parameters<typeof recorder>[1] = {}): { recorded: Recorded; seen: unknown[] } {
  const recorded = recorder(argv, options)
  const seen: unknown[] = []
  recorded.host.open = (open) => {
    recorded.opened.push(open)
    const workspace = createStubWorkspace({ canned: {} })
    workspace.execute = (_name, input) => {
      seen.push(input)
      return Promise.resolve([])
    }
    return workspace
  }
  return { recorded, seen }
}

describe('dm call with --args-file and stdin', () => {
  it('reads the file, strips its byte-order mark, and keeps a Windows path written with doubled backslashes', async () => {
    const path = resolve(CWD, 'args.json')
    const { recorded, seen } = capturing(['call', 'create_epic', '--args-file', 'args.json'], {
      files: { [path]: '\uFEFF{"title":"C:\\\\Users\\\\dev"}' }
    })
    await runCli(recorded.host)
    expect(seen).toEqual([{ title: 'C:\\Users\\dev' }])
    expect(recorded.exits).toEqual([0])
  })

  it('reads stdin for a lone dash, and strips a byte-order mark there too', async () => {
    const { recorded, seen } = capturing(['call', 'create_epic', '-'], { stdin: '\uFEFF{"title":"from stdin"}' })
    await runCli(recorded.host)
    expect(seen).toEqual([{ title: 'from stdin' }])
    expect(recorded.exits).toEqual([0])
  })

  it('reads inline JSON as before', async () => {
    const { recorded, seen } = capturing(['call', 'create_epic', '{"title":"inline"}'])
    await runCli(recorded.host)
    expect(seen).toEqual([{ title: 'inline' }])
  })

  it('reports an unreadable arguments file as a failed result, not a crash', async () => {
    const recorded = recorder(['call', 'create_epic', '--args-file', 'missing.json'])
    recorded.host.readFile = () => {
      throw new Error('ENOENT: no such file')
    }
    await runCli(recorded.host)
    expect(payload(recorded)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(recorded.stdout.join('')).toContain('ENOENT')
    expect(recorded.exits).toEqual([1])
  })

  it('names a non-Error failure to read the arguments file in the message', async () => {
    const recorded = recorder(['call', 'create_epic', '--args-file', 'locked.json'])
    recorded.host.readFile = () => {
      throw 'locked by another process'
    }
    await runCli(recorded.host)
    expect(payload(recorded)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(recorded.stdout.join('')).toContain('locked by another process')
  })

  it('refuses inline JSON together with --args-file before opening anything', async () => {
    const recorded = recorder(['call', 'create_epic', '{}', '--args-file', 'args.json'])
    await runCli(recorded.host)
    expect(recorded.exits).toEqual([2])
    expect(recorded.opened).toEqual([])
    expect(recorded.stdout).toEqual([])
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

function issue(position: number, key: string, title: string): LinearIssueItem {
  return {
    ref: `tk_${position}`,
    key,
    marker: `dm:ep_1/tk_${position}`,
    position,
    milestoneRef: 'sp_1',
    title,
    description: `Body\n\ndm:ep_1/tk_${position}`,
    priority: 3,
    labels: [],
    state: 'default',
    blockedBy: []
  }
}

const PACKET: LinearTransferPacket = {
  format: 'darkmechanicus.linear-transfer',
  version: 1,
  epicId: 'ep_1',
  revisionId: 'rv_1',
  packetHash: 'sha256:abc',
  project: { ref: 'project', marker: 'dm:ep_1/project', name: 'Linear handoff', summary: 'dm:ep_1/project', content: 'dm:ep_1/project' },
  milestones: [{ ref: 'sp_1', marker: 'dm:ep_1/sp_1', position: 1, name: 'Sprint 1: Build', description: 'dm:ep_1/sp_1' }],
  issues: [issue(1, 'DM-1', 'First ticket'), issue(2, 'DM-2', 'Second ticket')],
  relations: []
}

const EPIC = 'ep_01m6772ffwkwr2a91fsqzfz1he'
const CLAIM_TOKEN = 'at_01m44wa86sxhxz3xv76qnvza2e.gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX'

/** A host whose workspace knows one epic (its title carries a claim token) and its transfer in `status`. */
function transferHost(argv: string[], status: string, options: { unknown?: boolean; env?: Record<string, string> } = {}): Recorded {
  const recorded = recorder(argv, { env: options.env })
  recorded.host.open = (open) => {
    recorded.opened.push(open)
    const workspace = createStubWorkspace({
      canned: {
        getEpic: { id: EPIC, title: `Linear handoff ${CLAIM_TOKEN}` },
        getTransfer: { epicId: EPIC, status, packet: PACKET, recorded: [], lastMismatches: [], next: [] }
      }
    })
    if (options.unknown === true) {
      workspace.getEpic = () => Promise.reject(new DomainError('not_found', 'There is no epic ep_nope.'))
    }
    return workspace
  }
  return recorded
}

describe('dm transfer linear', () => {
  it('prints the kickoff, the packet summary, the setup and the grant help as text, as a reader', async () => {
    const recorded = transferHost(['transfer', 'linear', '--epic', EPIC], 'queued', { env: { DM_SESSION_TOKEN: 'dmg_abc' } })
    await runCli(recorded.host)
    const text = recorded.stdout.join('')
    expect(recorded.exits).toEqual([0])
    expect(recorded.opened[0]).toMatchObject({ role: 'reader', transport: 'cli' })
    expect(recorded.opened[0]?.grantToken).toBeUndefined()
    expect(text.startsWith('The transfer is authorized.')).toBe(true)
    expect(text).toContain(`(${EPIC})`)
    expect(text).toContain(skillBody('linear-transfer').trimEnd())
    expect(text).not.toContain(CLAIM_TOKEN)
    expect(text).toContain('=== Packet summary ===')
    expect(text).toContain('- Sprint 1: Build: 2 issues')
    expect(text).toContain('1. DM-1 First ticket')
    expect(text).toContain('claude mcp add --transport http linear-server https://mcp.linear.app/mcp')
    expect(text).toContain('codex mcp add linear --url https://mcp.linear.app/mcp')
    expect(text).toContain('- Cursor: add https://mcp.linear.app/mcp in its MCP settings.')
    expect(text).toContain('Agent access card')
    expect(text).toContain('DM_SESSION_TOKEN')
    expect(() => JSON.parse(text) as unknown).toThrow()
  })

  it('says first when the transfer is not authorized', async () => {
    const recorded = transferHost(['transfer', 'linear', '--epic', EPIC], 'not_started')
    await runCli(recorded.host)
    expect(recorded.stdout.join('').startsWith('The transfer is not authorized yet.')).toBe(true)
    expect(recorded.exits).toEqual([0])
  })

  it('prints the packet with --json', async () => {
    const recorded = transferHost(['transfer', 'linear', '--epic', EPIC, '--json'], 'queued')
    await runCli(recorded.host)
    expect(JSON.parse(recorded.stdout.join(''))).toEqual(PACKET)
    expect(recorded.exits).toEqual([0])
  })

  it('errors for an unknown epic', async () => {
    const recorded = transferHost(['transfer', 'linear', '--epic', 'ep_nope'], 'queued', { unknown: true })
    await runCli(recorded.host)
    expect(recorded.stdout).toEqual([])
    expect(recorded.stderr.join('')).toContain('There is no epic ep_nope.')
    expect(recorded.exits).toEqual([1])
  })

  it('rejects a missing --epic as a usage mistake', async () => {
    const recorded = recorder(['transfer', 'linear'])
    await runCli(recorded.host)
    expect(recorded.exits).toEqual([2])
    expect(recorded.opened).toEqual([])
  })
})
