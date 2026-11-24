import { describe, expect, it } from 'vitest'
import type { AgentAuthStatus, AgentView } from '../desktop/api'
import { pickChatAgent } from './pickChatAgent'

function agent(kind: AgentView['kind'], id = kind): AgentView {
  return { id, kind, displayName: kind, executablePath: kind, args: [], version: null, needsReview: false, connectedVia: 'found', connectedAt: '', lastProbed: '' }
}
const signedIn: AgentAuthStatus = { state: 'signed_in', reason: '' }
const signedOut: AgentAuthStatus = { state: 'signed_out', reason: '' }

describe('pickChatAgent', () => {
  it('prefers installed signed-in Skitarii regardless of list order', () => {
    expect(pickChatAgent([agent('codex'), agent('claude'), agent('omp')], { codex: signedIn, claude: signedIn, omp: signedIn }))
      .toEqual({ agentId: 'omp', surface: 'gui' })
  })

  it.each([{ others: [] }, { others: [agent('omp')] }])('chooses Claude when Skitarii is missing or signed out ($others)', ({ others }) => {
    expect(pickChatAgent([agent('codex'), ...others, agent('claude')], { codex: signedIn, claude: signedIn, omp: signedOut }))
      .toEqual({ agentId: 'claude', surface: 'gui' })
  })

  it('does not select a signed-in agent that is not installed', () => {
    expect(pickChatAgent([agent('claude')], { claude: signedIn, omp: signedIn })).toEqual({ agentId: 'claude', surface: 'gui' })
  })

  it('uses the first signed-in GUI agent before any terminal-only agent', () => {
    const second = { ...agent('claude'), id: 'other-claude' }
    expect(pickChatAgent([agent('codex'), agent('claude'), second], { codex: signedIn, claude: signedIn, 'other-claude': signedIn }))
      .toEqual({ agentId: 'claude', surface: 'gui' })
  })

  it('falls back to the first signed-in terminal agent, including codex-only', () => {
    expect(pickChatAgent([agent('codex')], { codex: signedIn })).toEqual({ agentId: 'codex', surface: 'terminal' })
    expect(pickChatAgent([agent('cursor'), agent('codex')], { cursor: signedIn, codex: signedIn }))
      .toEqual({ agentId: 'cursor', surface: 'terminal' })
  })

  it.each(['signed_out', 'unknown', 'unchecked'] as const)('returns null when auth is %s, missing, or the list is empty', (state) => {
    expect(pickChatAgent([agent('omp'), agent('claude'), agent('codex')], { omp: { state, reason: '' }, claude: signedOut })).toBeNull()
    expect(pickChatAgent([], { omp: signedIn })).toBeNull()
  })
})
