import { describe, expect, it } from 'vitest'
import { AGENT_DEFINITIONS, AGENT_KINDS, expectedExecutableNames } from './agentKinds'

describe('agent kind definitions', () => {
  it('is a closed set of claude, codex and cursor', () => {
    expect([...AGENT_KINDS]).toEqual(['claude', 'codex', 'cursor'])
    expect(Object.keys(AGENT_DEFINITIONS).sort()).toEqual([...AGENT_KINDS].sort())
  })

  it('gives every kind a display name', () => {
    expect(AGENT_DEFINITIONS.claude.displayName).toBe('Claude Code')
    expect(AGENT_DEFINITIONS.codex.displayName).toBe('Codex')
    expect(AGENT_DEFINITIONS.cursor.displayName).toBe('Cursor')
  })
})

describe('expectedExecutableNames', () => {
  it('uses the bare executable names outside Windows', () => {
    expect(expectedExecutableNames('claude', 'darwin')).toEqual(['claude'])
    expect(expectedExecutableNames('codex', 'linux')).toEqual(['codex'])
    expect(expectedExecutableNames('cursor', 'darwin')).toEqual(['agent', 'cursor-agent'])
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
