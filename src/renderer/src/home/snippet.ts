interface SnippetPart {
  text: string
  match: boolean
}

/** Full-text search wraps each matched term in [brackets]. */
const MARKED = /\[([^[\]]+)\]/g

/** Splits a search snippet into plain and highlighted parts (the brackets are not kept). */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let last = 0
  for (const found of snippet.matchAll(MARKED)) {
    const start = found.index ?? 0
    if (start > last) {
      parts.push({ text: snippet.slice(last, start), match: false })
    }
    parts.push({ text: found[1] ?? '', match: true })
    last = start + found[0].length
  }
  if (last < snippet.length) {
    parts.push({ text: snippet.slice(last), match: false })
  }
  return parts
}
