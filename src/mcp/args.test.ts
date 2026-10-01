import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_USAGE, parseMcpArgs } from './args'

const CWD = resolve('/work/current')
const NO_ENV: Record<string, string | undefined> = {}

function parse(argv: string[], env: Record<string, string | undefined> = NO_ENV) {
  return parseMcpArgs(argv, env, CWD)
}

describe('parseMcpArgs defaults', () => {
  it('defaults to the orchestrator role in the current directory', () => {
    expect(parse([])).toEqual({
      repo: CWD,
      role: 'orchestrator',
      allowSave: false,
      label: 'orchestrator via MCP',
      help: false
    })
  })

  it('derives the default label from the chosen role', () => {
    expect(parse(['--role', 'reviewer']).label).toBe('reviewer via MCP')
  })

  it('uses an explicit label verbatim', () => {
    expect(parse(['--label', 'Night shift']).label).toBe('Night shift')
    expect(parse(['--label=Day shift']).label).toBe('Day shift')
  })
})

describe('parseMcpArgs repository', () => {
  it('resolves --repo against the working directory', () => {
    expect(parse(['--repo', 'sub/dir']).repo).toBe(resolve(CWD, 'sub/dir'))
    expect(parse(['--repo', resolve('/abs/repo')]).repo).toBe(resolve('/abs/repo'))
    expect(parse(['--repo=' + resolve('/other/repo')]).repo).toBe(resolve('/other/repo'))
  })

  it('falls back to DARKMECHANICUS_REPO before the working directory', () => {
    const env = { DARKMECHANICUS_REPO: resolve('/env/repo') }
    expect(parse([], env).repo).toBe(resolve('/env/repo'))
  })

  it('prefers the flag over the environment', () => {
    const env = { DARKMECHANICUS_REPO: resolve('/env/repo') }
    expect(parse(['--repo', resolve('/flag/repo')], env).repo).toBe(resolve('/flag/repo'))
  })

  it('ignores an empty or blank environment value', () => {
    expect(parse([], { DARKMECHANICUS_REPO: '' }).repo).toBe(CWD)
    expect(parse([], { DARKMECHANICUS_REPO: '   ' }).repo).toBe(CWD)
  })

  it('consumes exactly the tokens of each flag form when they are mixed', () => {
    const argv = [
      '--repo=' + resolve('/mixed/repo'),
      '--role',
      'worker',
      '--label=Mixed',
      '--allow-save',
      '--label',
      'Final'
    ]
    expect(parse(argv)).toEqual({
      repo: resolve('/mixed/repo'),
      role: 'worker',
      allowSave: true,
      label: 'Final',
      help: false
    })
  })

  it('lets the last occurrence of a flag win', () => {
    const argv = ['--repo', resolve('/first'), '--repo', resolve('/second')]
    expect(parse(argv).repo).toBe(resolve('/second'))
  })
})

describe('parseMcpArgs roles and switches', () => {
  it('accepts every agent role in both spellings', () => {
    for (const role of ['planner', 'orchestrator', 'worker', 'reviewer'] as const) {
      expect(parse(['--role', role]).role).toBe(role)
      expect(parse([`--role=${role}`]).role).toBe(role)
    }
  })

  it('rejects the desktop role with an explanation', () => {
    expect(() => parse(['--role', 'desktop'])).toThrow(/desktop role is reserved/)
  })

  it('rejects unknown roles and lists the valid ones', () => {
    expect(() => parse(['--role', 'admin'])).toThrow(
      /Unknown role "admin"\. Use one of: planner, orchestrator, worker, reviewer\./
    )
  })

  it('enables saving only with --allow-save', () => {
    expect(parse(['--allow-save']).allowSave).toBe(true)
    expect(parse([]).allowSave).toBe(false)
  })

  it('rejects a value on a switch', () => {
    expect(() => parse(['--allow-save=yes'])).toThrow(/--allow-save does not take a value/)
  })
})

describe('parseMcpArgs help', () => {
  it('reports help for --help and -h', () => {
    expect(parse(['--help']).help).toBe(true)
    expect(parse(['-h']).help).toBe(true)
  })

  it('returns immediately on help without validating the rest', () => {
    const options = parse(['--help', '--role', 'desktop', '--bogus'])
    expect(options.help).toBe(true)
    expect(options.role).toBe('orchestrator')
  })

  it('ships usage text that documents every flag', () => {
    for (const flag of ['--repo', '--role', '--allow-save', '--label', '--help', 'DARKMECHANICUS_REPO']) {
      expect(MCP_USAGE).toContain(flag)
    }
  })
})

describe('parseMcpArgs errors', () => {
  it('rejects unknown options and stray arguments', () => {
    expect(() => parse(['--bogus'])).toThrow(/Unknown option "--bogus"/)
    expect(() => parse(['-x'])).toThrow(/Unknown option "-x"/)
    expect(() => parse(['stray'])).toThrow(/Unexpected argument "stray"/)
  })

  it('names the option that is missing its value', () => {
    expect(() => parse(['--repo'])).toThrow(/--repo requires a value/)
    expect(() => parse(['--role'])).toThrow(/--role requires a value/)
    expect(() => parse(['--label'])).toThrow(/--label requires a value/)
  })

  it('treats an empty value or a following flag as missing', () => {
    expect(() => parse(['--label', ''])).toThrow(/--label requires a value/)
    expect(() => parse(['--label='])).toThrow(/--label requires a value/)
    expect(() => parse(['--repo', '--role', 'planner'])).toThrow(/--repo requires a value/)
  })

  it('accepts an inline value that starts with dashes', () => {
    expect(parse(['--label=--odd']).label).toBe('--odd')
  })

  it('appends the usage text to every error', () => {
    expect(() => parse(['--bogus'])).toThrow(/Usage: /)
    expect(() => parse(['--role', 'x'])).toThrow(/Usage: /)
  })
})
