/**
 * A terminal session manager on fakes, for its tests: the fake PTY host, a fake clock, the chat store in memory,
 * grants and sign-in checks the test controls, and a tree kill that only records. The chat's folder and the
 * files main writes before a start are on the real disk, in a scratch folder, so the folder check and the
 * instructions file are the real ones. Not shipped.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentView } from '../../../shared/desktop/api'
import type { RunState } from '../../../shared/domain/status'
import { removeScratch } from '../../../test/removeScratch'
import { builtInAgent, connectedAgents, memoryChatFs, memoryChatStore, type MemoryChatFs } from '../../agents/__mocks__/chatFixtures'
import type { ChatStore } from '../../agents/chatStore'
import type { PtyTree } from '../../agents/processTree'
import { buildCliConfig, type CliLaunch } from '../../desktop/cliConfig'
import { claudeProjectName } from '../claudeSession'
import type { PtySpawnSpec } from '../ptyHost'
import { createTerminalSessions, type AttachOptions, type TerminalEvent, type TerminalSessions, type TerminalSessionsDeps } from '../terminalSessions'
import { FakePty, FakePtyHost } from './fakePtyHost'

/** A custom CLI the person added: started without a sign-in check. */
export const CUSTOM_AGENT: AgentView = builtInAgent('cursor', {
  id: 'cu_01m65kwqqeyajbj5bnq81gngrb',
  kind: 'custom',
  displayName: 'My CLI',
  executablePath: '/opt/mine',
  args: ['--in', '{folder}']
})

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Signed in.' }

/** Intervals and timeouts that run only when the test moves the clock on. */
export class FakeClock {
  now = 0
  /** A timeout is an interval with no `every`: it runs once. */
  private readonly timers = new Set<{ every: number | null; next: number; callback: () => void }>()

  repeat(callback: () => void, every: number): () => void {
    return this.add({ every, next: this.now + every, callback })
  }

  after(callback: () => void, ms: number): () => void {
    return this.add({ every: null, next: this.now + ms, callback })
  }

  /** How many intervals and timeouts are set. */
  get pending(): number {
    return this.timers.size
  }

  /** Moves time on by `ms`, running each timer as often as it falls due, in time order. */
  advance(ms: number): void {
    const until = this.now + ms
    for (;;) {
      const due = [...this.timers].filter((timer) => timer.next <= until).sort((a, b) => a.next - b.next)[0]
      if (due === undefined) {
        break
      }
      this.now = due.next
      if (due.every === null) {
        this.timers.delete(due)
      } else {
        due.next += due.every
      }
      due.callback()
    }
    this.now = until
  }

  private add(timer: { every: number | null; next: number; callback: () => void }): () => void {
    this.timers.add(timer)
    return () => {
      this.timers.delete(timer)
    }
  }
}

/** A promise the test settles. */
export interface Gate<T> {
  promise: Promise<T>
  open: (value: T) => void
}

export function gate<T>(): Gate<T> {
  let open: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * The fake host, which also writes down whether each PTY's grant was already on its chat's record on disk, and
 * which session id and kickoff flag that record held then.
 */
class RecordingHost extends FakePtyHost {
  /** For each spawn, in order: whether index.jsonl, read again, already held the grant the PTY was given. */
  readonly grantStoredAtSpawn: boolean[] = []
  /** For each spawn, in order: the session id on that record, read again from index.jsonl. */
  readonly sessionStoredAtSpawn: (string | null)[] = []
  /** For each spawn, in order: whether that record already said the kickoff was sent. */
  readonly kickoffSentAtSpawn: boolean[] = []
  /** Runs right after each spawn, as the program starting; a test plays a CLI that exits at once with it. */
  onSpawn: (pty: FakePty) => void = () => {}

  constructor(private readonly rig: () => Omit<TerminalRig, 'sessions'>) {
    super()
  }

  override spawn(spec: PtySpawnSpec): FakePty {
    const rig = this.rig()
    rig.steps.push('spawn')
    const grantId = (spec.env['DM_SESSION_TOKEN'] ?? '').replace(/^token-/, '')
    const stored = rig.reopenedStore().listChats(rig.repo).find((chat) => chat.grantIds?.includes(grantId) === true)
    this.grantStoredAtSpawn.push(stored !== undefined)
    this.sessionStoredAtSpawn.push(stored?.sessionId ?? null)
    this.kickoffSentAtSpawn.push(stored?.kickoffSent === true)
    const pty = super.spawn(spec)
    this.onSpawn(pty)
    return pty
  }
}

export interface TerminalRig {
  sessions: TerminalSessions
  store: ChatStore
  /** A store opened again over the same files, as after a restart. */
  reopenedStore: () => ChatStore
  /** The files both stores read, for seeding what an app from before terminals stored. */
  chatFs: MemoryChatFs
  host: RecordingHost
  clock: FakeClock
  /** The scratch folder, the tracked folder in it, and the app's userData. */
  root: string
  repo: string
  userData: string
  /** The folders the app tracks; a test untracks one by deleting it. */
  tracked: Set<string>
  /** Everything the manager did that the order matters for: `auth`, `grant:<id>`, `spawn`, `revoke:<id>`. */
  steps: string[]
  revoked: string[]
  /** The sign-in answer; a test holds it back with `holdAuth`. */
  auth: { status: AgentAuthStatus; held: Gate<AgentAuthStatus> | null }
  /** Makes the next sign-in checks wait until the gate is opened. */
  holdAuth: () => Gate<AgentAuthStatus>
  /** Makes the next grant wait until the gate is opened. */
  holdGrant: () => Gate<void>
  /** The gate the grants wait on, once `holdGrant` has set one. */
  grantGate: Gate<void> | null
  /** How many grants were asked for, counted as each request arrives (before any gate). */
  grantsAsked: number
  /**
   * Every PTY tree the manager asked to kill, once per tree as `killPtyTree` shares a kill: a running tree is
   * killed (node-pty's kill, and the kill settles when it exits); one that has exited is only checked for leftovers.
   */
  killed: PtyTree[]
  /** Every error the manager reported. */
  errors: unknown[]
  /** The runs the desktop's session knows, by id, and every run call the manager made, as `getRun <id>` and `pauseRun <id> <reason>`. */
  runs: { states: Record<string, RunState>; calls: string[] }
  newChat: (agent?: string) => ChatRecord
  /** A chat Start run opened: an orchestrator of `runId`. */
  newOrchestrator: (runId: string, agent?: string) => ChatRecord
  cleanup: () => void
}

interface RigOptions {
  agents?: readonly AgentView[]
  /** Tree kills that report the tree gone at once, instead of when the PTY reports its exit. */
  killSettlesAtOnce?: boolean
  /** Dependencies laid over the rig's own; an `undefined` value leaves the manager its default. */
  deps?: (rig: Omit<TerminalRig, 'sessions'>) => Partial<TerminalSessionsDeps>
}

type RigBase = Omit<TerminalRig, 'sessions'>

/** The `dm` invocation the rig's manager is given for `folder`, before a grant is laid over it. */
export function cliFor(folder: string): CliLaunch {
  return buildCliConfig({ packaged: false, execPath: '/bin/electron', appPath: '/app', repoPath: folder })
}

/** The session id the rig's manager generates `n`th: a UUID, `…000000000001` first. */
export function sessionIdNumber(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** The desktop session's runs, as the rig's `runs` holds them, writing down every call. */
function rigRuns(rig: RigBase): TerminalSessionsDeps['runs'] {
  return {
    getRun: async (folder, runId) => {
      rig.runs.calls.push(`getRun ${runId}`)
      const state = folder === rig.repo ? rig.runs.states[runId] : undefined
      return state === undefined ? null : { state }
    },
    pauseRun: async (_folder, input) => {
      rig.runs.calls.push(`pauseRun ${input.runId} ${input.reason}`)
    }
  }
}

/** Kills a process tree once, recording it; the kill settles when the tree exits, or at once with `killSettlesAtOnce`. */
function rigKillTree(rig: RigBase, options: RigOptions): TerminalSessionsDeps['killTree'] {
  const kills = new Map<PtyTree, Promise<boolean>>()
  return (tree) => {
    const known = kills.get(tree)
    if (known !== undefined) {
      return known
    }
    rig.killed.push(tree)
    if (!tree.hasExited()) {
      tree.kill()
    }
    const kill = options.killSettlesAtOnce === true ? Promise.resolve(true) : tree.exited.then(() => true)
    kills.set(tree, kill)
    return kill
  }
}

/** The manager's dependencies, each on the rig's fakes. */
function rigDeps(rig: RigBase, options: RigOptions): TerminalSessionsDeps {
  let grants = 0
  let sessions = 0
  return {
    store: rig.store,
    agentFor: connectedAgents(options.agents ?? [builtInAgent('claude'), builtInAgent('autonomous'), CUSTOM_AGENT]),
    folders: { trackedFolder: (path) => (rig.tracked.has(path) ? path : null) },
    checkAuth: async () => {
      rig.steps.push('auth')
      return rig.auth.held === null ? rig.auth.status : rig.auth.held.promise
    },
    cliFor,
    runs: rigRuns(rig),
    issueChatCli: async (folder) => {
      rig.grantsAsked += 1
      grants += 1
      const grantId = `gr_${grants}`
      await rig.grantGate?.promise
      rig.steps.push(`grant:${grantId}`)
      const launch = cliFor(folder)
      return { cli: { ...launch, env: { ...launch.env, DM_SESSION_TOKEN: `token-${grantId}` } }, grantId }
    },
    revokeChatGrant: async (grantId) => {
      rig.steps.push(`revoke:${grantId}`)
      rig.revoked.push(grantId)
    },
    host: async () => rig.host,
    killTree: rigKillTree(rig, options),
    userData: rig.userData,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: rig.root },
    newSessionId: () => sessionIdNumber((sessions += 1)),
    timers: { repeat: (callback, ms) => rig.clock.repeat(callback, ms), after: (callback, ms) => rig.clock.after(callback, ms), now: () => rig.clock.now },
    onError: (error) => {
      rig.errors.push(error)
    }
  }
}

export function terminalRig(options: RigOptions = {}): TerminalRig {
  // Canonical from the start: on macOS the temporary directory is reached through the /var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-terminals-')))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const chatFs = memoryChatFs([repo])
  const store = memoryChatStore(chatFs)
  const rig: RigBase = {
    store,
    reopenedStore: () => memoryChatStore(chatFs),
    chatFs,
    host: new RecordingHost(() => rig),
    clock: new FakeClock(),
    root,
    repo,
    userData: join(root, 'userData'),
    tracked: new Set([repo]),
    steps: [],
    revoked: [],
    auth: { status: SIGNED_IN, held: null },
    holdAuth: () => (rig.auth.held = gate<AgentAuthStatus>()),
    holdGrant: () => (rig.grantGate = gate<void>()),
    grantGate: null,
    grantsAsked: 0,
    killed: [],
    errors: [],
    runs: { states: {}, calls: [] },
    newChat: (agent = 'claude') => store.createChat({ folder: repo, agent, model: null, role: 'worker', allowSave: false, title: 'Fix the build' }),
    newOrchestrator: (runId, agent = 'claude') =>
      store.createChat({ folder: repo, agent, model: null, role: 'orchestrator', allowSave: false, title: 'Orchestrator · Terminal chats', runId }),
    cleanup: () => {
      removeScratch(root)
    }
  }
  // The same object: `holdGrant` sets the gate the dependencies read.
  return Object.assign(rig, { sessions: createTerminalSessions({ ...rigDeps(rig, options), ...options.deps?.(rig) }) })
}

/** Plays Claude Code writing the chat's session (`written`), or deleting it, in the rig's home folder. */
export function claudeSessionFile(rig: Pick<TerminalRig, 'root' | 'repo'>, sessionId: string, written: boolean): void {
  const project = join(rig.root, '.claude', 'projects', claudeProjectName(rig.repo))
  mkdirSync(project, { recursive: true })
  const file = join(project, `${sessionId}.jsonl`)
  if (written) {
    writeFileSync(file, '{"type":"user"}\n')
  } else {
    rmSync(file, { force: true })
  }
}

/** Lets due promise callbacks, held listener events and the screen's parsing run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** Waits until `check` holds (file writes run on the real disk), failing after two seconds. */
export async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 2_000) {
      throw new Error(`Still waiting for ${what}.`)
    }
    await settle()
  }
}

/** The events a listener heard, in order. */
export function recorder(): { events: TerminalEvent[]; listener: (event: TerminalEvent) => void } {
  const events: TerminalEvent[] = []
  return { events, listener: (event) => events.push(event) }
}

/** Attaches (with `options`) until the chat's PTY runs (past a sign-in check), and answers with it and its attach. */
export async function startTerminal(
  rig: TerminalRig,
  chat: ChatRecord,
  listener?: (event: TerminalEvent) => void,
  options?: AttachOptions
): Promise<{ pty: FakePty; pid: number; snapshot: string }> {
  for (let tries = 0; tries < 400; tries += 1) {
    const answer = await rig.sessions.attach(chat, listener, options)
    if (answer.state === 'running') {
      const pty = rig.host.spawns.find((candidate) => candidate.pid === answer.pid)
      if (pty === undefined) {
        throw new Error(`No fake PTY has the pid ${answer.pid}.`)
      }
      return { pty, pid: answer.pid, snapshot: answer.snapshot }
    }
    if (answer.state !== 'checking') {
      throw new Error(`The terminal did not start: ${answer.state}: ${answer.message}`)
    }
    await settle()
  }
  throw new Error('The sign-in check never answered.')
}
