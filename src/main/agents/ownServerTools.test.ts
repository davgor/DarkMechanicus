import { describe, expect, it } from 'vitest'
import type { ApprovalCategory } from '../../shared/agents/chat'
import type { AgentKind } from '../../shared/desktop/api'
import { isOwnServerCall } from './ownServerTools'

function call(agent: AgentKind, tool: string, category: ApprovalCategory = 'other'): boolean {
  return isOwnServerCall(agent, { category, tool })
}

describe('isOwnServerCall: Claude names a tool mcp__<server>__<tool>', () => {
  it.each(['mcp__darkmechanicus__claim_ticket', 'mcp__darkmechanicus__heartbeat_attempt', 'mcp__darkmechanicus__get_run'])('covers %s', (tool) => {
    expect(call('claude', tool)).toBe(true)
  })

  it.each([
    ['another server', 'mcp__other__claim_ticket'],
    ['a server whose name only starts with ours', 'mcp__darkmechanicus_evil__claim_ticket'],
    ['a server whose name ends the way ours does', 'mcp__not_darkmechanicus__claim_ticket'],
    ['a server named darkmechanicus__evil, which Claude would spell the same way as ours with a tool evil__x', 'mcp__darkmechanicus__evil__x'],
    ['an unprefixed name', 'darkmechanicus_claim_ticket'],
    ['the server with no tool', 'mcp__darkmechanicus__'],
    ['a prefix inside a longer name', 'xmcp__darkmechanicus__claim_ticket'],
    ['a tool name that is not one of ours (upper case)', 'mcp__darkmechanicus__Claim'],
    ['a tool name with a dot', 'mcp__darkmechanicus__claim.ticket'],
    ['a name that goes on after a line break', 'mcp__darkmechanicus__claim_ticket\nBash'],
    ['a built-in tool', 'Bash']
  ])('does not cover %s', (_what, tool) => {
    expect(call('claude', tool)).toBe(false)
  })

  it('covers only a request that is not a file edit or a command', () => {
    expect(call('claude', 'mcp__darkmechanicus__claim_ticket', 'command')).toBe(false)
    expect(call('claude', 'mcp__darkmechanicus__claim_ticket', 'file_edit')).toBe(false)
  })
})

describe('isOwnServerCall: Codex asks per server, as mcp:<server>', () => {
  it('covers the Dark Mechanicus server', () => {
    expect(call('codex', 'mcp:darkmechanicus')).toBe(true)
  })

  it.each(['mcp:other', 'mcp:darkmechanicus_evil', 'mcp:not_darkmechanicus', 'mcp:darkmechanicus:claim_ticket', 'mcp:', 'darkmechanicus', 'darkmechanicus.claim_ticket', 'permissions', 'shell'])(
    'does not cover %s',
    (tool) => {
      expect(call('codex', tool)).toBe(false)
    }
  )

  it('covers only a request that is not a file edit or a command', () => {
    expect(call('codex', 'mcp:darkmechanicus', 'command')).toBe(false)
  })
})

describe('isOwnServerCall: Cursor names a tool <server>:<tool>', () => {
  it.each(['darkmechanicus:claim_ticket', 'darkmechanicus:get_run'])('covers %s', (tool) => {
    expect(call('cursor', tool)).toBe(true)
  })

  it.each([
    ['another server', 'other:claim_ticket'],
    ['a server whose name only starts with ours', 'darkmechanicus_evil:claim_ticket'],
    ['a server whose name ends the way ours does', 'not_darkmechanicus:claim_ticket'],
    ['an unprefixed name', 'darkmechanicus_claim_ticket'],
    ['the server with no tool', 'darkmechanicus:'],
    ['a tool name that is not one of ours', 'darkmechanicus:Claim Ticket'],
    ['a tool with another server inside its name', 'darkmechanicus:claim:other'],
    ['a built-in tool', 'Shell']
  ])('does not cover %s', (_what, tool) => {
    expect(call('cursor', tool)).toBe(false)
  })

  it('covers only a request that is not a file edit or a command', () => {
    expect(call('cursor', 'darkmechanicus:claim_ticket', 'command')).toBe(false)
  })
})

describe('isOwnServerCall: one vendor never matches another vendor’s spelling', () => {
  it.each([
    ['claude', 'mcp:darkmechanicus'],
    ['claude', 'darkmechanicus:claim_ticket'],
    ['codex', 'mcp__darkmechanicus__claim_ticket'],
    ['codex', 'darkmechanicus:claim_ticket'],
    ['cursor', 'mcp__darkmechanicus__claim_ticket'],
    ['cursor', 'mcp:darkmechanicus']
  ] as const)('%s does not take %s', (agent, tool) => {
    expect(call(agent, tool)).toBe(false)
  })
})
