/**
 * The desktop app's own observation of the installed build on this machine. An agent can start the `dm` CLI or the
 * MCP server from any folder named `app.asar` with any package.json beside it, so the `serverInfo` such a session
 * reports is only its own claim. The desktop records what Electron itself reports (`app.getVersion()`,
 * `app.isPackaged`) whenever it opens the project; no command writes this key, so delivery verification can prefer it
 * over the recording session's `serverInfo`, which it falls back to only when no observation exists.
 */
import type { Ctx } from './context'
import { getMeta, META_KEYS, setMeta } from './meta'

interface InstalledAppObservation {
  version: string
  packaged: boolean
  /** The machine the observation was made on: the `meta` table is machine-local, and this makes that explicit. */
  machineId: string
  observedAt: string
}

/** Desktop only: records what the running desktop app reports about itself. */
export function recordInstalledApp(ctx: Pick<Ctx, 'db' | 'clock' | 'machineId'>, app: { version: string; packaged: boolean }): void {
  const observation: InstalledAppObservation = {
    version: app.version,
    packaged: app.packaged,
    machineId: ctx.machineId,
    observedAt: ctx.clock.nowIso()
  }
  ctx.db.tx(() => setMeta(ctx.db, META_KEYS.installedApp, JSON.stringify(observation)))
}

function isObservation(value: unknown): value is InstalledAppObservation {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.version === 'string' && typeof entry.packaged === 'boolean'
    && typeof entry.machineId === 'string' && typeof entry.observedAt === 'string'
}

/** The desktop's latest observation on `machineId`; null when none was recorded there or the stored value is malformed. */
export function readInstalledApp(ctx: Pick<Ctx, 'db' | 'machineId'>): InstalledAppObservation | null {
  const raw = getMeta(ctx.db, META_KEYS.installedApp)
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return isObservation(value) && value.machineId === ctx.machineId ? value : null
}
