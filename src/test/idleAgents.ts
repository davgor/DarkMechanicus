/**
 * Agent dependencies for desktop-handler tests that are not about agents: nothing is connected, the
 * file dialog is always cancelled, and storing or probing an agent fails the test. Not shipped.
 */
import type { AgentAuthHooks } from '../main/desktop/agentAuth'
import type { AgentHandlerDeps } from '../main/desktop/agentHandlers'
import type { FolderDefaultHandlerDeps } from '../main/desktop/folderAgentDefaults'

function failTest(message: string): never {
  throw new Error(message)
}

export function idleAgentDeps(): AgentHandlerDeps & AgentAuthHooks & FolderDefaultHandlerDeps {
  return {
    agents: { list: () => [], get: () => null, upsert: () => failTest('no agent should be stored'), remove: () => undefined },
    pickExecutable: () => Promise.resolve(null),
    probeAgent: () => failTest('no agent should be probed'),
    installAgent: () => failTest('no agent should be downloaded'),
    checkAuth: () => failTest('no agent should be asked for its sign-in state'),
    signIn: () => failTest('no agent should be signed in'),
    customAgents: {
      add: () => failTest('no custom agent should be added'),
      update: () => failTest('no custom agent should be edited')
    },
    endAgentSessions: () => Promise.resolve(),
    folderDefaults: { get: () => null, set: () => undefined }
  }
}
