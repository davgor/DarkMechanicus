import type { BoardImportView } from '../../../shared/domain/views'
import { plural } from '../app/plural'

/** Whether the repository has an old-style board worth showing: any epic, or any file it skipped. */
export function boardFound(view: BoardImportView): boolean {
  return view.open.length > 0 || view.done.length > 0 || view.skipped.length > 0
}

/** Open epics no earlier import created, which the next import creates. */
export function newEpicCount(view: BoardImportView): number {
  return view.open.filter((epic) => epic.state === 'new').length
}

export function importButtonLabel(count: number): string {
  return `Import ${plural(count, 'epic')} as ${count === 1 ? 'a draft' : 'drafts'}`
}
