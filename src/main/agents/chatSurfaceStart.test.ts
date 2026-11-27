import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../core/errors'
import type { AgentChatSnapshot } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TerminalListener, TerminalStart } from '../terminals/terminalSessions'
import { launchChatOnSurface, resumeChatOnSurface, startChatOnSurface } from './chatSurfaceStart'

const at = '2026-11-26T00:00:00.000Z'

function chat(surface: ChatRecord['surface']): ChatRecord {
  return { id: 'chat_1', folder: '/repo', agent: 'claude', model: null, role: 'planner', allowSave: true, title: 'Planner', createdAt: at, updatedAt: at, sessionId: null, surface }
}

type GuiStart = AgentChatSnapshot | { code: 'busy_elsewhere' }
const snapshot = (status: string): GuiStart => ({ status }) as unknown as AgentChatSnapshot

function starters(gui: () => Promise<GuiStart>, terminal: () => Promise<TerminalStart> = () => Promise.resolve({ state: 'running', pid: 1 })) {
  return { agentChats: { start: vi.fn(gui) }, terminals: { start: vi.fn(terminal) }, onError: vi.fn() }
}

describe('startChatOnSurface on the GUI', () => {
  it('starts the one GUI session with the kickoff as its first message and answers null once it runs', async () => {
    const deps = starters(() => Promise.resolve(snapshot('idle')))
    expect(await startChatOnSurface(deps, chat('gui'), 'Plan this')).toBeNull()
    expect(deps.agentChats.start.mock.calls).toEqual([[chat('gui'), { firstMessage: 'Plan this' }]])
    expect(deps.terminals.start).not.toHaveBeenCalled()
  })

  it.each([
    [{ code: 'busy_elsewhere' } as const, 'The chat is running in a terminal.'],
    [snapshot('signed_out'), 'The agent is signed out. Sign in from Agents, then start the chat again.'],
    [snapshot('failed'), 'The agent process did not start.'],
    [snapshot('exited'), 'The agent process did not start.']
  ])('says why the GUI agent did not start (%j)', async (started, reason) => {
    expect(await startChatOnSurface(starters(() => Promise.resolve(started)), chat('gui'), 'k')).toBe(reason)
  })
})

describe('startChatOnSurface in a terminal', () => {
  it('starts the terminal with the kickoff, answering null when it runs and its message when it does not', async () => {
    const running = starters(() => Promise.reject(new Error('unused')))
    expect(await startChatOnSurface(running, chat('terminal'), 'k')).toBeNull()
    expect(running.terminals.start.mock.calls).toEqual([[chat('terminal'), { kickoff: 'k' }]])
    const refused = starters(() => Promise.reject(new Error('unused')), () => Promise.resolve({ state: 'refused', message: 'Folder is missing.' }))
    expect(await startChatOnSurface(refused, chat('terminal'), 'k')).toBe('Folder is missing.')
  })
})

describe('startChatOnSurface failures', () => {
  it('answers a refusal without reporting it, and reports an unexpected failure', async () => {
    const refused = starters(() => Promise.reject(new DomainError('busy', 'The chat is busy.')))
    expect(await startChatOnSurface(refused, chat('gui'), 'k')).toBe('The chat is busy.')
    expect(refused.onError).not.toHaveBeenCalled()
    const failed = new Error('spawn EACCES')
    const broken = starters(() => Promise.reject(failed))
    expect(await startChatOnSurface(broken, chat('gui'), 'k')).toBe('spawn EACCES')
    expect(broken.onError.mock.calls).toEqual([[failed]])
  })

  it('answers a thrown non-error as its text', async () => {
    const odd = starters(() => Promise.reject('plain failure'))
    expect(await startChatOnSurface(odd, chat('gui'), 'k')).toBe('plain failure')
    expect(odd.onError.mock.calls).toEqual([['plain failure']])
  })
})

describe('launchChatOnSurface', () => {
  it('tells a signed-out agent apart from a failure on both surfaces, so a caller may try another agent', async () => {
    expect(await launchChatOnSurface(starters(() => Promise.resolve(snapshot('signed_out'))), chat('gui'), 'k'))
      .toEqual({ state: 'signed_out', message: 'The agent is signed out. Sign in from Agents, then start the chat again.' })
    const signedOut = starters(() => Promise.reject(new Error('unused')), () => Promise.resolve({ state: 'signed_out', message: 'Not signed in.' }))
    expect(await launchChatOnSurface(signedOut, chat('terminal'), 'k')).toEqual({ state: 'signed_out', message: 'Not signed in.' })
    const refused = starters(() => Promise.reject(new Error('unused')), () => Promise.resolve({ state: 'refused', message: 'Folder is missing.' }))
    expect(await launchChatOnSurface(refused, chat('terminal'), 'k')).toEqual({ state: 'failed', message: 'Folder is missing.' })
    expect(await launchChatOnSurface(starters(() => Promise.resolve(snapshot('idle'))), chat('gui'), 'k')).toEqual({ state: 'running' })
  })
})

function resumers(gui: () => Promise<GuiStart>) {
  const attached: ChatRecord[] = []
  return {
    attached,
    agentChats: { start: vi.fn(gui) },
    terminals: {
      attach: vi.fn(async (ref: ChatRecord, _listener?: TerminalListener) => { attached.push(ref); return { state: 'running' as const, pid: 1, snapshot: '' } }),
      detach: vi.fn()
    }
  }
}

describe('resumeChatOnSurface', () => {
  it('wakes a GUI chat through the one GUI session manager with no kickoff, never a terminal', async () => {
    const deps = resumers(() => Promise.resolve(snapshot('idle')))
    expect(await resumeChatOnSurface(deps, chat('gui'))).toBeNull()
    expect(deps.agentChats.start.mock.calls).toEqual([[chat('gui')]])
    expect(deps.attached).toEqual([])
    expect(await resumeChatOnSurface(resumers(() => Promise.resolve(snapshot('signed_out'))), chat('gui')))
      .toBe('The agent is signed out. Sign in from Agents, then start the chat again.')
  })

  it('attaches a terminal chat (and a chat stored before surfaces) as before', async () => {
    for (const surface of ['terminal', undefined] as const) {
      const deps = resumers(() => Promise.reject(new Error('unused')))
      expect(await resumeChatOnSurface(deps, chat(surface))).toBeNull()
      expect([deps.attached, deps.agentChats.start.mock.calls, deps.terminals.detach.mock.calls.length]).toEqual([[chat(surface)], [], 1])
    }
  })

  it('lets a GUI refusal reach the caller, as a terminal attach refusal does', async () => {
    const deps = resumers(() => Promise.reject(new DomainError('unsupported', 'Forge World merge resolvers run only in the terminal.')))
    await expect(resumeChatOnSurface(deps, chat('gui'))).rejects.toMatchObject({ code: 'unsupported' })
  })
})
