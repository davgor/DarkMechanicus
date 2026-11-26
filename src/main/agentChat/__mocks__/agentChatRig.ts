import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentChatEvent } from '../../../shared/agents/agentChat'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { removeScratch } from '../../../test/removeScratch'
import { builtInAgent } from '../../agents/__mocks__/chatFixtures'
import { createActivityBindings } from '../../agents/activityBindings'
import { createChatStore } from '../../agents/chatStore'
import { buildCliConfig } from '../../desktop/cliConfig'
import { startAgentProcess, type AgentProcess } from '../agentProcess'
import { createAgentChatSessions, type AgentChatSessionsDeps } from '../agentChatSessions'
import { fakeAgentShim } from './fakeAgentShim'

export const fakeAgentFixture = fileURLToPath(new URL('../__fixtures__/fakeAgentCli.mjs', import.meta.url))

export function runFakeLauncher(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  return process.platform === 'win32'
    ? spawnSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${executable}" ${args.map(arg => `"${arg}"`).join(' ')}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true })
    : spawnSync(executable, args, { env, encoding: 'utf8' })
}

export function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [readFileSync(path, 'utf8')]
  })
}

function nativeFixture(fixture: string) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm GUI sessions ')))
  const repo = join(root, 'repo'), userData = join(root, 'userData')
  mkdirSync(repo); mkdirSync(userData)
  const executable = fakeAgentShim(join(root, 'agent with spaces'), fixture)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root,
    FAKE_AGENT_LOG: join(root, 'agent.jsonl'), FAKE_AGENT_SESSION_FILES: '1' }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`
  const store = createChatStore({ root: join(userData, 'agents', 'chats') })
  return { root, repo, userData, executable, env, store }
}

function recordingChild(spec: Parameters<typeof startAgentProcess>[0], children: AgentProcess[], writes: string[], steps: string[]): AgentProcess {
  steps.push('spawn')
  const child = startAgentProcess(spec)
  children.push(child)
  return { pid: child.pid, write: line => { writes.push(line); return child.write(line) },
    onLine: listener => child.onLine(listener), onStderr: listener => child.onStderr(listener),
    onExit: listener => child.onExit(listener), stop: options => child.stop(options) }
}

/** Claims verify only as the exact token in `live`; ticket keys come from `ticketKeys` (absent: null). */
function claimStubs(userData: string) {
  const claims = { live: new Map<string, { attemptId: string; runId: string; ticketId: string }>(), ticketKeys: new Map<string, string | null>(), verified: [] as string[], lookups: [] as string[] }
  const bindingsFile = join(userData, 'agents', 'activity-bindings.jsonl')
  const deps: Pick<AgentChatSessionsDeps, 'bindings' | 'verifyAttemptClaim' | 'ticketKeyOfAttempt'> = {
    bindings: createActivityBindings({ file: bindingsFile }),
    verifyAttemptClaim: async (_folder, token) => { claims.verified.push(token.split('.')[0]); return claims.live.get(token) ?? null },
    ticketKeyOfAttempt: async (_folder, attemptId) => { claims.lookups.push(attemptId); return claims.ticketKeys.get(attemptId) ?? null }
  }
  return { claims, bindingsFile, deps }
}

/** `fixture` replaces the fake CLI, for a test that replays its own copy of the golden fixtures. */
export function agentChatRig(kind: 'claude' | 'omp' = 'claude', overrides: Partial<AgentChatSessionsDeps> = {}, fixture = fakeAgentFixture) {
  const { root, repo, userData, executable, env, store } = nativeFixture(fixture)
  const pushes: AgentChatEvent[] = [], children: AgentProcess[] = [], writes: string[] = []
  const revoked: string[] = [], renewed: string[] = [], bound: string[] = [], steps: string[] = []
  const intervals = new Map<number, Set<() => void>>()
  const token = `dmg_${'a1'.repeat(32)}`
  const agent = builtInAgent(kind, { executablePath: executable })
  const state = { signedOut: false, terminalLive: false, terminalGeneration: 'terminal-1', awake: 0, grantCount: 0, tracked: true, pauses: [] as string[] }
  const { claims, bindingsFile, deps: claimDeps } = claimStubs(userData)
  const cliFor = (folder: string | null) => buildCliConfig({ execPath: process.execPath, appPath: root, repoPath: folder })
  const deps: AgentChatSessionsDeps = {
    store, agentFor: () => agent, folders: { trackedFolder: path => state.tracked ? path : null },
    checkAuth: async (): Promise<AgentAuthStatus> => {
      steps.push('auth')
      const result = runFakeLauncher(executable, ['auth', 'status'], { ...env, FAKE_AGENT_SIGNED_OUT: state.signedOut ? '1' : '0' })
      if (result.error) throw result.error
      const auth = JSON.parse(result.stdout) as { loggedIn: boolean }
      return { state: auth.loggedIn ? 'signed_in' : 'signed_out', reason: 'Fake sign-in status.' }
    },
    cliFor, reachFolders: () => [repo],
    issueChatCli: async folder => {
      steps.push('issue')
      return { cli: { ...cliFor(folder), env: { ...cliFor(folder).env, DM_SESSION_TOKEN: token } }, grantId: `grant-${++state.grantCount}`, endpointId: null }
    },
    issueReachCli: async () => ({ cli: { ...cliFor(null), env: { ...cliFor(null).env, DM_SESSION_TOKEN: token } }, grantIds: [`grant-${++state.grantCount}`] }),
    revokeChatGrant: async id => { revoked.push(id) }, renewChatGrant: async id => { renewed.push(id) },
    bindChatGrant: id => { steps.push('bind'); bound.push(id) },
    runs: { getRun: async () => ({ state: 'running' }), pauseRun: async (_, input) => { state.pauses.push(input.reason) } },
    keepAwake: () => { state.awake++; return () => { state.awake-- } },
    userData, ompExtension: join(root, 'extension.ts'), platform: process.platform, env,
    terminalLive: () => state.terminalLive,
    terminalOwner: () => state.terminalLive ? state.terminalGeneration : null,
    stopTerminal: async () => { state.terminalLive = false },
    push: event => { pushes.push(event) },
    timers: { repeat: (callback, ms) => {
      const callbacks = intervals.get(ms) ?? new Set<() => void>()
      callbacks.add(callback); intervals.set(ms, callbacks)
      return () => { callbacks.delete(callback) }
    } },
    startProcess: spec => recordingChild(spec, children, writes, steps),
    ...claimDeps,
    ...overrides
  }
  const sessions = createAgentChatSessions(deps)
  return { root, repo, userData, executable, env, store, pushes, children, writes, revoked, renewed, bound, steps, token, state, deps, sessions, claims, bindingsFile,
    tick: (ms: number) => { for (const callback of intervals.get(ms) ?? []) callback() },
    newChat: (firstPrompt?: string, folder: string | null = repo) => store.createChat({ folder, agent: kind, model: null, role: 'worker', allowSave: false, surface: 'gui', firstPrompt }),
    cleanup: async () => { await sessions.dispose(); removeScratch(root) }
  }
}
