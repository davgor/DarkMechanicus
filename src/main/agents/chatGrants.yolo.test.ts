import { join } from 'node:path'
import { createYoloDesktopRuntime } from '../../core/services/yoloFence'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../../core/workspace'
import { createChatGrants, type ChatGrants } from './chatGrants'

let harness: Harness
let workspace: Workspace
let grants: ChatGrants
let disposeRuntime: () => Promise<void>
beforeEach(async () => {
  harness = createHarness()
  workspace = harness.open('desktop')
  await workspace.initializeRepository({ name: 'Native decision boundary' })
  const runtime = createYoloDesktopRuntime(join(harness.homeDir, 'desktop-fence.json'))
  await runtime.ready
  disposeRuntime = runtime.dispose
  grants = createChatGrants({ workspaceFor: () => workspace, cliFor: () => ({ command: 'node', args: [], env: {} }), minutes: 60, log: () => {},
    desktopFence: runtime.fence })
})
afterEach(async () => { grants.dispose(); await disposeRuntime(); harness.cleanup() })

async function live() {
  const issued = await grants.issueChatCli(harness.root, { role: 'worker', allowSave: false, label: 'A named existing chat' })
  grants.bindChatGrant(issued.grantId, { folder: harness.root, chatId: 'chat-id', generation: 'start-id' })
  return issued.grantId
}

describe('main-owned YOLO confirmation', () => {
  it('requires a fresh native decision, supplies exact scope/risk/powers, and defaults to no elevation', async () => {
    const id = await live()
    const details: string[] = []
    const declined = await grants.yolo(harness.root, id, 'enable', async (detail) => { details.push(detail); return false })
    expect(declined.expiresAt).toBeNull()
    expect(declined.audit.map((entry) => entry.result)).toEqual(['refused'])
    expect(details[0]).toContain('A named existing chat')
    expect(details[0]).toContain(harness.root)
    expect(details[0]).toContain(id)
    expect(details[0]).toContain('plan.save, ticket.retry_grant, checkpoint.approve, checkpoint.advance')
    expect(details[0]).toContain('unreviewed in-scope workflow changes')
    const enabled = await grants.yolo(harness.root, id, 'enable', async () => true)
    expect(enabled.expiresAt).toBe('2026-03-01T11:00:00.000Z')
    expect((await grants.yolo(harness.root, id, 'revoke', async () => { throw new Error('Revocation must not request consent') })).audit.map((entry) => entry.result)).toEqual(['refused', 'approved', 'revoked'])
  })

  it('rejects former approval when the live chat ends during the dialog and never renews active consent', async () => {
    const id = await live()
    await expect(grants.yolo(harness.root, id, 'enable', async () => { grants.dispose(); return true })).rejects.toThrow()
    expect((await grants.yolo(harness.root, id, 'inspect', async () => true)).expiresAt).toBeNull()
    const other = await live()
    const enabled = await grants.yolo(harness.root, other, 'enable', async () => true)
    harness.clock.advanceSeconds(60)
    await grants.renewChatGrant(other)
    await expect(grants.yolo(harness.root, other, 'enable', async () => true)).rejects.toMatchObject({ code: 'conflict' })
    expect((await grants.yolo(harness.root, other, 'inspect', async () => false)).expiresAt).toBe(enabled.expiresAt)
  })
})
