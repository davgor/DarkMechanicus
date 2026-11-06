/**
 * The Skitarii OMP extension: the mascot banner, the drill working indicator, the Mechanicus working messages and the
 * Skitarii title. The app loads it for its own OMP chats only, per launch, with `-e <this file>`
 * (`terminalLaunchSpec.ts`); it is never installed into the person's OMP folder. OMP runs it with its bundled Bun, which
 * reads the TypeScript and the JSON import directly. The logic is in `skitarii.ts`; this file only wires OMP's events.
 */
import frames from '../mascot/frames.json'
import { Skitarii, type MascotFrames, type SkitariiUi, type Timers } from './skitarii'

/** The slice of OMP's `ExtensionAPI` this extension uses (`packages/coding-agent/src/extensibility/extensions/types.ts`). */
interface OmpContext {
  ui: SkitariiUi
  hasUI: boolean
  cwd: string
  /** OMP's read-only session manager; `getEntries()` is the entries loaded so far (`session-manager.ts`). */
  sessionManager?: { getEntries: () => readonly { type?: string; message?: { role?: string } }[] }
}

type Handler = (event: unknown, ctx: OmpContext) => void

export interface OmpApi {
  on: (event: string, handler: Handler) => void
  /** OMP's package exports; `settings` is the scope its setting handles read. */
  pi?: { settings?: unknown }
}

/** A setting handle from OMP's registry (`@oh-my-pi/pi-coding-agent/config/registry`, `lookup`). */
interface SettingHandle {
  get: (scope: unknown) => unknown
}

type Lookup = (id: string) => SettingHandle | undefined

async function ompLookup(): Promise<Lookup | null> {
  try {
    const registry = await import('@oh-my-pi/pi-coding-agent/config/registry')
    return registry.lookup
  } catch {
    return null
  }
}

/**
 * Current OMP exposes `tui.motion`; both reduced and none hold the mascot still.
 * Older OMP used `display.shimmer: disabled`, which remains a static opt-out too.
 */
export function reducedMotion(pi: OmpApi, lookup: Lookup | null): boolean {
  try {
    const motion = lookup?.('tui.motion')?.get(pi.pi?.settings)
    return motion === 'reduced' || motion === 'none' || lookup?.('display.shimmer')?.get(pi.pi?.settings) === 'disabled'
  } catch {
    return false
  }
}

/**
 * Whether the session already holds conversation. OMP's `session_start` event carries no reason, but a resumed session
 * is loaded before it fires, so a user or assistant message among the entries (OMP's own test,
 * `hasConversationalHistory`) means resumed. Unreadable counts as new, so the banner shows as it always did.
 */
function isResumed(ctx: OmpContext): boolean {
  try {
    return ctx.sessionManager?.getEntries().some((e) => e.type === 'message' && (e.message?.role === 'user' || e.message?.role === 'assistant')) === true
  } catch {
    return false
  }
}

/** Registers the extension's handlers; `lookup` and `timers` are OMP's and the process's own unless a test gives them. */
export function attach(pi: OmpApi, lookup: Lookup | null, timers: Timers = { setInterval, clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>) }): Skitarii {
  const skitarii = new Skitarii(frames as MascotFrames, { timers, reducedMotion: reducedMotion(pi, lookup) })
  const withUi = (run: (ctx: OmpContext) => void): Handler => (_event, ctx) => {
    if (ctx.hasUI) run(ctx)
  }
  pi.on('session_start', withUi((ctx) => skitarii.start(ctx.ui, ctx.cwd, isResumed(ctx))))
  pi.on('agent_start', withUi((ctx) => skitarii.workStarted(ctx.ui)))
  pi.on('turn_start', withUi((ctx) => skitarii.turnStarted(ctx.ui)))
  pi.on('tool_execution_start', withUi((ctx) => skitarii.toolStarted(ctx.ui)))
  pi.on('agent_end', withUi((ctx) => skitarii.workEnded(ctx.ui)))
  pi.on('session_shutdown', () => skitarii.shutdown())
  return skitarii
}

export default async function skitariiExtension(pi: OmpApi): Promise<void> {
  attach(pi, await ompLookup())
}
