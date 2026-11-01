/**
 * The grants chat sessions run on. Each is revoked through the workspace it was issued in, held
 * since issue, never by finding its folder again: a folder renamed while its chat ran is no longer
 * at its path, but the workspace's open SQLite handle still reaches its `state.sqlite` on POSIX.
 *
 * The workspace is the desktop pool's, so it stays open until the folder is untracked or the app
 * has disposed its chats. One the pool has closed since is opened again in the folder it was issued
 * in, for the revoke only, and closed after. A grant that cannot be revoked either way is logged in
 * one line naming it and its expiry, and never throws: the session ending must not wait on it.
 */
import type { Workspace } from '../../core/workspace'
import type { ChatRole, DarkMechanicusCli } from '../../shared/agents/chat'

interface ChatGrantsDeps {
  /** The desktop's workspace for a tracked folder; throws for one that is not. Asked only at issue. */
  workspaceFor: (folder: string) => Workspace
  /** The `dm` invocation pinned to `folder`, before the grant's token is added. */
  cliFor: (folder: string) => DarkMechanicusCli
  /** How long a chat's grant lasts. */
  minutes: number
  /** Told, in one line, of each grant that could not be revoked. */
  log: (line: string) => void
}

/** What `createSessionManager` issues and revokes chat grants through. */
interface ChatGrants {
  issueChatCli(folder: string, grant: { role: ChatRole; allowSave: boolean; label: string }): Promise<{ cli: DarkMechanicusCli; grantId: string }>
  /** Never throws: a grant it cannot revoke is logged. */
  revokeChatGrant(grantId: string): Promise<void>
}

interface HeldGrant {
  workspace: Workspace
  expiresAt: string
}

async function revokeThrough(held: HeldGrant, grantId: string): Promise<void> {
  // A workspace with no session is one the pool closed since issue: the revoke opens it again in
  // its folder, so it is closed again after rather than left open outside the pool.
  const reopened = held.workspace.sessionId() === null
  try {
    await held.workspace.revokeGrant({ grantId })
  } finally {
    if (reopened) {
      held.workspace.close()
    }
  }
}

export function createChatGrants(deps: ChatGrantsDeps): ChatGrants {
  const held = new Map<string, HeldGrant>()
  return {
    async issueChatCli(folder, grant) {
      const workspace = deps.workspaceFor(folder)
      const issued = await workspace.issueGrant({ role: grant.role, label: grant.label, allowSave: grant.allowSave, minutes: deps.minutes })
      held.set(issued.grant.id, { workspace, expiresAt: issued.grant.expiresAt })
      const launch = deps.cliFor(folder)
      return {
        cli: { ...launch, env: { ...launch.env, DM_SESSION_TOKEN: issued.token } },
        grantId: issued.grant.id
      }
    },
    async revokeChatGrant(grantId) {
      const grant = held.get(grantId)
      if (grant === undefined) {
        deps.log(`Could not revoke chat grant ${grantId}: it was not issued by this app session.`)
        return
      }
      held.delete(grantId)
      try {
        await revokeThrough(grant, grantId)
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')
        deps.log(`Could not revoke chat grant ${grantId}; it stays usable until it expires at ${grant.expiresAt}: ${reason}`)
      }
    }
  }
}
