import { describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { arbiterEnv, terminalEnv, terminalLoginEnv } from './terminalEnv'

const CLI: DarkMechanicusCli = { env: { DM_SESSION_TOKEN: 'tok' } } as unknown as DarkMechanicusCli

const envFor = (kind: 'omp' | 'claude' | 'codex' | 'custom', base: Record<string, string> = {}): Record<string, string> =>
  terminalEnv({ base, platform: 'win32', kind, cli: CLI, launcherDir: null })

describe('terminalEnv: what the CLIs read to see a true-color xterm', () => {
  it.each(['omp', 'claude', 'codex', 'custom'] as const)('sets TERM and COLORTERM for %s over the inherited values', (kind) => {
    const env = envFor(kind, { TERM: 'dumb', colorterm: '', NO_COLOR: '1' })
    expect(env['TERM']).toBe('xterm-256color')
    expect(env['COLORTERM']).toBe('truecolor')
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'COLORTERM')).toEqual(['COLORTERM'])
  })

  it('sets the hyperlink and synchronized-output switches for OMP only', () => {
    expect(envFor('omp')['PI_FORCE_HYPERLINKS']).toBe('1')
    expect(envFor('omp')['PI_FORCE_SYNC_OUTPUT']).toBe('1')
    for (const kind of ['claude', 'codex', 'custom'] as const) {
      expect(envFor(kind)['PI_FORCE_HYPERLINKS']).toBeUndefined()
      expect(envFor(kind)['PI_FORCE_SYNC_OUTPUT']).toBeUndefined()
    }
  })

  it('gives a sign-in terminal TERM and COLORTERM and no OMP switches or grant', () => {
    const env = terminalLoginEnv({ TERM: 'dumb', DM_SESSION_TOKEN: 'x' })
    expect(env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })
    expect(env['PI_FORCE_HYPERLINKS']).toBeUndefined()
    expect(env['DM_SESSION_TOKEN']).toBeUndefined()
  })

  it.each(['omp', 'claude'] as const)('removes inherited terminal variables in every case for headless %s', (kind) => {
    const env = terminalEnv({
      base: { TERM: 'dumb', term: 'xterm', ColorTerm: 'truecolor', NODE_OPTIONS: '--inspect', dm_session_token: 'foreign' },
      platform: 'win32', kind, cli: CLI, launcherDir: null, headless: true
    })
    expect(Object.keys(env).some(key => /^(?:TERM|COLORTERM|NODE_OPTIONS)$/i.test(key))).toBe(false)
    expect(env['DM_SESSION_TOKEN']).toBe('tok')
    expect(env['dm_session_token']).toBeUndefined()
  })
})

it('gives only chat terminals their own naming address and never inherits one from the app environment', () => {
  const base = { DM_DESKTOP_PIPE: 'foreign', dm_session_token: 'foreign-token', dm_desktop_pipe: 'foreign-lower' }
  const cli = { ...CLI, env: { ...CLI.env, DM_DESKTOP_PIPE: 'owned-naming-pipe' } }
  const chat = terminalEnv({ base, platform: 'win32', kind: 'custom', cli, launcherDir: null })
  expect(chat['DM_DESKTOP_PIPE']).toBe('owned-naming-pipe')
  expect(Object.keys(chat).filter(key => key.toUpperCase() === 'DM_DESKTOP_PIPE')).toEqual(['DM_DESKTOP_PIPE'])
  const noChannel = terminalEnv({ base, platform: 'win32', kind: 'custom', cli: CLI, launcherDir: null })
  expect(Object.keys(noChannel).some(key => key.toUpperCase() === 'DM_DESKTOP_PIPE')).toBe(false)
  const login = terminalLoginEnv(base)
  expect(Object.keys(login).some(key => /^DM_(?:SESSION_TOKEN|DESKTOP_PIPE)$/iu.test(key))).toBe(false)
})

describe('terminalEnv: the Skitarii mail client descriptor', () => {
  const DESCRIPTOR = 'C:\\data\\agents\\omp\\ch_1\\dm-client\\gen.json'
  const stale = { DM_SKITARII_CLIENT_DESCRIPTOR: 'stale-upper', dm_skitarii_client_descriptor: 'stale-lower', Dm_Skitarii_Client_Descriptor: 'stale-mixed' }
  const descriptorKeys = (env: Record<string, string>): string[] => Object.keys(env).filter((key) => key.toUpperCase() === 'DM_SKITARII_CLIENT_DESCRIPTOR')

  it.each(['win32', 'darwin'] as const)('gives an OMP launch its own descriptor path, once, over any inherited variant (%s)', (platform) => {
    const env = terminalEnv({ base: stale, platform, kind: 'omp', cli: CLI, launcherDir: '/data/agents/bin/ch_1', dmClient: DESCRIPTOR })
    expect(descriptorKeys(env)).toEqual(['DM_SKITARII_CLIENT_DESCRIPTOR'])
    expect(env['DM_SKITARII_CLIENT_DESCRIPTOR']).toBe(DESCRIPTOR)
  })

  it.each(['omp', 'claude', 'codex', 'custom'] as const)('passes no inherited descriptor to a %s launch that has none', (kind) => {
    expect(descriptorKeys(envFor(kind, stale))).toEqual([])
  })

  it.each(['claude', 'codex', 'cursor', 'autonomous', 'custom'] as const)('refuses a descriptor for a %s launch', (kind) => {
    expect(() => terminalEnv({ base: {}, platform: 'win32', kind, cli: CLI, launcherDir: null, dmClient: DESCRIPTOR })).toThrow(/Only an OMP chat/)
  })

  it('gives a sign-in terminal no descriptor in any letter case', () => {
    expect(descriptorKeys(terminalLoginEnv(stale))).toEqual([])
  })
})

describe('arbiterEnv', () => {
  it.each(['claude', 'omp'] as const)('scrubs every grant, pipe, descriptor and runtime/terminal variant for %s', kind => {
    const base = Object.freeze({
      DM_SESSION_TOKEN: 'foreign', dm_session_token: 'lower',
      DM_DESKTOP_PIPE: 'pipe', Dm_Desktop_Pipe: 'mixed',
      DM_SKITARII_CLIENT_DESCRIPTOR: 'descriptor', dm_skitarii_client_descriptor: 'lower',
      ELECTRON_RUN_AS_NODE: '1', electron_enable_logging: '1', Electron_Custom: '1',
      NODE_OPTIONS: '--inspect', node_options: '--require=foreign',
      TERM: 'xterm', term: 'dumb', COLORTERM: 'truecolor', ColorTerm: 'other',
      Path: 'C:\\runtime', HOME: '/home/test', ANTHROPIC_API_KEY: 'fixture-key', OMITTED: undefined
    })
    const env = arbiterEnv(base, kind)
    expect(env).toEqual({
      Path: base.Path, HOME: base.HOME, ANTHROPIC_API_KEY: base.ANTHROPIC_API_KEY,
      ...(kind === 'claude' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : { PI_FORCE_HYPERLINKS: '1', PI_FORCE_SYNC_OUTPUT: '1' })
    })
    expect(env).not.toBe(base)
    expect(base.DM_SESSION_TOKEN).toBe('foreign')
  })

  it('overrides inherited kind constants case-insensitively without adding a dm launcher', () => {
    expect(arbiterEnv({ claude_code_disable_auto_memory: '0', PATH: '/usr/bin' }, 'claude'))
      .toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', PATH: '/usr/bin' })
    expect(arbiterEnv({ pi_force_hyperlinks: '0', Pi_Force_Sync_Output: '0' }, 'omp'))
      .toEqual({ PI_FORCE_HYPERLINKS: '1', PI_FORCE_SYNC_OUTPUT: '1' })
  })
})
