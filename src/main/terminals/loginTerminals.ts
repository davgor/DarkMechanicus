/**
 * The sign-in terminals (`docs/design/chat-shells.md`, "Sign-in detection"): one PTY per agent, keyed by agent id,
 * running the CLI's own login command (`terminalLoginSpec`: the registered executable with `LOGIN_ARGS`, in the home
 * folder, with the scrubbed environment). No grant is issued, no instructions file is written and no session is
 * stored: nothing of the chats' start applies. The caller names a connected built-in agent from main's registry.
 *
 * **Shared.** Every view that shows an agent's sign-in (a chat's sign-in card, the sign-in view) attaches to the same
 * PTY: an attach answers the screen so far (a headless screen, as a chat's) and its listener hears what follows, held
 * until the attach has answered. Attaches that arrive while the PTY starts share the start. A login that exited
 * before its attach answered is answered with its last screen, and the attach hears the exit; it is not started
 * again, so a login that fails at once cannot loop.
 *
 * **Stopped** (process tree killed) when the last view leaves it (Back, another view, a closed window), when its agent
 * is removed, and at quit: `dispose` cancels the starts under way and resolves once every PTY has reported its exit
 * and every kill has settled. A CLI that exits on its own has what it left in its process group ended too.
 */
import { DomainError } from '../../core/errors'
import type { AgentId, AgentView } from '../../shared/desktop/api'
import { killPtyTree, type PtyTree } from '../agents/processTree'
import type { PtyExit, PtyHost, PtyProcess } from './ptyHost'
import { terminalLoginSpec } from './terminalLaunchSpec'
import { createTerminalScreen, type TerminalScreen } from './terminalScreen'
import type { TerminalEvent, TerminalListener } from './terminalSessions'

const START_COLS = 80
const START_ROWS = 24

const QUITTING = 'The app is quitting, so the sign-in was stopped.'
const AGENT_REMOVED = 'The agent was removed, so its sign-in was stopped.'
const LEFT = 'The sign-in was closed.'

/** What an attach answers: the login runs (or has just ended) with its screen so far, or why it does not. */
export type LoginAttach = { state: 'running'; snapshot: string } | { state: 'refused' | 'failed'; message: string }

/** The agent a sign-in runs for, as main's registry has it. */
type LoginAgent = Pick<AgentView, 'id' | 'kind' | 'executablePath'>

export interface LoginTerminals {
  /** Starts the agent's login when none runs, and subscribes `listener` to it; see the module comment. */
  attach(agent: LoginAgent, listener: TerminalListener): Promise<LoginAttach>
  /** Stops `listener` hearing the agent's login; the last one leaving stops the login. */
  detach(agentId: AgentId, listener: TerminalListener): void
  /** Input for the agent's running login, as typed. */
  write(agentId: AgentId, data: string): void
  resize(agentId: AgentId, cols: number, rows: number): void
  /** Stops the login of a removed agent; resolves once its kill has settled. */
  endAgent(agentId: AgentId): Promise<void>
  /** True while a login runs or starts, or a kill has not settled. */
  busy(): boolean
  /** Quit: see the module comment. */
  dispose(): Promise<void>
}

interface LoginTerminalsDeps {
  /** The PTY host; rejects when PTYs cannot run here. */
  host: () => Promise<PtyHost>
  /** Ends a PTY's process tree; `killPtyTree` by default. */
  killTree?: (tree: PtyTree) => Promise<boolean>
  /** The person's home folder: where every sign-in runs. */
  home: string
  platform: NodeJS.Platform
  /** main's `process.env`. */
  env: Readonly<Record<string, string | undefined>>
  onError?: (error: unknown) => void
}

interface Subscriber {
  /** What it heard before its attach answered; null once released. */
  held: TerminalEvent[] | null
}

interface Login {
  kind: 'login'
  agentId: AgentId
  pty: PtyProcess
  screen: TerminalScreen
  tree: PtyTree
  subscribers: Map<TerminalListener, Subscriber>
  exited: boolean
  /** Why main stopped it, once it has. */
  stopMessage: string | null
  /** Settles when the PTY has reported its exit. */
  ended: Promise<void>
  /** Settles once its exit has been told and the agent can start another. */
  closed: Promise<void>
  /** Its last screen and exit, once closed. */
  last: { snapshot: string; exit: Extract<TerminalEvent, { kind: 'exited' }> } | null
}

/** A start under way, which every attach that comes meanwhile waits for. */
interface Starting {
  kind: 'starting'
  done: Promise<Login | Extract<LoginAttach, { message: string }>>
}

interface Manager {
  deps: Required<Omit<LoginTerminalsDeps, 'onError'>>
  onError: (error: unknown) => void
  entries: Map<AgentId, Login | Starting>
  /** Kills not yet settled. */
  pending: Set<Promise<unknown>>
  closing: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tell(manager: Manager, listener: TerminalListener, subscriber: Subscriber, event: TerminalEvent): void {
  if (subscriber.held !== null) {
    subscriber.held.push(event)
    return
  }
  try {
    listener(event)
  } catch (error) {
    manager.onError(error)
  }
}

function emit(manager: Manager, login: Login, event: TerminalEvent): void {
  for (const [listener, subscriber] of login.subscribers) {
    tell(manager, listener, subscriber, event)
  }
}

/** Subscribes `listener` here; what it hears is held until a later turn of the event loop, after the attach answered. */
function subscribe(manager: Manager, login: Login, listener: TerminalListener): Subscriber {
  const subscriber: Subscriber = { held: [] }
  login.subscribers.set(listener, subscriber)
  setImmediate(() => {
    const held = subscriber.held ?? []
    subscriber.held = null
    if (login.subscribers.get(listener) === subscriber) {
      for (const event of held) {
        tell(manager, listener, subscriber, event)
      }
    }
  })
  return subscriber
}

/** Ends the login's process tree; never rejects. A quit waits for it. */
function killTree(manager: Manager, login: Login): Promise<unknown> {
  const kill = manager.deps.killTree(login.tree).catch((error: unknown) => {
    manager.onError(error)
  })
  manager.pending.add(kill)
  void kill.finally(() => manager.pending.delete(kill))
  return kill
}

/** Stops the login for `message`. */
function stop(manager: Manager, login: Login, message: string): Promise<unknown> {
  login.stopMessage ??= message
  return killTree(manager, login)
}

/** Tracks a PTY just spawned; nothing here can fail, so no login runs untracked. */
function track(manager: Manager, agentId: AgentId, pty: PtyProcess): Login {
  const screen = createTerminalScreen(START_COLS, START_ROWS)
  let reportEnded: () => void = () => {}
  let reportClosed: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    reportEnded = resolve
  })
  const login: Login = {
    kind: 'login',
    agentId,
    pty,
    screen,
    tree: { pid: pty.pid, kill: () => pty.kill(), exited: ended, hasExited: () => login.exited },
    subscribers: new Map(),
    exited: false,
    stopMessage: null,
    ended,
    closed: new Promise<void>((resolve) => {
      reportClosed = resolve
    }),
    last: null
  }
  const stopData = pty.onData((data) => {
    screen.write(data, () => emit(manager, login, { kind: 'output', data }))
  })
  const stopExit = pty.onExit((exit: PtyExit) => {
    login.exited = true
    reportEnded()
    stopData()
    stopExit()
    // Asked now, while the group's id can only be the CLI's: ends what it left running in its process group.
    void killTree(manager, login)
    screen.snapshot((snapshot) => {
      const exited = { kind: 'exited', exitCode: exit.exitCode, signal: exit.signal, message: login.stopMessage, resumed: false } as const
      login.last = { snapshot, exit: exited }
      if (manager.entries.get(agentId) === login) {
        manager.entries.delete(agentId)
      }
      emit(manager, login, exited)
      screen.dispose()
      reportClosed()
    })
  })
  return login
}

/** Starts the agent's login; a quit that comes while the host loads stops it before anything runs. */
function begin(manager: Manager, agent: LoginAgent): Starting {
  const starting: Starting = { kind: 'starting', done: Promise.resolve({ state: 'failed', message: QUITTING }) }
  manager.entries.set(agent.id, starting)
  const start = async (): Promise<Login | Extract<LoginAttach, { message: string }>> => {
    try {
      const spec = terminalLoginSpec({ agent, home: manager.deps.home, platform: manager.deps.platform, env: manager.deps.env })
      const host = await manager.deps.host()
      if (manager.closing) {
        return { state: 'failed', message: QUITTING }
      }
      const pty = host.spawn({ file: spec.file, args: spec.commandLine ?? spec.args, cwd: spec.cwd, env: spec.env, cols: START_COLS, rows: START_ROWS })
      return track(manager, agent.id, pty)
    } catch (error) {
      return { state: error instanceof DomainError ? 'refused' : 'failed', message: messageOf(error) }
    }
  }
  starting.done = start().then((outcome) => {
    if (manager.entries.get(agent.id) === starting) {
      if ('kind' in outcome && !outcome.exited) {
        manager.entries.set(agent.id, outcome)
      } else {
        manager.entries.delete(agent.id)
      }
    }
    return outcome
  })
  return starting
}

/** The login's screen so far, with `listener` subscribed at that point; or, once it has ended, its last screen and exit. */
async function answerFor(manager: Manager, login: Login, listener: TerminalListener): Promise<LoginAttach> {
  if (login.exited) {
    await login.closed
    const last = login.last ?? { snapshot: '', exit: { kind: 'exited', exitCode: 0, signal: null, message: login.stopMessage, resumed: false } }
    // Told after the answer, as a login that exits later would be.
    tell(manager, listener, subscribe(manager, login, listener), last.exit)
    return { state: 'running', snapshot: last.snapshot }
  }
  return new Promise((resolve) => {
    login.screen.snapshot((snapshot) => {
      subscribe(manager, login, listener)
      resolve({ state: 'running', snapshot })
    })
  })
}

async function attach(manager: Manager, agent: LoginAgent, listener: TerminalListener): Promise<LoginAttach> {
  for (;;) {
    if (manager.closing) {
      return { state: 'failed', message: QUITTING }
    }
    const entry = manager.entries.get(agent.id) ?? begin(manager, agent)
    const login = entry.kind === 'starting' ? await entry.done : entry
    if (!('kind' in login)) {
      return login
    }
    if (login.stopMessage === null || login.last !== null) {
      return answerFor(manager, login, listener)
    }
    // Being stopped (left by its last view, an instant ago): once it has gone, a fresh one starts.
    await login.closed
  }
}

function running(manager: Manager, agentId: AgentId): Login | null {
  const entry = manager.entries.get(agentId)
  return entry?.kind === 'login' && !entry.exited ? entry : null
}

async function endEntry(manager: Manager, entry: Login | Starting, message: string): Promise<Login | null> {
  const login = entry.kind === 'starting' ? await entry.done : entry
  if (!('kind' in login)) {
    return null
  }
  if (!login.exited) {
    await stop(manager, login, message)
  }
  return login
}

export function createLoginTerminals(deps: LoginTerminalsDeps): LoginTerminals {
  const { onError, ...rest } = deps
  const manager: Manager = {
    deps: { ...rest, killTree: deps.killTree ?? ((tree) => killPtyTree(tree)) },
    onError: onError ?? (() => {}),
    entries: new Map(),
    pending: new Set(),
    closing: false
  }
  return {
    attach: (agent, listener) => attach(manager, agent, listener),
    detach: (agentId, listener) => {
      const login = running(manager, agentId)
      if (login !== null && login.subscribers.delete(listener) && login.subscribers.size === 0) {
        void stop(manager, login, LEFT)
      }
    },
    write: (agentId, data) => {
      running(manager, agentId)?.pty.write(data)
    },
    resize: (agentId, cols, rows) => {
      const login = running(manager, agentId)
      if (login !== null) {
        login.pty.resize(cols, rows)
        login.screen.resize(cols, rows)
      }
    },
    endAgent: async (agentId) => {
      const entry = manager.entries.get(agentId)
      if (entry !== undefined) {
        await endEntry(manager, entry, AGENT_REMOVED)
      }
    },
    busy: () => manager.entries.size > 0 || manager.pending.size > 0,
    dispose: async () => {
      manager.closing = true
      await Promise.all(
        [...manager.entries.values()].map(async (entry) => {
          await (await endEntry(manager, entry, QUITTING))?.closed
        })
      )
      await Promise.all(manager.pending)
    }
  }
}
