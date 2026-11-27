/**
 * The cult status writer, the member's side of `docs/design/cults.md` section 8 (main's reader is
 * `src/main/cults/memberActivity.ts`). A cult member's main session writes the private `cult-status.json` beside
 * `cult-control.json` when its turn starts (`agent_start`), when a tool call starts (`tool_execution_start`) and when the
 * turn ends (`agent_end`), so main sees working or idle as the turn changes instead of when the session JSONL catches up.
 *
 * The file holds only what main reads: `{ "state": "working" | "idle" }`. No tool input and no peer text is written;
 * main takes the last tool call from the session JSONL. Each write goes to a temp file (mode 0600) renamed over the
 * file, one at a time in event order, so main never reads a torn file. No timer is used and no handle stays open.
 *
 * Like the rest of the extension, this file imports nothing from OMP or npm.
 */
import { rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { DM_CLIENT_DESCRIPTOR_ENV } from './dmClient'

export const CULT_STATUS_FILE = 'cult-status.json'

type CultState = 'working' | 'idle'

interface CultStatusIo {
  writeFile: (path: string, text: string, options: { mode: number }) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const NODE_IO: CultStatusIo = { writeFile: (path, text, options) => writeFile(path, text, options), rename }

export interface CultStatusContext {
  agent?: { kind?: string }
}

export interface CultStatusApi {
  on: (event: string, handler: (event: unknown, ctx: CultStatusContext) => unknown) => void
}

/** Writes the member's state, in event order; a state already written is not written again. */
class CultStatusWriter {
  #last: CultState | null = null
  #chain: Promise<void> = Promise.resolve()

  constructor(private readonly io: CultStatusIo, private readonly path: string, private readonly temp: string) {}

  write(state: CultState): Promise<void> {
    if (state === this.#last) return this.#chain
    this.#last = state
    this.#chain = this.#chain.then(() => this.#replace(state))
    return this.#chain
  }

  async #replace(state: CultState): Promise<void> {
    try {
      await this.io.writeFile(this.temp, JSON.stringify({ state }), { mode: 0o600 })
      await this.io.rename(this.temp, this.path)
    } catch {
      // A failed write leaves main on the session JSONL fallback; the next event writes again.
      this.#last = null
    }
  }
}

/** The writer of this launch's chat (from its client descriptor's path); null without a usable descriptor. */
export function cultStatusWriter(env: Record<string, string | undefined>, io: CultStatusIo = NODE_IO, pid = process.pid): CultStatusWriter | null {
  const descriptor = env[DM_CLIENT_DESCRIPTOR_ENV]
  if (descriptor === undefined || !isAbsolute(descriptor) || !descriptor.endsWith('.json')) return null
  const dir = dirname(dirname(descriptor))
  return new CultStatusWriter(io, join(dir, CULT_STATUS_FILE), join(dir, `.${CULT_STATUS_FILE}.${pid}.tmp`))
}

/**
 * Writes the main session's state on its turn and tool events; attach it for cult members only. A session start writes
 * idle, so a launch never inherits the `working` an earlier one left when it ended mid-turn.
 */
export function attachCultStatus(pi: CultStatusApi, writer: CultStatusWriter): void {
  const on = (event: string, state: CultState): void =>
    pi.on(event, (_event, ctx) => {
      if (ctx.agent?.kind === 'main') void writer.write(state)
    })
  on('session_start', 'idle')
  on('agent_start', 'working')
  on('tool_execution_start', 'working')
  on('agent_end', 'idle')
}
