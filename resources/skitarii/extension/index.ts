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
 * OMP has no reduced-motion setting; its one switch for UI animation is `display.shimmer: disabled` ("No animation;
 * static muted text"), so the mascot holds still under it too. Unreadable means animate, as OMP's default does.
 */
export function reducedMotion(pi: OmpApi, lookup: Lookup | null): boolean {
  try {
    return lookup?.('display.shimmer')?.get(pi.pi?.settings) === 'disabled'
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
  pi.on('session_start', withUi((ctx) => skitarii.start(ctx.ui, ctx.cwd)))
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
