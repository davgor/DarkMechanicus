import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_USAGE, parseCliArgs, TOKEN_ENV } from './args'

const CWD = resolve('/work/repo')

function parse(argv: string[], env: Record<string, string | undefined> = {}) {
  return parseCliArgs(argv, env, CWD)
}

describe('parseCliArgs modes', () => {
  it.each([
    [['--list'], { kind: 'list' }],
    [['--describe', 'claim_ticket'], { kind: 'describe', command: 'claim_ticket' }],
    [['call', 'list_epics'], { kind: 'call', command: 'list_epics', input: { source: 'inline', text: '{}' } }],
    [
      ['call', 'get_epic', '{"epicId":"ep_1"}'],
      { kind: 'call', command: 'get_epic', input: { source: 'inline', text: '{"epicId":"ep_1"}' } }
    ],
    [['--help'], { kind: 'help' }],
    [['-h'], { kind: 'help' }]
  ])('reads %j', (argv, mode) => {
    expect(parse(argv).mode).toEqual(mode)
  })

  it('treats help as the whole request, whatever follows it', () => {
    expect(parse(['--help', 'call', 'nonsense']).mode).toEqual({ kind: 'help' })
  })
})

describe('parseCliArgs repository', () => {
  it('defaults to the working directory', () => {
    expect(parse(['--list']).repo).toBe(CWD)
  })

  it('resolves a relative --repo against it', () => {
    expect(parse(['--repo', '../other', '--list']).repo).toBe(resolve(CWD, '../other'))
  })

  it('falls back to the environment before the working directory', () => {
    expect(parse(['--list'], { DARKMECHANICUS_REPO: '/elsewhere' }).repo).toBe(resolve('/elsewhere'))
    expect(parse(['--list'], { DARKMECHANICUS_REPO: '   ' }).repo).toBe(CWD)
  })

  it('prefers the flag over the environment', () => {
    expect(parse(['--repo', '/flag', '--list'], { DARKMECHANICUS_REPO: '/env' }).repo).toBe(resolve('/flag'))
  })
})

describe('parseCliArgs and the grant token', () => {
  it('has no token file unless one is named', () => {
    expect(parse(['--list']).tokenFile).toBeNull()
  })

  it('resolves --token-file against the working directory', () => {
    expect(parse(['--token-file', '.secrets/dm', '--list']).tokenFile).toBe(resolve(CWD, '.secrets/dm'))
  })

  it('never takes a role from the command line', () => {
    // The point of the design: a local process cannot promote itself by passing a flag.
    for (const argv of [['--role', 'orchestrator', '--list'], ['call', 'list_epics', '--allow-save']]) {
      expect(() => parse(argv)).toThrow()
    }
    expect(CLI_USAGE).not.toContain('--role')
    expect(CLI_USAGE).toContain(TOKEN_ENV)
  })
})

describe('parseCliArgs refusals', () => {
  it.each([
    ['nothing at all', []],
    ['an unknown command', ['frobnicate']],
    ['--describe with no command', ['--describe']],
    ['call with no command', ['call']],
    ['call with too many arguments', ['call', 'list_epics', '{}', 'extra']],
    ['--repo with no value', ['--repo']],
    ['--repo followed by a flag', ['--repo', '--list']],
    ['--token-file with no value', ['--token-file']],
    ['--args-file with no value', ['call', 'list_epics', '--args-file']],
    ['--args-file outside call', ['--list', '--args-file', 'a.json']],
    ['--args-file on transfer', ['transfer', 'linear', '--epic', 'ep_1', '--args-file', 'a.json']],
    ['inline JSON with --args-file', ['call', 'list_epics', '{}', '--args-file', 'a.json']],
    ['stdin with --args-file', ['call', 'list_epics', '-', '--args-file', 'a.json']]
  ])('refuses %s', (_label, argv) => {
    expect(() => parse(argv)).toThrow()
  })

  it('shows the usage with every refusal, so the next try can be right', () => {
    expect(() => parse(['frobnicate'])).toThrow(/Usage: dm/)
  })
})

describe('parseCliArgs call input sources', () => {
  it('reads a file, resolved against the working directory', () => {
    expect(parse(['call', 'create_epic', '--args-file', 'input/epic.json']).mode).toEqual({
      kind: 'call',
      command: 'create_epic',
      input: { source: 'file', path: resolve(CWD, 'input/epic.json') }
    })
  })

  it('reads stdin for a lone dash', () => {
    expect(parse(['call', 'create_epic', '-']).mode).toEqual({
      kind: 'call',
      command: 'create_epic',
      input: { source: 'stdin' }
    })
  })

  it('takes the file when a dash-like word is not the third word', () => {
    expect(parse(['call', 'create_epic', '--args-file', '-']).mode).toEqual({
      kind: 'call',
      command: 'create_epic',
      input: { source: 'file', path: resolve(CWD, '-') }
    })
  })

  it('lists the new sources in the usage', () => {
    expect(CLI_USAGE).toContain('--args-file <path>')
    expect(CLI_USAGE).toContain('json|-')
  })
})

describe('parseCliArgs transfer linear', () => {
  it('reads the epic, with and without --json', () => {
    expect(parse(['transfer', 'linear', '--epic', 'ep_1']).mode).toEqual({
      kind: 'transfer',
      target: 'linear',
      epicId: 'ep_1',
      json: false
    })
    expect(parse(['--json', 'transfer', 'linear', '--epic', 'ep_1']).mode).toMatchObject({ epicId: 'ep_1', json: true })
  })

  it('rejects a missing --epic', () => {
    expect(() => parse(['transfer', 'linear'])).toThrow(/transfer linear requires --epic <id>/)
    expect(() => parse(['transfer', 'linear', '--epic'])).toThrow(/--epic requires a value/)
  })

  it('rejects another target or an extra word', () => {
    expect(() => parse(['transfer', '--epic', 'ep_1'])).toThrow(/one target: linear/)
    expect(() => parse(['transfer', 'jira', '--epic', 'ep_1'])).toThrow(/one target: linear/)
    expect(() => parse(['transfer', 'linear', 'now', '--epic', 'ep_1'])).toThrow(/one target: linear/)
  })

  it('keeps --epic and --json to this mode', () => {
    expect(() => parse(['call', 'list_epics', '--json'])).toThrow(/belong to transfer linear only/)
    expect(() => parse(['--list', '--epic', 'ep_1'])).toThrow(/belong to transfer linear only/)
  })

  it('is in the usage', () => {
    expect(CLI_USAGE).toContain('transfer linear --epic <id> [--json]')
  })
})

describe('parseCliArgs usage', () => {
  it('reads the run with the default billing and no session file', () => {
    expect(parse(['usage', '--run', 'run_1']).mode).toEqual({
      kind: 'usage',
      runId: 'run_1',
      sessionFile: null,
      billing: 'unknown',
      dryRun: false,
      unavailable: null
    })
  })

  it('resolves --session-file against the working directory and keeps billing and --dry-run', () => {
    const argv = ['usage', '--run', 'run_1', '--session-file', 'logs/s.jsonl', '--billing', 'subscription', '--dry-run']
    expect(parse(argv).mode).toMatchObject({ sessionFile: resolve(CWD, 'logs/s.jsonl'), billing: 'subscription', dryRun: true })
  })

  it('falls back to $PI_SESSION_FILE, ignoring a blank one', () => {
    expect(parse(['usage', '--run', 'run_1'], { PI_SESSION_FILE: 'env/s.jsonl' }).mode).toMatchObject({ sessionFile: resolve(CWD, 'env/s.jsonl') })
    expect(parse(['usage', '--run', 'run_1'], { PI_SESSION_FILE: '  ' }).mode).toMatchObject({ sessionFile: null })
  })

  it('records an unavailable host without reading any session file', () => {
    expect(parse(['usage', '--run', 'run_1', '--unavailable', 'codex'], { PI_SESSION_FILE: 'env/s.jsonl' }).mode).toMatchObject({
      sessionFile: null,
      unavailable: 'codex'
    })
  })

  it.each([
    ['a missing --run', ['usage'], /usage requires --run <id>/],
    ['an extra word', ['usage', 'now', '--run', 'run_1'], /usage takes only its flags/],
    ['--args-file', ['usage', '--run', 'run_1', '--args-file', 'a.json'], /usage takes only its flags/],
    ['an unknown billing', ['usage', '--run', 'run_1', '--billing', 'free'], /--billing is one of api_key, subscription, unknown/],
    ['both session sources', ['usage', '--run', 'run_1', '--session-file', 's.jsonl', '--unavailable', 'codex'], /not both/],
    ['--epic', ['usage', '--run', 'run_1', '--epic', 'ep_1'], /belong to transfer linear only/],
    ['--json', ['usage', '--run', 'run_1', '--json'], /belong to transfer linear only/]
  ])('refuses %s', (_label, argv, message) => {
    expect(() => parse(argv)).toThrow(message)
  })

  it.each([
    ['--run', ['--list', '--run', 'run_1']],
    ['--dry-run', ['--list', '--dry-run']]
  ])('keeps %s to usage', (_label, argv) => {
    expect(() => parse(argv)).toThrow(/belong to usage only/)
  })
})
