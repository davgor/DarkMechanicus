/**
 * DM-1118: a GUI OMP chat with a mailbox now has both the GUI's board delivery (a person's board message is its user
 * turn, `sendGuiTurn` in chatHandlers.ts) and the extension's native mail delivery over the descriptor its launch
 * wrote. Each message must reach it exactly once: peer mail only through the extension's inbox watcher, never as a GUI
 * turn or a desktop wake's input, and a board message only as its one GUI turn, never again through the host outbox.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDmClient, DM_CLIENT_DESCRIPTOR_ENV } from '../../../resources/skitarii/extension/dmClient'
import { MailWatcher } from '../../../resources/skitarii/extension/messaging'
import { createAgentContextDelivery } from '../agents/agentContextDelivery'
import { resumeChatOnSurface } from '../agents/chatSurfaceStart'
import { createConversationDeliveries } from '../agents/conversationDeliveries'
import { agentChatRig } from './__mocks__/agentChatRig'

/** The fixture `dm`: one unacknowledged peer message, `mm_1`, served by the mail status and inbox commands within their window. */
const MAIL_CLI = `
const fs = require('node:fs')
const command = process.argv[process.argv.length - 2]
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const meta = { id: 'mm_1', seq: 1, from: { endpointId: 'me_peer', name: 'Peer', deleted: false }, inReplyTo: null, bodyBytes: 16, acceptedAt: '2026-11-28T10:00:00.000Z', acknowledgedAt: null, expiresAt: null }
const after = input.afterSeq ?? 0, through = input.throughSeq ?? 1
const rows = 1 > after && 1 <= through ? [meta] : []
const answers = {
  get_agent_mail_status: { pendingCount: 1, messages: rows, snapshotHighWater: through, nextCursor: rows.length ? 1 : after, hasMore: false },
  read_agent_inbox: { messages: rows.map(row => ({ ...row, body: 'peer body once' })), snapshotHighWater: through, nextCursor: rows.length ? 1 : after, hasMore: false }
}
process.stdout.write(JSON.stringify(answers[command] === undefined ? { ok: false, error: { code: 'unexpected', message: command } } : { ok: true, data: answers[command] }))
`

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('a GUI omp chat with a mailbox gets each message exactly once (DM-1118)', () => {
  it('peer mail through the native watcher only, and a board message as its one GUI turn and never through the outbox', async () => {
    const r = agentChatRig('omp')
    cleanups.push(r.cleanup)
    const bin = join(r.root, 'out', 'main')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'cli.js'), MAIL_CLI)
    const issue = r.deps.issueChatCli, start = r.deps.startProcess!, launches: NodeJS.ProcessEnv[] = []
    r.deps.issueChatCli = async (folder, grant, chat) => {
      const issued = await issue(folder, grant, chat)
      return { ...issued, endpointId: 'me_gui', cli: { ...issued.cli, env: { ...issued.cli.env, DM_DESKTOP_PIPE: 'desktop-address' } } }
    }
    r.deps.startProcess = spec => { launches.push(spec.env ?? {}); return start(spec) }
    const chat = r.store.updateChat(r.newChat(), { endpointId: 'me_gui' })!
    await r.sessions.start(chat)
    const env = launches[0]!
    expect(env[DM_CLIENT_DESCRIPTOR_ENV]).toBeDefined()

    // The extension's inbox watcher in that process, over the client its descriptor gives it.
    const client = createDmClient({ env, platform: process.platform, readFile: path => Promise.resolve(readFileSync(path, 'utf8')), spawn })
    cleanups.unshift(() => client.cancelAll())
    const delivered: string[] = []
    const watcher = new MailWatcher({
      client, timers: { setInterval: () => 0, clearInterval: () => undefined },
      sendUserMessage: async (content, options) => { if (options.attribution === 'agent') delivered.push(content) }
    })
    watcher.start({ notify: () => undefined, setStatus: () => undefined })
    // The desktop monitor sees the pending message and wakes the chat on its surface, again at each sweep.
    for (let tick = 0; tick < 6; tick += 1) {
      await watcher.tick()
      expect(await resumeChatOnSurface({ terminals: { attach: () => { throw new Error('not a terminal chat') }, detach: () => undefined }, agentChats: r.sessions }, chat)).toBeNull()
    }
    watcher.stop()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('"id": "mm_1"')
    expect(launches).toHaveLength(1)
    const turns = () => r.writes.map(line => JSON.parse(line) as { type: string; message?: string }).filter(frame => frame.type === 'prompt' || frame.type === 'follow_up')
    expect(turns()).toEqual([])

    // A board message to a GUI chat is its user turn, recorded delivered with no body (chatHandlers.ts sendGuiTurn and sendConversationMessage).
    const deliveries = createConversationDeliveries({ userData: r.userData, onChanged: () => undefined })
    const context = createAgentContextDelivery({ userData: r.userData, deliveries, agentKind: () => 'omp' })
    await r.sessions.send(chat, { text: 'board body once' })
    deliveries.record({ messageId: 'bm_1', folder: r.repo, chatId: chat.id, state: 'delivered', problem: null, source: 'board', at: '2026-11-28T10:01:00.000Z' })
    expect(context.pendingBoard(chat)).toEqual([])
    await context.publishBoard(chat)
    expect(await client.readBoard()).toEqual({ ok: true, data: [] })
    expect(turns().map(frame => frame.message)).toEqual(['board body once'])
  })
})
