/** Parses git's progress lines (stderr with `--progress`, split on CR and LF by the runner). Pure. */

interface ProgressLine {
  /** Git's own phase name, such as `Receiving objects`. */
  phase: string
  /** 0 to 100, or null for a phase git counts without a total (`Enumerating objects: 12, done.`). */
  percent: number | null
}

/**
 * A phase is a capitalised run of lower-case words, a colon, then either a percentage or a bare count:
 * `Counting objects:  45% (9/20)`, `Enumerating objects: 12, done.`. `remote: ` is the server's own progress.
 * Anything else (ref updates, hints, the server's messages) is not progress, and only these fixed words are kept.
 */
const PROGRESS = /^(?:remote: +)?([A-Z][a-z]+(?: [a-z]+)*): +(?:(\d+)% \(|\d+(?:,|$))/

export function parseProgressLine(line: string): ProgressLine | null {
  const match = PROGRESS.exec(line)
  if (match === null) {
    return null
  }
  return { phase: match[1], percent: match[2] === undefined ? null : Math.min(100, Number(match[2])) }
}
