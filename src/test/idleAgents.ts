/**
 * Agent dependencies for desktop-handler tests that are not about agents: nothing is connected, the
 * file dialog is always cancelled, and storing or probing an agent fails the test. Not shipped.
 */
import type { AgentAuthHooks } from '../main/desktop/agentAuth'
import type { AgentHandlerDeps } from '../main/desktop/agentHandlers'

function failTest(message: string): never {
  throw new Error(message)
}

export function idleAgentDeps(): AgentHandlerDeps & AgentAuthHooks {
  return {
    agents: { list: () => [], upsert: () => failTest('no agent should be stored'), remove: () => undefined },
    pickExecutable: () => Promise.resolve(null),
    probeAgent: () => failTest('no agent should be probed'),
    installAgent: () => failTest('no agent should be downloaded'),
    checkAuth: () => failTest('no agent should be asked for its sign-in state'),
    signIn: () => failTest('no agent should be signed in')
  }
}
