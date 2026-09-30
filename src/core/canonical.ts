import { createHash } from 'node:crypto'

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : sortValue(item)))
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      // Object keys are unique, so two keys never compare equal.
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]))
  }
  return value
}

/** Deterministic JSON: object keys sorted, `undefined` members dropped, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** Human-readable deterministic JSON for Git-tracked records (sorted keys, 2-space indent, trailing newline). */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Content hash of a JSON value, stable across key order: `sha256:<hex>`. */
export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}
