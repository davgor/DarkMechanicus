import type { BoardRemovalResultView } from '../../../shared/domain/views'
import { plural } from '../app/plural'
import type { ToastTone } from '../app/toastState'

interface FolderGroup {
  /** Repository-relative, ending in `/`; empty for the repository root. */
  folder: string
  files: string[]
}

/** Line numbers shown for one file; the rest are only counted. */
const SHOWN_LINES = 8

/** Files grouped under their folder, in the order the paths come, so a long list stays readable. */
export function groupByFolder(paths: readonly string[]): FolderGroup[] {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const cut = path.lastIndexOf('/') + 1
    const folder = path.slice(0, cut)
    groups.set(folder, [...(groups.get(folder) ?? []), path.slice(cut)])
  }
  return [...groups].map(([folder, files]) => ({ folder, files }))
}

/** "line 52", or "lines 29, 37, 39", with any past the first eight counted. */
export function mentionedLines(lines: readonly number[]): string {
  if (lines.length === 1) {
    return `line ${lines[0]}`
  }
  const shown = lines.slice(0, SHOWN_LINES).join(', ')
  const more = lines.length > SHOWN_LINES ? ` and ${lines.length - SHOWN_LINES} more` : ''
  return `lines ${shown}${more}`
}

/** The toast after a removal: how many files went, and that nothing was committed. */
export function describeBoardRemoval(result: BoardRemovalResultView): { tone: ToastTone; message: string } {
  if (result.removed.length === 0) {
    return { tone: 'info', message: 'Nothing was removed.' }
  }
  return {
    tone: 'success',
    message: `Removed ${plural(result.removed.length, 'file')} of the old board workflow. Nothing was committed.`
  }
}
