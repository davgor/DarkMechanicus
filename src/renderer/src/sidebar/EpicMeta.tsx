import type { EpicSummaryView } from '../../../shared/domain/views'
import { epicBadges, epicStatusLine } from './epicStatusLine'

/** Status line under an epic title: a toned dot plus the words, so color is never the only cue. */
export function EpicStatusText({ epic }: { epic: EpicSummaryView }): JSX.Element {
  const line = epicStatusLine(epic)
  return (
    <span className={`epic-status epic-status-${line.tone}`}>
      <span className="epic-status-dot" aria-hidden="true" />
      <span>{line.text}</span>
    </span>
  )
}

/** "draft", "save pending" and "conflict" markers. Nothing renders for a clean epic. */
export function EpicBadges({ epic }: { epic: EpicSummaryView }): JSX.Element | null {
  const badges = epicBadges(epic)
  if (badges.length === 0) {
    return null
  }
  return (
    <span className="epic-badges">
      {badges.map((badge) => (
        <span key={badge.kind} className={`badge badge-${badge.kind}`} title={badge.title}>
          {badge.label}
        </span>
      ))}
    </span>
  )
}
