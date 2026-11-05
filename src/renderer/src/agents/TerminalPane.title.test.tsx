// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../shared/agents/chat'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { TerminalPane } from './TerminalPane'
import { cleanTitle, TITLE_MAX_LENGTH } from './useTerminal'

const CLAUDE = chatRecord({ id: 'chat_a', folder: '/a', title: 'Fix the build', agent: 'claude', role: 'worker' })
const OMP = chatRecord({ id: 'chat_o', folder: '/a', title: 'Plan it', agent: 'omp', role: 'planner' })

let terminals: FakeTerminals
let kit: FakeTerminalKit
let scheduler: ManualScheduler

beforeEach(() => {
  const dm = new FakeDm()
  terminals = new FakeTerminals()
  dm.terminals = terminals
  window.dm = dm
  kit = new FakeTerminalKit()
  scheduler = new ManualScheduler()
})

afterEach(() => cleanup())

const pane = (chat: ChatRecord): JSX.Element => <TerminalPane folder="/a" chat={chat} agentName="Agent" kit={kit} scheduler={scheduler} />

async function show(chat: ChatRecord): Promise<ReturnType<typeof render>> {
  const mounted = render(pane(chat))
  await settle()
  return mounted
}

/** What the CLI prints to set the title: OSC 0, ended by BEL. */
const osc0 = (title: string): string => `\x1b]0;${title}\x07`
const writeToTerminal = (data: string): void => act(() => kit.latest().write(data))
const shown = (): string | null => screen.queryByTestId('chat-terminal-title')?.textContent ?? null

describe('TerminalPane terminal title', () => {
  it('shows nothing until the CLI sets a title', async () => {
    await show(CLAUDE)
    expect(shown()).toBeNull()
  })

  it('shows the title an OSC 0 sequence sets, beside the chat title, for a Skitarii chat', async () => {
    await show(OMP)
    writeToTerminal(`some output ${osc0('Skitarii · work')}more`)
    expect(shown()).toBe('Skitarii · work')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Plan it')
  })

  it('shows the title for any other chat kind too, and follows later titles, ended by ST as well', async () => {
    await show(CLAUDE)
    writeToTerminal(osc0('first'))
    expect(shown()).toBe('first')
    writeToTerminal('\x1b]2;second\x1b\\')
    expect(shown()).toBe('second')
  })

  it('shows nothing again when the CLI sets an empty title', async () => {
    await show(CLAUDE)
    writeToTerminal(osc0('first'))
    writeToTerminal(osc0(''))
    expect(shown()).toBeNull()
  })

  it('strips control characters from a title', async () => {
    await show(CLAUDE)
    writeToTerminal(osc0('a\u0001b\u007fc\u0085d\te\u009fz'))
    expect(shown()).toBe('abcdez')
  })

  it('truncates a long title to the cap, with an ellipsis', async () => {
    await show(CLAUDE)
    writeToTerminal(osc0('x'.repeat(TITLE_MAX_LENGTH + 50)))
    expect(shown()).toBe(`${'x'.repeat(TITLE_MAX_LENGTH - 1)}…`)
    expect(cleanTitle('y'.repeat(TITLE_MAX_LENGTH))).toBe('y'.repeat(TITLE_MAX_LENGTH))
  })

})

describe('TerminalPane terminal title lifetime', () => {
  it('does not change the chat’s own title', async () => {
    await show(CLAUDE)
    writeToTerminal(osc0('Something else'))
    expect(CLAUDE.title).toBe('Fix the build')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Fix the build')
  })

  it('stops listening for titles when the pane goes, and shows no title for the next chat', async () => {
    const mounted = await show(CLAUDE)
    const view = kit.latest()
    expect(view.titleListeners).toBe(1)
    writeToTerminal(osc0('first'))
    mounted.rerender(pane(OMP))
    await settle()
    expect(view.titleListeners).toBe(0)
    expect(kit.views).toHaveLength(2)
    expect(shown()).toBeNull()
    mounted.unmount()
    expect(kit.latest().titleListeners).toBe(0)
  })
})
