// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { useAgents } from './useAgents'

let dm: FakeDm
let errors: string[]

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const claude = agentView({ kind: 'claude' })
const codex = agentView({ kind: 'codex', executablePath: '/usr/local/bin/codex', version: '0.9.1' })

async function mount(): Promise<ReturnType<typeof renderHook<ReturnType<typeof useAgents>, undefined>>> {
  const view = renderHook(() => useAgents((error) => errors.push((error as Error).message)))
  await settle()
  return view
}

type View = Awaited<ReturnType<typeof mount>>
const model = (view: View): ReturnType<typeof useAgents> => view.result.current

describe('useAgents listing', () => {
  it('lists the connected agents in the order of the add-agent cards', async () => {
    dm.agents = [codex, claude]
    const view = await mount()
    expect(model(view).loaded).toBe(true)
    expect(model(view).agents.map((agent) => agent.kind)).toEqual(['claude', 'codex'])
  })

  it('is loaded and empty when there are no agents', async () => {
    const view = await mount()
    expect(model(view)).toMatchObject({ loaded: true, agents: [] })
  })

  it('reports a failed listing and still finishes loading', async () => {
    dm.listAgents = () => Promise.reject(new Error('registry unreadable'))
    const view = await mount()
    expect(model(view)).toMatchObject({ loaded: true, agents: [] })
    expect(errors).toEqual(['registry unreadable'])
  })
})

describe('useAgents sign-in state', () => {
  it('asks each connected agent for its state, and only those', async () => {
    dm.agents = [claude]
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    const view = await mount()
    expect(model(view).statuses.claude).toEqual({ state: 'signed_in', reason: 'Signed in.' })
    expect(dm.agentCallsOf('agentStatus')).toEqual([['claude']])
  })

  it('checks again when the window regains focus', async () => {
    dm.agents = [claude]
    dm.agentStatuses.claude = { state: 'signed_out', reason: 'Not signed in.' }
    const view = await mount()
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(model(view).statuses.claude?.state).toBe('signed_in')
  })

  it('keeps the last state when a check fails, and reports it', async () => {
    dm.agents = [claude]
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    const view = await mount()
    dm.agentStatus = () => Promise.reject(new Error('cli crashed'))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(model(view).statuses.claude?.state).toBe('signed_in')
    expect(errors).toEqual(['cli crashed'])
  })
})

describe('useAgents find', () => {
  it('names only the kind, and is in flight until the dialog answers', async () => {
    const hold = dm.holdAgent('findAgent')
    const view = await mount()
    act(() => {
      void model(view).find('claude')
    })
    await settle()
    expect(dm.agentCallsOf('findAgent')).toEqual([['claude']])
    expect(model(view).activity('claude')).toMatchObject({ finding: true, busy: true })
    expect(model(view).activity('codex').busy).toBe(false)
    hold.resolve()
    await settle()
    expect(model(view).activity('claude')).toMatchObject({ finding: false, busy: false })
  })

  it('opens one dialog however often it is pressed while one is open', async () => {
    const hold = dm.holdAgent('findAgent')
    const view = await mount()
    act(() => {
      void model(view).find('claude')
      void model(view).find('claude')
    })
    await settle()
    hold.resolve()
    await settle()
    expect(dm.agentCallsOf('findAgent')).toHaveLength(1)
  })

  it('adds a connected agent and says so', async () => {
    dm.findOutcomes = [{ outcome: 'connected', agent: claude }]
    const view = await mount()
    await act(() => model(view).find('claude'))
    expect(model(view).agents).toEqual([claude])
    expect(model(view).activity('claude').outcome).toMatchObject({ tone: 'ok', title: 'Connected Claude Code 2.1.4' })
  })

  it('checks the sign-in state of a newly connected agent', async () => {
    dm.findOutcomes = [{ outcome: 'connected', agent: claude }]
    dm.agentStatuses.claude = { state: 'signed_out', reason: 'Not signed in.' }
    const view = await mount()
    await act(() => model(view).find('claude'))
    await settle()
    expect(model(view).statuses.claude?.state).toBe('signed_out')
  })

  it('shows why a pick was refused and connects nothing', async () => {
    dm.findOutcomes = [{ outcome: 'refused', code: 'wrong_program', reason: 'That is not Claude Code.' }]
    const view = await mount()
    await act(() => model(view).find('claude'))
    expect(model(view).agents).toEqual([])
    expect(model(view).activity('claude').outcome).toMatchObject({ tone: 'error', detail: 'That is not Claude Code.' })
  })

})

describe('useAgents find results', () => {
  it('says nothing when the dialog is closed, and clears an older result', async () => {
    dm.findOutcomes = [{ outcome: 'refused', code: 'failed', reason: 'Broken.' }, { outcome: 'cancelled' }]
    const view = await mount()
    await act(() => model(view).find('claude'))
    await act(() => model(view).find('claude'))
    expect(model(view).activity('claude').outcome).toBeNull()
  })

  it('reports a rejected call and frees the buttons', async () => {
    dm.findAgent = () => Promise.reject(new Error('ipc closed'))
    const view = await mount()
    await act(() => model(view).find('claude'))
    expect(errors).toEqual(['ipc closed'])
    expect(model(view).activity('claude').busy).toBe(false)
  })
})

describe('useAgents download', () => {
  const installed = { outcome: 'installed', agent: claude, updated: false } as const

  it('starts at the confirmation, follows the progress, then reports the install', async () => {
    const hold = dm.holdAgent('downloadAgent')
    dm.downloadOutcomes = [installed]
    const view = await mount()
    act(() => {
      void model(view).download('claude')
    })
    await settle()
    expect(dm.agentCallsOf('downloadAgent')).toEqual([['claude']])
    expect(model(view).activity('claude').download).toEqual({ phase: 'confirming', percent: null })

    act(() => dm.emitProgress({ kind: 'claude', phase: 'downloading', percent: 40 }))
    expect(model(view).activity('claude').download).toEqual({ phase: 'downloading', percent: 40 })
    expect(model(view).activity('codex').download).toBeNull()

    hold.resolve()
    await settle()
    expect(model(view).activity('claude')).toMatchObject({ download: null, busy: false })
    expect(model(view).activity('claude').outcome).toMatchObject({ tone: 'ok', title: 'Installed Claude Code 2.1.4' })
    expect(model(view).agents).toEqual([claude])
  })

  it('refuses a second download of the same kind while one runs', async () => {
    const hold = dm.holdAgent('downloadAgent')
    const view = await mount()
    act(() => {
      void model(view).download('claude')
      void model(view).download('claude')
    })
    await settle()
    hold.resolve()
    await settle()
    expect(dm.agentCallsOf('downloadAgent')).toHaveLength(1)
  })

})

describe('useAgents download results', () => {
  it('updates the entry of an agent that is already connected', async () => {
    dm.agents = [claude]
    const newer = agentView({ kind: 'claude', version: '2.2.0' })
    dm.downloadOutcomes = [{ outcome: 'installed', agent: newer, updated: true }]
    const view = await mount()
    await act(() => model(view).download('claude'))
    expect(model(view).agents).toEqual([newer])
    expect(model(view).activity('claude').outcome?.title).toBe('Updated Claude Code 2.2.0')
  })

  it('shows a failure with the installer last lines and connects nothing', async () => {
    dm.downloadOutcomes = [
      { outcome: 'failed', code: 'installer_failed', reason: 'The installer failed (exit code 1).', output: ['disk full'] }
    ]
    const view = await mount()
    await act(() => model(view).download('claude'))
    expect(model(view).agents).toEqual([])
    expect(model(view).activity('claude').outcome).toEqual({
      tone: 'error',
      title: 'Download failed',
      detail: 'The installer failed (exit code 1).',
      output: ['disk full']
    })
  })

  it('says a declined confirmation changed nothing', async () => {
    const view = await mount()
    await act(() => model(view).download('claude'))
    expect(model(view).activity('claude').outcome).toMatchObject({ tone: 'warn', title: 'Download cancelled' })
  })

})

describe('useAgents download progress', () => {
  it('ignores progress that arrives when no download is running', async () => {
    const view = await mount()
    act(() => dm.emitProgress({ kind: 'claude', phase: 'downloading', percent: 10 }))
    expect(model(view).activity('claude').download).toBeNull()
  })

  it('stops listening to progress when the view goes away', async () => {
    const view = await mount()
    expect(dm.progressSubscribers).toBe(1)
    view.unmount()
    expect(dm.progressSubscribers).toBe(0)
  })

  it('reports a rejected call and frees the buttons', async () => {
    dm.downloadAgent = () => Promise.reject(new Error('ipc closed'))
    const view = await mount()
    await act(() => model(view).download('claude'))
    expect(errors).toEqual(['ipc closed'])
    expect(model(view).activity('claude')).toMatchObject({ download: null, busy: false })
  })
})

describe('useAgents remove', () => {
  it('forgets a removed agent and what was shown for it', async () => {
    dm.agents = [claude, codex]
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    const view = await mount()
    await act(() => model(view).remove('claude'))
    expect(dm.agentCallsOf('removeAgent')).toEqual([['claude']])
    expect(model(view).agents).toEqual([codex])
    expect(model(view).statuses.claude).toBeUndefined()
  })

})

describe('useAgents sign-in changes', () => {
  const signedOut = { state: 'signed_out', reason: 'Claude Code asked to sign in again.' } as const
  const signedIn = { state: 'signed_in', reason: 'Signed in.' } as const

  it('shows a status a sign-in prompt found, without asking again', async () => {
    dm.agents = [claude]
    dm.agentStatuses.claude = signedOut
    const view = await mount()
    act(() => model(view).recordStatus('claude', signedIn))
    expect(model(view).statuses.claude).toEqual(signedIn)
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
  })

  it('drops a status recorded for an agent that is not connected', async () => {
    dm.agents = [claude]
    const view = await mount()
    act(() => model(view).recordStatus('codex', signedIn))
    expect(model(view).statuses.codex).toBeUndefined()
  })

  it('asks the agent’s state again when a chat reports its sign-in changed', async () => {
    dm.agents = [claude]
    dm.agentStatuses.claude = signedIn
    const view = await mount()
    dm.agentStatuses.claude = signedOut
    act(() => dm.chats.emit({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_out' }))
    await settle()
    expect(model(view).statuses.claude).toEqual(signedOut)
    dm.agentStatuses.claude = signedIn
    act(() => dm.chats.emit({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_in' }))
    await settle()
    expect(model(view).statuses.claude).toEqual(signedIn)
  })

  it('leaves the other pushes of a chat alone, and stops listening when it is removed from the screen', async () => {
    dm.agents = [claude]
    const view = await mount()
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_1', running: true }))
    await settle()
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
    view.unmount()
    act(() => dm.chats.emit({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_out' }))
    await settle()
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
  })
})
