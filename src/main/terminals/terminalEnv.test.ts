import { describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { terminalEnv, terminalLoginEnv } from './terminalEnv'

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
})
