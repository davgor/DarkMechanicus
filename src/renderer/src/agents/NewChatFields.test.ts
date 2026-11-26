// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAuthStatus, AgentView } from '../../../shared/desktop/api'
import { agentView } from '../__mocks__/fixtures'
import { AgentChoice, chattableAgents, newChatAgent } from './NewChatFields'

afterEach(cleanup)

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

  it('ignores a folder default that is no longer connected, and names no agent when none is connected', () => {
    const statuses = { claude: signedIn, omp: signedIn }
    expect(newChatAgent('codex', [claude, omp], statuses)).toBe('omp')
    expect(newChatAgent('codex', [claude], { claude: signedIn })).toBe('claude')
    expect(newChatAgent('codex', [], {})).toBeNull()
  })

  it('falls back to the first connected agent when none can chat', () => {
    expect(newChatAgent(null, [claude, omp], { claude: { state: 'signed_out', reason: '' }, omp: { state: 'unknown', reason: '' } })).toBe('claude')
  })
})

describe('New chat rendered agent choice', () => {
  const agents = [agentView({ kind: 'codex' }), agentView({ kind: 'claude' }), agentView({ kind: 'omp' })]
  function Choice({ statuses }: { statuses: Record<string, AgentAuthStatus> }): React.ReactElement {
    const [value, setValue] = useState(() => newChatAgent(null, agents, statuses) ?? '')
    return createElement(AgentChoice, { agents, statuses, value, onChange: setValue,
      onAddAgent: () => { throw new Error('Unexpected setup navigation') },
      onAgentStatus: () => { throw new Error('Unexpected authentication call') } })
  }

  it.each([
    [{ claude: signedIn, omp: signedIn }, 'Skitarii'],
    [{ claude: signedIn, codex: signedIn }, 'Claude Code']
  ] as const)('preselects the shared signed-in GUI default %s', (statuses, selected) => {
    render(createElement(Choice, { statuses }))
    expect((screen.getByRole('radio', { name: new RegExp(selected) }) as HTMLInputElement).checked).toBe(true)
  })

  it('preserves the person’s different selection through a status refresh', () => {
    const view = render(createElement(Choice, { statuses: { claude: signedIn, omp: signedIn } }))
    fireEvent.click(screen.getByRole('radio', { name: /Claude Code/ }))
    view.rerender(createElement(Choice, { statuses: { claude: signedIn, omp: signedIn, codex: signedIn } }))
    expect((screen.getByRole('radio', { name: /Claude Code/ }) as HTMLInputElement).checked).toBe(true)
  })

  it('uses kind rather than registry order to prefer signed-in Claude over terminal-only agents', () => {
    const registered: AgentView[] = agents
    expect(newChatAgent(null, registered, { codex: signedIn, claude: signedIn })).toBe('claude')
  })
})
