import { describe, expect, it } from 'vitest'
import { agentView } from '../__mocks__/fixtures'
import { chattableAgents, newChatAgent } from './NewChatFields'

const signedIn = { state: 'signed_in', reason: '' } as const

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

describe('newChatAgent', () => {
  const claude = agentView({ kind: 'claude' })
  const omp = agentView({ kind: 'omp' })

  it('picks a chattable OMP over an earlier-connected Claude when the folder has no default', () => {
    const statuses = { claude: signedIn, omp: signedIn }
    expect(newChatAgent(null, [claude, omp], statuses)).toBe('omp')
  })

  it('keeps a connected folder default of another agent over OMP', () => {
    const statuses = { claude: signedIn, omp: signedIn }
    expect(newChatAgent('claude', [claude, omp], statuses)).toBe('claude')
  })

  it('skips a signed-out OMP for a chattable agent, as before', () => {
    const statuses = { claude: signedIn, omp: { state: 'signed_out', reason: '' } } as const
    expect(newChatAgent(null, [claude, omp], statuses)).toBe('claude')
  })
})
