/**
 * Markdown read by documentation tests: one section of a document, and the phrases a text lacks, so a doc that drifts
 * from the code or loses a rule fails its test. Not shipped.
 */

const HEADING = /^(#+)\s/

const headingLevel = (line: string): number => HEADING.exec(line)?.[1]?.length ?? 0

/**
 * The text of one section: from the heading whose title is exactly `heading` to the next heading of the same or a
 * higher level. Throws when no heading has that title.
 */
export function markdownSection(markdown: string, heading: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => HEADING.test(line) && line.replace(/^#+\s*/, '') === heading)
  if (start < 0) {
    throw new Error(`No section titled "${heading}"`)
  }
  const level = headingLevel(lines[start] ?? '')
  const end = lines.findIndex((line, index) => index > start && HEADING.test(line) && headingLevel(line) <= level)
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ').toLowerCase()

/** The phrases `text` does not contain, compared case-insensitively, with any run of whitespace (a line wrap) as one space. */
export function missingPhrases(text: string, phrases: readonly string[]): string[] {
  const flat = flatten(text)
  return phrases.filter((phrase) => !flat.includes(flatten(phrase)))
}
