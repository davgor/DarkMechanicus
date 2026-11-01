/**
 * Chats stored before chats became terminals (`docs/design/chat-shells.md`, "Existing chats and their transcripts"),
 * and deleting a chat with everything it left: an old record has no grant ids, no kickoff flag and no started flag,
 * which a start reads as none issued, none sent and none started; an old Claude chat's stored id is the SDK's session
 * id, which `claude --resume` continues once its session file is there (checked live, DM-329). Deleting a chat kills
 * its PTY, revokes its grant, and removes its record, its transcript and its bindings, so no panel finds it again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import { connectedAgents, memoryChatFs, storeItems } from '../agents/__mocks__/chatFixtures'
import { ATTEMPT_A, RUN_ID } from '../agents/__mocks__/orchestratorChat'
import { createActivityBindings, type ActivityBindings } from '../agents/activityBindings'
import { createChatRecords } from '../agents/chatRecords'
import { findBoundTerminal, type GrantBindingReads } from '../agents/grantBindings'
import type { FakePty } from './__mocks__/fakePtyHost'
import { claudeSessionFile, recorder, sessionIdNumber, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'
import { endingTerminals } from './terminalSessions'

/** The SDK session id the epic's start commit stored for a Claude chat with one exchange (live, DM-329). */
const SDK_SESSION = '42eb1ddb-3b32-4ca9-9352-918f157b9ad7'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

/** A chat as the app stored it before terminals: `sessionId` from the agent's own protocol, and nothing a terminal adds. */
function oldChat(agent: string, sessionId: string): ChatRecord {
  const chat = rig.store.updateChat(rig.newChat(agent), { sessionId })
  expect([chat.grantIds, chat.sessionStarted, 'kickoffSent' in chat]).toEqual([undefined, undefined, false])
  return chat
}

function args(pty: FakePty): string[] {
  return [...(pty.spec.args as string[])]
}

function stored(chat: ChatRecord): ChatRecord | null {
  return rig.reopenedStore().getChat(chat)
}

describe('terminal sessions: an old Claude chat', () => {
  it('resumes its SDK session with claude --resume in the same folder, and stores its first grant on the record', async () => {
    const chat = oldChat('claude', SDK_SESSION)
    claudeSessionFile(rig, SDK_SESSION, true)
    const heard = recorder()

    const { pty } = await startTerminal(rig, chat, heard.listener)

    expect(args(pty)).toContain('--resume')
    expect(args(pty)[args(pty).indexOf('--resume') + 1]).toBe(SDK_SESSION)
    expect(args(pty)).not.toContain('--session-id')
    expect(pty.spec.cwd).toBe(rig.repo)
    expect(stored(chat)).toMatchObject({ sessionId: SDK_SESSION, grantIds: ['gr_1'], title: chat.title, role: chat.role })
    pty.exit({ exitCode: 0, signal: null })
    await settle()
    expect(heard.events.at(-1)).toMatchObject({ kind: 'exited', resumed: true })
  })

  it('starts on its stored id as a new session when the SDK session is gone, rather than resuming what is not there', async () => {
    const chat = oldChat('claude', SDK_SESSION)

    const { pty } = await startTerminal(rig, chat)

    expect(args(pty)[args(pty).indexOf('--session-id') + 1]).toBe(SDK_SESSION)
    expect(args(pty)).not.toContain('--resume')
  })

  it('starts a new session on New session after the CLI refused the resume, forgetting the SDK id', async () => {
    const chat = oldChat('claude', SDK_SESSION)
    claudeSessionFile(rig, SDK_SESSION, true)
    const refused = await startTerminal(rig, chat)
    refused.pty.emitData(`No conversation found with session ID: ${SDK_SESSION}\r\n`)
    refused.pty.exit({ exitCode: 1, signal: 0 })
    await settle()

    const { pty } = await startTerminal(rig, chat, undefined, { newSession: true })

    expect(args(pty)[args(pty).indexOf('--session-id') + 1]).toBe(sessionIdNumber(1))
    expect(stored(chat)).toMatchObject({ sessionId: sessionIdNumber(1), grantIds: ['gr_1', 'gr_2'] })
  })
})

describe('terminal sessions: an old Autonomous chat', () => {
  it('starts a new a8s session: an ACP session id is not one a8s resume takes, and no input was ever typed into a terminal', async () => {
    const chat = oldChat('autonomous', 'acp-session-1')

    const { pty } = await startTerminal(rig, chat)

    expect(args(pty).slice(0, 2)).toEqual(['start', rig.repo])
    expect(args(pty)).not.toContain('acp-session-1')
  })
})

/** The chat records over the rig's store, deleting through the terminals like the app. */
function app(): { deleteChat: (chat: ChatRecord) => Promise<void> } {
  return endingTerminals(createChatRecords({ store: rig.store, agentFor: connectedAgents() }), rig.sessions)
}

/** The command layer's reads for an attempt claimed at `at` by a session on grant `gr_1`. */
function claimedByGrant(at: string): GrantBindingReads {
  return {
    attemptTimeline: async () => ({
      attemptId: ATTEMPT_A,
      runId: RUN_ID,
      ticketId: 'tk_1',
      state: 'running' as const,
      isLive: true,
      cursor: 1,
      entries: [{ kind: 'claim' as const, id: 'event:1', at, sessionId: 'ss_cli', attemptId: ATTEMPT_A, ticketId: 'tk_1', number: 1, worker: { label: 'w', modelId: null, hostId: null, effort: null, rationale: null } }],
      sessions: [{ id: 'ss_cli', role: 'orchestrator' as const, label: 'dm', grantId: 'gr_1' }]
    }),
    runTimeline: async () => ({ runId: RUN_ID, epicId: 'ep_1', state: 'running' as const, isLive: true, cursor: 0, groups: [] })
  }
}

describe('deleting a chat', () => {
  it('kills its PTY, revokes its grant, and removes its record, transcript and bindings, also as read after a restart', async () => {
    const chat = oldChat('claude', SDK_SESSION)
    const bindingsFs = memoryChatFs([rig.repo])
    const file = `${rig.userData}/agents/activity-bindings.jsonl`
    const heartbeat: ChatItem = {
      id: 'beat',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'tool_call',
      name: 'mcp__darkmechanicus__heartbeat_attempt',
      input: { attemptId: ATTEMPT_A },
      status: 'completed',
      resultSummary: null
    }
    storeItems(rig.chatFs, chat, [heartbeat])
    // The binding the old app stored for that heartbeat.
    bindingsFs.files.set(file, `${JSON.stringify({ chatId: chat.id, threadId: null, folder: chat.folder, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A })}\n`)
    const activity = (): ActivityBindings => createActivityBindings({ file, fs: bindingsFs })
    const chats = endingTerminals(createChatRecords({ store: rig.store, agentFor: connectedAgents(), activity: activity() }), rig.sessions)
    const { pty } = await startTerminal(rig, chat)
    // A newer chat of the same folder on another grant, which neither the link nor the delete may take for this one.
    const newer = rig.store.updateChat(rig.newChat(), { grantIds: ['gr_other'] })
    const reads = claimedByGrant(heartbeat.at)
    expect(await findBoundTerminal({ reads, store: rig.reopenedStore() }, rig.repo, { attemptId: ATTEMPT_A })).toBe(chat.id)
    expect(activity().byAttempt(ATTEMPT_A).map((binding) => binding.chatId)).toEqual([chat.id])
    expect(rig.reopenedStore().readTranscript(chat)?.items).toEqual([heartbeat])
    expect(rig.reopenedStore().listChats(rig.repo)[0]?.id).toBe(newer.id)

    const deleting = chats.deleteChat(chat)
    // Killed before the PTY reports its exit, with the grant revoked; the record goes once the kill has settled.
    expect([rig.killed.map((tree) => tree.pid), pty.kills, rig.revoked]).toEqual([[pty.pid], 1, ['gr_1']])
    expect(rig.reopenedStore().getChat(chat)).not.toBeNull()
    pty.exit({ exitCode: 0, signal: 9 })
    await deleting

    expect([rig.store.getChat(chat), rig.reopenedStore().getChat(chat), rig.reopenedStore().readTranscript(chat)]).toEqual([null, null, null])
    expect(activity().byAttempt(ATTEMPT_A)).toEqual([])
    expect(await findBoundTerminal({ reads, store: rig.reopenedStore() }, rig.repo, { attemptId: ATTEMPT_A })).toBeNull()
    expect(await rig.sessions.attach(chat)).toEqual({ state: 'refused', message: `No chat ${chat.id} in ${rig.repo}.` })
  })
})

describe('deleting a chat whose terminal is not running', () => {
  it('revokes nothing more for a chat whose terminal is not running, and still removes everything', async () => {
    const { deleteChat } = app()
    const chat = oldChat('claude', SDK_SESSION)
    storeItems(rig.chatFs, chat, [{ id: 'msg', at: '2026-01-01T00:00:00.000Z', kind: 'user_message', text: 'hello' }])

    await deleteChat(chat)

    expect([rig.revoked, rig.killed, rig.host.spawns]).toEqual([[], [], []])
    expect([rig.reopenedStore().getChat(chat), rig.reopenedStore().readTranscript(chat)]).toEqual([null, null])
  })
})
