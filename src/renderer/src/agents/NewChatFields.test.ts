import { describe, expect, it } from 'vitest'
import { agentView } from '../__mocks__/fixtures'
import { chattableAgents } from './NewChatFields'

describe('chattableAgents', () => {
  it('offers signed-in agents and agents whose sign-in cannot be checked, and hides signed-out and unknown ones', () => {
    const agents = ['in', 'unchecked', 'out', 'unknown', 'not_asked'].map((id) => agentView({ id, kind: 'custom', displayName: id }))
    const statuses = {
      in: { state: 'signed_in', reason: '' },
      unchecked: { state: 'unchecked', reason: '' },
      out: { state: 'signed_out', reason: '' },
      unknown: { state: 'unknown', reason: '' }
    } as const

    expect(chattableAgents(agents, statuses).map((agent) => agent.id)).toEqual(['in', 'unchecked'])
  })
})
