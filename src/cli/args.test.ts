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
    [['call', 'list_epics'], { kind: 'call', command: 'list_epics', input: '{}' }],
    [['call', 'get_epic', '{"epicId":"ep_1"}'], { kind: 'call', command: 'get_epic', input: '{"epicId":"ep_1"}' }],
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
    ['--token-file with no value', ['--token-file']]
  ])('refuses %s', (_label, argv) => {
    expect(() => parse(argv)).toThrow()
  })

  it('shows the usage with every refusal, so the next try can be right', () => {
    expect(() => parse(['frobnicate'])).toThrow(/Usage: dm/)
  })
})
