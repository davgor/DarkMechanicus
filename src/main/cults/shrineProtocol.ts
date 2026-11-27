/**
 * The `dm-shrine:` protocol (DM-632): serves a cult run's published Shrine to the app window, read-only, in the
 * `dm-attachment:` style (`src/main/desktop/attachmentProtocol.ts`). An address names a run and a revision
 * (`dm-shrine://shrine/<run id>/<revision>`), never a path: main serves only the file that run recorded, checked again on
 * every read (inside the run's work dir, an allowed type, at most 10 MiB), and 404 for anything else. HTML is sent with
 * `SHRINE_HTML_CSP` (no network, no app origin) and shown only in an `<iframe sandbox="allow-scripts">`; images with a
 * script-free policy. The handler and the lookup are pure, so they are tested without Electron; `registerShrineScheme`
 * and `registerShrineProtocol` only pass the scheme and the handler through.
 */
import type { Protocol } from 'electron'
import type { CultRunView } from '../../shared/cults/cult'
import { SHRINE_HOST, SHRINE_HTML_CSP, SHRINE_IMAGE_CSP, SHRINE_SCHEME, SHRINE_TYPES } from '../../shared/cults/shrine'
import { readShrine, type ShrineContent } from './cultShrine'

/** A run id or a revision as an address carries it: the run ids main makes, and a revision counter. */
const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/

interface ShrineTarget {
  runId: string
  revision: string
}

/** The run and revision a request URL names, or null when it names neither validly. */
export function parseShrineUrl(url: string): ShrineTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${SHRINE_SCHEME}:` || parsed.hostname !== SHRINE_HOST || parsed.search !== '') return null
  const [, runId, revision, ...rest] = parsed.pathname.split('/')
  if (rest.length > 0 || runId === undefined || revision === undefined || !SEGMENT.test(runId) || !SEGMENT.test(revision)) return null
  return { runId, revision }
}

/** The run's recorded Shrine content, or null when the run has none to serve. */
type ShrineLookup = (runId: string) => Promise<ShrineContent | null>

/** Reads a run's Shrine from the store's record: its path, checked again against its work dir. */
export function createShrineLookup(getRun: (runId: string) => Pick<CultRunView, 'workDir' | 'shrinePath'> | null): ShrineLookup {
  return async (runId) => {
    const run = getRun(runId)
    if (run === null || run.shrinePath === null) return null
    return readShrine(run.workDir, run.shrinePath)
  }
}

const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // A revision is in the address; the file behind it changes in place, so nothing is cached.
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Referrer-Policy': 'no-referrer'
}

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...COMMON_HEADERS, ...headers } })
}

/**
 * Answers one `dm-shrine:` request: the run's recorded Shrine with its type and policy for a known run, 404 for an
 * unknown or malformed address, a run without a Shrine, or a file that no longer passes its checks, and 405 for any
 * method but GET.
 */
export async function handleShrineRequest(request: Request, lookup: ShrineLookup): Promise<Response> {
  if (request.method !== 'GET') return empty(405, { Allow: 'GET' })
  const target = parseShrineUrl(request.url)
  if (target === null) return empty(404)
  const content = await lookup(target.runId).catch(() => null)
  if (content === null) return empty(404)
  const html = content.extension === 'html'
  return new Response(content.bytes as BodyInit, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': SHRINE_TYPES[content.extension],
      'Content-Length': String(content.bytes.byteLength),
      'Content-Security-Policy': html ? SHRINE_HTML_CSP : SHRINE_IMAGE_CSP
    }
  })
}

/** Before the app is ready: a standard, secure scheme, so a frame of it has its own opaque origin and may load as an image. */
export function registerShrineScheme(protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SHRINE_SCHEME, privileges: { standard: true, secure: true } }])
}

/** After the app is ready: answers `dm-shrine:` requests with `lookup`. */
export function registerShrineProtocol(protocol: Pick<Protocol, 'handle'>, lookup: ShrineLookup): void {
  protocol.handle(SHRINE_SCHEME, (request) => handleShrineRequest(request, lookup))
}
