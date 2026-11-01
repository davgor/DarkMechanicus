import { describe, expect, it } from 'vitest'
import { AGENT_DEFINITIONS, AGENT_KINDS, agentIdSchema, expectedExecutableNames } from './agentKinds'

describe('agent kind definitions', () => {
  it('is a closed set of claude, codex, cursor and autonomous', () => {
    expect([...AGENT_KINDS]).toEqual(['claude', 'codex', 'cursor', 'autonomous'])
    expect(Object.keys(AGENT_DEFINITIONS).sort()).toEqual([...AGENT_KINDS].sort())
  })

  it('gives every kind a display name', () => {
    expect(AGENT_DEFINITIONS.claude.displayName).toBe('Claude Code')
    expect(AGENT_DEFINITIONS.codex.displayName).toBe('Codex')
    expect(AGENT_DEFINITIONS.cursor.displayName).toBe('Cursor')
    expect(AGENT_DEFINITIONS.autonomous.displayName).toBe('Autonomous')
  })

  it('has a download for every kind but Autonomous, which installs itself', () => {
    expect(AGENT_KINDS.filter((kind) => !AGENT_DEFINITIONS[kind].downloadable)).toEqual(['autonomous'])
  })
})

describe('expectedExecutableNames', () => {
  it('uses the bare executable names outside Windows', () => {
    expect(expectedExecutableNames('claude', 'darwin')).toEqual(['claude'])
    expect(expectedExecutableNames('codex', 'linux')).toEqual(['codex'])
    expect(expectedExecutableNames('cursor', 'darwin')).toEqual(['agent', 'cursor-agent'])
    expect(expectedExecutableNames('autonomous', 'darwin')).toEqual(['a8s'])
  })

  it('adds the .exe and .cmd variants on Windows', () => {
    expect(expectedExecutableNames('claude', 'win32')).toEqual(['claude.exe', 'claude.cmd'])
    expect(expectedExecutableNames('codex', 'win32')).toEqual(['codex.exe', 'codex.cmd'])
    expect(expectedExecutableNames('cursor', 'win32')).toEqual([
      'agent.exe',
      'agent.cmd',
      'cursor-agent.exe',
      'cursor-agent.cmd'
    ])
  })
})

describe('agentIdSchema', () => {
  const ulid = '01m65kwqqeyajbj5bnq81gngrb'

  it('accepts each built-in kind name and a cu_ id of 26 Crockford base32 characters', () => {
    for (const kind of AGENT_KINDS) {
      expect(agentIdSchema.safeParse(kind).success).toBe(true)
    }
    expect(ulid).toHaveLength(26)
    expect(agentIdSchema.safeParse(`cu_${ulid}`).success).toBe(true)
  })

  it('rejects 25 and 27 characters, uppercase, path tricks, other names and the empty string', () => {
    for (const id of [
      `cu_${ulid.slice(1)}`,
      `cu_${ulid}0`,
      `cu_${ulid.toUpperCase()}`,
      `CU_${ulid}`,
      'cu_../../../../../../../../etc',
      `cu_${ulid.slice(0, 25)}u`,
      'custom',
      'Claude',
      ''
    ]) {
      expect(agentIdSchema.safeParse(id).success, id).toBe(false)
    }
  })
})
