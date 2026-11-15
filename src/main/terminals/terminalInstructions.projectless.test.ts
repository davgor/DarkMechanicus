/**
 * What a chat is told, written to its instructions file and, for a CLI that takes them as its first input, pasted:
 * a project-less chat names itself through any folder's line, one that reaches no folder is told nothing about
 * naming, and a folder chat keeps its own text.
 */
import { describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { terminalInstructions } from './terminalFiles'
import { terminalLaunchSpec, type TerminalLaunchInput } from './terminalLaunchSpec'

const PINNED: DarkMechanicusCli = { command: '/bin/electron', args: ['/app/out/main/cli.js', '--repo', '/work/repo'], env: { DM_SESSION_TOKEN: 'token-a' } }
const UNPINNED: DarkMechanicusCli = { command: '/bin/electron', args: ['/app/out/main/cli.js'], env: { DM_SESSION_TOKEN: 'token-a' } }
const REACH = [{ folder: '/work/repo', tokenFile: '/scratch/.dm/grants/a.token' }]
const BASE = { role: 'orchestrator', allowSave: true, launcherDir: null, orchestratesRun: false, nameFirstPrompt: true } as const

describe('chat instructions: naming from the first prompt', () => {
  it('names a folder chat through its own dm invocation', () => {
    expect(terminalInstructions({ ...BASE, cli: PINNED })).toContain('Use the dm invocation above with: call name_chat')
  })

  it('names a project-less chat through the line of any folder it reaches', () => {
    const text = terminalInstructions({ ...BASE, cli: UNPINNED, reach: REACH })

    expect(text).toContain('Use the dm line of any folder above with: call name_chat')
    expect(text).toContain('--token-file /scratch/.dm/grants/a.token')
  })

  it('asks a project-less chat that reaches no folder for no name it could not report', () => {
    const text = terminalInstructions({ ...BASE, cli: { ...UNPINNED, env: {} }, reach: [] })

    expect(text).not.toContain('name_chat')
    expect(text).toContain('No folder is tracked and set up')
  })
})

function cursorLaunch(overrides: Partial<Omit<TerminalLaunchInput, 'chat'>> & { chat?: Partial<TerminalLaunchInput['chat']> } = {}): TerminalLaunchInput {
  const { chat, ...rest } = overrides
  return {
    chat: { agent: 'cursor', role: 'orchestrator', allowSave: true, model: null, sessionId: null, titleStatus: 'pending', sessionStarted: false, kickoffSent: false, ...chat },
    kickoff: null,
    agent: builtInAgent('cursor'),
    folder: '/scratch',
    cli: UNPINNED,
    reach: REACH,
    files: { instructions: '/data/agents/instructions/chat_1.md', launcherDir: '/data/agents/bin/chat_1' },
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    newSessionId: () => '00000000-0000-4000-8000-000000000001',
    ...rest
  }
}

describe('a project-less chat’s launch', () => {
  it('pastes the project-less instructions, with naming through any folder, to a CLI that takes them as its first input', () => {
    const spec = terminalLaunchSpec(cursorLaunch())

    expect(spec.cwd).toBe('/scratch')
    expect(spec.pasteFirst).toContain('not tied to a project')
    expect(spec.pasteFirst).toContain('Use the dm line of any folder above')
  })

  it('pastes no naming section once the chat is named, and the run guidance for a chat that orchestrates one', () => {
    const named = terminalLaunchSpec(cursorLaunch({ chat: { titleStatus: 'generated' } }))
    const orchestrating = terminalLaunchSpec(cursorLaunch({ chat: { runId: 'rn_1' } }))

    expect(named.pasteFirst).not.toContain('name_chat')
    expect(orchestrating.pasteFirst).not.toBe(terminalLaunchSpec(cursorLaunch()).pasteFirst)
  })

  it('starts with no grant in its environment when it reaches no folder, and refuses a pinned dm', () => {
    const grantless = terminalLaunchSpec(cursorLaunch({ cli: { ...UNPINNED, env: {} }, reach: [] }))

    expect(grantless.env['DM_SESSION_TOKEN']).toBeUndefined()
    expect(() => terminalLaunchSpec(cursorLaunch({ cli: PINNED }))).toThrow(/project-less chat must name no folder/)
    expect(() => terminalLaunchSpec(cursorLaunch({ cli: { ...UNPINNED, env: {} }, reach: undefined }))).toThrow(/pinned/)
  })
})
