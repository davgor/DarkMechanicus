/**
 * A Linear transfer chat started again (an exit, an idle stop, an app restart): its kickoff went with the first
 * start only, so a CLI that starts on a new session (Codex and Cursor with no stored session, a custom CLI) must
 * still find its task in the chat's instructions: the epic id, the start_transfer step and the guide. On the fake
 * PTY host and the fake clock.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { transferKickoff } from '../../mcp/transferKickoff'
import type { ChatRecord } from '../../shared/agents/chat'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import type { FakePty } from './__mocks__/fakePtyHost'
import { CUSTOM_AGENT, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

const SECOND = 1_000
const ENTER_DELAY = 500
const EPIC_ID = 'ep_01m6772ffwkwr2a91fsqzfz1he'
const KICKOFF = transferKickoff({ epicId: EPIC_ID, epicTitle: 'Linear handoff' })
const STEP = `Call start_transfer for epic ${EPIC_ID}`
/** A custom CLI that is given the instructions file, as `{instructions}` lets one be. */
const CUSTOM = { ...CUSTOM_AGENT, args: ['--prompt-file', '{instructions}'] }

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig({ agents: [builtInAgent('codex'), CUSTOM] })
})

afterEach(() => {
  rig.cleanup()
})

function transferChat(agent: string): ChatRecord {
  return rig.store.createChat({ folder: rig.repo, agent, model: null, role: 'orchestrator', allowSave: false, title: 'Linear transfer · Linear handoff', transferEpicId: EPIC_ID })
}

function instructionsOf(chat: ChatRecord): string {
  return readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
}

/** The CLI draws its first screen with bracketed paste on; the first paste and its Enter then go. */
async function settleFirstPaste(pty: FakePty): Promise<void> {
  pty.emitData('\x1b[?2004hready')
  await settle()
  rig.clock.advance(SECOND + ENTER_DELAY)
}

async function exit(pty: FakePty): Promise<void> {
  pty.exit({ exitCode: 0, signal: null })
  await settle()
}

describe('terminal sessions: a Linear transfer chat started again', () => {
  it('gives a Codex transfer chat on a new session its task again: the epic id, the start_transfer step and the guide, without the kickoff', async () => {
    const chat = transferChat('codex')
    expect(await rig.sessions.start(chat, { kickoff: KICKOFF })).toMatchObject({ state: 'running' })
    const first = rig.host.last()
    await settleFirstPaste(first)
    expect(first.written[0]).toContain('Move this saved Dark Mechanicus epic to a Linear project')
    await exit(first)

    const again = await startTerminal(rig, chat)
    await settleFirstPaste(again.pty)

    expect(rig.host.spawns).toHaveLength(2)
    expect(again.pty.spec.args).not.toContain('resume')
    const [paste = ''] = again.pty.written
    expect(paste).toContain(EPIC_ID)
    expect(paste).toContain(STEP)
    expect(paste).toContain('=== Linear transfer guidance ===')
    expect(paste).not.toContain('Move this saved Dark Mechanicus epic to a Linear project')
    expect(instructionsOf(chat)).toContain(STEP)
  })

  it('writes the task into the instructions file a custom transfer CLI is started with, on every start', async () => {
    const chat = transferChat(CUSTOM.id)
    expect(await rig.sessions.start(chat, { kickoff: KICKOFF })).toMatchObject({ state: 'running' })
    await exit(rig.host.last())

    const again = await startTerminal(rig, chat)

    expect(rig.host.spawns).toHaveLength(2)
    const file = (again.pty.spec.args as string[])[1] ?? ''
    expect(file).toBe(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`))
    expect(readFileSync(file, 'utf8')).toContain(EPIC_ID)
    expect(readFileSync(file, 'utf8')).toContain(STEP)
  })

  it('gives a chat that is not a transfer chat no transfer guidance', async () => {
    const chat = rig.newChat('codex')

    const { pty } = await startTerminal(rig, chat)
    await settleFirstPaste(pty)

    expect(instructionsOf(chat)).not.toContain('start_transfer')
    expect(pty.written[0]).not.toContain('Linear transfer guidance')
  })
})
