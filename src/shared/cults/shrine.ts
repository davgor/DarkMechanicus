/**
 * The cult Shrine (DM-632): one file a member published from its run's work dir, shown on the Cult page. Its content is
 * untrusted. Main serves it only through the app-owned `dm-shrine:` protocol (`src/main/cults/shrineProtocol.ts`), at
 * `dm-shrine://shrine/<run id>/<revision>`: the address names a run, never a path, and main serves only that run's
 * recorded shrine. Images and SVG are shown as `<img>` (an SVG's scripts never run); HTML only in an
 * `<iframe sandbox="allow-scripts">` (never `allow-same-origin`), served with `SHRINE_HTML_CSP`. No Node imports.
 */

export const SHRINE_SCHEME = 'dm-shrine'
/** The fixed host of every shrine address; the run id and revision are path segments (a standard scheme lowercases hosts). */
export const SHRINE_HOST = 'shrine'
/** The largest file a member may publish: 10 MiB. */
export const SHRINE_MAX_BYTES = 10 * 1024 * 1024

/** The extensions a Shrine may have, lower-case, with the type each is served as. */
export const SHRINE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8'
} as const
export type ShrineExtension = keyof typeof SHRINE_TYPES

/** An HTML shrine's policy: inline script and style only, images from data and blob; no network, nothing else. */
export const SHRINE_HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:"
/** An image's policy, should it ever be opened as a document: no script at all, and a sandbox. */
export const SHRINE_IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"

export type ShrineKind = 'image' | 'html'

/** The extension of `path` when it is one a Shrine may have; null otherwise. */
export function shrineExtension(path: string): ShrineExtension | null {
  const match = /\.([A-Za-z]+)$/.exec(path)
  const extension = match?.[1]?.toLowerCase()
  return extension !== undefined && Object.hasOwn(SHRINE_TYPES, extension) ? (extension as ShrineExtension) : null
}

/** How a shrine at `path` is shown: HTML in the sandboxed frame, any other allowed type as an image; null if not allowed. */
export function shrineKind(path: string): ShrineKind | null {
  const extension = shrineExtension(path)
  if (extension === null) return null
  return extension === 'html' ? 'html' : 'image'
}

/** The address of a run's shrine at a revision; a new revision is a new address, so the view reloads. */
export function shrineUrl(runId: string, revision: string): string {
  return `${SHRINE_SCHEME}://${SHRINE_HOST}/${encodeURIComponent(runId)}/${encodeURIComponent(revision)}`
}
